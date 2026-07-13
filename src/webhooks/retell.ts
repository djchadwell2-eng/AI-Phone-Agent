import { Hono } from "hono";
import { tasks } from "@trigger.dev/sdk";
import type { postCall } from "../trigger/post-call.js";
import { env, requireEnv } from "../lib/env.js";
import { buildDynamicVariables } from "../lib/dynamic-vars.js";
import { reportError } from "../lib/errors.js";
import { claimReceipt } from "../lib/idempotency.js";
import { verifyRetellSignature } from "../lib/retell.js";
import { clientByTwilioNumber, logEvent } from "../lib/supabase.js";

export const retellRoutes = new Hono();

/**
 * Retell call-lifecycle events (call_started / call_ended / call_analyzed).
 * We trigger post-call on BOTH call_ended and call_analyzed with the same
 * idempotency key: whichever lands first wins, so a dropped webhook of one
 * type doesn't lose the call. The task refetches the call from Retell's API
 * anyway, so payload staleness doesn't matter.
 */
retellRoutes.post("/", async (c) => {
  const raw = await c.req.text();
  if (!verifyRetellSignature(raw, c.req.header("x-retell-signature"))) {
    return c.text("invalid signature", 403);
  }
  const body = JSON.parse(raw) as { event: string; call?: { call_id: string; from_number?: string; to_number?: string } };
  const call = body.call;
  if (!call?.call_id) return c.json({ ok: true });

  if (!(await claimReceipt(`retell:${body.event}:${call.call_id}`))) return c.json({ ok: true });

  if (body.event === "call_ended" || body.event === "call_analyzed") {
    try {
      await tasks.trigger<typeof postCall>(
        "post-call",
        { retellCallId: call.call_id },
        // call_analyzed can arrive minutes after call_ended; 1h TTL dedupes them.
        { idempotencyKey: `post-call:${call.call_id}`, idempotencyKeyTTL: "1h" }
      );
    } catch (e) {
      const client = call.to_number ? await clientByTwilioNumber(call.to_number).catch(() => null) : null;
      await reportError({ source: "webhook:retell", error: e, clientId: client?.id, detail: { callId: call.call_id } });
      return c.text("trigger failed", 500);
    }
  }
  return c.json({ ok: true });
});

/**
 * Inbound-call webhook — Layer 2's config injection. Retell calls this when a
 * call hits the number and substitutes the returned dynamic_variables into the
 * agent prompt. Must answer inside Retell's 10s budget: one DB read, no LLM.
 * If we're down, Retell retries then falls back to the agent's
 * default_dynamic_variables (set by scripts/create-retell-agent.ts), so the
 * call still gets answered — just with generic config.
 */
retellRoutes.post("/inbound", async (c) => {
  // Signature when present, plus URL token (belt and suspenders — this endpoint
  // decides what the agent says, so it must not be spoofable).
  if (c.req.query("token") !== requireEnv("INTERNAL_WEBHOOK_TOKEN")) return c.text("forbidden", 403);
  const raw = await c.req.text();
  const sig = c.req.header("x-retell-signature");
  if (sig && !verifyRetellSignature(raw, sig)) return c.text("invalid signature", 403);

  const body = JSON.parse(raw) as {
    event: string;
    call_inbound?: { from_number?: string; to_number?: string; agent_id?: string };
  };
  const to = body.call_inbound?.to_number ?? "";
  const client = await clientByTwilioNumber(to);
  if (!client) {
    // Unknown number: let the default agent handle it rather than dropping the call.
    await logEvent({ type: "inbound_unknown_number", payload: { to } });
    return c.json({ call_inbound: {} });
  }

  const vars = buildDynamicVariables(client);
  await logEvent({
    client_id: client.id,
    type: "inbound_call_config_injected",
    payload: { from: body.call_inbound?.from_number, mode: vars.mode },
  });
  return c.json({
    call_inbound: {
      dynamic_variables: vars,
      metadata: { client_id: client.id, client_slug: client.slug },
    },
  });
});

// Quick sanity endpoint for the health-check task: proves env + routing works.
retellRoutes.get("/ping", (c) => c.json({ ok: true, base: env.PUBLIC_BASE_URL ?? null }));
