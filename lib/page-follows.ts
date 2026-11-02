import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, stableStringify, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import { summarizePageChange } from "./page-follow-diff";
import type { Repository } from "./repository";

export const DEFAULT_FOLLOW_TIME_ZONE = "Asia/Kolkata";
export const REMOVED_FOLLOW = "A page you follow was removed";
export const UNSUBSCRIBE_PAGE = "If this link was valid, following for that page has stopped.";
export const PAGE_HIDDEN = "Page is restricted or unavailable";
const DIGEST_HOUR = 9;
const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const operationId = z.string().uuid();
const frequency = z.enum(["daily", "weekly"]);
const pageCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("follow"), operationId, includeChildren: z.boolean() }).strict(),
  z.object({ action: z.literal("unfollow"), operationId }).strict(),
  z.object({ action: z.literal("frequency"), operationId, frequency }).strict(),
]);
const settingsCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("timezone"), operationId, timezone: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("frequency"), operationId, pageId: z.string().min(1).max(200), frequency }).strict(),
  z.object({ action: z.literal("unfollow"), operationId, pageId: z.string().min(1).max(200) }).strict(),
]);

export type FollowFrequency = "daily" | "weekly";
export type PageFollowState = { following: boolean; includeChildren: boolean; frequency: FollowFrequency | null };
export type PageFollowResult = PageFollowState & { replayed: boolean };
export type PageFollowList = {
  timezone: string;
  follows: { pageId: string; title: string | null; unavailable: boolean; includeChildren: boolean; frequency: FollowFrequency }[];
};
type FollowRow = { page_id: string; include_children: boolean; frequency: FollowFrequency; last_digest_at: string | Date; removal_batch_id: string | null };
type DraftItem = { pageId: string; followPageId: string };
type ZoneParts = { date: string; hour: number; weekday: string };

const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const hidden = () => new DocumentError(PAGE_HIDDEN, "not_found", 404);
const mismatch = () => new DocumentError("This follow attempt was reused with different fields.", "operation_mismatch", 409);
const invalid = () => new DocumentError("Invalid follow request", "invalid_follow", 400);

export function followTimeZone(value: string | null | undefined) {
  const zone = value?.trim() || DEFAULT_FOLLOW_TIME_ZONE;
  try {
    Intl.DateTimeFormat("en-GB", { timeZone: zone }).format();
    return zone;
  } catch {
    return DEFAULT_FOLLOW_TIME_ZONE;
  }
}

export function zonedParts(now: Date, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: followTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return { date: `${read("year")}-${read("month")}-${read("day")}`, hour: Number(read("hour")), weekday: read("weekday") };
}

/** Daily at 09:00 in the user's timezone. Weekly is Monday of that same hour. IST is the default zone. */
export function digestWindow(now: Date, timeZone: string, value: FollowFrequency) {
  const parts = zonedParts(now, timeZone);
  if (parts.hour !== DIGEST_HOUR) return null;
  if (value === "weekly" && parts.weekday !== "Mon") return null;
  return parts.date;
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function stored<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

async function audit(tx: Sql, actorId: string, action: string, pageId: string | null, correlationId: string, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id, actor_id, action, page_id, after_value, correlation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
    [randomUUID(), actorId, action, pageId, JSON.stringify(after), correlationId],
  );
}

export function unsubscribeSecret() {
  const configured = process.env.HS_FOLLOW_UNSUBSCRIBE_SECRET;
  if (configured && configured.length >= 16) return configured;
  if (process.env.NODE_ENV === "production") throw new Error("HS_FOLLOW_UNSUBSCRIBE_SECRET is required");
  return "holy-sheet-page-follow-dev-secret";
}

