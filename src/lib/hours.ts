import { DateTime } from "luxon";
import type { ClientRow, HoursConfig } from "./types.js";

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/**
 * Is the business open at `instant`, per its configured hours + timezone?
 * Pure so it's unit-testable; callers pass client.fake_now (the Layer 2 test
 * hook) as `instant` when set.
 */
export function isOpenAt(hours: HoursConfig, timezone: string, instant: Date): boolean {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  if (!local.isValid) throw new Error(`Invalid timezone: ${timezone}`);
  const day = DAY_KEYS[local.weekday - 1]!; // luxon weekday: 1=Mon..7=Sun
  const window = hours[day];
  if (!window) return false;
  const [oh = 0, om = 0] = window.open.split(":").map(Number);
  const [ch = 0, cm = 0] = window.close.split(":").map(Number);
  const minutes = local.hour * 60 + local.minute;
  return minutes >= oh * 60 + om && minutes < ch * 60 + cm;
}

/** Effective "now" for a client — honors the fake_now testing override. */
export function clientNow(client: Pick<ClientRow, "fake_now">): Date {
  return client.fake_now ? new Date(client.fake_now) : new Date();
}

export function isClientOpen(client: Pick<ClientRow, "hours" | "timezone" | "fake_now">): boolean {
  return isOpenAt(client.hours, client.timezone, clientNow(client));
}

/** Human-readable hours line for prompts/SMS, e.g. "Mon-Fri 8:00 AM-5:00 PM". */
export function hoursText(hours: HoursConfig, timezone: string): string {
  const fmt = (t: string) => {
    const [h = 0, m = 0] = t.split(":").map(Number);
    return DateTime.fromObject({ hour: h, minute: m }, { zone: timezone }).toFormat("h:mm a");
  };
  const parts: string[] = [];
  for (const day of DAY_KEYS) {
    const w = hours[day];
    if (w) parts.push(`${day[0]!.toUpperCase()}${day.slice(1)} ${fmt(w.open)}-${fmt(w.close)}`);
  }
  return parts.length ? parts.join(", ") : "by appointment";
}

/** Local-time string the agent can say, e.g. "Thursday 7:42 PM". */
export function localTimeText(client: Pick<ClientRow, "timezone" | "fake_now">): string {
  return DateTime.fromJSDate(clientNow(client), { zone: client.timezone }).toFormat("cccc h:mm a");
}
