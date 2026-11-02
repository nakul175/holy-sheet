import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, stableStringify } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { canEdit } from "./types";

export const HANDOVER_BATCH = 10;
export const PAGE_HIDDEN = "Page is restricted or unavailable";
export const WORKSPACE_HIDDEN = "Workspace is restricted or unavailable";
export const PERSON_HIDDEN = "That person is unavailable";
export const HANDOVER_HIDDEN = "That handover is unavailable";
export const ADMIN_REQUIRED = "Workspace administrator access required";
export const OWNER_CHANGE_FORBIDDEN = "You cannot change the owner of this page.";
export const HANDOVER_REVIEW = "Review the handover and try again.";
export const TRASH_OPT_IN = "Trashed pages are listed separately. Include trash to transfer them.";
export const EDIT_DECISION = "Choose grant or skip for pages the recipient cannot edit.";
const PAGE_LIMIT = 1000;

const operationId = z.string().uuid();
const userId = z.string().min(1).max(200);
const decision = z.object({ pageId: z.string().min(1).max(200), decision: z.enum(["transfer", "grant", "skip"]) }).strict();
const decisions = z.array(decision).max(PAGE_LIMIT);
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), fromUserId: userId, toUserId: userId }).strict(),
  z.object({ action: z.literal("preview-ownerless"), toUserId: userId }).strict(),
  z.object({ action: z.literal("start"), operationId, fromUserId: userId, toUserId: userId, includeTrashed: z.boolean(), decisions }).strict(),
  z.object({ action: z.literal("assign"), operationId, toUserId: userId, includeTrashed: z.boolean(), decisions }).strict(),
  z.object({ action: z.literal("resume"), operationId, jobId: z.string().uuid() }).strict(),
]);
const ownerCommand = z.object({ operationId, ownerId: userId }).strict();

export type OwnerDecision = "transfer" | "grant" | "skip";
export type OwnerPerson = { id: string; name: string; avatar: string };
export type OwnerView = { owner: OwnerPerson; canChange: boolean; canHandover: boolean; candidates?: OwnerPerson[] };
export type OwnerChange = OwnerView & { replayed: boolean; atIst: string };
export type HandoverPage = { pageId: string; title: string; trashed: boolean; recipientCanEdit: boolean };
export type HandoverPreview = { from: OwnerPerson | null; to: OwnerPerson; pages: HandoverPage[]; trashed: HandoverPage[] };
export type OwnerlessReport = { pages: { pageId: string; title: string }[]; trashed: { pageId: string; title: string }[] };
export type HandoverItem = {
  pageId: string;
  trashed: boolean;
  hadEdit: boolean;
  decision: OwnerDecision;
  disposition: "pending" | "transferred" | "granted" | "skipped" | "failed";
  code: string | null;
};
export type HandoverJob = {
  jobId: string;
  state: "running" | "completed";
  replayed: boolean;
  version: number;
  atIst: string;
  counts: { transferred: number; granted: number; skipped: number; failed: number; pending: number };
  items: HandoverItem[];
};

type Planned = HandoverPage & { ownerId: string };
type JobRow = { id: string; to_user_id: string; kind: "handover" | "ownerless"; state: "running" | "completed"; version: number };
type ItemRow = {
  page_id: string;
  ordinal: number;
  trashed: boolean;
  had_edit: boolean;
  decision: OwnerDecision;
  expected_owner_id: string;
  disposition: HandoverItem["disposition"];
  code: string | null;
};

const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const pageHidden = () => new DocumentError(PAGE_HIDDEN, "not_found", 404);
const workspaceHidden = () => new DocumentError(WORKSPACE_HIDDEN, "not_found", 404);
const personHidden = () => new DocumentError(PERSON_HIDDEN, "not_found", 404);
const handoverHidden = () => new DocumentError(HANDOVER_HIDDEN, "not_found", 404);
const adminRequired = () => new DocumentError(ADMIN_REQUIRED, "admin_required", 403);
const ownerForbidden = () => new DocumentError(OWNER_CHANGE_FORBIDDEN, "not_allowed", 403);
const invalid = (message = HANDOVER_REVIEW) => new DocumentError(message, "invalid_handover", 422);
const mismatch = () => new DocumentError("This handover attempt was reused with different fields.", "operation_mismatch", 409);
const ownerInvalid = () => new DocumentError("Review the owner change and try again.", "invalid_owner", 400);
const ownerMismatch = () => new DocumentError("This owner change was reused with different fields.", "operation_mismatch", 409);

