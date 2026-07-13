import { task } from "@trigger.dev/sdk";
import { reportError } from "../lib/errors.js";
import { clientById, db, logEvent } from "../lib/supabase.js";
import { placeAnnouncementCall, sendInternalSms } from "../lib/twilio.js";

/**
 * Layer 4 fallback: warm transfer failed (or agent judged the caller needed
 * immediate human help) → page the on-call number by SMS AND voice, right now,
 * while the caller may still be on the line. Triggered mid-call by the
 * escalate_emergency custom function.
 */
export const emergencyEscalation = task({
  id: "emergency-escalation",
  retry: { maxAttempts: 5 }, // this one page MUST land; retry harder than default
  run: async (
    payload: {
      clientId: string;
      retellCallId: string | null;
      callerNumber: string;
      callerName: string;
      issue: string;
      address: string;
    },
    { ctx }
  ) => {
    try {
      const client = await clientById(payload.clientId);
      const onCall = client.on_call_number;
      if (!onCall || !client.twilio_number) {
        throw new Error(`Client ${client.slug} missing on_call_number or twilio_number — cannot escalate`);
      }

      const summary = [
        `EMERGENCY — ${client.business_name}`,
        `Caller: ${payload.callerName} ${payload.callerNumber}`,
        payload.address ? `Address: ${payload.address}` : null,
        `Issue: ${payload.issue}`,
        `Call them back ASAP.`,
      ]
        .filter(Boolean)
        .join("\n");

      // Event first: post-call reads it to mark the call as emergency/transfer-failed
      // even if the SMS/voice page below needs retries.
      await logEvent({
        client_id: client.id,
        type: "emergency_escalation",
        payload: { retell_call_id: payload.retellCallId, caller: payload.callerNumber, issue: payload.issue },
      });

      // SMS and voice page in parallel; each failure alone shouldn't stop the other.
      const results = await Promise.allSettled([
        sendInternalSms({
          clientId: client.id,
          from: client.twilio_number,
          to: onCall,
          body: `🚨 ${summary}`,
          eventType: "emergency_page_sms",
        }),
        placeAnnouncementCall({
          from: client.twilio_number,
          to: onCall,
          message: `Emergency page from ${client.business_name} answering service. ${payload.issue}. Caller ${payload.callerName}. Number ${payload.callerNumber.split("").join(" ")}. ${payload.address ? `Address ${payload.address}.` : ""} Please call back immediately.`,
        }),
      ]);
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length === 2) {
        throw new Error(`Both SMS and voice page failed: ${failed.map((f: any) => f.reason?.message).join(" | ")}`);
      }
      return { paged: onCall, smsOk: results[0]!.status === "fulfilled", callOk: results[1]!.status === "fulfilled" };
    } catch (error) {
      await reportError({
        source: "task:emergency-escalation",
        error,
        clientId: payload.clientId,
        detail: { caller: payload.callerNumber, issue: payload.issue },
        alert: ctx.attempt.number >= 5, // final attempt alerts MY_CELL — a lost emergency page is a five-alarm bug
      });
      throw error;
    }
  },
});
