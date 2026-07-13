import { createHmac } from "node:crypto";
import { env, requireEnv } from "../src/lib/env.js";
import { db } from "../src/lib/supabase.js";

/**
 * Phase 1 acceptance: proves webhooks land, signatures validate, and rows write —
 * WITHOUT needing a phone number yet. Signs fake webhooks exactly the way the
 * providers do and posts them to the running webhook service.
 *
 *   Terminal A: npm run dev:webhooks
 *   Terminal B: npm run smoke              (target defaults to http://localhost:8080)
 *   npm run smoke -- --base https://your-app.up.railway.app   (after deploy)
 *
 * NOTE: Twilio signatures are computed against PUBLIC_BASE_URL, so PUBLIC_BASE_URL
 * in .env must match --base for the SMS test to pass (that's the point of the test).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Twilio's signing scheme: HMAC-SHA1(url + sorted-concatenated params, auth token), base64.
function twilioSign(url: string, params: Record<string, string>, authToken: string): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

async function main() {
  const base = arg("base") ?? `http://localhost:${env.PORT}`;
  const publicBase = requireEnv("PUBLIC_BASE_URL");
  const results: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, note = "") => {
    results.push([name, ok, note]);
    console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  // 1. Health (also proves DB connectivity through the service)
  try {
    const res = await fetch(`${base}/health`);
    const body: any = await res.json();
    check("GET /health", res.ok && body.ok === true, JSON.stringify(body));
  } catch (e) {
    check("GET /health", false, String(e));
  }

  // 2. Retell inbound webhook: token required, returns dynamic variables for client zero
  try {
    const { data: client } = await db().from("clients").select("twilio_number, slug").eq("slug", "summit-heating-air").single();
    const to = client?.twilio_number ?? "+15550000001"; // unknown number still returns 200 + empty override
    const res = await fetch(`${base}/webhooks/retell/inbound?token=${requireEnv("INTERNAL_WEBHOOK_TOKEN")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "call_inbound", call_inbound: { from_number: "+15550009999", to_number: to } }),
    });
    const body: any = await res.json();
    const gotVars = !!body?.call_inbound;
    check("POST /webhooks/retell/inbound", res.ok && gotVars, client?.twilio_number ? `mode=${body.call_inbound?.dynamic_variables?.mode}` : "no number yet (empty override ok)");

    const bad = await fetch(`${base}/webhooks/retell/inbound?token=wrong`, { method: "POST", body: "{}" });
    check("inbound rejects bad token", bad.status === 403);
  } catch (e) {
    check("POST /webhooks/retell/inbound", false, String(e));
  }

  // 3. Twilio SMS webhook: correct signature accepted, bad signature rejected.
  //    Uses a STOP message so the flow is fully exercised (opt_outs row) without
  //    needing Trigger.dev or a real client number.
  try {
    const url = `${publicBase}/webhooks/twilio/sms`;
    const params: Record<string, string> = {
      MessageSid: `SMSMOKE${Date.now()}`,
      From: "+15550009999",
      To: "+15550000001",
      Body: "STOP",
    };
    const sig = twilioSign(url, params, requireEnv("TWILIO_AUTH_TOKEN"));
    const res = await fetch(`${base}/webhooks/twilio/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    check("POST /webhooks/twilio/sms (signed)", res.status === 200);

    const bad = await fetch(`${base}/webhooks/twilio/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "bogus" },
      body: new URLSearchParams(params).toString(),
    });
    check("SMS rejects bad signature", bad.status === 403);

    // Row-write proof: the receipt was claimed.
    const { data } = await db().from("webhook_receipts").select("id").eq("id", `twilio-sms:${params.MessageSid}`).maybeSingle();
    check("webhook_receipts row written", !!data);
    // Clean up the fake opt-out so it never suppresses a real send.
    await db().from("opt_outs").delete().eq("phone_number", "+15550009999");
  } catch (e) {
    check("POST /webhooks/twilio/sms", false, String(e));
  }

  // 4. Client zero row exists
  const { data: c0 } = await db().from("clients").select("slug, status").eq("slug", "summit-heating-air").maybeSingle();
  check("client zero row exists", !!c0, c0 ? `status=${(c0 as any).status}` : "run supabase/seed.sql");

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nPHASE 1 SMOKE: ALL GREEN" : `\nPHASE 1 SMOKE: ${failed.length} FAILURE(S)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
