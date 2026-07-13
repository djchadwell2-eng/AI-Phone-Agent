import type { ClientRow } from "../types.js";
import { calcomAdapter } from "./calcom.js";
import type { BookingAdapter } from "./types.js";

export type { BookingAdapter, BookingResult, Slot } from "./types.js";

export function bookingAdapterFor(client: ClientRow): BookingAdapter {
  switch (client.booking_method) {
    case "calcom":
      return calcomAdapter(client);
    // case "servicetitan": return serviceTitanAdapter(client);  // future — same interface
    default:
      throw new Error(`Unknown booking_method '${client.booking_method}' for client ${client.slug}`);
  }
}