export function ownerAvatar(name: string) {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase("en") : "?";
}

export function handoverPrompt(name: string, count: number) {
  return `${name} owned ${count} pages — start handover`;
}

function stored<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function batchOf(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : HANDOVER_BATCH;
}

function person(id: string, name: string): OwnerPerson {
  return { id, name, avatar: ownerAvatar(name) };
}

async function audit(tx: Sql, actorId: string, action: string, pageId: string | null, correlationId: string, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id, actor_id, action, page_id, subject_id, after_value, correlation_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
    [randomUUID(), actorId, action, pageId, typeof after.toOwnerId === "string" ? after.toOwnerId : null, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), correlationId],
  );
}

async function requireAdmin(tx: Sql, workspaceId: string, actor: Actor) {
  const row = await tx.query<{ role: string }>(
    `SELECT m.role FROM hs_workspaces w
     JOIN hs_members m ON m.workspace_id = w.id AND m.user_id = $2 AND m.active = true
     WHERE w.id = $1`,
    [workspaceId, actor.id],
  );
  if (!row.rows.length) throw workspaceHidden();
  if (row.rows[0].role !== "owner" && row.rows[0].role !== "admin") throw adminRequired();
}

async function lockWorkspace(tx: Sql, workspaceId: string) {
  await tx.query("SELECT id FROM hs_workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
}

async function actorCanSee(r: Repository, tx: Sql, pageId: string, actor: Actor) {
  try {
    await r.access(tx, pageId, actor);
    return true;
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) return false;
    throw error;
  }
}

