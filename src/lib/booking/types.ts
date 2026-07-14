// Booking is behind this interface so ServiceTitan / Housecall Pro / raw
// Google Calendar adapters can be added later without touching voice/SMS flow.
// clients.booking_method selects the adapter.

export interface Slot {
  startIso: string; // UTC ISO
  label: string; // caller-friendly, in the client's timezone: "Thursday at 9:00 AM"
}

export interface BookingResult {
  ok: boolean;
  providerBookingUid?: string;
  startIso?: string;
  error?: string;
}

export interface BookingAdapter {
  /** Next available slots inside the window, capped at `limit`. */
  getSlots(input: { fromIso: string; toIso: string; timezone: string; limit: number }): Promise<Slot[]>;
  book(input: {
    startIso: string;
    name: string;
    phone: string;
    timezone: string;
    address?: string; // service address — shown as the event's actual "Where", not just in notes
    notes?: string;
  }): Promise<BookingResult>;
}
