/** Client-safe published-page copy and view types. The server module keeps database access. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
const PATH = /^([a-z0-9][a-z0-9-]{1,78}[a-z0-9])(?:@v([1-9][0-9]{0,5}))?$/;

export const PUBLISHED_NOT_FOUND = { error: "Page not found", code: "not_found" } as const;
export const PUBLISHED_NOT_FOUND_TITLE = "Not found";
export const NOT_LATEST_BANNER = "This is not the latest version";
export const UNPUBLISHED_MESSAGE = "This page is no longer published";
export const TRASH_MESSAGE = "In trash — Restore";
export const UNPUBLISHED_CHANGES = "Unpublished changes";

export function isPublishedSlug(slug: string) {
  return SLUG.test(slug);
}

export function suggestSlug(title: string) {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
  return SLUG.test(slug) ? slug : "";
}

export function formatPublishedAt(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${pick("day")} ${pick("month")} ${pick("year")}, ${pick("hour")}:${pick("minute")} ${pick("dayPeriod").replace(/\s/g, "").toUpperCase()} IST`;
}

export function publishedBanner(at: string | Date, publisher: string) {
  return `Published ${formatPublishedAt(at)} by ${publisher}`;
}

export function valuesAsOf(at: string | Date) {
  return `Values as of ${formatPublishedAt(at)}`;
}

export type DiffLine = { kind: "same" | "removed" | "added"; text: string };
export function textDiff(before: string, after: string) {
  if (before === after) return { changed: false, lines: [] as DiffLine[] };
  const a = before.split("\n").slice(0, 200);
  const b = after.split("\n").slice(0, 200);
  if (before.split("\n").length > 200 || after.split("\n").length > 200) return { changed: true, lines: [{ kind: "removed" as const, text: before.slice(0, 2000) }, { kind: "added" as const, text: after.slice(0, 2000) }] };
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ kind: "removed", text: a[i] }); i++; }
    else { lines.push({ kind: "added", text: b[j] }); j++; }
  }
  while (i < a.length) lines.push({ kind: "removed", text: a[i++] });
  while (j < b.length) lines.push({ kind: "added", text: b[j++] });
  return { changed: true, lines };
}

export function parsePublishedPath(space: string, page: string) {
  let spaceSlug = space;
  let pageSlug = page;
  try { spaceSlug = decodeURIComponent(space); pageSlug = decodeURIComponent(page); } catch { return null; }
  if (!SLUG.test(spaceSlug) || !PATH.test(pageSlug)) return null;
  const match = PATH.exec(pageSlug);
  if (!match) return null;
  return { spaceSlug, pageSlug: match[1], version: match[2] ? Number(match[2]) : null };
}

export type PublishedField = { key: string; label: string; access: "visible" | "hidden"; value?: string };
export type PublishedRecord = { blockId: string; status: "visible" | "restricted"; title: string | null; fields: PublishedField[]; valuesAsOf: string | null };
export type PublishedVersionSummary = { versionNo: number; publishedAt: string; publishedAtIst: string; publisher: string; note: string };
export type PublishedResolution =
  | { kind: "missing" }
  | { kind: "redirect"; location: string }
  | { kind: "trashed"; pageId: string; canonicalPath: string }
  | { kind: "unpublished"; pageId: string; canonicalPath: string; stablePath: string }
  | { kind: "published"; pageId: string; title: string; text: string; versionNo: number; revisionId: string; banner: string; stablePath: string; canonicalPath: string; latest: boolean; notLatestBanner: string | null; latestPath: string; versions: PublishedVersionSummary[]; records: PublishedRecord[] };

export type DraftPublication = {
  canPublish: boolean;
  suggestedSlug: string;
  slug: string | null;
  spaceSlug: string | null;
  stablePath: string | null;
  canonicalPath: string;
  live: boolean;
  unpublished: boolean;
  unpublishReason: string | null;
  versionNo: number | null;
  banner: string | null;
  unpublishedChanges: boolean;
  diff: { changed: boolean; lines: DiffLine[] };
  versions: PublishedVersionSummary[];
};

export function publishedDocumentMetadata(result: PublishedResolution): { title: string; robots: { index: false; follow: false } } {
  if (result.kind === "published") return { title: result.title, robots: { index: false, follow: false } };
  return { title: PUBLISHED_NOT_FOUND_TITLE, robots: { index: false, follow: false } };
}
