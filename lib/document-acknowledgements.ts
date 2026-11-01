import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ACK_GENESIS, acknowledgementRecordHash, verifyAcknowledgementChain, type AcknowledgementChainRecord } from "./acknowledgement-chain";
import {
  ACK_WAIT_SECONDS,
  CANNOT_ASSIGN_REASON,
  acknowledgementAllowed,
  acknowledgementBannerCopy,
  acknowledgementCsv,
  acknowledgementRoles,
  acknowledgementStatusLabel,
  acknowledgementVersionLabel,
  SHORT_ACKNOWLEDGEMENT_CHARS,
  type AcknowledgementAssignment,
  type AcknowledgementAudienceChoices,
  type AcknowledgementBanner,
  type AcknowledgementExcluded,
  type AcknowledgementOwnerView,
  type AcknowledgementReaderView,
  type AcknowledgementStatus,
  type AcknowledgementView,
  type AudienceTarget,
} from "./acknowledgement-copy";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, plainText, stableStringify, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";

const hidden = () => new DocumentError("Page is restricted or unavailable", "not_found", 404);
const mismatch = () => new DocumentError("This acknowledgement attempt was reused with different fields.", "operation_mismatch", 409);
const audienceError = () => new DocumentError("Choose an audience in this workspace.", "acknowledgement_audience", 422);
const roleId = z.enum(["workspace:owner", "workspace:admin", "workspace:member", "workspace:observer", "space:leader", "space:editor", "space:viewer"]);
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("group"), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("role"), id: roleId }).strict(),
  z.object({ kind: z.literal("space"), id: z.string().min(1).max(200) }).strict(),
]);
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), operationId: z.string().uuid(), dueOn: z.string().min(8).max(40), audience: z.array(target).min(1).max(50) }).strict(),
  z.object({
    action: z.literal("acknowledge"),
    operationId: z.string().uuid(),
    versionId: z.string().uuid(),
    confirm: z.boolean(),
    reachedEnd: z.boolean(),
    waitedSeconds: z.number().int().min(0).max(86_400).optional(),
  }).strict(),
  z.object({ action: z.literal("require-reacknowledgement"), operationId: z.string().uuid() }).strict(),
]);

type OwnerPage = { id: string; workspace_id: string; space_id: string; owner_id: string; deleted_at: string | null; title: string };
type PublicationRow = { id: string; version_number: number; bump: "major" | "minor"; snapshot_hash: string; document: RichNode };
type CampaignRow = {
  id: string;
  page_id: string;
  workspace_id: string;
  version_id: string;
  version_number: number;
  audience: AudienceTarget[];
  due_at: string;
  status: "active" | "paused" | "superseded";
  paused_reason: string | null;
  excluded: AcknowledgementExcluded[];
  created_by: string;
};
type Person = { id: string; name: string };

const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const iso = (value: string | Date) => new Date(value).toISOString();

export function ipCountryFromHeader(value: string | null) {
  if (!value || !/^[A-Za-z]{2}$/.test(value.trim())) return null;
  return value.trim().toUpperCase();
}

export function dueAtFromInput(dueOn: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    const due = new Date(`${dueOn}T23:59:59.999+05:30`);
    if (Number.isNaN(due.getTime())) throw new DocumentError("Choose a due date.", "acknowledgement_validation", 400);
    return due;
  }
  const due = new Date(dueOn);
  if (Number.isNaN(due.getTime())) throw new DocumentError("Choose a due date.", "acknowledgement_validation", 400);
  return due;
}