async function recipientCanEdit(r: Repository, tx: Sql, pageId: string, userId: string, trashed: boolean) {
  if (!trashed) {
    try {
      return canEdit((await r.access(tx, pageId, { id: userId })).role);
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) return false;
      throw error;
    }
  }
  const row = await tx.query<{ role: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, workspace_id, visibility, owner_id, ARRAY[id] AS path FROM hs_pages WHERE id=$1
       UNION ALL SELECT p.id, p.parent_id, p.workspace_id, p.visibility, p.owner_id, a.path||p.id
       FROM hs_pages p JOIN ancestors a ON p.id=a.parent_id AND p.workspace_id=a.workspace_id
       WHERE p.deleted_at IS NULL AND NOT p.id=ANY(a.path)
     )
     SELECT CASE
       WHEN m.user_id IS NULL OR m.active IS NOT TRUE THEN 'none'
       WHEN m.role='observer' THEN 'viewer'
       WHEN target.owner_id=$2 THEN 'owner'
       WHEN m.role IN ('owner','admin') THEN 'editor'
       WHEN EXISTS (
         SELECT 1 FROM ancestors a
         LEFT JOIN hs_grants g ON g.page_id=a.id AND (g.subject=$2 OR (a.visibility='space' AND g.subject='space'))
         WHERE a.owner_id=$2 OR g.role='editor'
       ) THEN 'editor'
       ELSE 'viewer'
     END AS role
     FROM hs_pages target
     LEFT JOIN hs_members m ON m.workspace_id=target.workspace_id AND m.user_id=$2
     WHERE target.id=$1`,
    [pageId, userId],
  );
  return canEdit(row.rows[0]?.role ?? "none");
}

async function workspaceMember(tx: Sql, workspaceId: string, id: string) {
  const row = await tx.query<{ id: string; name: string; active: boolean; role: string }>(
    `SELECT u.id, u.name, m.active, m.role FROM hs_members m JOIN hs_users u ON u.id=m.user_id
     WHERE m.workspace_id=$1 AND m.user_id=$2`,
    [workspaceId, id],
  );
  return row.rows[0] ?? null;
}

async function requireRecipient(tx: Sql, workspaceId: string, id: string) {
  const member = await workspaceMember(tx, workspaceId, id);
  if (!member) throw personHidden();
  if (!member.active) throw invalid("Choose an active member of this workspace.");
  if (member.role === "observer") throw invalid("Choose a member who can edit pages in this workspace.");
  return member;
}

async function requireSource(tx: Sql, workspaceId: string, id: string) {
  const member = await workspaceMember(tx, workspaceId, id);
  if (!member) throw personHidden();
  if (member.role === "observer" && member.active) throw invalid("Choose a member who owns pages in this workspace.");
  return member;
}

async function sourcePages(tx: Sql, workspaceId: string, fromUserId: string | null) {
  const rows = fromUserId
    ? await tx.query<{ id: string; title: string; owner_id: string; trashed: boolean }>(
      `SELECT id, title, owner_id, deleted_at IS NOT NULL AS trashed FROM hs_pages
       WHERE workspace_id=$1 AND owner_id=$2 ORDER BY id LIMIT ${PAGE_LIMIT + 1}`,
      [workspaceId, fromUserId],
    )
    : await tx.query<{ id: string; title: string; owner_id: string; trashed: boolean }>(
      `SELECT p.id, p.title, p.owner_id, p.deleted_at IS NOT NULL AS trashed FROM hs_pages p
       WHERE p.workspace_id=$1 AND NOT EXISTS (
         SELECT 1 FROM hs_members m WHERE m.workspace_id=p.workspace_id AND m.user_id=p.owner_id AND m.active=true
       ) ORDER BY p.id LIMIT ${PAGE_LIMIT + 1}`,
      [workspaceId],
    );
  if (rows.rows.length > PAGE_LIMIT) throw invalid("This handover is limited to 1,000 pages. No pages were changed.");
  return rows.rows;
}

async function planPages(r: Repository, tx: Sql, actor: Actor, workspaceId: string, toUserId: string, fromUserId: string | null) {
  const rows = await sourcePages(tx, workspaceId, fromUserId);
  const live: Planned[] = [];
  const trashed: Planned[] = [];
  for (const row of rows) {
    if (!row.trashed && !await actorCanSee(r, tx, row.id, actor)) continue;
    const editable = await recipientCanEdit(r, tx, row.id, toUserId, row.trashed);
    const planned = { pageId: row.id, title: row.title, trashed: row.trashed, recipientCanEdit: editable, ownerId: row.owner_id };
    if (row.trashed) trashed.push(planned);
    else live.push(planned);
  }
  return { live, trashed };
}

function scopeOf(live: Planned[], trashed: Planned[], includeTrashed: boolean) {
  return includeTrashed ? [...live, ...trashed] : live;
}

function normalizeDecisions(value: { pageId: string; decision: OwnerDecision }[]) {
  const ids = new Set(value.map(item => item.pageId));
  if (ids.size !== value.length) throw invalid();
  return [...value].sort((a, b) => a.pageId.localeCompare(b.pageId));
}

async function explainExtra(r: Repository, tx: Sql, actor: Actor, workspaceId: string, pageId: string, includeTrashed: boolean) {
  const row = await tx.query<{ workspace_id: string; deleted_at: string | null }>("SELECT workspace_id, deleted_at FROM hs_pages WHERE id=$1", [pageId]);
  if (!row.rows.length || row.rows[0].workspace_id !== workspaceId) throw pageHidden();
  if (row.rows[0].deleted_at) {
    if (!includeTrashed) throw invalid(TRASH_OPT_IN);
    throw invalid();
  }
  if (!await actorCanSee(r, tx, pageId, actor)) throw pageHidden();
  throw invalid();
}

function decisionsFor(scope: Planned[], chosen: { pageId: string; decision: OwnerDecision }[]) {
  const byId = new Map(chosen.map(item => [item.pageId, item.decision]));
  if (byId.size !== scope.length || scope.some(page => !byId.has(page.pageId))) return null;
  return scope.map(page => ({ page, decision: byId.get(page.pageId)! }));
}

async function counts(tx: Sql, jobId: string) {
  const rows = await tx.query<{ disposition: HandoverItem["disposition"]; n: number }>(
    "SELECT disposition, count(*)::int AS n FROM hs_handover_items WHERE job_id=$1 GROUP BY disposition",
    [jobId],
  );
  const tally = { transferred: 0, granted: 0, skipped: 0, failed: 0, pending: 0 };
  for (const row of rows.rows) tally[row.disposition] = Number(row.n);
  return tally;
}

async function present(tx: Sql, job: JobRow, replayed: boolean): Promise<HandoverJob> {
  const items = await tx.query<ItemRow>(
    `SELECT page_id, ordinal, trashed, had_edit, decision, expected_owner_id, disposition, code
     FROM hs_handover_items WHERE job_id=$1 ORDER BY ordinal`,
    [job.id],
  );
  return {
    jobId: job.id,
    state: job.state,
    replayed,
    version: Number(job.version),
    atIst: formatIst(new Date()),
    counts: await counts(tx, job.id),
    items: items.rows.map(item => ({
      pageId: item.page_id,
      trashed: item.trashed,
      hadEdit: item.had_edit,
      decision: item.decision,
      disposition: item.disposition,
      code: item.code,
    })),
  };
}

async function remembered(tx: Sql, workspaceId: string, actorId: string, operation: string, requestHash: string) {
  const prior = await tx.query<{ request_hash: string; result: unknown }>(
    "SELECT request_hash, result FROM hs_handover_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3",
    [workspaceId, actorId, operation],
  );
  if (!prior.rows.length) return null;
  if (prior.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...stored<Omit<HandoverJob, "replayed">>(prior.rows[0].result), replayed: true };
}

async function remember(tx: Sql, workspaceId: string, actorId: string, operation: string, requestHash: string, jobId: string, result: HandoverJob) {
  const storedResult = { ...result, replayed: false };
  await tx.query(
    "INSERT INTO hs_handover_operations(workspace_id, actor_id, operation_id, request_hash, job_id, result) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [workspaceId, actorId, operation, requestHash, jobId, JSON.stringify(storedResult)],
  );
  return storedResult;
}

async function applyItem(r: Repository, tx: Sql, job: JobRow, workspaceId: string, item: ItemRow, operation: string, actorId: string) {
  const member = await tx.query<{ active: boolean; role: string }>(
    "SELECT active, role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
    [workspaceId, job.to_user_id],
  );
  const active = !!member.rows[0]?.active && member.rows[0]?.role !== "observer";
  let disposition: ItemRow["disposition"] = "skipped";
  let code: string | null = null;
  if (item.decision === "skip") {
    disposition = "skipped";
  } else if (!active) {
    disposition = "failed";
    code = "recipient_revoked";
  } else if (job.kind === "ownerless") {
    const restored = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, item.expected_owner_id]);
    if (restored.rows.length) {
      disposition = "failed";
      code = "owner_changed";
    }
  }
  if (disposition !== "failed" && item.decision !== "skip") {
    const can = item.decision === "grant" ? true : await recipientCanEdit(r, tx, item.page_id, job.to_user_id, item.trashed);
    if (!can) {
      disposition = "failed";
      code = "recipient_revoked";
    } else {
      const moved = await moveOwner(tx, item, workspaceId, job.to_user_id);
      if (!moved) {
        disposition = "failed";
        code = "owner_changed";
      } else {
        if (item.decision === "grant") {
          await tx.query(
            `INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'editor')
             ON CONFLICT(page_id, subject) DO UPDATE SET role='editor'`,
            [item.page_id, job.to_user_id],
          );
        }
        disposition = item.decision === "grant" ? "granted" : "transferred";
        code = null;
      }
    }
  }
  const settled = await tx.query(
    "UPDATE hs_handover_items SET disposition=$3, code=$4 WHERE job_id=$1 AND page_id=$2 AND disposition='pending' RETURNING page_id",
    [job.id, item.page_id, disposition, code],
  );
  if (!settled.rows.length) return;
  await audit(tx, actorId, "page-owner.handover", item.page_id, operation, {
    jobId: job.id,
    pageId: item.page_id,
    fromOwnerId: item.expected_owner_id,
    toOwnerId: job.to_user_id,
    decision: item.decision,
    disposition,
    code,
  });
}

async function moveOwner(tx: Sql, item: ItemRow, workspaceId: string, toUserId: string): Promise<boolean | "already"> {
  const locked = await tx.query<{ owner_id: string }>("SELECT owner_id FROM hs_pages WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [item.page_id, workspaceId]);
  if (!locked.rows.length) return false;
  if (locked.rows[0].owner_id === toUserId) return "already";
  if (locked.rows[0].owner_id !== item.expected_owner_id) return false;
  await tx.query("UPDATE hs_pages SET owner_id=$3, acl_version=acl_version+1, updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2", [item.page_id, workspaceId, toUserId]);
  return true;
}

async function settleJob(tx: Sql, jobId: string) {
  const pending = await tx.query("SELECT 1 FROM hs_handover_items WHERE job_id=$1 AND disposition='pending' LIMIT 1", [jobId]);
  if (pending.rows.length) {
    await tx.query("UPDATE hs_handover_jobs SET version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND state='running'", [jobId]);
  } else {
    await tx.query("UPDATE hs_handover_jobs SET state='completed', completed_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND state='running'", [jobId]);
  }
}

async function processJob(r: Repository, tx: Sql, job: JobRow, workspaceId: string, actorId: string, operation: string, batchSize: number) {
  if (job.state === "completed") return;
  const items = await tx.query<ItemRow>(
    `SELECT page_id, ordinal, trashed, had_edit, decision, expected_owner_id, disposition, code
     FROM hs_handover_items WHERE job_id=$1 AND disposition='pending' ORDER BY ordinal LIMIT $2`,
    [job.id, batchSize],
  );
  for (const item of items.rows) await applyItem(r, tx, job, workspaceId, item, operation, actorId);
  await settleJob(tx, job.id);
}

async function loadJob(tx: Sql, workspaceId: string, actorId: string, jobId: string) {
  const row = await tx.query<JobRow>(
    "SELECT id, to_user_id, kind, state, version FROM hs_handover_jobs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE",
    [jobId, workspaceId, actorId],
  );
  if (!row.rows.length) throw handoverHidden();
  return row.rows[0];
}

async function beginJob(tx: Sql, r: Repository, actor: Actor, workspaceId: string, kind: "handover" | "ownerless", fromUserId: string | null, toUserId: string, includeTrashed: boolean, chosen: { pageId: string; decision: OwnerDecision }[], operation: string, requestHash: string, batchSize: number) {
  const to = await requireRecipient(tx, workspaceId, toUserId);
  const from = fromUserId ? await requireSource(tx, workspaceId, fromUserId) : null;
  if (from && from.id === to.id) throw invalid("Choose a different recipient.");
  const planned = await planPages(r, tx, actor, workspaceId, to.id, fromUserId);
  const scope = scopeOf(planned.live, planned.trashed, includeTrashed);
  if (!scope.length) {
    if (chosen[0]) await explainExtra(r, tx, actor, workspaceId, chosen[0].pageId, includeTrashed);
    throw invalid("Nothing to hand over.");
  }
  const matched = decisionsFor(scope, chosen);
  if (!matched) {
    const expected = new Set(scope.map(page => page.pageId));
    const extra = chosen.find(item => !expected.has(item.pageId));
    if (extra) await explainExtra(r, tx, actor, workspaceId, extra.pageId, includeTrashed);
    if (!scope.length) throw invalid("Nothing to hand over.");
    throw invalid();
  }
  for (const item of matched) {
    if (item.page.recipientCanEdit && item.decision !== "transfer") throw invalid(EDIT_DECISION);
    if (!item.page.recipientCanEdit && item.decision === "transfer") throw invalid(EDIT_DECISION);
  }
  const jobId = randomUUID();
  await tx.query(
    `INSERT INTO hs_handover_jobs(id, workspace_id, actor_id, operation_id, request_hash, from_user_id, to_user_id, include_trashed, kind, state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running')`,
    [jobId, workspaceId, actor.id, operation, requestHash, fromUserId, to.id, includeTrashed, kind],
  );
  for (const [index, item] of matched.entries()) {
    await tx.query(
      `INSERT INTO hs_handover_items(job_id, page_id, ordinal, trashed, had_edit, decision, expected_owner_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [jobId, item.page.pageId, index + 1, item.page.trashed, item.page.recipientCanEdit, item.decision, item.page.ownerId],
    );
  }
  await audit(tx, actor.id, "page-owner.handover-start", null, operation, {
    jobId,
    kind,
    fromUserId,
    toOwnerId: to.id,
    pageIds: matched.map(item => item.page.pageId),
    includeTrashed,
  });
  const job = await loadJob(tx, workspaceId, actor.id, jobId);
  await processJob(r, tx, job, workspaceId, actor.id, operation, batchSize);
  const current = await loadJob(tx, workspaceId, actor.id, jobId);
  return remember(tx, workspaceId, actor.id, operation, requestHash, jobId, await present(tx, current, false));
}

export async function notifyPageOwnersLeft(tx: Sql, input: { workspaceId: string; actorId: string; subjectId: string; subjectName: string; operationId: string }) {
  const pages = await tx.query<{ id: string }>("SELECT id FROM hs_pages WHERE workspace_id=$1 AND owner_id=$2 ORDER BY id", [input.workspaceId, input.subjectId]);
  if (!pages.rows.length) return;
  const summary = handoverPrompt(input.subjectName, pages.rows.length);
  const admins = await tx.query<{ user_id: string }>(
    "SELECT user_id FROM hs_members WHERE workspace_id=$1 AND active=true AND role IN ('owner','admin') AND user_id<>$2 ORDER BY user_id",
    [input.workspaceId, input.subjectId],
  );
  for (const admin of admins.rows) {
    await tx.query(
      "INSERT INTO hs_notifications(id, recipient_id, page_id, kind, summary) VALUES($1,$2,$3,'page-handover',$4)",
      [randomUUID(), admin.user_id, pages.rows[0].id, summary],
    );
  }
  await audit(tx, input.actorId, "page-owner.leaver", null, input.operationId, {
    subjectId: input.subjectId,
    pageCount: pages.rows.length,
    pageIds: pages.rows.map(page => page.id),
  });
}

async function workspaceRole(tx: Sql, workspaceId: string, userId: string) {
  const row = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, userId]);
  return row.rows[0]?.role ?? null;
}

async function ownerState(r: Repository, tx: Sql, actor: Actor, pageId: string): Promise<OwnerView> {
  const page = await r.access(tx, pageId, actor);
  const role = await workspaceRole(tx, page.workspace_id, actor.id);
  const canHandover = role === "owner" || role === "admin";
  const canChange = page.role === "owner" || canHandover;
  const ownerRow = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_users WHERE id=$1", [page.owner_id]);
  if (!ownerRow.rows.length) throw pageHidden();
  const view: OwnerView = { owner: person(ownerRow.rows[0].id, ownerRow.rows[0].name), canChange, canHandover };
  if (!canChange) return view;
  const members = await tx.query<{ id: string; name: string; role: string }>(
    `SELECT u.id, u.name, m.role FROM hs_members m JOIN hs_users u ON u.id=m.user_id
     WHERE m.workspace_id=$1 AND m.active=true AND u.id<>$2 AND m.role<>'observer' ORDER BY u.name, u.id LIMIT 200`,
    [page.workspace_id, page.owner_id],
  );
  const candidates: OwnerPerson[] = [];
  for (const member of members.rows) {
    if (await recipientCanEdit(r, tx, pageId, member.id, false)) candidates.push(person(member.id, member.name));
  }
  return { ...view, candidates };
}

export async function pageOwner(r: Repository, actor: Actor, pageId: string): Promise<OwnerView> {
  return r.db.transaction(async tx => ownerState(r, tx, actor, pageId));
}

export async function changePageOwner(r: Repository, actor: Actor, pageId: string, input: unknown): Promise<OwnerChange> {
  const parsed = ownerCommand.safeParse(input);
  if (!parsed.success) throw ownerInvalid();
  const requestHash = hash({ pageId, ownerId: parsed.data.ownerId });
  return r.db.transaction(async tx => {
    const prior = await tx.query<{ actor_id: string; request_hash: string; result: unknown }>(
      "SELECT actor_id, request_hash, result FROM hs_page_owner_operations WHERE page_id=$1 AND operation_id=$2",
      [pageId, parsed.data.operationId],
    );
    if (prior.rows.length && prior.rows[0].actor_id === actor.id) {
      if (prior.rows[0].request_hash !== requestHash) throw ownerMismatch();
      return { ...stored<OwnerView>(prior.rows[0].result), replayed: true, atIst: formatIst(new Date()) };
    }
    const page = await r.access(tx, pageId, actor, false, true);
    const role = await workspaceRole(tx, page.workspace_id, actor.id);
    if (page.role !== "owner" && role !== "owner" && role !== "admin") throw ownerForbidden();
    if (prior.rows.length) throw ownerMismatch();
    const target = await workspaceMember(tx, page.workspace_id, parsed.data.ownerId);
    if (!target) throw personHidden();
    if (!target.active || target.role === "observer" || !await recipientCanEdit(r, tx, pageId, target.id, false)) {
      throw new DocumentError("Choose a member who can edit this page.", "owner_ineligible", 422);
    }
    const previous = page.owner_id;
    if (previous !== target.id) {
      await tx.query("UPDATE hs_pages SET owner_id=$2, acl_version=acl_version+1, updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$3", [pageId, target.id, page.workspace_id]);
    }
    const atIst = formatIst(new Date());
    await audit(tx, actor.id, "page-owner.change", pageId, parsed.data.operationId, { pageId, fromOwnerId: previous, toOwnerId: target.id });
    let view: OwnerView;
    try {
      view = await ownerState(r, tx, actor, pageId);
    } catch (error) {
      if (!(error instanceof DocumentError) || error.status !== 404) throw error;
      view = { owner: person(target.id, target.name), canChange: false, canHandover: false };
    }
    await tx.query(
      "INSERT INTO hs_page_owner_operations(page_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5::jsonb)",
      [pageId, parsed.data.operationId, actor.id, requestHash, JSON.stringify(view)],
    );
    return { ...view, replayed: false, atIst };
  });
}

export async function ownerlessPages(r: Repository, actor: Actor, workspaceId: string): Promise<OwnerlessReport> {
  return r.db.transaction(async tx => {
    await requireAdmin(tx, workspaceId, actor);
    const rows = await sourcePages(tx, workspaceId, null);
    const pages: OwnerlessReport["pages"] = [];
    const trashed: OwnerlessReport["trashed"] = [];
    for (const row of rows) {
      if (!row.trashed && !await actorCanSee(r, tx, row.id, actor)) continue;
      const item = { pageId: row.id, title: row.title };
      if (row.trashed) trashed.push(item);
      else pages.push(item);
    }
    return { pages, trashed };
  });
}

export async function readHandoverJob(r: Repository, actor: Actor, workspaceId: string, jobId: string): Promise<HandoverJob> {
  if (!z.string().uuid().safeParse(jobId).success) throw handoverHidden();
  return r.db.transaction(async tx => {
    await requireAdmin(tx, workspaceId, actor);
    await lockWorkspace(tx, workspaceId);
    const job = await loadJob(tx, workspaceId, actor.id, jobId);
    return present(tx, job, false);
  });
}

export async function runPageHandover(r: Repository, actor: Actor, workspaceId: string, input: unknown, batchSize = HANDOVER_BATCH): Promise<HandoverPreview | HandoverJob> {
  const parsed = command.safeParse(input);
  if (!parsed.success) throw invalid();
  const batch = batchOf(batchSize);
  return r.db.transaction(async tx => {
    await requireAdmin(tx, workspaceId, actor);
    const body = parsed.data;
    if (body.action === "preview" || body.action === "preview-ownerless") {
      const to = await requireRecipient(tx, workspaceId, body.toUserId);
      const from = body.action === "preview" ? await requireSource(tx, workspaceId, body.fromUserId) : null;
      if (from && from.id === to.id) throw invalid("Choose a different recipient.");
      const planned = await planPages(r, tx, actor, workspaceId, to.id, from?.id ?? null);
      return {
        from: from ? person(from.id, from.name) : null,
        to: person(to.id, to.name),
        pages: planned.live.map(stripOwner),
        trashed: planned.trashed.map(stripOwner),
      };
    }
    await lockWorkspace(tx, workspaceId);
    if (body.action === "resume") {
      const requestHash = hash({ action: "resume", jobId: body.jobId });
      const replay = await remembered(tx, workspaceId, actor.id, body.operationId, requestHash);
      if (replay) return replay;
      const job = await loadJob(tx, workspaceId, actor.id, body.jobId);
      await processJob(r, tx, job, workspaceId, actor.id, body.operationId, batch);
      const current = await loadJob(tx, workspaceId, actor.id, body.jobId);
      return remember(tx, workspaceId, actor.id, body.operationId, requestHash, current.id, await present(tx, current, false));
    }
    const chosen = normalizeDecisions(body.decisions);
    const fromUserId = body.action === "start" ? body.fromUserId : null;
    const requestHash = hash({ action: body.action, fromUserId, toUserId: body.toUserId, includeTrashed: body.includeTrashed, decisions: chosen });
    const replay = await remembered(tx, workspaceId, actor.id, body.operationId, requestHash);
    if (replay) return replay;
    return beginJob(tx, r, actor, workspaceId, body.action === "assign" ? "ownerless" : "handover", fromUserId, body.toUserId, body.includeTrashed, chosen, body.operationId, requestHash, batch);
  });
}

function stripOwner(page: Planned): HandoverPage {
  return { pageId: page.pageId, title: page.title, trashed: page.trashed, recipientCanEdit: page.recipientCanEdit };
}
