import type { Sql } from "./database";

/** Working-copy pages stay visible only to the copy owner. Role and grants do not widen this. */
export function workingCopyVisibleSql(page: string, actorParam: string) {
  if (!/^[a-z]$/.test(page) || !/^\$\d+$/.test(actorParam)) throw new Error("Invalid working-copy predicate");
  return `NOT EXISTS (SELECT 1 FROM hs_working_copies wc WHERE wc.copy_page_id = ${page}.id AND wc.owner_id <> ${actorParam})`;
}

export async function isWorkingCopyPage(tx: Sql, pageId: string) {
  const rows = await tx.query("SELECT 1 FROM hs_working_copies WHERE copy_page_id=$1", [pageId]);
  return rows.rows.length > 0;
}

export async function isForeignWorkingCopy(tx: Sql, pageId: string, actorId: string) {
  const rows = await tx.query("SELECT 1 FROM hs_working_copies WHERE copy_page_id=$1 AND owner_id<>$2", [pageId, actorId]);
  return rows.rows.length > 0;
}