function istDay(now: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function shortDocument(document: RichNode) {
  return plainText(document).trim().length < SHORT_ACKNOWLEDGEMENT_CHARS;
}

async function ownerPage(tx: Sql, pageId: string, actor: Actor) {
  const rows = await tx.query<OwnerPage>(`SELECT p.id,p.workspace_id,p.space_id,p.owner_id,p.deleted_at,p.title
    FROM hs_pages p JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$2 AND m.active=true
    WHERE p.id=$1 AND p.owner_id=$2`, [pageId, actor.id]);
  return rows.rows[0] ?? null;
}

async function currentPublication(tx: Sql, pageId: string) {
  const rows = await tx.query<PublicationRow>(`SELECT pub.id,pub.version_number,pub.bump,pub.snapshot_hash,pub.document
    FROM hs_document_workflows w JOIN hs_document_publications pub ON pub.id=w.publication_id AND pub.page_id=w.page_id
    WHERE w.page_id=$1 AND pub.version_number IS NOT NULL AND pub.bump IN ('major','minor')`, [pageId]);
  return rows.rows[0] ?? null;
}

async function openCampaign(tx: Sql, pageId: string, lock = false) {
  const rows = await tx.query<CampaignRow>(`SELECT id,page_id,workspace_id,version_id,version_number,audience,due_at,status,paused_reason,excluded,created_by
    FROM hs_ack_campaigns WHERE page_id=$1 AND status IN ('active','paused') ${lock ? "FOR UPDATE" : ""}`, [pageId]);
  return rows.rows[0] ?? null;
}

async function canReadPublished(r: Repository, tx: Sql, pageId: string, userId: string) {
  try {
    await r.access(tx, pageId, { id: userId });
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) return false;
    throw error;
  }
  const workflow = await tx.query<{ publication_id: string | null }>("SELECT publication_id FROM hs_document_workflows WHERE page_id=$1", [pageId]);
  if (!workflow.rows.length) return true;
  return Boolean(workflow.rows[0].publication_id);
}

async function workspacePeople(tx: Sql, workspaceId: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await tx.query<Person>(`SELECT u.id,u.name FROM hs_users u
    JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$1 AND m.active=true
    WHERE u.id = ANY($2::text[])`, [workspaceId, ids]);
  return new Map(rows.rows.map(person => [person.id, person.name]));
}

async function resolveAudience(tx: Sql, page: OwnerPage, audience: AudienceTarget[]) {
  const people = new Map<string, string>();
  const add = (rows: Person[]) => { for (const person of rows) people.set(person.id, person.name); };
  for (const item of audience) {
    if (item.kind === "user") {
      const known = await workspacePeople(tx, page.workspace_id, [item.id]);
      if (known.has(item.id)) people.set(item.id, known.get(item.id)!);
      else people.set(item.id, "");
    } else if (item.kind === "group") {
      const group = await tx.query("SELECT id FROM hs_workspace_groups WHERE id=$1 AND workspace_id=$2", [item.id, page.workspace_id]);
      if (!group.rows.length) throw audienceError();
      add((await tx.query<Person>(`SELECT u.id,u.name FROM hs_workspace_group_members gm
        JOIN hs_users u ON u.id=gm.user_id
        JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$2 AND m.active=true
        WHERE gm.group_id=$1`, [item.id, page.workspace_id])).rows);
    } else if (item.kind === "space") {
      const space = await tx.query("SELECT id FROM hs_spaces WHERE id=$1 AND workspace_id=$2", [item.id, page.workspace_id]);
      if (!space.rows.length) throw audienceError();
      add((await tx.query<Person>(`SELECT u.id,u.name FROM hs_space_members sm
        JOIN hs_users u ON u.id=sm.user_id
        JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$2 AND m.active=true
        WHERE sm.space_id=$1 AND sm.active=true`, [item.id, page.workspace_id])).rows);
    } else if (item.id.startsWith("workspace:")) {
      add((await tx.query<Person>(`SELECT u.id,u.name FROM hs_members m JOIN hs_users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND m.active=true AND m.role=$2`, [page.workspace_id, item.id.slice("workspace:".length)])).rows);
    } else {
      add((await tx.query<Person>(`SELECT u.id,u.name FROM hs_space_members sm
        JOIN hs_users u ON u.id=sm.user_id
        JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$2 AND m.active=true
        WHERE sm.space_id=$1 AND sm.active=true AND sm.role=$3`, [page.space_id, page.workspace_id, item.id.slice("space:".length)])).rows);
    }
  }
  if (people.size > 500) throw new DocumentError("Choose an audience of at most 500 people.", "acknowledgement_audience", 422);
  return people;
}

async function splitAccess(r: Repository, tx: Sql, pageId: string, people: Map<string, string>) {
  const assigned: Person[] = [];
  const excluded: AcknowledgementExcluded[] = [];
  for (const [userId, name] of people) {
    const readable = name ? await canReadPublished(r, tx, pageId, userId) : false;
    if (readable) assigned.push({ id: userId, name });
    else excluded.push({ userId, name: name || null, reason: CANNOT_ASSIGN_REASON });
  }
  assigned.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  excluded.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.userId.localeCompare(b.userId));
  return { assigned, excluded };
}

