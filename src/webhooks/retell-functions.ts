import { Hono } from "hono";
import { DateTime } from "luxon";
import { tasks } from "@trigger.dev/sdk";
import type { emergencyEscalation } from "../trigger/emergency-escalation.js";
import { bookingAdapterFor } from "../lib/booking/index.js";
import { requireEnv } from "../lib/env.js";
import { reportError } from "../lib/errors.js";
import { clientByTwilioNumber, db, logEvent } from "../lib/supabase.js";
import type { ClientRow } from "../lib/types.js";

/**
 * Custom tools the voice agent calls MID-CALL (Retell → us). These are the one
 * place our code sits near the live voice path, so every handler:
 *   - resolves fast (Cal.com fetch has an 8s abort),
 *   - NEVER throws to Retell — always returns a JSON the agent can speak from,
 *   - degrades to "collect preferred windows" language on any failure.
 */
export const retellFunctionRoutes = new Hono();

retellFunctionRoutes.use("*", async (c, next) => {
  if (c.req.query("token") !== requireEnv("INTERNAL_WEBHOOK_TOKEN")) return c.text("forbidden", 403);
  await next();
});

interface FnBody {
  call?: { call_id?: string; from_number?: string; to_number?: string };
  name?: string;
  args?: Record<string, any>;
}

/**
 * Prefer the caller-ID over whatever the LLM passed as `phone` unless the LLM's
 * value looks like a full number. Observed live: the agent sent phone="+1"
 * (truthy!) which beat the real from_number in a plain `||` fallback.
 */
function bestPhone(argsPhone: unknown, fromNumber: string | undefined): string {
  const candidate = String(argsPhone ?? "").replace(/[^\d+]/g, "");
  if (candidate.replace(/\D/g, "").length >= 10) return candidate;
  return fromNumber ?? "";
}

async function resolveClient(body: FnBody): Promise<ClientRow | null> {
  const to = body.call?.to_number;
  return to ? clientByTwilioNumber(to) : null;
}

// check_availability — agent asks for slots to offer. Returns 3 concrete options.
retellFunctionRoutes.post("/check_availability", async (c) => {
  const body = (await c.req.json()) as FnBody;
  try {
    const client = await resolveClient(body);
    if (!client) return c.json({ result: "Booking system unavailable. Collect preferred days and times instead." });
    const now = DateTime.now().setZone(client.timezone);
    const slots = await bookingAdapterFor(client).getSlots({
      fromIso: now.plus({ hours: 2 }).toUTC().toISO()!,
      toIso: now.plus({ days: 7 }).toUTC().toISO()!,
      timezone: client.timezone,
      limit: 3,
    });
    if (slots.length === 0) {
      return c.json({ result: "No open slots in the next week. Collect preferred days and times for a callback." });
    }
    return c.json({
      result: `Available slots: ${slots.map((s) => s.label).join("; ")}. Offer these to the caller. When they pick one, call book_appointment with its slot_iso.`,
      slots: slots.map((s) => ({ label: s.label, slot_iso: s.startIso })),
    });
  } catch (e) {
    await reportError({ source: "fn:check_availability", error: e, detail: { call: body.call } });
    return c.json({ result: "Booking system unavailable right now. Collect preferred days and times; the team will confirm by text." });
  }
});

