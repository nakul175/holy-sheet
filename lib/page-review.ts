import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, stableStringify } from "./document";
import { formatIst } from "./ist-label";
import {
  EXPIRED_BANNER,
  NOT_ALLOWED,
  OWNER_NEEDED,
  PAGE_HIDDEN,
  SPACE_HIDDEN,
  addCalendarMonths,
  calendarDaysBetween,
  classifyReview,
  formatReviewDate,
  istCalendarDate,
  nextReviewHeader,
  parseCalendarDate,
  reminderPlan,
  reviewCsvCell,
  reviewIsVerified,
  reviewJobReady,
  searchHitPageId,
  type ReviewFilter,
  type ReviewSearchHit,
  isReviewFilter,
} from "./page-review-copy";
import type { Repository } from "./repository";

const hidden = () => new DocumentError(PAGE_HIDDEN, "not_found", 404);
const spaceHidden = () => new DocumentError(SPACE_HIDDEN, "not_found", 404);
const workspaceHidden = () => new DocumentError("Workspace is restricted or unavailable", "not_found", 404);
const notAllowed = () => new DocumentError(NOT_ALLOWED, "not_allowed", 403);
const mismatch = () => new DocumentError("This review attempt was reused with different fields.", "operation_mismatch", 409);
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pageCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), operationId: z.string().uuid(), cycleMonths: z.number().int().min(1).max(120), startsOn: dateField, expiresOn: dateField }).strict(),
  z.object({ action: z.literal("mark-reviewed"), operationId: z.string().uuid(), note: z.string().min(1).max(500) }).strict(),
]);
const policyCommand = z.object({ action: z.literal("policy"), operationId: z.string().uuid(), hideExpiredFromReaders: z.boolean() }).strict();

type StoredPage = { id: string; workspace_id: string; space_id: string; owner_id: string; title: string; role: string };
type ReviewRow = {
  page_id: string;
  cycle_months: number;
  cycle_start_on: string | Date;
  next_review_on: string | Date;
  expires_on: string | Date;
  last_reviewed_by: string | null;
  last_reviewed_at: string | Date | null;
  last_review_note: string | null;
  reviewer_name: string | null;
};
type DashboardRow = {
  id: string;
  title: string;
  owner_id: string;
  owner_name: string;
  owner_active: boolean;
  cycle_months: number;
  next_review_on: string | Date;
  expires_on: string | Date;
  last_reviewed_at: string | Date | null;
};

export type PageReviewView = {
  pageId: string;
  canManage: boolean;
  cycleMonths: number | null;
  startsOn: string | null;
  nextReviewOn: string | null;
  expiresOn: string | null;
  header: string | null;
  banner: string | null;
  badge: string | null;
  verified: boolean;
  overdue: boolean;
  expired: boolean;
  reviewerName: string | null;
  reviewedAtIst: string | null;
  note: string | null;
  coversPublishedVersion: boolean;
};

export type SpaceReviewEntry = {
  pageId: string;
  title: string;
  ownerId: string;
  ownerLabel: string;
  ownerNeeded: boolean;
  cycleMonths: number;
  nextReviewOn: string;
  nextReviewLabel: string;
  expiresOn: string;
  expiresLabel: string;
  lastReviewedAtIst: string | null;
  statuses: string[];
};

export type SpaceReviewDashboard = {
  workspaceId: string;
  spaceId: string;
  spaceName: string;
  filter: ReviewFilter;
  canManagePolicy: boolean;
  hideExpiredFromReaders: boolean;
  counts: { due: number; overdue: number; expired: number; scheduled: number };
  rows: SpaceReviewEntry[];
};

const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");

export function calendarDate(value: string | Date | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match ? match[1] : String(value);
}

function requireDate(value: string, message: string) {
  const parsed = parseCalendarDate(value);
  if (!parsed) throw new DocumentError(message, "review_validation", 400);
  return parsed;
}

async function readable(r: Repository, tx: Sql, pageId: string, actor: Actor, lock = false) {
  try {
    return await r.access(tx, pageId, actor, false, lock) as StoredPage;
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) throw hidden();
    throw error;
  }
}

