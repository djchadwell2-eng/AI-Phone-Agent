import { DateTime } from "luxon";
import { task } from "@trigger.dev/sdk";
import { alertOwner } from "../lib/alerts.js";
import { bookingAdapterFor } from "../lib/booking/index.js";
import { reportError } from "../lib/errors.js";
import { smsAgentTurn } from "../lib/sms-agent.js";
import { clientById, db, isOptedOut, logEvent } from "../lib/supabase.js";
import { sendCustomerSms } from "../lib/twilio.js";
import type { SmsThreadRow } from "../lib/types.js";

/**
 * One turn of the two-way SMS agent (Layer 3's conversation loop). Triggered
 * per inbound SMS by the webhook. Flow: record inbound → fetch bookable slots
 * → one cheap-model decision → act (book / escalate / close) → reply.
 */
export const smsTurn = task({
  id: "sms-turn",
  run: async (
    payload: { clientId: string; from: string; to: string; body: string; messageSid: string },
    { ctx }
  ) => {
    try {
      const client = await clientById(payload.clientId);
      if (client.status !== "active" || client.features.sms_agent === false) return { skipped: "disabled" };
      if (await isOptedOut(payload.from)) return { skipped: "opted_out" };
      if (!client.twilio_number) throw new Error(`Client ${client.slug} has no twilio_number`);

      // Find or open the thread (customers can text first without ever calling).
      let { data: thread } = await db()
        .from("sms_threads")
        .select("*")
        .eq("client_id", client.id)
        .eq("customer_number", payload.from)
        .in("status", ["active", "escalated"])
        .maybeSingle();
      if (!thread) {
        const { data: created, error } = await db()
          .from("sms_threads")
          .insert({ client_id: client.id, customer_number: payload.from, context: { origin: "inbound_sms" } })
          .select("*")
          .single();
        if (error) throw new Error(`thread insert: ${error.message}`);
        thread = created;
      }
      const threadRow = thread as SmsThreadRow;

      // Record inbound (unique sid → replays are no-ops).
      await db()
        .from("sms_messages")
        .upsert(
          { thread_id: threadRow.id, direction: "inbound", body: payload.body, twilio_message_sid: payload.messageSid },
          { onConflict: "twilio_message_sid", ignoreDuplicates: true }
        );

      const { data: historyRows } = await db()
        .from("sms_messages")
        .select("direction, body")
        .eq("thread_id", threadRow.id)
        .order("created_at", { ascending: true })
        .limit(30);
      const history = (historyRows ?? []) as { direction: "inbound" | "outbound"; body: string }[];

      // Offerable slots: best effort — an unavailable calendar must not kill the reply.
      let offeredSlots: { startIso: string; label: string }[] = [];
      if (client.calcom_event_type_id) {
        try {
          const now = DateTime.now().setZone(client.timezone);
          offeredSlots = await bookingAdapterFor(client).getSlots({
            fromIso: now.plus({ hours: 3 }).toUTC().toISO()!,
            toIso: now.plus({ days: 7 }).toUTC().toISO()!,
            timezone: client.timezone,
            limit: 3,
          });
        } catch (e) {
          await reportError({ source: "task:sms-turn:slots", error: e, clientId: client.id, alert: false });
        }
      }

      const { decision, costCents } = await smsAgentTurn({ client, thread: threadRow, history, offeredSlots });

      // Merge whatever the agent learned into thread memory.
      const newContext = {
        ...threadRow.context,
        ...(decision.collected.name ? { name: decision.collected.name } : {}),
        ...(decision.collected.address ? { address: decision.collected.address } : {}),
        ...(decision.collected.issue ? { issue: decision.collected.issue } : {}),
      };

      let reply = decision.reply;
      let threadStatus: SmsThreadRow["status"] = threadRow.status;

      if (decision.action === "book" && decision.slot_iso) {
        const result = await bookingAdapterFor(client).book({
          startIso: decision.slot_iso,
          name: newContext.name ?? "Text customer",
          phone: payload.from,
          timezone: client.timezone,
          notes: newContext.issue ?? "",
        });
        if (result.ok) {
          const local = DateTime.fromISO(result.startIso!, { zone: client.timezone }).toFormat("cccc, LLLL d 'at' h:mm a");
          const { data: bookingRow } = await db()
            .from("bookings")
            .insert({
              client_id: client.id,
              thread_id: threadRow.id,
              status: "booked",
              provider: client.booking_method,
              provider_booking_uid: result.providerBookingUid ?? null,
              start_at: result.startIso,
              customer_name: newContext.name ?? null,
              customer_phone: payload.from,
              issue: newContext.issue ?? null,
            })
            .select("id")
            .single();
          await logEvent({
            client_id: client.id,
            type: "booking_created",
            thread_id: threadRow.id,
            payload: { via: "sms", booking_id: bookingRow?.id, start: result.startIso },
          });
          // A booking ends any pending follow-up nagging.
          await db()
            .from("follow_up_sequences")
            .update({ status: "completed" })
            .eq("client_id", client.id)
            .eq("customer_number", payload.from)
            .eq("status", "active");
          reply = `You're booked for ${local}. We'll text a reminder — reply here anytime if something changes.`;
          threadStatus = "closed";
        } else {
          await reportError({ source: "task:sms-turn:book", error: new Error(result.error ?? "booking failed"), clientId: client.id, alert: false });
          reply = "Hit a snag locking that time in on our end — the team will text you shortly to confirm it. Sorry about that!";
          await db().from("bookings").insert({
            client_id: client.id,
            thread_id: threadRow.id,
            status: "needs_scheduling",
            provider: client.booking_method,
            customer_name: newContext.name ?? null,
            customer_phone: payload.from,
            issue: newContext.issue ?? null,
            preferred_windows: decision.slot_iso,
          });
          await alertOwner({
            client,
            body: `⚠️ SMS booking failed for ${payload.from} (wanted ${decision.slot_iso}). Please confirm manually.\nContext: ${JSON.stringify(newContext)}`,
            eventType: "owner_alert",
            threadId: threadRow.id,
          });
        }
      } else if (decision.action === "escalate") {
        threadStatus = "escalated";
        const transcriptTail = history.slice(-6).map((m) => `${m.direction === "inbound" ? "Cust" : "AI"}: ${m.body}`).join("\n");
        await alertOwner({
          client,
          body: `🔔 OWNER ALERT — SMS thread needs you (${decision.escalate_reason ?? "agent out of depth"})\nFrom: ${payload.from}\nKnown: ${JSON.stringify(newContext)}\n---\n${transcriptTail}`,
          eventType: "owner_alert",
          threadId: threadRow.id,
        });
      } else if (decision.action === "close") {
        threadStatus = "closed";
      }

      const sent = await sendCustomerSms({
        clientId: client.id,
        from: client.twilio_number,
        to: payload.from,
        body: reply,
        eventType: "sms_agent_reply",
        threadId: threadRow.id,
      });
      if (!("skipped" in sent)) {
        await db().from("sms_messages").insert({
          thread_id: threadRow.id,
          direction: "outbound",
          body: reply,
          twilio_message_sid: sent.sid,
          meta: { action: decision.action, openai_cost_cents: costCents },
        });
      }

      await db()
        .from("sms_threads")
        .update({ context: newContext, status: threadStatus, last_message_at: new Date().toISOString() })
        .eq("id", threadRow.id);

      return { threadId: threadRow.id, action: decision.action };
    } catch (error) {
      await reportError({
        source: "task:sms-turn",
        error,
        clientId: payload.clientId,
        detail: { from: payload.from, sid: payload.messageSid },
        alert: ctx.attempt.number >= 3,
      });
      throw error;
    }
  },
});
