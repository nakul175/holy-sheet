import { SYNCED_RESTRICTED_LABEL } from "./synced-block-copy";

export const SNIPPET_RESTORE_DAYS = 30;
export const SNIPPET_HIDDEN_MESSAGE = "Snippet is restricted or unavailable";
export const SNIPPET_UPDATE_LABEL = "Newer approved version available — Update";
export const SNIPPET_RETIRED_BADGE = "Retired";
export const SNIPPET_DELETED_BADGE = "Snippet deleted";
export const SNIPPET_EDIT_LABEL = "Edit snippet";
export const SNIPPET_DETACH_LABEL = "Detach as text";
export const SNIPPET_RESTRICTED_LABEL = SYNCED_RESTRICTED_LABEL;

export function retireSnippetCopy(titles: readonly string[], hidden: number) {
  const visible = titles.length ? titles.join(", ") : "no pages you can read";
  const others = hidden > 0 ? ` ${hidden} other ${hidden === 1 ? "page" : "pages"} without titles.` : "";
  return `Retire this snippet? Pages you can read: ${visible}.${others} Placements keep the last approved text. Editors see a Retired badge. The snippet leaves the insert picker.`;
}

export function snippetUsageCsv(rows: readonly { pageId: string; pageTitle: string; pageOwnerId: string; pageOwnerName: string; versionMode: string; versionNumber: number }[]) {
  const header = ["page_id", "page_title", "page_owner_id", "page_owner_name", "version_mode", "version_number"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([row.pageId, row.pageTitle, row.pageOwnerId, row.pageOwnerName, row.versionMode, String(row.versionNumber)].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string) {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}
