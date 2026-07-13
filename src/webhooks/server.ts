import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "../lib/env.js";
import { db } from "../lib/supabase.js";
import { calcomRoutes } from "./calcom.js";
import { retellFunctionRoutes } from "./retell-functions.js";
import { retellRoutes } from "./retell.js";
import { twilioRoutes } from "./twilio.js";

/**
 * The thin always-on layer. Its only jobs: validate webhook authenticity,
 * claim idempotency, hand off to Trigger.dev, answer fast. All real work —
 * LLM calls, SMS sends, waits — lives in src/trigger/. The one latency-real
 * exception is /webhooks/retell/functions/* (mid-call booking), which calls
 * Cal.com directly with a tight timeout.
 */
const app = new Hono();

app.get("/health", async (c) => {
  // Used by the daily health-check task and Railway's healthcheck.
  try {
    const { error } = await db().from("clients").select("id").limit(1);
    if (error) throw new Error(error.message);
    return c.json({ ok: true, db: "up" });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 503);
  }
});

app.route("/webhooks/twilio", twilioRoutes);
app.route("/webhooks/retell", retellRoutes);
app.route("/webhooks/retell/functions", retellFunctionRoutes);
app.route("/webhooks/calcom", calcomRoutes);

app.onError((err, c) => {
  console.error(`unhandled ${c.req.method} ${c.req.path}:`, err);
  // 500 → provider retries; combined with claimReceipt that's safe.
  return c.json({ error: "internal" }, 500);
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`webhook service listening on :${info.port}`);
});

export default app;
