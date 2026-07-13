import twilio from "twilio";
import { requireEnv } from "./env.js";
import { db, isOptedOut, logEvent } from "./supabase.js";

let cached: ReturnType<typeof twilio> | null = null;

export function twilioClient() {
  if (!cached) cached = twilio(requireEnv("TWILIO_ACCOUNT_SID"), requireEnv("TWILIO_AUTH_TOKEN"));
  return cached;
}

/**
 * Customer-facing SMS. Enforces the GLOBAL opt-out list — this is the single
 * choke point, so no code path can text an opted-out number. Logs to events.
 */
export async function sendCustomerSms(input: {
  clientId: string;
  from: string;
  to: string;
  body: string;
  eventType: string;
  callId?: string | null;
  threadId?: string | null;
}): Promise<{ sid: string } | { skipped: "opted_out" }> {
  if (await isOptedOut(input.to)) {
    await logEvent({
      client_id: input.clientId,
      type: "send_suppressed_opt_out",
      call_id: input.callId,
      thread_id: input.threadId,
      payload: { to: input.to, intended: input.eventType },
    });
    return { skipped: "opted_out" };
  }
  const msg = await twilioClient().messages.create({ from: input.from, to: input.to, body: input.body });
  await logEvent({
    client_id: input.clientId,
    type: input.eventType,
    call_id: input.callId,
    thread_id: input.threadId,
    payload: { to: input.to, sid: msg.sid, body: input.body },
  });
  return { sid: msg.sid };
}

/**
 * Internal SMS (owner alerts, system alerts to MY_CELL). Not subject to
 * customer opt-outs — these recipients are the business, not consumers.
 */
export async function sendInternalSms(input: {
  clientId?: string | null;
  from: string;
  to: string;
  body: string;
  eventType: string;
  callId?: string | null;
  threadId?: string | null;
}): Promise<string> {
  const msg = await twilioClient().messages.create({ from: input.from, to: input.to, body: input.body });
  await logEvent({
    client_id: input.clientId,
    type: input.eventType,
    call_id: input.callId,
    thread_id: input.threadId,
    payload: { to: input.to, sid: msg.sid, body: input.body },
  });
  return msg.sid;
}

/** Outbound voice call that speaks a message (emergency escalation to on-call). */
export async function placeAnnouncementCall(input: {
  from: string;
  to: string;
  message: string;
}): Promise<string> {
  const say = input.message.replace(/[<>&]/g, " "); // keep TwiML valid
  const call = await twilioClient().calls.create({
    from: input.from,
    to: input.to,
    // Repeat twice — announcement calls get answered mid-sentence.
    twiml: `<Response><Pause length="1"/><Say voice="Polly.Matthew">${say}</Say><Pause length="1"/><Say voice="Polly.Matthew">Repeating. ${say}</Say></Response>`,
  });
  return call.sid;
}

/** Record a global opt-out and close any active threads for that number, across all tenants. */
export async function recordOptOut(phoneNumber: string, keyword: string): Promise<void> {
  const { error } = await db()
    .from("opt_outs")
    .upsert({ phone_number: phoneNumber, source: "sms", last_keyword: keyword, opted_out_at: new Date().toISOString() });
  if (error) throw new Error(`recordOptOut: ${error.message}`);
  await db()
    .from("sms_threads")
    .update({ status: "opted_out" })
    .eq("customer_number", phoneNumber)
    .in("status", ["active", "escalated"]);
  await db()
    .from("follow_up_sequences")
    .update({ status: "cancelled" })
    .eq("customer_number", phoneNumber)
    .eq("status", "active");
}

export const STOP_KEYWORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];
export const START_KEYWORDS = ["start", "unstop", "yes"];

export function matchOptKeyword(body: string): "stop" | "start" | null {
  const normalized = body.trim().toLowerCase();
  if (STOP_KEYWORDS.includes(normalized)) return "stop";
  if (START_KEYWORDS.includes(normalized)) return "start";
  return null;
}
