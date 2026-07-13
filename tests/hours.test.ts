import { describe, expect, it } from "vitest";
import { hoursText, isOpenAt } from "../src/lib/hours.js";
import type { HoursConfig } from "../src/lib/types.js";

// The day/night switch drives Layer 2's entire behavior — worth pinning down,
// especially DST edges and the fake-clock path used in phase tests.

const summit: HoursConfig = {
  mon: { open: "08:00", close: "17:00" },
  tue: { open: "08:00", close: "17:00" },
  wed: { open: "08:00", close: "17:00" },
  thu: { open: "08:00", close: "17:00" },
  fri: { open: "08:00", close: "17:00" },
  sat: null,
  sun: null,
};
const TZ = "America/New_York";

// helper: a UTC instant for a given Eastern wall-clock time
const eastern = (iso: string) => new Date(iso);

describe("isOpenAt", () => {
  it("open mid-morning on a weekday", () => {
    // Thu 2026-07-09 10:00 EDT = 14:00 UTC
    expect(isOpenAt(summit, TZ, eastern("2026-07-09T14:00:00Z"))).toBe(true);
  });
  it("closed in the evening", () => {
    // Thu 19:30 EDT
    expect(isOpenAt(summit, TZ, eastern("2026-07-09T23:30:00Z"))).toBe(false);
  });
  it("closed on weekends (null day)", () => {
    // Sat noon EDT
    expect(isOpenAt(summit, TZ, eastern("2026-07-11T16:00:00Z"))).toBe(false);
  });
  it("boundary: opens exactly at 08:00, closes exactly at 17:00", () => {
    expect(isOpenAt(summit, TZ, eastern("2026-07-09T12:00:00Z"))).toBe(true); // 08:00 EDT
    expect(isOpenAt(summit, TZ, eastern("2026-07-09T21:00:00Z"))).toBe(false); // 17:00 EDT — close is exclusive
  });
  it("handles EST (winter) offset correctly", () => {
    // Thu 2026-01-08 10:00 EST = 15:00 UTC
    expect(isOpenAt(summit, TZ, eastern("2026-01-08T15:00:00Z"))).toBe(true);
    // 14:00 UTC would be 09:00 EST — still open; 12:30 UTC = 07:30 EST — closed
    expect(isOpenAt(summit, TZ, eastern("2026-01-08T12:30:00Z"))).toBe(false);
  });
  it("throws on a bad timezone instead of silently defaulting", () => {
    expect(() => isOpenAt(summit, "Not/AZone", new Date())).toThrow();
  });
});

describe("hoursText", () => {
  it("renders human-readable hours", () => {
    const text = hoursText(summit, TZ);
    expect(text).toContain("Mon 8:00 AM-5:00 PM");
    expect(text).not.toContain("Sat");
  });
  it("empty config → by appointment", () => {
    expect(hoursText({}, TZ)).toBe("by appointment");
  });
});
