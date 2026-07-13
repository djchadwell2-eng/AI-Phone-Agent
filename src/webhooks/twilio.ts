import { Hono } from "hono";
import twilio from "twilio";
import { tasks } from "@trigger.dev/sdk";
import type { missedCallTextback } from "../trigger/missed-call-textback.js";
import type { smsTurn } from "../trigger/sms-turn.js";
import { requireEnv } from "../lib/env.js";
import { reportError } from "../lib/errors.js";
import { claimReceipt } from "../lib/idempotency.js";
import { clientByTwilioNumber, db, logEvent } from "../lib/supabase.js";
import { matchOptKeyword, recordOptOut } from "../lib/twilio.js";

export const twilioRoutes = new Hono();

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

/**
 * Parse + authenticate a Twilio webhook. Twilio signs the EXACT public URL
 * plus the form params with our auth token; we reconstruct the URL from
 * PUBLIC_BASE_URL because behind Railway's proxy the local URL differs.
 */
async function readTwilioRequest(c: any): Promise<Record<string, string> | null> {
  const raw = await c.req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const local = new URL(c.req.url);
  const publicUrl = `${requireEnv("PUBLIC_BASE_URL")}${local.pathname}${local.search}`;
  const signature = c.req.header("x-twilio-signature") ?? "";
  const valid = twilio.validateRequest(requireEnv("TWILIO_AUTH_TOKEN"), signature, publicUrl, params);
  return valid ? params : null;
}

// ── Inbound SMS: opt-outs inline, everything else to the SMS agent task ─────
twilioRoutes.post("/sms", async (c) => {
  const params = await readTwilioRequest(c);
  if (!params) return c.text("invalid signature", 403);

  const sid = params.MessageSid ?? params.SmsSid ?? "";
  if (!(await claimReceipt(`twilio-sms:${sid}`))) return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });

  const from = params.From ?? "";
  const to = params.To ?? "";
  const body = params.Body ?? "";

  const client = await clientByTwilioNumber(to);
  if (!client) {
    await logEvent({ type: "sms_unknown_number", payload: { from, to } });
    return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
  }

  // STOP/START: handled inline and globally, never routed to the LLM.
  // Twilio's built-in opt-out handling sends the carrier-mandated confirmation
  // and hard-blocks future sends at the API level; we mirror state in our DB so
  // every tenant and every code path honors it too.
  const keyword = matchOptKeyword(body);
  if (keyword === "stop") {
    await recordOptOut(from, body.trim().toLowerCase());
    await logEvent({ client_id: client.id, type: "opt_out", payload: { from } });
    return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
  }
  if (keyword === "start") {
    await db().from("opt_outs").delete().eq("phone_number", from);
    await logEvent({ client_id: client.id, type: "opt_in", payload: { from } });
    return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
  }

  try {
    await tasks.trigger<typeof smsTurn>(
      "sms-turn",
      { clientId: client.id, from, to, body, messageSid: sid },
      { idempotencyKey: `sms-turn:${sid}` }
    );
  } catch (e) {
    await reportError({ source: "webhook:twilio-sms", error: e, clientId: client.id, detail: { from, sid } });
    // Release the receipt so Twilio's retry gets processed instead of dropped.
    await db().from("webhook_receipts").delete().eq("id", `twilio-sms:${sid}`);
    return c.text("trigger failed", 500);
  }
  // Conversational reply is sent by the task via REST (1-3s later) — return empty TwiML now.
  return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
});

/**
 * Elastic-trunk Disaster Recovery URL. Twilio requests TwiML here only when it
 * could NOT deliver the call to Retell — i.e. the voice path itself is down.
 * The failure mode must itself capture the lead: tell the caller we'll text,
 * fire the Layer 3 text-back, and page MY_CELL.
 */
twilioRoutes.post("/voice-dr", async (c) => {
  const params = await readTwilioRequest(c);
  if (!params) return c.text("invalid signature", 403);

  const callSid = params.CallSid ?? "";
  const from = params.From ?? "";
  const to = params.To ?? "";

  if (await claimReceipt(`twilio-dr:${callSid}`)) {
    const client = await clientByTwilioNumber(to);
    await reportError({
      source: "voice-path-down",
      error: new Error(`Trunk DR fired for ${to} — Retell unreachable`),
      clientId: client?.id,
      detail: { callSid, from },
    });
    if (client) {
      await logEvent({ client_id: client.id, type: "voice_path_failure", payload: { callSid, from } });
      await tasks
        .trigger<typeof missedCallTextback>(
          "missed-call-textback",
          { clientId: client.id, callerNumber: from, reason: "voice_path_down", callSid },
          { idempotencyKey: `textback:${callSid}` }
        )
        .catch((e) => reportError({ source: "webhook:voice-dr-trigger", error: e, clientId: client.id }));
    }
  }
  const say = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we're having trouble connecting your call. We're sending you a text message right now so we can help.</Say></Response>`;
  return c.body(say, 200, { "Content-Type": "text/xml" });
});