async function notify(tx: Sql, recipientId: string, pageId: string, campaignId: string, kind: "acknowledgement" | "acknowledgement-reminder" | "acknowledgement-overdue", summary: string, emailKind: "assigned" | "reminder" | "overdue-summary") {
  await tx.query("INSERT INTO hs_notifications(id,recipient_id,page_id,kind,summary) VALUES($1,$2,$3,$4,$5)", [randomUUID(), recipientId, pageId, kind, summary]);
  await tx.query("INSERT INTO hs_ack_email_outbox(id,recipient_id,campaign_id,kind) VALUES($1,$2,$3,$4)", [randomUUID(), recipientId, campaignId, emailKind]);
}

async function audit(tx: Sql, actorId: string, action: string, pageId: string, operationId: string, after: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), actorId, action, pageId, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId]);
}

async function choices(tx: Sql, page: OwnerPage): Promise<AcknowledgementAudienceChoices> {
  const users = await tx.query<Person>("SELECT u.id,u.name FROM hs_users u JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$1 AND m.active=true ORDER BY u.name,u.id", [page.workspace_id]);
  const groups = await tx.query<{ id: string; name: string }>("SELECT id,name FROM hs_workspace_groups WHERE workspace_id=$1 ORDER BY name,id", [page.workspace_id]);
  const space = await tx.query<{ id: string; name: string }>("SELECT id,name FROM hs_spaces WHERE id=$1 AND workspace_id=$2", [page.space_id, page.workspace_id]);
  return { users: users.rows, groups: groups.rows, roles: acknowledgementRoles, space: space.rows[0] ?? null };
}

function bannerFor(campaign: CampaignRow, publication: PublicationRow, status: "pending" | "acknowledged", acknowledgedAt: string | null): AcknowledgementBanner {
  return {
    campaignId: campaign.id,
    versionId: campaign.version_id,
    versionLabel: acknowledgementVersionLabel(campaign.version_number),
    shortDocument: shortDocument(publication.document),
    status,
    acknowledgedAtIst: acknowledgedAt ? formatIst(acknowledgedAt) : null,
    copy: acknowledgementBannerCopy(acknowledgementVersionLabel(campaign.version_number)),
  };
}

async function assignmentRows(r: Repository, tx: Sql, page: OwnerPage, campaign: CampaignRow, now: Date) {
  const rows = await tx.query<{ id: string; user_id: string; name: string; status: "pending" | "acknowledged"; acknowledged_at: string | null }>(`SELECT a.id,a.user_id,u.name,a.status,rec.acknowledged_at
    FROM hs_ack_assignments a JOIN hs_users u ON u.id=a.user_id
    LEFT JOIN hs_ack_records rec ON rec.assignment_id=a.id
    WHERE a.campaign_id=$1 ORDER BY u.name,a.user_id`, [campaign.id]);
  const assignments: AcknowledgementAssignment[] = [];
  for (const row of rows.rows) {
    const readable = page.deleted_at ? true : await canReadPublished(r, tx, page.id, row.user_id);
    let status: AcknowledgementStatus = row.status === "acknowledged" ? "acknowledged" : "pending";
    if (status === "pending" && !page.deleted_at && !readable) status = "lost_access";
    else if (status === "pending" && new Date(campaign.due_at).getTime() < now.getTime()) status = "overdue";
    assignments.push({
      userId: row.user_id,
      name: row.name,
      status,
      statusLabel: acknowledgementStatusLabel(status),
      versionLabel: acknowledgementVersionLabel(campaign.version_number),
      acknowledgedAt: row.acknowledged_at ? iso(row.acknowledged_at) : null,
      acknowledgedAtIst: row.acknowledged_at ? formatIst(row.acknowledged_at) : null,
    });
  }
  return assignments;
}