async function reviewRow(tx: Sql, pageId: string, lock = false) {
  const rows = await tx.query<ReviewRow>(`SELECT rv.page_id, rv.cycle_months, rv.cycle_start_on, rv.next_review_on, rv.expires_on,
    rv.last_reviewed_by, rv.last_reviewed_at, rv.last_review_note, u.name AS reviewer_name
    FROM hs_page_review rv LEFT JOIN hs_users u ON u.id = rv.last_reviewed_by
    WHERE rv.page_id = $1 ${lock ? "FOR UPDATE OF rv" : ""}`, [pageId]);
  return rows.rows[0] ?? null;
}

async function published(tx: Sql, pageId: string) {
  const rows = await tx.query<{ publication_id: string | null }>("SELECT publication_id FROM hs_document_workflows WHERE page_id = $1", [pageId]);
  return Boolean(rows.rows[0]?.publication_id);
}

function present(pageId: string, canManage: boolean, row: ReviewRow | null, coversPublishedVersion: boolean, today: string): PageReviewView {
  if (!row) {
    return { pageId, canManage, cycleMonths: null, startsOn: null, nextReviewOn: null, expiresOn: null, header: null, banner: null, badge: null, verified: false, overdue: false, expired: false, reviewerName: null, reviewedAtIst: null, note: null, coversPublishedVersion };
  }
  const nextReviewOn = calendarDate(row.next_review_on)!;
  const expiresOn = calendarDate(row.expires_on)!;
  const startsOn = calendarDate(row.cycle_start_on)!;
  const state = classifyReview(today, nextReviewOn, expiresOn);
  const verified = reviewIsVerified(today, nextReviewOn, expiresOn, Boolean(row.last_reviewed_at));
  return {
    pageId,
    canManage,
    cycleMonths: row.cycle_months,
    startsOn,
    nextReviewOn,
    expiresOn,
    header: nextReviewHeader(nextReviewOn),
    banner: state.expired ? EXPIRED_BANNER : null,
    badge: verified ? "Verified" : state.overdue && !state.expired ? "Overdue" : null,
    verified,
    overdue: state.overdue,
    expired: state.expired,
    reviewerName: verified || canManage ? row.reviewer_name : null,
    reviewedAtIst: (verified || canManage) && row.last_reviewed_at ? formatIst(row.last_reviewed_at) : null,
    note: canManage ? row.last_review_note : null,
    coversPublishedVersion,
  };
}

async function audit(tx: Sql, actorId: string, action: string, pageId: string | null, operationId: string, after: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), actorId, action, pageId, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId]);
}

function storedResult(value: unknown) {
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>;
}

export async function pageReviewView(r: Repository, actor: Actor, pageId: string, now = new Date()): Promise<PageReviewView> {
  return r.db.transaction(async tx => {
    const page = await readable(r, tx, pageId, actor);
    const row = await reviewRow(tx, pageId);
    return present(page.id, page.role === "owner", row, await published(tx, pageId), istCalendarDate(now));
  });
}

type ReviewWrite =
  | { pageId: string; cycleMonths: number; startsOn: string; nextReviewOn: string; expiresOn: string; header: string; replayed: boolean }
  | { pageId: string; nextReviewOn: string; header: string; reviewedAtIst: string; reviewerId: string; replayed: boolean };

