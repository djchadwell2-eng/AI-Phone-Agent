import { task, wait } from "@trigger.dev/sdk";
import { reportError } from "../lib/errors.js";
import { clientById, db, isOptedOut } from "../lib/supabase.js";
import { sendCustomerSms } from "../lib/twilio.js";

/**
 * Day 1/3/7 follow-up for callers who wanted an appointment but didn't book.
 * One long-lived run with durable waits (the reason Trigger.dev was chosen);
 * before EVERY send it re-checks reality — booked, opted out, cancelled,
 * client paused — so a stale sequence can never nag someone who converted.
 */
export const followUpSequence = task({
  id: "follow-up-sequence",
  run: async (payload: { clientId: string; customerNumber: string; callId: string | null }, { ctx }) => {
    try {
      // Claim the one-active-sequence-per-customer slot; a second call from the
      // same person while a sequence runs should not start a parallel one.
      const { data: seq, error } = await db()
        .from("follow_up_sequences")
        .insert({
          client_id: payload.clientId,
          customer_number: payload.customerNumber,
          call_id: payload.callId,
        })
        .select("id")
        .single();
      if (error) {
        if (error.code === "23505") return { skipped: "sequence_already_active" }; // unique partial index
        throw new Error(`sequence insert: ${error.message}`);
      }
      const seqId = seq.id as string;

      const HOUR = 3600;
      const stages: { waitSeconds: number; body: (biz: string) => string }[] = [
        {
          waitSeconds: 20 * HOUR, // "day 1": next morning-ish, not 3am
          body: (biz) => `Hi, it's ${biz} following up on your call — want us to get you on the schedule? Just text back a good day/time and we'll set it up.`,
        },
        {
          waitSeconds: 48 * HOUR, // "day 3"
          body: (biz) => `${biz} here — still happy to help with what you called about. Want us to grab you a spot this week?`,
        },
        {
          waitSeconds: 96 * HOUR, // "day 7"
          body: (biz) => `Last check-in from ${biz} — if you still need a hand, just text back anytime and we'll take care of it. Thanks!`,
        },
      ];

      for (let stage = 1; stage <= stages.length; stage++) {
        const s = stages[stage - 1]!;
        await wait.for({ seconds: s.waitSeconds });

        // Re-check the world after each wait.
        const { data: seqRow } = await db().from("follow_up_sequences").select("status").eq("id", seqId).single();
        if (seqRow?.status !== "active") return { stopped: seqRow?.status, stage };
        const client = await clientById(payload.clientId);
        if (client.status !== "active" || client.features.follow_ups === false || !client.twilio_number) {
          await db().from("follow_up_sequences").update({ status: "cancelled" }).eq("id", seqId);
          return { stopped: "client_inactive", stage };
        }
        if (await isOptedOut(payload.customerNumber)) {
          await db().from("follow_up_sequences").update({ status: "cancelled" }).eq("id", seqId);
          return { stopped: "opted_out", stage };
        }
        const { data: booked } = await db()
          .from("bookings")
          .select("id")
          .eq("client_id", payload.clientId)
          .eq("customer_phone", payload.customerNumber)
          .in("status", ["booked", "confirmed"])
          .limit(1);
        if ((booked?.length ?? 0) > 0) {
          await db().from("follow_up_sequences").update({ status: "completed" }).eq("id", seqId);
          return { stopped: "booked", stage };
        }

        const sent = await sendCustomerSms({
          clientId: client.id,
          from: client.twilio_number,
          to: payload.customerNumber,
          body: s.body(client.business_name),
          eventType: "follow_up_sent",
          callId: payload.callId,
        });
        if ("skipped" in sent) {
          await db().from("follow_up_sequences").update({ status: "cancelled" }).eq("id", seqId);
          return { stopped: "opted_out", stage };
        }
        await db().from("follow_up_sequences").update({ stage }).eq("id", seqId);
      }

      await db().from("follow_up_sequences").update({ status: "completed" }).eq("id", seqId);
      return { completed: true };
    } catch (error) {
      await reportError({
        source: "task:follow-up-sequence",
        error,
        clientId: payload.clientId,
        detail: { customer: payload.customerNumber },
        alert: ctx.attempt.number >= 3,
      });
      throw error;
    }
  },
});
