export const REVIEW_TIME_ZONE = "Asia/Kolkata";
export const REVIEW_JOB_HOUR = 10;
export const REVIEW_DUE_WINDOW_DAYS = 14;
export const REVIEW_OVERDUE_DAILY_DAYS = 7;
export const EXPIRED_BANNER = "Expired — may be out of date";
export const OWNER_NEEDED = "Owner needed";
export const NOT_ALLOWED = "Not allowed";
export const PAGE_HIDDEN = "Page is restricted or unavailable";
export const SPACE_HIDDEN = "Space is restricted or unavailable";
export const reviewFilters = ["open", "due", "overdue", "expired", "all"] as const;
export type ReviewFilter = (typeof reviewFilters)[number];
export type ReviewBucket = "due" | "overdue" | "expired" | "scheduled";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function istCalendarDate(now: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: REVIEW_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function istHour(now: Date) {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: REVIEW_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).formatToParts(now).find(part => part.type === "hour")?.value;
  return Number(hour ?? "0");
}

export function reviewJobReady(now: Date) {
  return istHour(now) >= REVIEW_JOB_HOUR;
}

export function parseCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900 || year > 9999) return null;
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) return null;
  return value;
}

export function addCalendarMonths(isoDate: string, months: number) {
  const parsed = parseCalendarDate(isoDate);
  if (!parsed || !Number.isInteger(months)) throw new Error("invalid calendar date");
  const [year, month, day] = parsed.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(index / 12);
  const nextMonth = index % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  const nextDay = Math.min(day, lastDay);
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth + 1).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}`;
}

export function formatReviewDate(isoDate: string) {
  const parsed = parseCalendarDate(isoDate);
  if (!parsed) return "";
  const [year, month, day] = parsed.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function nextReviewHeader(isoDate: string) {
  const label = formatReviewDate(isoDate);
  return label ? `Next review ${label}` : "";
}

export function calendarDaysBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function classifyReview(today: string, nextReviewOn: string, expiresOn: string) {
  const days = calendarDaysBetween(today, nextReviewOn);
  const expired = expiresOn < today;
  const overdue = days < 0;
  const due = days >= 0 && days <= REVIEW_DUE_WINDOW_DAYS;
  const scheduled = !expired && !overdue && !due;
  return { due, overdue, expired, scheduled };
}

export function reviewIsVerified(today: string, nextReviewOn: string, expiresOn: string, reviewed: boolean) {
  if (!reviewed || expiresOn < today) return false;
  return calendarDaysBetween(today, nextReviewOn) >= 0;
}

export type ReminderPlan = { slot: string; summary: string };

export function reminderPlan(today: string, nextReviewOn: string): ReminderPlan | null {
  const days = calendarDaysBetween(today, nextReviewOn);
  if (days === 14 || days === 7 || days === 1) return { slot: `upcoming:${nextReviewOn}:${days}`, summary: `Review due in ${days} ${days === 1 ? "day" : "days"}` };
  if (days === 0) return { slot: `due:${nextReviewOn}`, summary: "Review due today" };
  if (days < 0) {
    const overdue = -days;
    if (overdue <= REVIEW_OVERDUE_DAILY_DAYS || overdue % 7 === 0) return { slot: `overdue:${today}`, summary: "Review overdue" };
  }
  return null;
}

export function isReviewFilter(value: string | null): value is ReviewFilter {
  return reviewFilters.includes(value as ReviewFilter);
}

export function reviewCsvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export type ReviewSearchHit = { id: string; kind?: string; href?: string; badge?: string | null };

export function searchHitPageId(hit: ReviewSearchHit) {
  if ((hit.kind === "page" || hit.kind === undefined) && !hit.id.includes(":")) return hit.id;
  if (!hit.href) return null;
  const match = /^\/pages\/([^/?#]+)/.exec(hit.href);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}
