import { expect, it } from "vitest";
import {
  covers,
  effectiveAccess,
  effectiveCalculation,
  overlaps,
  parseEffectiveWindow,
  rangeOf,
  resolveAsOf,
  type AsOfInterval,
} from "./effective-dates";

const now = new Date("2026-11-01T12:00:00Z");
const zone = "Asia/Calcutta";

function window(start: string, end: string | null) {
  const parsed = parseEffectiveWindow({ start, end, timezone: zone, now });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.window;
}

it("accepts an explicit timezone and half-open interval", () => {
  const parsed = window("2026-12-01T09:00:00+05:30", "2026-12-01T17:00:00+05:30");
  expect(parsed.timezone).toBe(zone);
  expect(parsed.backdated).toBe(false);
  expect(parsed.state).toBe("scheduled");
  expect(parsed.end && parsed.start.getTime() < parsed.end.getTime()).toBe(true);
  expect(parseEffectiveWindow({ start: "2026-12-01T09:00:00Z", end: null, timezone: zone, now }).ok).toBe(false);
  expect(parseEffectiveWindow({ start: "2026-12-01T09:00:00+05:30", end: "2026-12-01T09:00:00+05:30", timezone: zone, now }).ok).toBe(false);
  expect(parseEffectiveWindow({ start: "2026-12-01T09:00:00", end: null, timezone: "IST", now }).ok).toBe(false);
  expect(parseEffectiveWindow({ start: "2026-12-01T09:00:00+05:30", end: null, timezone: zone, now }).ok).toBe(true);
});

it("rejects overlapping ranges and keeps a shared boundary clear", () => {
  const earlier = rangeOf("2026-01-01T00:00:00+05:30", "2026-06-01T00:00:00+05:30");
  const next = rangeOf("2026-06-01T00:00:00+05:30", "2026-12-01T00:00:00+05:30");
  const conflict = rangeOf("2026-05-01T00:00:00+05:30", "2026-07-01T00:00:00+05:30");
  expect(overlaps(earlier, next)).toBe(false);
  expect(overlaps(earlier, conflict)).toBe(true);
  expect(covers(earlier, new Date("2026-06-01T00:00:00+05:30").getTime())).toBe(false);
  expect(covers(next, new Date("2026-06-01T00:00:00+05:30").getTime())).toBe(true);
  const open = { start: new Date("2026-01-01T00:00:00Z").getTime(), end: Number.POSITIVE_INFINITY };
  expect(overlaps(open, rangeOf("2099-01-01T00:00:00Z", "2099-02-01T00:00:00Z"))).toBe(true);
});

it("resolves as-of time without treating a scheduled value as already effective", () => {
  const intervals: AsOfInterval[] = [
    { id: "past", start: Date.parse("2024-01-01T00:00:00Z"), end: Date.parse("2025-01-01T00:00:00Z"), state: "ended", value: "earlier", enteredAt: "2026-11-01T12:00:00.000Z", effectiveStart: "2024-01-01T00:00:00.000Z", effectiveEnd: "2025-01-01T00:00:00.000Z", timezone: zone },
    { id: "later", start: Date.parse("2027-01-01T00:00:00Z"), end: Date.parse("2027-06-01T00:00:00Z"), state: "scheduled", value: "future", enteredAt: "2026-11-01T12:00:00.000Z", effectiveStart: "2027-01-01T00:00:00.000Z", effectiveEnd: "2027-06-01T00:00:00.000Z", timezone: zone },
    { id: "dropped", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:00Z"), state: "cancelled", value: "secret", enteredAt: "2026-10-01T00:00:00.000Z", effectiveStart: "2025-01-01T00:00:00.000Z", effectiveEnd: "2026-01-01T00:00:00.000Z", timezone: zone },
  ];
  expect(resolveAsOf(intervals, Date.parse("2024-06-01T00:00:00Z"))).toMatchObject({ state: "effective", value: "earlier" });
  expect(resolveAsOf(intervals, Date.parse("2025-01-01T00:00:00Z")).state).toBe("none");
  expect(resolveAsOf(intervals, Date.parse("2027-03-01T00:00:00Z"))).toMatchObject({ state: "scheduled-pending", value: null });
  const calculation = effectiveCalculation("2024-06-01T00:00:00.000Z", "earlier", "text");
  expect(calculation).toMatchObject({ identified: true, engine: "effective-value", asOf: "2024-06-01T00:00:00.000Z", value: "earlier" });
  expect(calculation.engine).not.toBe("payroll");
});

it("keeps configuration and assignment from granting data access", () => {
  const assignment = { canPropose: true, canCorrect: true, canActivate: true, canCancel: true };
  const field = { canView: true, canWrite: true, canHistory: true };
  expect(effectiveAccess({ recordCapabilities: ["manage-effective-dates"], field, assignment: null })).toMatchObject({ canConfigure: true, canView: false, canPropose: false, canExport: false, canHistory: false });
  expect(effectiveAccess({ recordCapabilities: [], field, assignment })).toMatchObject({ canView: false, canPropose: false, canCorrect: false, canActivate: false });
  expect(effectiveAccess({ recordCapabilities: ["view", "edit"], field, assignment: { ...assignment, canCorrect: true } }).canCorrect).toBe(false);
  expect(effectiveAccess({ recordCapabilities: ["view", "edit", "correct-effective"], field, assignment }).canCorrect).toBe(true);
  expect(effectiveAccess({ recordCapabilities: ["view", "edit"], field: { canView: false, canWrite: false, canHistory: false }, assignment }).canActivate).toBe(true);
  expect(effectiveAccess({ recordCapabilities: ["view", "edit"], field: { canView: false, canWrite: false, canHistory: false }, assignment }).canPropose).toBe(false);
});