async function ownerView(r: Repository, tx: Sql, actor: Actor, page: OwnerPage, now: Date): Promise<AcknowledgementOwnerView> {
  const publication = page.deleted_at ? null : await currentPublication(tx, page.id);
  const campaign = await openCampaign(tx, page.id);
  let publicationView: AcknowledgementOwnerView["publication"] = null;
  if (publication) publicationView = { versionId: publication.id, versionLabel: acknowledgementVersionLabel(Number(publication.version_number)), bump: publication.bump };
  else if (page.deleted_at && campaign) publicationView = { versionId: campaign.version_id, versionLabel: acknowledgementVersionLabel(Number(campaign.version_number)), bump: "major" };
  const retained = await tx.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM hs_ack_records WHERE page_id=$1", [page.id]);
  const assignments = campaign ? await assignmentRows(r, tx, page, campaign, now) : [];
  const acknowledged = assignments.filter(item => item.status === "acknowledged").length;
  let banner: AcknowledgementBanner | null = null;
  if (campaign && publication && !page.deleted_at) {
    const own = assignments.find(item => item.userId === actor.id);
    if (own && (own.status === "pending" || own.status === "overdue" || own.status === "acknowledged")) {
      banner = bannerFor(campaign, publication, own.status === "acknowledged" ? "acknowledged" : "pending", own.acknowledgedAt);
    }
  }
  return {
    scope: "owner",
    publication: publicationView,
    audienceChoices: await choices(tx, page),
    campaign: campaign ? {
      id: campaign.id,
      status: campaign.status,
      paused: campaign.status === "paused",
      versionId: campaign.version_id,
      versionLabel: acknowledgementVersionLabel(Number(campaign.version_number)),
      dueAt: iso(campaign.due_at),
      dueAtIst: formatIst(campaign.due_at),
      completion: { acknowledged, assigned: assignments.length, label: `${acknowledged}/${assignments.length}` },
      retainedRecords: Number(retained.rows[0]?.n ?? 0),
    } : null,
    assignments,
    excluded: campaign?.excluded ?? [],
    banner,
  };
}

export async function acknowledgementView(r: Repository, actor: Actor, pageId: string, now = new Date()): Promise<AcknowledgementView> {
  return r.db.transaction(async tx => {
    const owned = await ownerPage(tx, pageId, actor);
    if (owned) return ownerView(r, tx, actor, owned, now);
    try {
      await r.get(pageId, actor, tx);
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) throw hidden();
      throw error;
    }
    const campaign = await openCampaign(tx, pageId);
    const publication = await currentPublication(tx, pageId);
    if (!campaign || !publication || campaign.status !== "active") return { scope: "reader", banner: null };
    const assignment = await tx.query<{ status: "pending" | "acknowledged"; acknowledged_at: string | null }>(`SELECT a.status,rec.acknowledged_at
      FROM hs_ack_assignments a LEFT JOIN hs_ack_records rec ON rec.assignment_id=a.id
      WHERE a.campaign_id=$1 AND a.user_id=$2`, [campaign.id, actor.id]);
    if (!assignment.rows.length) return { scope: "reader", banner: null };
    const row = assignment.rows[0];
    return { scope: "reader", banner: bannerFor(campaign, publication, row.status, row.acknowledged_at) };
  });
}

async function priorOperation(tx: Sql, pageId: string, actor: Actor, operationId: string, requestHash: string) {
  const prior = await tx.query<{ actor_id: string; request_hash: string; result: unknown }>("SELECT actor_id,request_hash,result FROM hs_ack_operations WHERE page_id=$1 AND operation_id=$2", [pageId, operationId]);
  if (!prior.rows.length) return null;
  if (prior.rows[0].actor_id !== actor.id || prior.rows[0].request_hash !== requestHash) throw mismatch();
  const result = prior.rows[0].result;
  if (result && typeof result === "object") return { ...(result as Record<string, unknown>), replayed: true };
  return result;
}

async function remember(tx: Sql, pageId: string, actor: Actor, operationId: string, requestHash: string, result: unknown) {
  await tx.query("INSERT INTO hs_ack_operations(page_id,operation_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5)", [pageId, operationId, actor.id, requestHash, JSON.stringify(result)]);
}

async function chainTail(tx: Sql, pageId: string) {
  await tx.query("SELECT id FROM hs_pages WHERE id=$1 FOR UPDATE", [pageId]);
  const rows = await tx.query<{ hash: string }>(`SELECT hash FROM hs_ack_records record
    WHERE record.page_id=$1 AND NOT EXISTS (SELECT 1 FROM hs_ack_records newer WHERE newer.page_id=record.page_id AND newer.prev_hash=record.hash)`, [pageId]);
  if (rows.rows.length > 1) throw new DocumentError("Acknowledgement evidence needs review before another record can be added.", "acknowledgement_chain", 409);
  return rows.rows[0]?.hash ?? ACK_GENESIS;
}

