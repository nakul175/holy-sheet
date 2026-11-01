/** Effective time for selected scalar and reference fields.
 * This is not a legal, payroll, or schedule runner.
 */

import { looksLikeCredential } from "./external-identifier-mapping";
import type { FieldKind } from "./shared-record-types";

export const eligibleEffectiveKinds = ["text", "number", "currency", "date", "boolean", "email", "phone", "url", "single-select", "record"] as const;
export type EligibleEffectiveKind = (typeof eligibleEffectiveKinds)[number];
export const intervalStates = ["scheduled", "active", "ended", "cancelled", "blocked"] as const;
export type IntervalState = (typeof intervalStates)[number];
export const occupyingStates = ["scheduled", "active", "ended"] as const;
export const blockedCodes = ["schema_invalid", "target_invalid", "rights_revoked", "field_unavailable", "config_disabled"] as const;
export type BlockedCode = (typeof blockedCodes)[number];

const instantPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?)(Z|[+-]\d{2}:\d{2})$/;

export type EffectiveWindow = {
  start: Date;
  end: Date | null;
  timezone: string;
  backdated: boolean;
  state: "scheduled" | "active" | "ended";
};

export type EffectiveAssignment = { canPropose: boolean; canCorrect: boolean; canActivate: boolean; canCancel: boolean };

export function isEligibleEffectiveKind(kind: FieldKind): kind is EligibleEffectiveKind {
  return (eligibleEffectiveKinds as readonly string[]).includes(kind);
}

export function ianaTimezone(value: string) {
  if (!value || value.length > 100 || value !== value.trim() || !/^[A-Za-z0-9_+-]{1,14}(?:\/[A-Za-z0-9_+-]{1,40}){0,2}$/.test(value)) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function zoneOffset(instant: Date, timeZone: string) {
  try {
    const raw = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset", hour: "2-digit" }).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value ?? "";
    if (raw === "GMT" || raw === "UTC") return "Z";
    const match = raw.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!match) return null;
    return `${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
  } catch {
    return null;
  }
}

function offsetsMatch(declared: string, zone: string) {
  if (declared === zone) return true;
  return (declared === "Z" || declared === "+00:00") && (zone === "Z" || zone === "+00:00");
}

export function parseAsOf(value: string) {
  const match = instantPattern.exec(value);
  if (!match) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

export function parseEffectiveInstant(value: string, timezone: string) {
  const match = instantPattern.exec(value);
  if (!match) return { ok: false as const, message: "Enter an effective time with an explicit offset, such as 2026-12-01T09:00:00+05:30." };
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return { ok: false as const, message: "Enter a real effective time." };
  const declared = match[2];
  const zone = zoneOffset(instant, timezone);
  if (!zone || !offsetsMatch(declared, zone)) return { ok: false as const, message: "The time offset must match the chosen timezone." };
  return { ok: true as const, instant };
}

export function parseEffectiveWindow(input: { start: string; end?: string | null; timezone: string; now: Date }): { ok: true; window: EffectiveWindow } | { ok: false; message: string } {
  if (!ianaTimezone(input.timezone)) return { ok: false, message: "Choose an explicit IANA timezone. Abbreviations are not accepted." };
  const start = parseEffectiveInstant(input.start, input.timezone);
  if (!start.ok) return start;
  const endText = input.end?.trim() ?? "";
  let end: Date | null = null;
  if (endText) {
    const parsed = parseEffectiveInstant(endText, input.timezone);
    if (!parsed.ok) return { ok: false, message: "Enter an effective end with an offset that matches the timezone, or leave the end open." };
    end = parsed.instant;
    if (end.getTime() <= start.instant.getTime()) return { ok: false, message: "The effective end must be after the start. The interval is half-open and includes the start only." };
  }
  const startMs = start.instant.getTime();
  const endMs = end ? end.getTime() : Number.POSITIVE_INFINITY;
  const now = input.now.getTime();
  const state = startMs > now ? "scheduled" as const : now < endMs ? "active" as const : "ended" as const;
  return { ok: true, window: { start: start.instant, end, timezone: input.timezone, backdated: startMs < now, state } };
}

export function parseCorrectionReason(value: unknown, required: boolean) {
  if (value === undefined || value === null || value === "") {
    return required ? { ok: false as const, message: "Enter a reason for this backdated correction." } : { ok: true as const, reason: "" };
  }
  if (typeof value !== "string") return { ok: false as const, message: "Enter a reason for this backdated correction." };
  const reason = value.normalize("NFC").trim();
  if (!reason || reason.length > 500 || /[\p{Cc}]/u.test(reason)) return { ok: false as const, message: "Use a correction reason of 1–500 characters without control characters." };
  if (looksLikeCredential(reason)) return { ok: false as const, message: "A correction reason cannot carry a credential." };
  return { ok: true as const, reason };
}

export function rangeOf(start: Date | string, end: Date | string | null) {
  const startMs = new Date(start).getTime();
  const endMs = end === null ? Number.POSITIVE_INFINITY : new Date(end).getTime();
  return { start: startMs, end: endMs };
}

/** Half-open [start, end). Touching at the end is not an overlap. */
export function overlaps(left: { start: number; end: number }, right: { start: number; end: number }) {
  return left.start < right.end && right.start < left.end;
}

export function covers(interval: { start: number; end: number }, instant: number) {
  return interval.start <= instant && instant < interval.end;
}

export type AsOfInterval = {
  id: string;
  start: number;
  end: number;
  state: IntervalState;
  value: unknown;
  enteredAt: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  timezone: string;
};

export function resolveAsOf(intervals: readonly AsOfInterval[], asOf: number) {
  const match = intervals.find((interval) => (occupyingStates as readonly string[]).includes(interval.state) && covers(interval, asOf));
  if (!match) return { state: "none" as const, value: null, interval: null };
  if (match.state === "scheduled") return { state: "scheduled-pending" as const, value: null, interval: match };
  return { state: "effective" as const, value: match.value, interval: match };
}

/** Identifies the as-of instant on a resolved scalar or reference. Not a payroll engine. */
export function effectiveCalculation(asOf: string, value: unknown, kind: string | null) {
  return { asOf, identified: true as const, kind, value, engine: "effective-value" as const };
}

export function effectiveAccess(input: {
  recordCapabilities: readonly string[];
  field: { canView: boolean; canWrite: boolean; canHistory: boolean };
  assignment: EffectiveAssignment | null;
}) {
  const caps = new Set(input.recordCapabilities);
  const view = caps.has("view") && input.field.canView;
  const write = view && caps.has("edit") && input.field.canWrite;
  const assignment = input.assignment;
  return {
    canView: view,
    canSearch: view,
    canPropose: write && assignment?.canPropose === true,
    canCorrect: write && caps.has("correct-effective") && assignment?.canCorrect === true,
    // Field write is checked again at activation. Losing it blocks the value instead of granting it.
    canActivate: caps.has("view") && caps.has("edit") && assignment?.canActivate === true,
    canCancel: write && assignment?.canCancel === true,
    canConfigure: caps.has("manage-effective-dates"),
    canAssign: caps.has("manage-effective-dates"),
    canHistory: view && caps.has("history") && input.field.canHistory,
    canExport: view && caps.has("export"),
  };
}