export async function changePageReview(r: Repository, actor: Actor, pageId: string, input: unknown, now = new Date()): Promise<ReviewWrite> {
  const parsed = pageCommand.safeParse(input);
  if (!parsed.success) throw new DocumentError("Invalid review operation", "invalid_review", 400);
  const command = parsed.data;
  const requestHash = hash(command);
  return r.db.transaction(async tx => {
    const page = await readable(r, tx, pageId, actor, true);
    if (page.role !== "owner") throw notAllowed();
    const prior = await tx.query<{ actor_id: string; request_hash: string; result: unknown }>("SELECT actor_id, request_hash, result FROM hs_page_review_operations WHERE page_id = $1 AND operation_id = $2", [pageId, command.operationId]);
    if (prior.rows.length) {
      const previous = prior.rows[0];
      if (previous.actor_id !== actor.id || previous.request_hash !== requestHash) throw mismatch();
      return { ...storedResult(previous.result), replayed: true } as ReviewWrite;
    }
    const today = istCalendarDate(now);
    if (command.action === "set") {
      const startsOn = requireDate(command.startsOn, "Choose a start date.");
      const expiresOn = requireDate(command.expiresOn, "Choose an expiry date.");
      const nextReviewOn = addCalendarMonths(startsOn, command.cycleMonths);
      await tx.query(`INSERT INTO hs_page_review(page_id, cycle_months, cycle_start_on, next_review_on, expires_on)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(page_id) DO UPDATE SET cycle_months = EXCLUDED.cycle_months, cycle_start_on = EXCLUDED.cycle_start_on, next_review_on = EXCLUDED.next_review_on, expires_on = EXCLUDED.expires_on`, [pageId, command.cycleMonths, startsOn, nextReviewOn, expiresOn]);
      const result = { pageId, cycleMonths: command.cycleMonths, startsOn, nextReviewOn, expiresOn, header: nextReviewHeader(nextReviewOn), replayed: false };
      await tx.query("INSERT INTO hs_page_review_operations(page_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5)", [pageId, command.operationId, actor.id, requestHash, JSON.stringify(result)]);
      await audit(tx, actor.id, "page-review.set", pageId, command.operationId, { pageId, cycleMonths: command.cycleMonths, startsOn, nextReviewOn, expiresOn });
      return result;
    }
    const note = command.note.trim();
    if (!note) throw new DocumentError("Add a review note.", "review_validation", 400);
    const current = await reviewRow(tx, pageId, true);
    if (!current) throw new DocumentError("Set a review cycle before marking this page reviewed.", "review_missing", 422);
    const nextReviewOn = addCalendarMonths(calendarDate(current.next_review_on)!, current.cycle_months);
    const reviewedAt = now;
    await tx.query("UPDATE hs_page_review SET next_review_on = $2, last_reviewed_by = $3, last_reviewed_at = $4, last_review_note = $5 WHERE page_id = $1", [pageId, nextReviewOn, actor.id, reviewedAt.toISOString(), note]);
    const result = { pageId, nextReviewOn, header: nextReviewHeader(nextReviewOn), reviewedAtIst: formatIst(reviewedAt), reviewerId: actor.id, replayed: false };
    await tx.query("INSERT INTO hs_page_review_operations(page_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5)", [pageId, command.operationId, actor.id, requestHash, JSON.stringify(result)]);
    await audit(tx, actor.id, "page-review.mark", pageId, command.operationId, { pageId, nextReviewOn, cycleMonths: current.cycle_months, reviewerId: actor.id });
    return result;
  });
}

type SpaceScope = { id: string; name: string; workspace_id: string; workspace_role: string; space_role: string | null };

async function spaceScope(tx: Sql, workspaceId: string, spaceId: string, actor: Actor) {
  const rows = await tx.query<SpaceScope>(`SELECT s.id, s.name, s.workspace_id, m.role AS workspace_role, sm.role AS space_role
    FROM hs_spaces s
    JOIN hs_workspaces w ON w.id = s.workspace_id
    JOIN hs_members m ON m.workspace_id = w.id AND m.user_id = $3 AND m.active = true
    LEFT JOIN hs_space_members sm ON sm.space_id = s.id AND sm.user_id = $3 AND sm.active = true
    WHERE s.id = $1 AND w.id = $2`, [spaceId, workspaceId, actor.id]);
  return rows.rows[0] ?? null;
}

async function canManagePolicy(tx: Sql, scope: SpaceScope, actor: Actor) {
  if (scope.workspace_role === "owner" || scope.workspace_role === "admin" || scope.space_role === "leader") return true;
  const owned = await tx.query("SELECT id FROM hs_pages WHERE space_id = $1 AND workspace_id = $2 AND owner_id = $3 AND deleted_at IS NULL LIMIT 1", [scope.id, scope.workspace_id, actor.id]);
  return owned.rows.length > 0;
}

function entry(row: DashboardRow, today: string): SpaceReviewEntry {
  const nextReviewOn = calendarDate(row.next_review_on)!;
  const expiresOn = calendarDate(row.expires_on)!;
  const state = classifyReview(today, nextReviewOn, expiresOn);
  const statuses = (["expired", "overdue", "due", "scheduled"] as const).filter(status => state[status]);
  const ownerNeeded = !row.owner_active;
  return {
    pageId: row.id,
    title: row.title,
    ownerId: row.owner_id,
    ownerLabel: ownerNeeded ? OWNER_NEEDED : row.owner_name,
    ownerNeeded,
    cycleMonths: row.cycle_months,
    nextReviewOn,
    nextReviewLabel: formatReviewDate(nextReviewOn),
    expiresOn,
    expiresLabel: formatReviewDate(expiresOn),
    lastReviewedAtIst: row.last_reviewed_at ? formatIst(row.last_reviewed_at) : null,
    statuses,
  };
}