async function insertCampaign(r: Repository, tx: Sql, actor: Actor, page: OwnerPage, publication: PublicationRow, audience: AudienceTarget[], dueAt: Date, operationId: string) {
  const people = await resolveAudience(tx, page, audience);
  const { assigned, excluded } = await splitAccess(r, tx, page.id, people);
  const campaignId = randomUUID();
  await tx.query(`INSERT INTO hs_ack_campaigns(id,page_id,workspace_id,version_id,version_number,audience,due_at,status,excluded,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`, [campaignId, page.id, page.workspace_id, publication.id, publication.version_number, JSON.stringify(audience), dueAt.toISOString(), JSON.stringify(excluded), actor.id]);
  const assignmentIds: string[] = [];
  const copy = acknowledgementBannerCopy(acknowledgementVersionLabel(Number(publication.version_number)));
  for (const person of assigned) {
    const assignmentId = randomUUID();
    assignmentIds.push(assignmentId);
    await tx.query("INSERT INTO hs_ack_assignments(id,campaign_id,user_id,status) VALUES($1,$2,$3,'pending')", [assignmentId, campaignId, person.id]);
    await notify(tx, person.id, page.id, campaignId, "acknowledgement", copy, "assigned");
  }
  const result = {
    campaignId,
    versionId: publication.id,
    versionLabel: acknowledgementVersionLabel(Number(publication.version_number)),
    assigned: assigned.map(person => ({ userId: person.id, name: person.name })),
    excluded,
    replayed: false,
  };
  await audit(tx, actor.id, "acknowledgement.request", page.id, operationId, {
    campaignId,
    versionId: publication.id,
    versionNumber: Number(publication.version_number),
    assignedIds: assigned.map(person => person.id),
    excludedIds: excluded.map(person => person.userId),
  });
  return result;
}

async function requestAcknowledgement(r: Repository, tx: Sql, actor: Actor, page: OwnerPage, input: z.infer<typeof command> & { action: "request" }, requestHash: string) {
  const replay = await priorOperation(tx, page.id, actor, input.operationId, requestHash);
  if (replay) return replay;
  if (page.deleted_at) throw hidden();
  await r.access(tx, page.id, actor, false, true);
  const publication = await currentPublication(tx, page.id);
  if (!publication) throw new DocumentError("Publish a version before requesting acknowledgement.", "acknowledgement_unpublished", 409);
  const existing = await openCampaign(tx, page.id, true);
  if (existing) throw new DocumentError("An acknowledgement request is already open for this page.", "acknowledgement_exists", 409);
  const result = await insertCampaign(r, tx, actor, page, publication, input.audience, dueAtFromInput(input.dueOn), input.operationId);
  await remember(tx, page.id, actor, input.operationId, requestHash, result);
  return result;
}

