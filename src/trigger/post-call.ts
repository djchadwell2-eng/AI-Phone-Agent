import { task, tasks, wait } from "@trigger.dev/sdk";
import { alertOwner } from "../lib/alerts.js";
import { reportError } from "../lib/errors.js";
import { extractFromTranscript } from "../lib/extraction.js";
import { isOpenAt, clientNow } from "../lib/hours.js";
import { retellClient } from "../lib/retell.js";
import { clientByTwilioNumber, db, logEvent } from "../lib/supabase.js";
import type { CallExtraction } from "../lib/types.js";
import type { followUpSequence } from "./follow-ups.js";
import type { missedCallTextback } from "./missed-call-textback.js";

// Under ~5s = caller gave up before saying anything useful → Layer 3 text-back.
const MISSED_CALL_MAX_SECONDS = 5;

/**
 * The post-call pipeline: Retell end-of-call event → refetch call → OpenAI
 * extraction → calls row → follow-ups/alerts. Idempotent: upserts by
 * retell_call_id and is triggered with idempotencyKey post-call:{call_id}.
 */
export const postCall = task({
  id: "post-call",
  run: async (payload: { retellCallId: string }, { ctx }) => {
    try {
      // Refetch from the API — webhooks can be stale/partial; the API is truth.
      let call: any = await retellClient().call.retrieve(payload.retellCallId);

      // Transcript sometimes lags the call_ended event by a few seconds.
      for (let i = 0; i < 2 && !call.transcript && call.call_status === "ended"; i++) {
        await wait.for({ seconds: 10 });
        call = await retellClient().call.retrieve(payload.retellCallId);
      }

      const toNumber: string = call.to_number ?? "";
      const fromNumber: string = call.from_number ?? "";
      const client = await clientByTwilioNumber(toNumber);
      if (!client) throw new Error(`No client for number ${toNumber} (call ${payload.retellCallId})`);

      const startedAt = call.start_timestamp ? new Date(call.start_timestamp) : new Date();
      const endedAt = call.end_timestamp ? new Date(call.end_timestamp) : null;
      const durationSeconds = endedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000) : 0;
      // After-hours judged at call START, honoring the fake_now test override.
      const afterHours = !isOpenAt(client.hours, client.timezone, client.fake_now ? clientNow(client) : startedAt);

      const transcript: string = call.transcript ?? "";
      const disconnect: string = call.disconnection_reason ?? "";
      const missed = durationSeconds < MISSED_CALL_MAX_SECONDS || disconnect.startsWith("dial_") || disconnect === "error";
      const transferConnected = disconnect === "call_transfer";

      // Extraction only when there's something to extract.
      let extraction: CallExtraction | null = null;
      let openaiCents = 0;
      if (transcript.trim().length > 20) {
        const result = await extractFromTranscript({ client, transcript, fromNumber });
        extraction = result.extraction;
        openaiCents = result.costCents;
      }

      // Emergency = extraction says so, or the agent escalated mid-call (event exists).
      const { data: escalationEvents } = await db()
        .from("events")
        .select("id")
        .eq("client_id", client.id)
        .eq("type", "emergency_escalation")
        .contains("payload", { retell_call_id: payload.retellCallId });
      const isEmergency = extraction?.urgency === "emergency" || (escalationEvents?.length ?? 0) > 0;

      // Costs. Retell reports combined cost in cents; Twilio trunk minutes are
      // estimated (~1¢/min inbound) — close enough for trending, noted in reports.
      const retellCents = Math.ceil(call.call_cost?.combined_cost ?? 0);
      const twilioCents = Math.ceil(durationSeconds / 60);

      const { data: callRow, error: upsertErr } = await db()
        .from("calls")
        .upsert(
          {
            client_id: client.id,
            retell_call_id: payload.retellCallId,
            from_number: fromNumber,
            to_number: toNumber,
            direction: "inbound",
            started_at: startedAt.toISOString(),
            ended_at: endedAt?.toISOString() ?? null,
            duration_seconds: durationSeconds,
            status: missed ? "missed" : "completed",
            disconnect_reason: disconnect,
            is_after_hours: afterHours,
            is_emergency: isEmergency,
            transfer_status: transferConnected ? "connected" : (escalationEvents?.length ?? 0) > 0 ? "failed" : null,
            transcript,
            recording_url: client.recording_enabled ? (call.recording_url ?? null) : null,
            extracted: extraction,
            sentiment: extraction?.sentiment ?? null,
            summary: extraction?.summary ?? null,
            retell_cost_cents: retellCents,
            twilio_cost_cents: twilioCents,
            openai_cost_cents: openaiCents,
            total_cost_cents: retellCents + twilioCents + openaiCents,
          },
          { onConflict: "retell_call_id" }
        )
        .select("id")
        .single();
      if (upsertErr) throw new Error(`calls upsert: ${upsertErr.message}`);
      const callId = callRow.id as string;

      if (transferConnected) {
        await logEvent({ client_id: client.id, type: "transfer_connected", call_id: callId, payload: { to: client.on_call_number } });
      }
      if (isEmergency) {
        // Distinct event type — emergencies are the case-study gold.
        await logEvent({ client_id: client.id, type: "emergency", call_id: callId, payload: { summary: extraction?.summary } });
      }

      // Layer 3: caller bailed before the agent could help → text back within seconds.
      if (missed && client.features.layer3 !== false && fromNumber.startsWith("+")) {
        await tasks.trigger<typeof missedCallTextback>(
          "missed-call-textback",
          { clientId: client.id, callerNumber: fromNumber, reason: "short_call", callSid: payload.retellCallId, callId },
          { idempotencyKey: `textback:${payload.retellCallId}` }
        );
      }

      // Was a booking made during this call? (voice function logs booking_created with the retell call id)
      const { data: bookedEvents } = await db()
        .from("events")
        .select("id")
        .eq("client_id", client.id)
        .eq("type", "booking_created")
        .contains("payload", { retell_call_id: payload.retellCallId });
      const booked = (bookedEvents?.length ?? 0) > 0 || extraction?.booked === true;

      // Unfulfilled booking intent → day 1/3/7 follow-up sequence.
      if (!missed && !booked && extraction?.wants_booking && client.features.follow_ups !== false) {
        await tasks.trigger<typeof followUpSequence>(
          "follow-up-sequence",
          { clientId: client.id, customerNumber: fromNumber, callId },
          { idempotencyKey: `follow-up:${payload.retellCallId}` }
        );
      }

      // Owner notification policy: emergencies + after-hours in real time;
      // daytime routine calls batch into the 6pm digest (digest_sent=false marks them).
      // Rerun guard: the trigger idempotency key has a 1h TTL (call_analyzed can
      // lag call_ended past it) — DB upserts tolerate a second run, an SMS doesn't.
      const { data: alreadyAlerted } = await db()
        .from("events")
        .select("id")
        .eq("type", "owner_alert")
        .eq("call_id", callId)
        .limit(1);
      if (!missed && (isEmergency || afterHours) && (alreadyAlerted?.length ?? 0) === 0) {
        const lines = [
          isEmergency ? `🚨 EMERGENCY call` : `🌙 After-hours call`,
          `${extraction?.caller_name ?? "Unknown caller"} — ${fromNumber}`,
          extraction?.summary ?? "(no transcript)",
          extraction?.address ? `Addr: ${extraction.address}` : null,
          booked ? "✅ Booked during call" : extraction?.wants_booking ? "Wants appointment — follow-up started" : null,
          transferConnected ? "Transfer connected" : null,
        ].filter(Boolean);
        await alertOwner({
          client,
          body: lines.join("\n"),
          eventType: "owner_alert",
          callId,
        });
        await db().from("calls").update({ digest_sent: true }).eq("id", callId); // already reported in real time
      }

      return { callId, missed, isEmergency, afterHours, booked };
    } catch (error) {
      // Alert only on the final attempt — retries handle blips silently.
      await reportError({
        source: "task:post-call",
        error,
        detail: { retellCallId: payload.retellCallId },
        alert: ctx.attempt.number >= 3,
      });
      throw error;
    }
  },
});