function matches(filter: ReviewFilter, row: SpaceReviewEntry) {
  if (filter === "all") return true;
  if (filter === "open") return row.statuses.some(status => status !== "scheduled");
  return row.statuses.includes(filter);
}

async function dashboardRows(r: Repository, tx: Sql, actor: Actor, scope: SpaceScope, now: Date) {
  const today = istCalendarDate(now);
  const rows = await tx.query<DashboardRow>(`SELECT p.id, p.title, p.owner_id, u.name AS owner_name,
      EXISTS(SELECT 1 FROM hs_members m WHERE m.workspace_id = p.workspace_id AND m.user_id = p.owner_id AND m.active = true) AS owner_active,
      rv.cycle_months, rv.next_review_on, rv.expires_on, rv.last_reviewed_at
    FROM hs_page_review rv
    JOIN hs_pages p ON p.id = rv.page_id
    JOIN hs_users u ON u.id = p.owner_id
    WHERE p.space_id = $1 AND p.workspace_id = $2 AND p.deleted_at IS NULL
    ORDER BY rv.next_review_on, p.id
    LIMIT 1001`, [scope.id, scope.workspace_id]);
  const visible: SpaceReviewEntry[] = [];
  for (const row of rows.rows) {
    try {
      await r.access(tx, row.id, actor);
    } catch (error) {
      if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) continue;
      throw error;
    }
    visible.push(entry(row, today));
  }
  return visible;
}

export async function spaceReviewDashboard(r: Repository, actor: Actor, workspaceId: string, spaceId: string, filterInput: string | null, now = new Date()): Promise<SpaceReviewDashboard> {
  if (!isReviewFilter(filterInput ?? "open")) throw new DocumentError("Choose a review filter.", "review_validation", 400);
  const filter = (filterInput ?? "open") as ReviewFilter;
  return r.db.transaction(async tx => {
    const scope = await spaceScope(tx, workspaceId, spaceId, actor);
    if (!scope) throw spaceHidden();
    const rows = await dashboardRows(r, tx, actor, scope, now);
    const policy = await tx.query<{ hide_expired_from_readers: boolean }>("SELECT hide_expired_from_readers FROM hs_space_review_policy WHERE space_id = $1", [scope.id]);
    const counts = { due: 0, overdue: 0, expired: 0, scheduled: 0 };
    for (const row of rows) for (const status of row.statuses) if (status === "due" || status === "overdue" || status === "expired" || status === "scheduled") counts[status] += 1;
    return {
      workspaceId: scope.workspace_id,
      spaceId: scope.id,
      spaceName: scope.name,
      filter,
      canManagePolicy: await canManagePolicy(tx, scope, actor),
      hideExpiredFromReaders: Boolean(policy.rows[0]?.hide_expired_from_readers),
      counts,
      rows: rows.filter(row => matches(filter, row)),
    };
  });
}

export async function spaceReviewCsv(r: Repository, actor: Actor, workspaceId: string, spaceId: string, filterInput: string | null, now = new Date()) {
  const dashboard = await spaceReviewDashboard(r, actor, workspaceId, spaceId, filterInput, now);
  const header = ["page_id", "title", "status", "owner", "next_review_on", "expires_on", "last_reviewed_at_ist", "cycle_months"];
  const lines = [header.join(","), ...dashboard.rows.map(row => [row.pageId, row.title, row.statuses.join("|"), row.ownerLabel, row.nextReviewOn, row.expiresOn, row.lastReviewedAtIst ?? "", String(row.cycleMonths)].map(reviewCsvCell).join(","))];
  return { body: `${lines.join("\n")}\n`, filename: "page-reviews.csv", contentType: "text/csv; charset=utf-8" };
}