// book_appointment — the demo money shot: books Cal.com live during the call.
retellFunctionRoutes.post("/book_appointment", async (c) => {
  const body = (await c.req.json()) as FnBody;
  const args = body.args ?? {};
  try {
    const client = await resolveClient(body);
    if (!client) return c.json({ result: "Booking failed. Collect preferred days and times instead." });
    const phone = bestPhone(args.phone, body.call?.from_number);
    const address = String(args.address ?? "");
    const issue = String(args.issue ?? "");
    // Address goes first and labeled — this is the line the tech actually needs
    // to see glancing at the calendar event, not buried after the issue text.
    const notes = [address ? `Service address: ${address}` : null, issue].filter(Boolean).join("\n");
    const result = await bookingAdapterFor(client).book({
      startIso: String(args.slot_iso ?? ""),
      name: String(args.name ?? "Caller"),
      phone,
      timezone: client.timezone,
      address,
      notes,
    });

    // Find the calls row if post-call already made one (usually not yet — call is live).
    const retellCallId = body.call?.call_id ?? null;
    const { data: bookingRow } = await db()
      .from("bookings")
      .insert({
        client_id: client.id,
        status: result.ok ? "booked" : "needs_scheduling",
        provider: client.booking_method,
        provider_booking_uid: result.providerBookingUid ?? null,
        start_at: result.ok ? result.startIso : null,
        customer_name: String(args.name ?? ""),
        customer_phone: phone,
        address,
        issue,
        preferred_windows: result.ok ? null : String(args.preferred_windows ?? ""),
      })
      .select("id")
      .single();
    await logEvent({
      client_id: client.id,
      type: result.ok ? "booking_created" : "booking_degraded",
      payload: { via: "voice", retell_call_id: retellCallId, booking_id: bookingRow?.id, error: result.error },
    });

    if (!result.ok) {
      return c.json({
        result:
          "The booking system had a problem, so nothing is confirmed yet. Apologize, collect their preferred days and times, and promise the team will confirm the exact time by text shortly.",
      });
    }
    const local = DateTime.fromISO(result.startIso!, { zone: client.timezone }).toFormat("cccc, LLLL d 'at' h:mm a");
    return c.json({ result: `Booked successfully for ${local}. Confirm this time back to the caller.` });
  } catch (e) {
    await reportError({ source: "fn:book_appointment", error: e, detail: { call: body.call, args } });
    return c.json({
      result: "The booking system had a problem, so nothing is confirmed. Collect preferred days and times; the team will confirm by text.",
    });
  }
});

// request_callback — degraded-booking path and general "take a message" record.
retellFunctionRoutes.post("/request_callback", async (c) => {
  const body = (await c.req.json()) as FnBody;
  const args = body.args ?? {};
  try {
    const client = await resolveClient(body);
    if (!client) return c.json({ result: "Noted." });
    await db().from("bookings").insert({
      client_id: client.id,
      status: "needs_scheduling",
      provider: client.booking_method,
      customer_name: String(args.name ?? ""),
      customer_phone: bestPhone(args.phone, body.call?.from_number),
      address: String(args.address ?? ""),
      issue: String(args.issue ?? ""),
      preferred_windows: String(args.preferred_windows ?? ""),
    });
    await logEvent({ client_id: client.id, type: "callback_requested", payload: { retell_call_id: body.call?.call_id, args } });
    return c.json({ result: "Callback request saved. Tell the caller the team will text shortly to confirm a time." });
  } catch (e) {
    await reportError({ source: "fn:request_callback", error: e, detail: { call: body.call } });
    return c.json({ result: "Noted — tell the caller the team will follow up shortly." });
  }
});

/**
 * escalate_emergency — the agent calls this the moment a warm transfer fails
 * (or the on-call line is unreachable). Fires the Layer 4 escalation task
 * (SMS + voice page to on-call) WHILE the caller is still on the line, so the
 * promise "someone is being notified right now" is literally true.
 */
retellFunctionRoutes.post("/escalate_emergency", async (c) => {
  const body = (await c.req.json()) as FnBody;
  const args = body.args ?? {};
  try {
    const client = await resolveClient(body);
    if (!client) return c.json({ result: "Escalation noted." });
    await tasks.trigger<typeof emergencyEscalation>(
      "emergency-escalation",
      {
        clientId: client.id,
        retellCallId: body.call?.call_id ?? null,
        callerNumber: bestPhone(args.phone, body.call?.from_number),
        callerName: String(args.name ?? "unknown"),
        issue: String(args.issue ?? "emergency reported on a call"),
        address: String(args.address ?? ""),
      },
      { idempotencyKey: `emergency:${body.call?.call_id ?? crypto.randomUUID()}` }
    );
    return c.json({ result: "On-call tech is being paged by text and phone right now. Reassure the caller and promise a callback within minutes." });
  } catch (e) {
    await reportError({ source: "fn:escalate_emergency", error: e, detail: { call: body.call, args } });
    return c.json({ result: "Tell the caller the on-call tech is being notified and will call back shortly." });
  }
});
