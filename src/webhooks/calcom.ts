import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { env } from "../lib/env.js";
import { claimReceipt } from "../lib/idempotency.js";
import { db, logEvent } from "../lib/supabase.js";

/**
 * Cal.com webhooks confirm what actually landed on the calendar — bookings
 * made by the voice/SMS agents, plus reschedules/cancellations made by humans
 * in Cal.com itself. This keeps our bookings table honest for the metrics view.
 */
export const calcomRoutes = new Hono();

function verifyCalcomSignature(raw: string, header: string | undefined): boolean {
  const secret = env.CALCOM_WEBHOOK_SECRET;
  if (!secret) return true; // dev convenience; set the secret in prod (SETUP.md step 7)
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

calcomRoutes.post("/", async (c) => {
  const raw = await c.req.text();
  if (!verifyCalcomSignature(raw, c.req.header("x-cal-signature-256"))) return c.text("invalid signature", 403);

  const body = JSON.parse(raw) as { triggerEvent?: string; payload?: any };
  const event = body.triggerEvent ?? "";
  const p = body.payload ?? {};
  const uid: string | undefined = p.uid ?? p.bookingUid;
  if (!uid) return c.json({ ok: true });

  const receiptKey = `calcom:${event}:${uid}`;
  if (!(await claimReceipt(receiptKey))) return c.json({ ok: true });

  try {
    await handleCalcomEvent(event, p, uid);
  } catch (e) {
    // Release the receipt so Cal.com's retry gets processed instead of dropped.
    await db().from("webhook_receipts").delete().eq("id", receiptKey);
    throw e;
  }
  return c.json({ ok: true });
});

async function handleCalcomEvent(event: string, p: any, uid: string): Promise<void> {
  if (event === "BOOKING_CREATED") {
    // Voice bookings already inserted a row (with the uid) — confirm it. Rows
    // without a match are bookings made outside our flow; record those too.
    const { data: existing } = await db().from("bookings").select("id").eq("provider_booking_uid", uid).maybeSingle();
    if (existing) {
      await db().from("bookings").update({ status: "confirmed" }).eq("id", existing.id);
    } else {
      // No tenant mapping in the payload — resolve by event type id.
      const { data: client } = await db()
        .from("clients")
        .select("id")
        .eq("calcom_event_type_id", p.eventTypeId ?? -1)
        .maybeSingle();
      if (client) {
        await db().from("bookings").insert({
          client_id: (client as { id: string }).id,
          status: "confirmed",
          provider: "calcom",
          provider_booking_uid: uid,
          start_at: p.startTime ?? null,
          customer_name: p.attendees?.[0]?.name ?? null,
          customer_phone: p.attendees?.[0]?.phoneNumber ?? null,
        });
      }
    }
    await logEvent({ type: "calcom_booking_created", payload: { uid, eventTypeId: p.eventTypeId } });
  } else if (event === "BOOKING_CANCELLED") {
    await db().from("bookings").update({ status: "cancelled" }).eq("provider_booking_uid", uid);
    await logEvent({ type: "calcom_booking_cancelled", payload: { uid } });
  }
}