export function signPageUnsubscribe(userId: string, pageId: string, now = new Date(), secret = unsubscribeSecret()) {
  const body = Buffer.from(JSON.stringify({ v: 1, userId, pageId, exp: now.getTime() + TOKEN_TTL_MS })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function readUnsubscribe(token: string, secret: string) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { v?: number; userId?: string; pageId?: string; exp?: number };
    if (parsed.v !== 1 || typeof parsed.userId !== "string" || typeof parsed.pageId !== "string" || typeof parsed.exp !== "number") return null;
    if (!parsed.userId || !parsed.pageId || parsed.userId.length > 200 || parsed.pageId.length > 200) return null;
    return { userId: parsed.userId, pageId: parsed.pageId, exp: parsed.exp };
  } catch {
    return null;
  }
}

export function unsubscribePath(token: string) {
  return `/follows/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function unsubscribeResponse() {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Following</title><p>${UNSUBSCRIBE_PAGE}</p></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "Cookie" } });
}

function presentState(row: { include_children: boolean; frequency: FollowFrequency } | undefined): PageFollowState {
  if (!row) return { following: false, includeChildren: false, frequency: null };
  return { following: true, includeChildren: row.include_children, frequency: row.frequency };
}

async function readable(r: Repository, tx: Sql, pageId: string, actor: Actor) {
  try {
    return await r.access(tx, pageId, actor);
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) throw hidden();
    throw error;
  }
}

async function canRead(r: Repository, tx: Sql, pageId: string, actor: Actor) {
  try {
    await r.access(tx, pageId, actor);
    return true;
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) return false;
    throw error;
  }
}

async function remember(tx: Sql, actorId: string, operation: string, requestHash: string) {
  const prior = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_page_follow_operations WHERE user_id=$1 AND operation_id=$2", [actorId, operation]);
  if (!prior.rows.length) return null;
  if (prior.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...stored<PageFollowState>(prior.rows[0].result), replayed: true };
}

async function finish(tx: Sql, actorId: string, operation: string, pageId: string | null, requestHash: string, action: string, result: PageFollowState) {
  await tx.query(
    "INSERT INTO hs_page_follow_operations(user_id, operation_id, page_id, request_hash, result) VALUES($1,$2,$3,$4,$5::jsonb)",
    [actorId, operation, pageId, requestHash, JSON.stringify(result)],
  );
  await audit(tx, actorId, action, pageId, operation, { includeChildren: result.includeChildren, frequency: result.frequency, following: result.following, atIst: formatIst(new Date()) });
  return { ...result, replayed: false };
}

export async function pageFollowState(r: Repository, actor: Actor, pageId: string): Promise<PageFollowState> {
  return r.db.transaction(async tx => {
    await readable(r, tx, pageId, actor);
    const row = await tx.query<{ include_children: boolean; frequency: FollowFrequency }>("SELECT include_children, frequency FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [actor.id, pageId]);
    return presentState(row.rows[0]);
  });
}

export async function changePageFollow(r: Repository, actor: Actor, pageId: string, input: unknown): Promise<PageFollowResult> {
  const parsed = pageCommand.safeParse(input);
  if (!parsed.success) throw invalid();
  const command = parsed.data;
  const requestHash = hash({ pageId, command });
  return r.db.transaction(async tx => {
    await readable(r, tx, pageId, actor);
    const replay = await remember(tx, actor.id, command.operationId, requestHash);
    if (replay) return replay;
    if (command.action === "unfollow") {
      await tx.query("DELETE FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [actor.id, pageId]);
      return finish(tx, actor.id, command.operationId, pageId, requestHash, "page-follow.unfollow", presentState(undefined));
    }
    if (command.action === "frequency") {
      const updated = await tx.query<{ include_children: boolean; frequency: FollowFrequency }>(
        "UPDATE hs_page_follows SET frequency=$3, updated_at=clock_timestamp() WHERE user_id=$1 AND page_id=$2 RETURNING include_children, frequency",
        [actor.id, pageId, command.frequency],
      );
      if (!updated.rows.length) throw hidden();
      return finish(tx, actor.id, command.operationId, pageId, requestHash, "page-follow.frequency", presentState(updated.rows[0]));
    }
    const saved = await tx.query<{ include_children: boolean; frequency: FollowFrequency }>(
      `INSERT INTO hs_page_follows(user_id, page_id, include_children, frequency, last_digest_at)
       VALUES($1,$2,$3,'daily',clock_timestamp())
       ON CONFLICT(user_id, page_id) DO UPDATE SET include_children=EXCLUDED.include_children, removal_batch_id=NULL, updated_at=clock_timestamp()
       RETURNING include_children, frequency`,
      [actor.id, pageId, command.includeChildren],
    );
    return finish(tx, actor.id, command.operationId, pageId, requestHash, "page-follow.follow", presentState(saved.rows[0]));
  });
}

export async function listPageFollows(r: Repository, actor: Actor): Promise<PageFollowList> {
  const zone = await r.db.query<{ timezone: string }>("SELECT timezone FROM hs_users WHERE id=$1", [actor.id]);
  if (!zone.rows.length) throw hidden();
  const rows = await r.db.query<{ page_id: string; include_children: boolean; frequency: FollowFrequency }>(
    "SELECT page_id, include_children, frequency FROM hs_page_follows WHERE user_id=$1 ORDER BY created_at, page_id",
    [actor.id],
  );
  const follows: PageFollowList["follows"] = [];
  for (const row of rows.rows) {
    let title: string | null = null;
    try { title = (await r.get(row.page_id, actor)).title; }
    catch (error) { if (!(error instanceof DocumentError && error.status === 404)) throw error; }
    follows.push({ pageId: row.page_id, title, unavailable: title === null, includeChildren: row.include_children, frequency: row.frequency });
  }
  return { timezone: followTimeZone(zone.rows[0].timezone), follows };
}

export async function changeFollowSettings(r: Repository, actor: Actor, input: unknown): Promise<PageFollowList & { replayed?: boolean }> {
  const parsed = settingsCommand.safeParse(input);
  if (!parsed.success) throw invalid();
  const command = parsed.data;
  const requestHash = hash(command);
  await r.db.transaction(async tx => {
    const user = await tx.query("SELECT id FROM hs_users WHERE id=$1", [actor.id]);
    if (!user.rows.length) throw hidden();
    const replay = await remember(tx, actor.id, command.operationId, requestHash);
    if (replay) return;
    if (command.action === "timezone") {
      try { Intl.DateTimeFormat("en-GB", { timeZone: command.timezone }).format(); }
      catch { throw new DocumentError("Choose a valid timezone.", "invalid_follow", 400); }
      await tx.query("UPDATE hs_users SET timezone=$2 WHERE id=$1", [actor.id, command.timezone]);
      await finish(tx, actor.id, command.operationId, null, requestHash, "page-follow.timezone", presentState(undefined));
      return;
    }
    const owned = await tx.query("SELECT page_id FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [actor.id, command.pageId]);
    if (!owned.rows.length) throw hidden();
    if (command.action === "unfollow") {
      await tx.query("DELETE FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [actor.id, command.pageId]);
      await finish(tx, actor.id, command.operationId, command.pageId, requestHash, "page-follow.unfollow", presentState(undefined));
      return;
    }
    const updated = await tx.query<{ include_children: boolean; frequency: FollowFrequency }>(
      "UPDATE hs_page_follows SET frequency=$3, updated_at=clock_timestamp() WHERE user_id=$1 AND page_id=$2 RETURNING include_children, frequency",
      [actor.id, command.pageId, command.frequency],
    );
    await finish(tx, actor.id, command.operationId, command.pageId, requestHash, "page-follow.frequency", presentState(updated.rows[0]));
  });
  return listPageFollows(r, actor);
}

export async function unsubscribeFromToken(r: Repository, token: string, now = new Date()) {
  const parsed = readUnsubscribe(token, unsubscribeSecret());
  if (!parsed || parsed.exp < now.getTime()) return;
  await r.db.transaction(async tx => {
    const existing = await tx.query("SELECT page_id FROM hs_page_follows WHERE user_id=$1 AND page_id=$2 FOR UPDATE", [parsed.userId, parsed.pageId]);
    if (!existing.rows.length) return;
    await tx.query("DELETE FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [parsed.userId, parsed.pageId]);
    await audit(tx, parsed.userId, "page-follow.unsubscribe", parsed.pageId, randomUUID(), { atIst: formatIst(now) });
  });
}

async function pageTree(tx: Sql, pageId: string) {
  const rows = await tx.query<{ id: string }>(
    `WITH RECURSIVE tree AS (
      SELECT id, 0 AS depth, ARRAY[id] AS path FROM hs_pages WHERE id=$1
      UNION ALL
      SELECT child.id, tree.depth + 1, tree.path || child.id
      FROM hs_pages child JOIN tree ON child.parent_id = tree.id
      WHERE tree.depth < 40 AND NOT child.id = ANY(tree.path)
    ) SELECT id FROM tree`,
    [pageId],
  );
  return rows.rows.map(row => row.id);
}

type PageMeta = { trashed: boolean; restorer: boolean; title: string | null; batchId: string | null };

async function pageMeta(tx: Sql, pageId: string, actorId: string): Promise<PageMeta | null> {
  const rows = await tx.query<{ trashed: boolean; restorer: boolean; title: string | null; batch_id: string | null }>(
    `SELECT p.deleted_at IS NOT NULL AS trashed,
            (p.owner_id = $2 AND p.deleted_at IS NOT NULL) AS restorer,
            CASE WHEN p.owner_id = $2 AND p.deleted_at IS NOT NULL THEN p.title ELSE NULL END AS title,
            p.deletion_batch_id AS batch_id
     FROM hs_pages p
     WHERE p.id = $1 AND EXISTS (
       SELECT 1 FROM hs_members m WHERE m.workspace_id = p.workspace_id AND m.user_id = $2 AND m.active = true
     )`,
    [pageId, actorId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return { trashed: row.trashed, restorer: row.restorer, title: row.title, batchId: row.batch_id };
}

type RevisionRow = { version: number; title: string; document: RichNode | string; created_at: string | Date; actor_name: string };
type PublishRow = { id: string; note: string; created_at: string | Date; actor_name: string };

async function describeChange(tx: Sql, pageId: string, since: string | Date, now: Date) {
  const baselineRows = await tx.query<RevisionRow>(
    `SELECT v.version, v.title, v.document, v.created_at, COALESCE(u.name, 'Someone') AS actor_name
     FROM hs_revisions v LEFT JOIN hs_users u ON u.id = v.actor_id
     WHERE v.page_id = $1 AND v.created_at <= $2 ORDER BY v.version DESC LIMIT 1`,
    [pageId, since],
  );
  const revisions = await tx.query<RevisionRow>(
    `SELECT v.version, v.title, v.document, v.created_at, COALESCE(u.name, 'Someone') AS actor_name
     FROM hs_revisions v LEFT JOIN hs_users u ON u.id = v.actor_id
     WHERE v.page_id = $1 AND v.created_at > $2 AND v.created_at <= $3 ORDER BY v.version`,
    [pageId, since, now],
  );
  const publishes = await tx.query<PublishRow>(
    `SELECT v.id, v.note, v.created_at, COALESCE(u.name, 'Someone') AS actor_name
     FROM hs_published_versions v JOIN hs_users u ON u.id = v.published_by
     WHERE v.page_id = $1 AND v.created_at > $2 AND v.created_at <= $3 ORDER BY v.version_no`,
    [pageId, since, now],
  );
  let previous = baselineRows.rows[0] ?? { title: "", document: { type: "doc", content: [] } as RichNode, created_at: since, actor_name: "Someone", version: 0 };
  let edits = 0;
  let latest: RevisionRow | null = null;
  for (const revision of revisions.rows) {
    const step = summarizePageChange(previous.document, previous.title, revision.document, revision.title);
    if (step.meaningful) { edits += 1; latest = revision; }
    previous = revision;
  }
  const net = summarizePageChange(baselineRows.rows[0]?.document ?? null, baselineRows.rows[0]?.title ?? "", previous.document, previous.title);
  if (!net.meaningful && !publishes.rows.length) return null;
  const stamp = latest?.created_at ?? publishes.rows.at(-1)?.created_at ?? now;
  const editor = latest?.actor_name ?? publishes.rows.at(-1)?.actor_name ?? "Someone";
  const notes = publishes.rows.map(row => oneLine(row.note)).filter(Boolean);
  const summary = [edits > 1 ? `${edits} edits` : "", net.summary || (publishes.rows.length ? "Published" : "")].filter(Boolean).join(". ");
  return { editor, atIst: formatIst(stamp), summary, notes, edits };
}

function section(lines: string[]) {
  return lines.filter(Boolean).join("\n");
}

async function removeFollow(tx: Sql, userId: string, pageId: string, now: Date) {
  const removed = await tx.query("DELETE FROM hs_page_follows WHERE user_id=$1 AND page_id=$2 RETURNING page_id", [userId, pageId]);
  if (!removed.rows.length) return false;
  await audit(tx, userId, "page-follow.remove", pageId, randomUUID(), { reason: "access", atIst: formatIst(now) });
  return true;
}

export async function notifyPublishedFollowers(tx: Sql, r: Repository, input: { pageId: string; actorId: string; note: string; versionId: string; publishedAt: string }) {
  const followers = await tx.query<{ user_id: string; follow_page_id: string }>(
    `WITH RECURSIVE chain AS (
      SELECT id, parent_id, 0 AS depth FROM hs_pages WHERE id = $1
      UNION ALL
      SELECT parent.id, parent.parent_id, chain.depth + 1
      FROM hs_pages parent JOIN chain ON parent.id = chain.parent_id
      WHERE chain.depth < 40
    )
    SELECT DISTINCT f.user_id, f.page_id AS follow_page_id
    FROM hs_page_follows f
    JOIN chain c ON c.id = f.page_id
    WHERE f.user_id <> $2 AND (f.page_id = $1 OR f.include_children)`,
    [input.pageId, input.actorId],
  );
  const publisher = await tx.query<{ name: string }>("SELECT name FROM hs_users WHERE id=$1", [input.actorId]);
  const editor = publisher.rows[0]?.name || "Someone";
  const atIst = formatIst(input.publishedAt);
  for (const follower of followers.rows) {
    const actor = { id: follower.user_id };
    const allowed = await canRead(r, tx, input.pageId, actor);
    if (!allowed) {
      if (!await canRead(r, tx, follower.follow_page_id, actor)) await removeFollow(tx, follower.user_id, follower.follow_page_id, new Date(input.publishedAt));
      continue;
    }
    const claimed = await tx.query(
      "INSERT INTO hs_page_publish_notices(version_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING version_id",
      [input.versionId, follower.user_id],
    );
    if (!claimed.rows.length) continue;
    const titleRow = await tx.query<{ title: string }>("SELECT title FROM hs_pages WHERE id=$1 AND deleted_at IS NULL", [input.pageId]);
    const title = oneLine(titleRow.rows[0]?.title ?? "");
    if (!title) continue;
    const token = signPageUnsubscribe(follower.user_id, follower.follow_page_id, new Date(input.publishedAt));
    const note = oneLine(input.note);
    const body = section([
      "A page you follow was published",
      "",
      title,
      `${editor} · ${atIst}`,
      `Change note: ${note}`,
      `/pages/${encodeURIComponent(input.pageId)}`,
      "Unsubscribe",
      unsubscribePath(token),
    ]);
    await tx.query(
      "INSERT INTO hs_notifications(id, recipient_id, page_id, kind, summary) VALUES($1,$2,$3,'page-publish',$4)",
      [randomUUID(), follower.user_id, input.pageId, `Change note: ${note}`],
    );
    await tx.query(
      "INSERT INTO hs_page_digest_mail(id, user_id, kind, subject, body) VALUES($1,$2,'publish',$3,$4)",
      [randomUUID(), follower.user_id, "A page you follow was published", body],
    );
    await audit(tx, follower.user_id, "page-follow.publish", input.pageId, input.versionId, { versionId: input.versionId, atIst });
  }
}

async function buildDraft(tx: Sql, userId: string, zone: string, now: Date) {
  const follows = await tx.query<FollowRow>("SELECT page_id, include_children, frequency, last_digest_at, removal_batch_id FROM hs_page_follows WHERE user_id=$1 ORDER BY page_id", [userId]);
  const due = follows.rows.filter(row => digestWindow(now, zone, row.frequency));
  const byPage = new Map<string, DraftItem & { direct: boolean }>();
  for (const follow of due) {
    const pages = follow.include_children ? await pageTree(tx, follow.page_id) : [follow.page_id];
    for (const pageId of pages) {
      const direct = pageId === follow.page_id;
      const existing = byPage.get(pageId);
      if (!existing || (direct && !existing.direct)) byPage.set(pageId, { pageId, followPageId: follow.page_id, direct });
    }
  }
  return { items: [...byPage.values()].map(({ pageId, followPageId }) => ({ pageId, followPageId })) };
}

async function deliverDigest(r: Repository, userId: string, zone: string, items: DraftItem[], now: Date) {
  const windowKey = zonedParts(now, zone).date;
  return r.db.transaction(async tx => {
    const claimed = await tx.query("INSERT INTO hs_page_digest_runs(user_id, window_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING user_id", [userId, windowKey]);
    if (!claimed.rows.length) return false;
    const follows = new Map((await tx.query<FollowRow>("SELECT page_id, include_children, frequency, last_digest_at, removal_batch_id FROM hs_page_follows WHERE user_id=$1 FOR UPDATE", [userId])).rows.map(row => [row.page_id, row]));
    const actor = { id: userId };
    const removed = new Set<string>();
    const sections: string[] = [];
    let neutral = false;
    const bumped = new Set<string>();
    for (const item of items) {
      const follow = follows.get(item.followPageId);
      if (!follow || removed.has(item.followPageId) || !digestWindow(now, zone, follow.frequency)) continue;
      bumped.add(item.followPageId);
      const allowed = await canRead(r, tx, item.pageId, actor);
      if (!allowed) {
        const meta = await pageMeta(tx, item.pageId, userId);
        if (meta?.trashed) {
          if (follow.removal_batch_id && meta.batchId && follow.removal_batch_id === meta.batchId) continue;
          if (meta.restorer && meta.title) {
            sections.push(section([REMOVED_FOLLOW, oneLine(meta.title), "Unsubscribe", unsubscribePath(signPageUnsubscribe(userId, item.followPageId, now))]));
          } else if (!neutral) {
            neutral = true;
            sections.push(section([REMOVED_FOLLOW, "Unsubscribe", unsubscribePath(signPageUnsubscribe(userId, item.followPageId, now))]));
          } else continue;
          await tx.query("INSERT INTO hs_notifications(id, recipient_id, page_id, kind, summary) VALUES($1,$2,$3,'page-digest',$4)", [randomUUID(), userId, item.pageId, REMOVED_FOLLOW]);
          if (meta.batchId) await tx.query("UPDATE hs_page_follows SET removal_batch_id=$3 WHERE user_id=$1 AND page_id=$2", [userId, item.followPageId, meta.batchId]);
          continue;
        }
        const followReadable = item.pageId === item.followPageId ? false : await canRead(r, tx, item.followPageId, actor);
        if (!followReadable && await removeFollow(tx, userId, item.followPageId, now)) removed.add(item.followPageId);
        continue;
      }
      const change = await describeChange(tx, item.pageId, follow.last_digest_at, now);
      if (!change) continue;
      const titleRow = await tx.query<{ title: string }>("SELECT title FROM hs_pages WHERE id=$1 AND deleted_at IS NULL", [item.pageId]);
      const title = oneLine(titleRow.rows[0]?.title ?? "");
      if (!title) continue;
      const lines = [title, `${change.editor} · ${change.atIst}`, change.summary, ...change.notes.map(note => `Published: ${note}`), `/pages/${encodeURIComponent(item.pageId)}`, "Unsubscribe", unsubscribePath(signPageUnsubscribe(userId, item.pageId, now))];
      sections.push(section(lines));
      await tx.query(
        "INSERT INTO hs_notifications(id, recipient_id, page_id, kind, summary) VALUES($1,$2,$3,'page-digest',$4)",
        [randomUUID(), userId, item.pageId, [change.summary, ...change.notes.map(note => `Published: ${note}`)].filter(Boolean).join("\n")],
      );
    }
    for (const pageId of bumped) {
      if (removed.has(pageId)) continue;
      await tx.query("UPDATE hs_page_follows SET last_digest_at=$3, updated_at=clock_timestamp() WHERE user_id=$1 AND page_id=$2", [userId, pageId, now]);
    }
    if (!sections.length) return false;
    let chosen = sections;
    let body = ["Page changes", "", chosen.join("\n\n")].join("\n");
    while (body.length > 19000 && chosen.length > 1) {
      chosen = chosen.slice(0, -1);
      body = ["Page changes", "", chosen.join("\n\n")].join("\n");
    }
    if (body.length > 20000) body = body.slice(0, 20000);
    await tx.query(
      "INSERT INTO hs_page_digest_mail(id, user_id, kind, window_key, subject, body) VALUES($1,$2,'digest',$3,$4,$5)",
      [randomUUID(), userId, windowKey, "Page changes", body],
    );
    await audit(tx, userId, "page-follow.digest", null, randomUUID(), { pages: sections.length, atIst: formatIst(now) });
    return true;
  });
}

export async function runPageFollowDigests(r: Repository, now = new Date(), hooks?: { afterBuild?: (draft: { userId: string; pageIds: string[] }) => Promise<void> }) {
  const users = await r.db.query<{ id: string; timezone: string }>(
    "SELECT DISTINCT u.id, u.timezone FROM hs_users u JOIN hs_page_follows f ON f.user_id = u.id ORDER BY u.id",
  );
  let delivered = 0;
  let considered = 0;
  for (const user of users.rows) {
    const zone = followTimeZone(user.timezone);
    const draft = await r.db.transaction(tx => buildDraft(tx, user.id, zone, now));
    if (!draft.items.length) continue;
    considered += 1;
    if (hooks?.afterBuild) await hooks.afterBuild({ userId: user.id, pageIds: draft.items.map(item => item.pageId) });
    if (await deliverDigest(r, user.id, zone, draft.items, now)) delivered += 1;
  }
  return { delivered, deferred: considered === 0, considered };
}

export async function presentFollowNotification(r: Repository, actor: Actor, pageId: string, summary: string | null) {
  try {
    const page = await r.get(pageId, actor);
    return { pageTitle: page.title, body: summary, readable: true, removed: false };
  } catch (error) {
    if (!(error instanceof DocumentError && error.status === 404)) throw error;
  }
  const meta = await pageMeta(r.db, pageId, actor.id);
  if (meta?.trashed) {
    return { pageTitle: meta.restorer && meta.title ? meta.title : REMOVED_FOLLOW, body: REMOVED_FOLLOW, readable: false, removed: true };
  }
  return { pageTitle: PAGE_HIDDEN, body: null, readable: false, removed: false };
}
