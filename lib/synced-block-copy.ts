import type { RichNode } from "./document";

/** Poll interval for placement refresh. Readers must observe an edit within 5 seconds. */
export const SYNCED_POLL_MS = 2000;
export const SYNCED_UNDO_DAYS = 30;
export const SYNCED_CLIPBOARD_PREFIX = "holy-sheet-synced:v1:";

export const SYNCED_RESTRICTED_LABEL = "Restricted content";
export const SYNCED_UNAVAILABLE_LABEL = "Synced block unavailable";
export const SYNCED_TRASH_LABEL = "Source in trash — Restore";
export const SYNCED_EDIT_HINT = "Edit in source";
export const SYNCED_CONFLICT_MESSAGE = "This synced block changed elsewhere. Review both versions. Nothing was overwritten.";

export function syncedPlacementLabel(count: number) {
  return count > 1 ? `Synced to ${count} pages` : "Synced";
}

export function hiddenPagesCopy(count: number) {
  if (count <= 0) return "";
  return count === 1 ? "1 other page you can't see" : `${count} other pages you can't see`;
}

export function deleteAllCopy(titles: readonly string[], hidden: number) {
  const visible = titles.length ? titles.join(", ") : "no pages you can read";
  const extra = hidden > 0 ? ` ${hiddenPagesCopy(hidden)}.` : "";
  return `Delete all copies of this synced block? Pages you can read: ${visible}.${extra} You can undo this for 30 days.`;
}

export function syncedEditedSurface(originTitle: string) {
  return `Synced block edited from ${originTitle}`;
}

export function syncedClipboardPayload(syncedId: string) {
  return `${SYNCED_CLIPBOARD_PREFIX}${syncedId}`;
}

export function parseSyncedClipboard(value: string) {
  if (!value.startsWith(SYNCED_CLIPBOARD_PREFIX)) return null;
  const syncedId = value.slice(SYNCED_CLIPBOARD_PREFIX.length).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(syncedId) ? syncedId : null;
}

export type SyncedConflictDetails = {
  server: { version: number; content: RichNode };
  client: { version: number; content: RichNode };
};

export function syncedConflictDetails(value: unknown): SyncedConflictDetails | null {
  if (!value || typeof value !== "object") return null;
  const details = value as SyncedConflictDetails;
  if (!details.server || !details.client || typeof details.server.version !== "number" || typeof details.client.version !== "number") return null;
  if (!details.server.content || !details.client.content) return null;
  return details;
}
