import { task } from "@trigger.dev/sdk";
import { reportError } from "../lib/errors.js";
import { clientById, db, logEvent } from "../lib/supabase.js";
import { sendCustomerSms } from "../lib/twilio.js";

/**
 * Layer 3: the missed-call text-back. Fires from post-call (short/failed
 * calls) and from the trunk Disaster Recovery route (voice path down).
 * Opens/reuses the SMS thread so the reply lands in the agent loop.
 */
export const missedCallTextback = task({
  id: "missed-call-textback",
  run: async (
    payload: {
      clientId: string;
      callerNumber: string;
      reason: "short_call" | "voice_path_down";
      callSid: string; // retell call id or twilio call sid — used for logging only
      callId?: string;
    },
    { ctx }
  ) => {
    try {
      const client = await clientById(payload.clientId);
      if (client.status !== "active" || client.features.layer3 === false) return { skipped: "disabled" };
      if (!client.twilio_number) throw new Error(`Client ${client.slug} has no twilio_number`);

      // One active thread per customer per tenant; reuse if it exists.
      const { data: existing } = await db()
        .from("sms_threads")
        .select("id")
        .eq("client_id", client.id)
        .eq("customer_number", payload.callerNumber)
        .in("status", ["active", "escalated"])
        .maybeSingle();

      let threadId = existing?.id as string | undefined;
      if (!threadId) {
        const { data: thread, error } = await db()
          .from("sms_threads")
          .insert({
            client_id: client.id,
            customer_number: payload.callerNumber,
            context: { origin: payload.reason },
            origin_call_id: payload.callId ?? null,
          })
          .select("id")
          .single();
        if (error) throw new Error(`thread insert: ${error.message}`);
        threadId = thread.id as string;
      }

      const body = `Sorry we missed you — this is ${client.business_name}. What do you need? Text back and we'll get you taken care of.`;
      const sent = await sendCustomerSms({
        clientId: client.id,
        from: client.twilio_number,
        to: payload.callerNumber,
        body,
        eventType: "missed_call_textback",
        callId: payload.callId,
        threadId,
      });
      if ("skipped" in sent) return { skipped: "opted_out" };

      await db().from("sms_messages").insert({
        thread_id: threadId,
        direction: "outbound",
        body,
        twilio_message_sid: sent.sid,
        meta: { kind: "textback", reason: payload.reason },
      });
      await logEvent({
        client_id: client.id,
        type: payload.reason === "voice_path_down" ? "textback_voice_path_down" : "textback_sent",
        thread_id: threadId,
        call_id: payload.callId,
        payload: { to: payload.callerNumber, callSid: payload.callSid },
      });
      return { threadId };
    } catch (error) {
      await reportError({
        source: "task:missed-call-textback",
        error,
        clientId: payload.clientId,
        detail: { caller: payload.callerNumber, reason: payload.reason },
        alert: ctx.attempt.number >= 3,
      });
      throw error;
    }
  },
});
