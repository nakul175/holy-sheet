import { randomUUID } from "node:crypto";
import type { Sql } from "./database";
import { formatIst } from "./ist-label";

/** Authors follow their page once. A later explicit frequency is left alone. Audit stores no title or body. */
export async function ensureAuthorFollow(tx: Sql, userId: string, pageId: string) {
  const inserted = await tx.query<{ user_id: string }>(
    `INSERT INTO hs_page_follows(user_id, page_id, include_children, frequency, last_digest_at)
     VALUES($1, $2, false, 'daily', clock_timestamp())
     ON CONFLICT (user_id, page_id) DO NOTHING
     RETURNING user_id`,
    [userId, pageId],
  );
  if (!inserted.rows.length) return;
  await tx.query(
    "INSERT INTO hs_audit(id, actor_id, action, page_id, after_value, correlation_id) VALUES($1,$2,'page-follow.auto',$3,$4::jsonb,$5)",
    [randomUUID(), userId, pageId, JSON.stringify({ includeChildren: false, frequency: "daily", atIst: formatIst(new Date()) }), randomUUID()],
  );
}
