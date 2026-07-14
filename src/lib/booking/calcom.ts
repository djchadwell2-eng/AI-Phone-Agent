import { DateTime } from "luxon";
import { env } from "../env.js";
import type { ClientRow } from "../types.js";
import type { BookingAdapter, BookingResult, Slot } from "./types.js";

const BASE = "https://api.cal.com/v2";
// Cal.com versions endpoints via this header. Values verified against
// cal.com/docs/api-reference/v2 (July 2026). If a call starts 400-ing after a
// Cal.com change, these constants are the first thing to check.
const VERSION_SLOTS = "2024-09-04";
const VERSION_BOOKINGS = "2026-02-25";

async function calFetch(apiKey: string, path: string, version: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "cal-api-version": version,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    // Booking runs mid-phone-call; fail fast so the agent can degrade gracefully.
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cal.com ${path} ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

export function calcomAdapter(client: ClientRow): BookingAdapter {
  const apiKey = client.calcom_api_key ?? env.CALCOM_API_KEY;
  const eventTypeId = client.calcom_event_type_id;

  return {
    async getSlots({ fromIso, toIso, timezone, limit }): Promise<Slot[]> {
      if (!apiKey || !eventTypeId) throw new Error(`Cal.com not configured for client ${client.slug}`);
      const params = new URLSearchParams({
        eventTypeId: String(eventTypeId),
        start: fromIso,
        end: toIso,
        timeZone: timezone,
      });
      const res = await calFetch(apiKey, `/slots?${params}`, VERSION_SLOTS);
      // Response: { data: { "2026-07-10": [{start: "..."}, ...], ... } }
      const slots: Slot[] = [];
      for (const day of Object.values<any>(res.data ?? {})) {
        for (const s of day as { start: string }[]) {
          const dt = DateTime.fromISO(s.start, { zone: timezone });
          slots.push({ startIso: dt.toUTC().toISO()!, label: dt.toFormat("cccc 'at' h:mm a") });
          if (slots.length >= limit) return slots;
        }
      }
      return slots;
    },

    async book({ startIso, name, phone, timezone, address, notes }): Promise<BookingResult> {
      if (!apiKey || !eventTypeId) return { ok: false, error: `Cal.com not configured for ${client.slug}` };
      // Callers don't give emails on the phone, and Cal.com rejects non-deliverable
      // domains (email_domain_cannot_receive_mail — synthetic placeholders fail).
      // Each client configures a real inbox that receives phone-booking
      // confirmations; the caller's own confirmation travels by SMS.
      if (!client.booking_email) return { ok: false, error: `booking_email not configured for ${client.slug}` };
      try {
        const res = await calFetch(apiKey, "/bookings", VERSION_BOOKINGS, {
          method: "POST",
          body: JSON.stringify({
            start: startIso,
            eventTypeId,
            attendee: {
              name,
              email: client.booking_email,
              timeZone: timezone,
              phoneNumber: phone,
            },
            // The event's actual "Where" field — separate from notes/metadata,
            // which Cal.com doesn't surface as the location. Only send this when
            // we have a real address; an empty string 400s ("min length 1").
            ...(address ? { location: { type: "attendeeAddress", address } } : {}),
            metadata: { source: "voice-agent", notes: (notes ?? "").slice(0, 500) },
          }),
        });
        return { ok: true, providerBookingUid: res.data?.uid, startIso: res.data?.start ?? startIso };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