export async function changeSpaceReviewPolicy(r: Repository, actor: Actor, workspaceId: string, spaceId: string, input: unknown) {
  const parsed = policyCommand.safeParse(input);
  if (!parsed.success) throw new DocumentError("Invalid review operation", "invalid_review", 400);
  const command = parsed.data;
  const requestHash = hash(command);
  return r.db.transaction(async tx => {
    const scope = await spaceScope(tx, workspaceId, spaceId, actor);
    if (!scope) throw spaceHidden();
    if (!await canManagePolicy(tx, scope, actor)) throw notAllowed();
    const prior = await tx.query<{ actor_id: string; request_hash: string; result: unknown }>("SELECT actor_id, request_hash, result FROM hs_space_review_operations WHERE space_id = $1 AND operation_id = $2", [spaceId, command.operationId]);
    if (prior.rows.length) {
      const previous = prior.rows[0];
      if (previous.actor_id !== actor.id || previous.request_hash !== requestHash) throw mismatch();
      return { ...storedResult(previous.result), replayed: true };
    }
    await tx.query(`INSERT INTO hs_space_review_policy(space_id, hide_expired_from_readers, updated_by, updated_at)
      VALUES($1,$2,$3,clock_timestamp())
      ON CONFLICT(space_id) DO UPDATE SET hide_expired_from_readers = EXCLUDED.hide_expired_from_readers, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()`, [spaceId, command.hideExpiredFromReaders, actor.id]);
    const result = { spaceId, hideExpiredFromReaders: command.hideExpiredFromReaders, replayed: false };
    await tx.query("INSERT INTO hs_space_review_operations(space_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5)", [spaceId, command.operationId, actor.id, requestHash, JSON.stringify(result)]);
    await audit(tx, actor.id, "page-review.policy", null, command.operationId, { spaceId, hideExpiredFromReaders: command.hideExpiredFromReaders });
    return result;
  });
}

async function memberActive(tx: Sql, workspaceId: string, userId: string) {
  const rows = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id = $1 AND user_id = $2 AND active = true", [workspaceId, userId]);
  return rows.rows.length > 0;
}

async function reminderRecipient(tx: Sql, workspaceId: string, spaceId: string, ownerId: string) {
  if (await memberActive(tx, workspaceId, ownerId)) return { recipientId: ownerId, rerouted: false };
  const leader = await tx.query<{ user_id: string }>(`SELECT sm.user_id FROM hs_space_members sm
    JOIN hs_members m ON m.workspace_id = $2 AND m.user_id = sm.user_id AND m.active = true
    WHERE sm.space_id = $1 AND sm.role = 'leader' AND sm.active = true
    ORDER BY sm.created_at, sm.user_id LIMIT 1`, [spaceId, workspaceId]);
  if (leader.rows[0]) return { recipientId: leader.rows[0].user_id, rerouted: true };
  const owner = await tx.query<{ user_id: string }>("SELECT user_id FROM hs_members WHERE workspace_id = $1 AND role = 'owner' AND active = true ORDER BY user_id LIMIT 1", [workspaceId]);
  if (owner.rows[0]) return { recipientId: owner.rows[0].user_id, rerouted: true };
  return null;
}

export async function runWorkspacePageReviewReminders(r: Repository, actor: Actor, workspaceId: string, now = new Date()) {
  const member = await r.db.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id = $1 AND user_id = $2 AND active = true", [workspaceId, actor.id]);
  if (!member.rows.length) throw workspaceHidden();
  if (member.rows[0].role !== "owner" && member.rows[0].role !== "admin") throw notAllowed();
  return runPageReviewReminders(r, now, workspaceId);
}