async function acknowledge(r: Repository, tx: Sql, actor: Actor, pageId: string, input: z.infer<typeof command> & { action: "acknowledge" }, requestHash: string, ipCountry: string | null) {
  const replay = await priorOperation(tx, pageId, actor, input.operationId, requestHash);
  if (replay) return replay;
  let readable = false;
  try {
    await r.get(pageId, actor, tx);
    readable = true;
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw hidden();
    throw error;
  }
  if (!readable) throw hidden();
  const campaign = await openCampaign(tx, pageId, true);
  const publication = campaign ? await tx.query<PublicationRow>("SELECT id,version_number,bump,snapshot_hash,document FROM hs_document_publications WHERE id=$1 AND page_id=$2", [campaign.version_id, pageId]) : { rows: [] as PublicationRow[] };
  const assignment = campaign ? await tx.query<{ id: string; status: "pending" | "acknowledged" }>("SELECT id,status FROM hs_ack_assignments WHERE campaign_id=$1 AND user_id=$2 FOR UPDATE", [campaign.id, actor.id]) : { rows: [] as { id: string; status: "pending" | "acknowledged" }[] };
  if (!campaign || campaign.status !== "active" || campaign.version_id !== input.versionId || !publication.rows.length || !assignment.rows.length) throw hidden();
  const published = publication.rows[0];
  if (assignment.rows[0].status === "acknowledged") {
    const existing = await tx.query<AcknowledgementChainRecord>(`SELECT id,campaign_id AS "campaignId",assignment_id AS "assignmentId",page_id AS "pageId",version_id AS "versionId",user_id AS "userId",at_iso AS "acknowledgedAt",content_hash AS "contentHash",ip_country AS "ipCountry",prev_hash AS "prevHash",hash
      FROM hs_ack_records WHERE assignment_id=$1`, [assignment.rows[0].id]);
    const record = existing.rows[0];
    const result = { recordId: record?.id ?? null, versionId: campaign.version_id, versionLabel: acknowledgementVersionLabel(Number(campaign.version_number)), contentHash: published.snapshot_hash, acknowledgedAtIst: record ? formatIst(record.acknowledgedAt) : null, replayed: true };
    await remember(tx, pageId, actor, input.operationId, requestHash, result);
    return result;
  }
  const gate = acknowledgementAllowed({ confirm: input.confirm, reachedEnd: input.reachedEnd, shortDocument: shortDocument(published.document), waitedSeconds: input.waitedSeconds ?? 0 });
  if (gate === "confirm") throw new DocumentError("Confirm that you have read this published version.", "acknowledgement_confirm", 422);
  if (gate === "read") throw new DocumentError(shortDocument(published.document) ? `Read to the end, or wait ${ACK_WAIT_SECONDS} seconds on a short document, before acknowledging.` : "Read to the end of the published version before acknowledging.", "acknowledgement_unread", 422);
  const country = ipCountryFromHeader(ipCountry);
  const acknowledgedAt = new Date().toISOString();
  const recordId = randomUUID();
  const prevHash = await chainTail(tx, pageId);
  const chainRecord = {
    id: recordId,
    campaignId: campaign.id,
    assignmentId: assignment.rows[0].id,
    pageId,
    versionId: campaign.version_id,
    userId: actor.id,
    acknowledgedAt,
    contentHash: published.snapshot_hash,
    ipCountry: country,
    prevHash,
  };
  const recordHash = acknowledgementRecordHash(chainRecord);
  await tx.query(`INSERT INTO hs_ack_records(id,workspace_id,campaign_id,assignment_id,page_id,version_id,version_number,user_id,acknowledged_at,at_iso,content_hash,ip_country,prev_hash,hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [recordId, campaign.workspace_id, campaign.id, assignment.rows[0].id, pageId, campaign.version_id, campaign.version_number, actor.id, acknowledgedAt, acknowledgedAt, published.snapshot_hash, country, prevHash, recordHash]);
  await tx.query("UPDATE hs_ack_assignments SET status='acknowledged' WHERE id=$1", [assignment.rows[0].id]);
  const result = { recordId, versionId: campaign.version_id, versionLabel: acknowledgementVersionLabel(Number(campaign.version_number)), contentHash: published.snapshot_hash, acknowledgedAt: acknowledgedAt, acknowledgedAtIst: formatIst(acknowledgedAt), ipCountry: country, replayed: false };
  await audit(tx, actor.id, "acknowledgement.acknowledge", pageId, input.operationId, { campaignId: campaign.id, versionId: campaign.version_id, recordId, userId: actor.id });
  await remember(tx, pageId, actor, input.operationId, requestHash, result);
  return result;
}

async function requireReacknowledgement(r: Repository, tx: Sql, actor: Actor, page: OwnerPage, input: z.infer<typeof command> & { action: "require-reacknowledgement" }, requestHash: string) {
  const replay = await priorOperation(tx, page.id, actor, input.operationId, requestHash);
  if (replay) return replay;
  if (page.deleted_at) throw hidden();
  await r.access(tx, page.id, actor, false, true);
  const publication = await currentPublication(tx, page.id);
  if (!publication) throw new DocumentError("Publish a version before requesting acknowledgement.", "acknowledgement_unpublished", 409);
  if (publication.bump !== "major") throw new DocumentError("A minor publication keeps existing acknowledgements.", "acknowledgement_minor_keeps", 409);
  const existing = await openCampaign(tx, page.id, true);
  if (!existing) throw new DocumentError("Request acknowledgement before requiring it again.", "acknowledgement_missing", 409);
  if (existing.version_id === publication.id) throw new DocumentError("This published version already has the open acknowledgement request.", "acknowledgement_exists", 409);
  await tx.query("UPDATE hs_ack_campaigns SET status='superseded', paused_reason=NULL WHERE id=$1", [existing.id]);
  const previous = await tx.query<Person>("SELECT u.id,u.name FROM hs_ack_assignments a JOIN hs_users u ON u.id=a.user_id WHERE a.campaign_id=$1", [existing.id]);
  const people = new Map(previous.rows.map(person => [person.id, person.name]));
  const { assigned, excluded } = await splitAccess(r, tx, page.id, people);
  const campaignId = randomUUID();
  await tx.query(`INSERT INTO hs_ack_campaigns(id,page_id,workspace_id,version_id,version_number,audience,due_at,status,excluded,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`, [campaignId, page.id, page.workspace_id, publication.id, publication.version_number, JSON.stringify(existing.audience), existing.due_at, JSON.stringify(excluded), actor.id]);
  const copy = acknowledgementBannerCopy(acknowledgementVersionLabel(Number(publication.version_number)));
  for (const person of assigned) {
    await tx.query("INSERT INTO hs_ack_assignments(id,campaign_id,user_id,status) VALUES($1,$2,$3,'pending')", [randomUUID(), campaignId, person.id]);
    await notify(tx, person.id, page.id, campaignId, "acknowledgement", copy, "assigned");
  }
  const result = {
    campaignId,
    previousCampaignId: existing.id,
    versionId: publication.id,
    versionLabel: acknowledgementVersionLabel(Number(publication.version_number)),
    assigned: assigned.map(person => ({ userId: person.id, name: person.name })),
    excluded,
    replayed: false,
  };
  await audit(tx, actor.id, "acknowledgement.reacknowledge", page.id, input.operationId, {
    campaignId,
    previousCampaignId: existing.id,
    versionId: publication.id,
    versionNumber: Number(publication.version_number),
    assignedIds: assigned.map(person => person.id),
  });
  await remember(tx, page.id, actor, input.operationId, requestHash, result);
  return result;
}

export type AcknowledgementMutation = {
  replayed: boolean;
  campaignId?: string;
  versionId?: string;
  versionLabel?: string;
  assigned?: { userId: string; name: string }[];
  excluded?: AcknowledgementExcluded[];
  contentHash?: string;
  ipCountry?: string | null;
  acknowledgedAtIst?: string | null;
  recordId?: string | null;
  previousCampaignId?: string;
};

export async function changeAcknowledgement(r: Repository, actor: Actor, pageId: string, input: unknown, options: { ipCountry?: string | null } = {}): Promise<AcknowledgementMutation> {
  const parsed = command.safeParse(input);
  if (!parsed.success) throw new DocumentError("Check the acknowledgement request.", "acknowledgement_validation", 400);
  const requestHash = hash(parsed.data);
  return r.db.transaction(async tx => {
    if (parsed.data.action === "acknowledge") return acknowledge(r, tx, actor, pageId, parsed.data, requestHash, options.ipCountry ?? null) as Promise<AcknowledgementMutation>;
    const page = await ownerPage(tx, pageId, actor);
    if (!page) throw hidden();
    if (parsed.data.action === "request") return requestAcknowledgement(r, tx, actor, page, parsed.data, requestHash) as Promise<AcknowledgementMutation>;
    return requireReacknowledgement(r, tx, actor, page, parsed.data, requestHash) as Promise<AcknowledgementMutation>;
  });
}

function matchesFilter(status: AcknowledgementStatus, filter: string | null) {
  if (!filter || filter === "all") return true;
  return status === filter;
}

export async function acknowledgementExport(r: Repository, actor: Actor, pageId: string, format: "csv" | "evidence", filter: string | null, now = new Date()) {
  return r.db.transaction(async tx => {
    const page = await ownerPage(tx, pageId, actor);
    if (!page) throw hidden();
    if (filter && !["all", "pending", "overdue", "acknowledged", "lost_access"].includes(filter)) throw new DocumentError("Check the acknowledgement request.", "acknowledgement_validation", 400);
    const view = await ownerView(r, tx, actor, page, now);
    if (format === "csv") {
      const rows = view.assignments.filter(item => matchesFilter(item.status, filter)).map(item => ({
        name: item.name,
        status: item.statusLabel,
        versionLabel: item.versionLabel,
        acknowledgedAtIst: item.acknowledgedAtIst ?? "",
      }));
      return { body: acknowledgementCsv(rows), contentType: "text/csv; charset=utf-8", filename: "acknowledgements.csv" };
    }
    const records = await tx.query<AcknowledgementChainRecord & { name: string }>(`SELECT rec.id,rec.campaign_id AS "campaignId",rec.assignment_id AS "assignmentId",rec.page_id AS "pageId",rec.version_id AS "versionId",rec.user_id AS "userId",rec.at_iso AS "acknowledgedAt",rec.content_hash AS "contentHash",rec.ip_country AS "ipCountry",rec.prev_hash AS "prevHash",rec.hash,u.name
      FROM hs_ack_records rec JOIN hs_users u ON u.id=rec.user_id WHERE rec.page_id=$1`, [pageId]);
    const chainRecords = records.rows.map(record => ({ ...record, ipCountry: record.ipCountry, name: record.name }));
    const verification = verifyAcknowledgementChain(chainRecords);
    const body = {
      pageId,
      contentHash: view.publication ? (await tx.query<{ snapshot_hash: string }>("SELECT snapshot_hash FROM hs_document_publications WHERE id=$1", [view.campaign?.versionId ?? view.publication.versionId])).rows[0]?.snapshot_hash ?? null : null,
      chainValid: verification.ok,
      records: chainRecords.map(record => ({
        userId: record.userId,
        name: record.name,
        versionId: record.versionId,
        acknowledgedAt: record.acknowledgedAt,
        acknowledgedAtIst: formatIst(record.acknowledgedAt),
        contentHash: record.contentHash,
        ipCountry: record.ipCountry,
        prevHash: record.prevHash,
        hash: record.hash,
        id: record.id,
        campaignId: record.campaignId,
        assignmentId: record.assignmentId,
        pageId: record.pageId,
      })),
    };
    return { body: JSON.stringify(body, null, 2), contentType: "application/json; charset=utf-8", filename: "acknowledgement-evidence.json" };
  });
}

export async function runAcknowledgementReminders(r: Repository, now = new Date()) {
  return r.db.transaction(async tx => {
    const day = istDay(now);
    const campaigns = await tx.query<CampaignRow>(`SELECT id,page_id,workspace_id,version_id,version_number,audience,due_at,status,paused_reason,excluded,created_by
      FROM hs_ack_campaigns WHERE status='active' AND due_at < $1 ORDER BY created_at,id FOR UPDATE`, [now.toISOString()]);
    let assigneeReminders = 0;
    let ownerSummaries = 0;
    let skippedDuplicates = 0;
    for (const campaign of campaigns.rows) {
      const pending = await tx.query<{ id: string; user_id: string }>("SELECT id,user_id FROM hs_ack_assignments WHERE campaign_id=$1 AND status='pending' ORDER BY user_id", [campaign.id]);
      const overdue: { id: string; user_id: string }[] = [];
      for (const assignment of pending.rows) {
        if (await canReadPublished(r, tx, campaign.page_id, assignment.user_id)) overdue.push(assignment);
      }
      const copy = acknowledgementBannerCopy(acknowledgementVersionLabel(Number(campaign.version_number)));
      for (const assignment of overdue) {
        const already = await tx.query("SELECT id FROM hs_ack_reminders WHERE assignment_id=$1 AND ist_date=$2 AND kind='assignee'", [assignment.id, day]);
        if (already.rows.length) {
          skippedDuplicates += 1;
          continue;
        }
        const reminderId = randomUUID();
        await tx.query("INSERT INTO hs_ack_reminders(id,campaign_id,assignment_id,recipient_id,kind,ist_date) VALUES($1,$2,$3,$4,'assignee',$5)", [reminderId, campaign.id, assignment.id, assignment.user_id, day]);
        await notify(tx, assignment.user_id, campaign.page_id, campaign.id, "acknowledgement-reminder", copy, "reminder");
        await audit(tx, campaign.created_by, "acknowledgement.remind", campaign.page_id, reminderId, { campaignId: campaign.id, assignmentId: assignment.id, recipientId: assignment.user_id, kind: "assignee" });
        assigneeReminders += 1;
      }
      if (!overdue.length) continue;
      const summaryAlready = await tx.query("SELECT id FROM hs_ack_reminders WHERE campaign_id=$1 AND ist_date=$2 AND kind='owner_summary'", [campaign.id, day]);
      if (summaryAlready.rows.length) {
        skippedDuplicates += 1;
        continue;
      }
      const summaryId = randomUUID();
      await tx.query("INSERT INTO hs_ack_reminders(id,campaign_id,recipient_id,kind,ist_date) VALUES($1,$2,$3,'owner_summary',$4)", [summaryId, campaign.id, campaign.created_by, day]);
      await notify(tx, campaign.created_by, campaign.page_id, campaign.id, "acknowledgement-overdue", `Overdue acknowledgements: ${overdue.length}`, "overdue-summary");
      await audit(tx, campaign.created_by, "acknowledgement.remind", campaign.page_id, summaryId, { campaignId: campaign.id, kind: "owner_summary", overdue: overdue.length });
      ownerSummaries += 1;
    }
    return { assigneeReminders, ownerSummaries, skippedDuplicates };
  });
}

export { acknowledgementCsv, verifyAcknowledgementChain };
