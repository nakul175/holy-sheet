import { includesParsed, parseQuery } from "./search";

/** Neutral sentence for hidden, revoked, deleted, and unknown targets (LO-1). */
export const SEARCH_JUMP_UNAVAILABLE = "This item is no longer available";
export const SEARCH_LINK_COPIED = "Link copied";
export const SEARCH_BLOCK_HIGHLIGHT_MS = 2000;
export const SEARCH_RECENT_LIMIT = 5;
export const SEARCH_SHORTCUT_HINT = "Enter open · Ctrl+Enter or Cmd+Enter new tab · Shift+Enter insert reference · Ctrl+Shift+C or Cmd+Shift+C copy link";

export const searchActionIds = ["open", "open-tab", "copy-link", "insert-link", "insert-chip", "insert-card", "jump-section", "peek-record"] as const;
export type SearchActionId = (typeof searchActionIds)[number];

export const searchActionLabels: Record<SearchActionId, string> = {
  open: "Open",
  "open-tab": "Open in new tab",
  "copy-link": "Copy link",
  "insert-link": "Insert as link",
  "insert-chip": "Insert as inline chip",
  "insert-card": "Insert as card",
  "jump-section": "Jump to section",
  "peek-record": "Open record in side peek",
};

export type SearchActionTarget = {
  kind?: "page" | "block" | "record" | "field" | "attachment" | "heading" | string;
  trashed?: boolean;
  hasHeadings?: boolean;
};

const blockIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;

/** Actions the focused result may offer. Insert and jump are omitted when the target is trashed. */
export function permittedSearchActions(target: SearchActionTarget, editing: boolean): SearchActionId[] {
  const kind = target.kind ?? "page";
  const actions: SearchActionId[] = ["open", "open-tab", "copy-link"];
  if (target.trashed) return actions;
  if (editing && (kind === "page" || kind === "block" || kind === "heading")) actions.push("insert-link");
  if (editing && kind === "record") actions.push("insert-chip", "insert-card");
  if ((kind === "page" || kind === "heading") && target.hasHeadings) actions.push("jump-section");
  if (kind === "record") actions.push("peek-record");
  return actions;
}

export type SearchShortcutEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
};

/** Maps a result key to an action only when that action is permitted. */
export function searchResultShortcut(event: SearchShortcutEvent, permitted: readonly SearchActionId[]): SearchActionId | null {
  if (event.isComposing || event.altKey) return null;
  const key = event.key.toLowerCase();
  const command = !!(event.metaKey || event.ctrlKey);
  let action: SearchActionId | null = null;
  if (key === "enter" && command && !event.shiftKey) action = "open-tab";
  else if (key === "enter" && event.shiftKey && !command) action = permitted.includes("insert-chip") ? "insert-chip" : permitted.includes("insert-link") ? "insert-link" : null;
  else if (key === "enter" && !command && !event.shiftKey) action = "open";
  else if (key === "c" && command && event.shiftKey) action = "copy-link";
  if (!action || !permitted.includes(action)) return null;
  return action;
}

export function parseJumpQuery(query: string): { pageQuery: string; headingQuery: string } | null {
  const at = query.indexOf(">");
  if (at < 0) return null;
  const pageQuery = query.slice(0, at).trim();
  const headingQuery = query.slice(at + 1).trim();
  if (!pageQuery || !headingQuery || pageQuery.length > 512 || headingQuery.length > 512) return null;
  return { pageQuery, headingQuery };
}

export function headingMatches(text: string, headingQuery: string) {
  const parsed = parseQuery(headingQuery);
  if (!parsed.terms.length && !parsed.phrases.length) return false;
  return includesParsed(text, parsed);
}

export function pageQueryMatches(title: string, pageQuery: string) {
  const parsed = parseQuery(pageQuery);
  if (!parsed.terms.length && !parsed.phrases.length) return false;
  return includesParsed(title, parsed);
}

export function blockFragment(blockId: string) {
  return `#block-${encodeURIComponent(blockId)}`;
}

export function blockJumpHref(pageId: string, blockId: string) {
  return `/pages/${encodeURIComponent(pageId)}${blockFragment(blockId)}`;
}

export function parseBlockFragment(hash: string): string | null {
  if (!hash.startsWith("#block-") || hash.length > 120) return null;
  try {
    const id = decodeURIComponent(hash.slice("#block-".length));
    return blockIdPattern.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Uses a link the palette already showed. Copy does not ask the server whether the target still exists. */
export function canonicalSearchHref(result: { id: string; href?: string }) {
  const href = result.href?.trim() ?? "";
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return `/pages/${encodeURIComponent(result.id)}`;
}

export function recordIdFromHit(id: string) {
  const match = /^record:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(id);
  return match ? match[1] : null;
}

/** Create-on-miss copy names only the typed title and a destination the actor may use. */
export function createPageActionLabel(title: string, spaceName: string) {
  return `Create page "${title}" in ${spaceName}`;
}

export function createRecordActionLabel(title: string, collectionName: string) {
  return `Create record "${title}" in ${collectionName}`;
}

export type SearchHeadingHit = { pageId: string; pageTitle: string; blockId: string; level: number; text: string; href: string };
export type SearchCreateAction = { kind: "page" | "record"; label: string; spaceId?: string; collection?: string; title: string };
export type SearchQuickAction = { id: string; label: string; kind: "new-page" | "new-record" | "space-home"; href?: string; spaceId?: string; collection?: string };
export type SearchRecentHit = { id: string; title: string; href: string; spaceName: string };