export async function runPageReviewReminders(r: Repository, now = new Date(), workspaceId?: string) {
  if (!reviewJobReady(now)) return { sent: 0, deferred: true };
  const today = istCalendarDate(now);
  return r.db.transaction(async tx => {
    const pages = await tx.query<{ id: string; workspace_id: string; space_id: string; owner_id: string; next_review_on: string | Date }>(`SELECT p.id, p.workspace_id, p.space_id, p.owner_id, rv.next_review_on
      FROM hs_page_review rv JOIN hs_pages p ON p.id = rv.page_id
      WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.workspace_id = $1)
      ORDER BY p.id
      FOR UPDATE OF rv`, [workspaceId ?? null]);
    let sent = 0;
    for (const page of pages.rows) {
      const nextReviewOn = calendarDate(page.next_review_on);
      if (!nextReviewOn) continue;
      const plan = reminderPlan(today, nextReviewOn);
      if (!plan) continue;
      const existing = await tx.query("SELECT id FROM hs_page_review_reminders WHERE page_id = $1 AND slot = $2", [page.id, plan.slot]);
      if (existing.rows.length) continue;
      const recipient = await reminderRecipient(tx, page.workspace_id, page.space_id, page.owner_id);
      if (!recipient) continue;
      const reminderId = randomUUID();
      await tx.query("INSERT INTO hs_page_review_reminders(id, page_id, recipient_id, slot, ist_date) VALUES($1,$2,$3,$4,$5)", [reminderId, page.id, recipient.recipientId, plan.slot, today]);
      await tx.query("INSERT INTO hs_notifications(id, recipient_id, page_id, kind, summary) VALUES($1,$2,$3,'page-review-reminder',$4)", [randomUUID(), recipient.recipientId, page.id, plan.summary]);
      await audit(tx, recipient.recipientId, "page-review.remind", page.id, reminderId, { pageId: page.id, slot: plan.slot, recipientId: recipient.recipientId, rerouted: recipient.rerouted });
      sent += 1;
    }
    return { sent, deferred: false };
  });
}

const hiddenExpiredSql = `SELECT p.id
  FROM hs_pages p
  JOIN hs_page_review rv ON rv.page_id = p.id
  JOIN hs_space_review_policy pol ON pol.space_id = p.space_id AND pol.hide_expired_from_readers
  JOIN hs_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2 AND m.active = true
  WHERE p.id = ANY($1::text[]) AND p.deleted_at IS NULL AND rv.expires_on < $3::date
    AND (m.role = 'observer' OR (m.role NOT IN ('owner', 'admin') AND p.owner_id <> $2 AND NOT EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, visibility, owner_id, ARRAY[id] AS path FROM hs_pages WHERE id = p.id AND deleted_at IS NULL
        UNION ALL
        SELECT parent.id, parent.parent_id, parent.visibility, parent.owner_id, a.path || parent.id
        FROM hs_pages parent JOIN ancestors a ON parent.id = a.parent_id
        WHERE parent.deleted_at IS NULL AND parent.workspace_id = p.workspace_id AND NOT parent.id = ANY(a.path)
      )
      SELECT 1 FROM ancestors a
      LEFT JOIN hs_grants g ON g.page_id = a.id AND (g.subject = $2 OR (a.visibility = 'space' AND g.subject = 'space'))
      WHERE a.owner_id = $2 OR g.role = 'editor'
    )))`;

export async function decorateReviewSearch<T extends ReviewSearchHit>(tx: Sql, actor: Actor, ranked: string[], extras: T[], now = new Date()) {
  const pageIds = new Set<string>();
  for (const id of ranked) if (!id.includes(":")) pageIds.add(id);
  const extraPages = new Map<string, string>();
  for (const extra of extras) {
    const pageId = searchHitPageId(extra);
    if (!pageId) continue;
    pageIds.add(pageId);
    extraPages.set(extra.id, pageId);
  }
  const expired = new Set<string>();
  const hidden = new Set<string>();
  if (pageIds.size) {
    const ids = [...pageIds];
    const today = istCalendarDate(now);
    const expiredRows = await tx.query<{ page_id: string }>("SELECT page_id FROM hs_page_review WHERE page_id = ANY($1::text[]) AND expires_on < $2::date", [ids, today]);
    for (const row of expiredRows.rows) expired.add(row.page_id);
    const hiddenRows = await tx.query<{ id: string }>(hiddenExpiredSql, [ids, actor.id, today]);
    for (const row of hiddenRows.rows) hidden.add(row.id);
  }
  return {
    ranked: ranked.filter(id => {
      const pageId = id.includes(":") ? extraPages.get(id) : id;
      return !pageId || !hidden.has(pageId);
    }),
    extras: extras.filter(extra => {
      const pageId = extraPages.get(extra.id);
      return !pageId || !hidden.has(pageId);
    }).map(extra => {
      const pageId = extraPages.get(extra.id);
      return pageId && expired.has(pageId) ? { ...extra, badge: EXPIRED_BANNER } : extra;
    }),
    expired,
  };
}

export { EXPIRED_BANNER };
