import { env } from "./env.js";
import { db } from "./supabase.js";
import { sendInternalSms } from "./twilio.js";

/**
 * Every failure branch funnels here: persist to `errors`, and (optionally) SMS
 * MY_CELL. Deliberately swallow-proof — an error reporter that throws turns
 * one incident into two.
 */
export async function reportError(input: {
  source: string;
  error: unknown;
  clientId?: string | null;
  detail?: Record<string, unknown>;
  alert?: boolean; // default true; pass false on retryable attempts to avoid alert spam
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const shouldAlert = input.alert !== false;
  try {
    await db().from("errors").insert({
      client_id: input.clientId ?? null,
      source: input.source,
      message: message.slice(0, 2000),
      detail: { ...input.detail, stack: input.error instanceof Error ? input.error.stack?.slice(0, 4000) : undefined },
      alerted: shouldAlert,
    });
  } catch (e) {
    console.error(`errors insert failed (${input.source}):`, e);
  }
  if (shouldAlert && env.MY_CELL) {
    try {
      // Alert from any active tenant number we can find; without one (pre-Phase-2) we just log.
      const { data } = await db().from("clients").select("twilio_number").not("twilio_number", "is", null).limit(1).maybeSingle();
      const from = (data as { twilio_number: string } | null)?.twilio_number;
      if (from) {
        await sendInternalSms({
          from,
          to: env.MY_CELL,
          body: `⚠️ [call-capture] ${input.source}: ${message.slice(0, 240)}`,
          eventType: "system_alert",
        });
      }
    } catch (e) {
      console.error(`alert SMS failed (${input.source}):`, e);
    }
  }
}
