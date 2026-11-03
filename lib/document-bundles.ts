import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, documentBlocks, plainText, stableStringify, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { exportRecordPageRefs } from "./record-page-ref-store";
import type { RecordExportSlice } from "./record-page-refs";
import {
  bundleFilename,
  bundleLimits,
  mergeMembers,
  modeLabel,
  packageDecision,
  type BundleMode,
  type PackageAvailability,
  type PackageRetention,
  type StoredMember,
} from "./document-bundle-plan";

const unavailable = () => new DocumentError("Document bundle unavailable", "not_found", 404);
const documentUnavailable = () => new DocumentError("Document unavailable", "not_found", 404);
const conflict = () => new DocumentError("This bundle changed. Refresh and review it before saving.", "bundle_conflict", 409);
const readOnly = () => new DocumentError("This bundle is read only.", "read_only", 403);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MemberInput = { pageId: string; mode: BundleMode; pinnedVersion?: number | null };
export type BundleSaveInput = { operationId: string; expectedVersion: number; name: string; description: string; ownerId: string; members: MemberInput[] };

export type BundleMemberView = {
  pageId: string;
  title: string;
  mode: BundleMode;
  modeLabel: string;
  publishedVersionNo: number | null;
  revisionVersion: number | null;
  availability: PackageAvailability;
};

export type BundleDraftView = {
  baseVersion: number;
  name: string;
  description: string;
  ownerId: string;
  members: BundleMemberView[];
  updatedAt: string;
};

export type BundleView = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  version: number;
  state: "draft" | "published";
  access: "manage" | "edit" | "view";
  publicationId: string | null;
  publicationNo: number | null;
  immutableSnapshot: boolean;
  members: BundleMemberView[];
  recoverableDraft: BundleDraftView | null;
  replayed?: boolean;
  unchanged?: boolean;
};

type BundleRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  owner_id: string;
  state: "draft" | "published" | "archived";
  version: number;
  members: StoredMember[] | string;
  created_by: string;
  archived_at: string | null;
};

type Gate = { role: string; manager: boolean; native: boolean; bundle: BundleRow; access: "manage" | "edit" | "view" };
type Resolved = BundleMemberView & { document: RichNode | null; pinnedVersion: number | null };

function asJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function digest(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function membersOf(row: BundleRow): StoredMember[] {
  return asJson<StoredMember[]>(row.members);
}

function iso(value: string | Date) {
  return new Date(value).toISOString();
}

async function audit(tx: Sql, actor: Actor, action: string, operationId: string, bundleId: string | null, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id, actor_id, action, page_id, subject_id, after_value, correlation_id) VALUES($1,$2,$3,NULL,$4,$5,$6)",
    [randomUUID(), actor.id, action, bundleId, JSON.stringify({ source: "document-bundle", operationId, atIst: formatIst(new Date()), ...after }), operationId],
  );
}

async function priorOperation(tx: Sql, actor: Actor, operationId: string, requestHash: string) {
  const prior = await tx.query<{ request_hash: string; bundle_id: string | null; result: unknown }>(
    "SELECT request_hash, bundle_id, result FROM hs_document_bundle_operations WHERE actor_id=$1 AND operation_id=$2",
    [actor.id, operationId],
  );
  const row = prior.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new DocumentError("Operation ID was reused with different content", "operation_mismatch", 409);
  return { bundleId: row.bundle_id, result: asJson<Record<string, unknown>>(row.result as Record<string, unknown> | string) };
}

async function finish(tx: Sql, actor: Actor, operationId: string, requestHash: string, bundleId: string | null, result: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_document_bundle_operations(actor_id, operation_id, request_hash, bundle_id, result) VALUES($1,$2,$3,$4,$5)",
    [actor.id, operationId, requestHash, bundleId, JSON.stringify(result)],
  );
}

async function workspaceRole(tx: Sql, workspaceId: string, actor: Actor) {
  const rows = await tx.query<{ role: string }>(
    "SELECT m.role FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1",
    [workspaceId, actor.id],
  );
  if (!rows.rows.length) throw unavailable();
  return rows.rows[0].role;
}

function nativeManager(role: string) {
  return role === "owner" || role === "admin";
}

async function managerFlag(tx: Sql, workspaceId: string, actor: Actor, role: string) {
  if (role === "observer") return false;
  if (nativeManager(role)) return true;
  const rows = await tx.query("SELECT 1 FROM hs_document_bundle_managers WHERE workspace_id=$1 AND user_id=$2", [workspaceId, actor.id]);
  return rows.rows.length > 0;
}

async function requireManager(tx: Sql, workspaceId: string, actor: Actor) {
  const role = await workspaceRole(tx, workspaceId, actor);
  if (role === "observer") throw readOnly();
  if (!await managerFlag(tx, workspaceId, actor, role)) throw new DocumentError("Bundle management authority required", "management_required", 403);
  return { role, native: nativeManager(role) };
}

async function activeMember(tx: Sql, workspaceId: string, userId: string) {
  const rows = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, userId]);
  return rows.rows[0] ?? null;
}

async function loadBundle(tx: Sql, workspaceId: string, id: string, lock: boolean) {
  if (!uuidPattern.test(id)) throw unavailable();
  const rows = await tx.query<BundleRow>(
    `SELECT * FROM hs_document_bundles WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
    [id, workspaceId],
  );
  if (!rows.rows.length) throw unavailable();
  return rows.rows[0];
}

async function bundleAccess(tx: Sql, actor: Actor, row: BundleRow, role: string, manager: boolean): Promise<Gate["access"] | null> {
  if (manager) return "manage";
  const grant = await tx.query<{ role: "viewer" | "editor" }>("SELECT role FROM hs_document_bundle_grants WHERE bundle_id=$1 AND subject=$2", [row.id, actor.id]);
  const granted = grant.rows[0]?.role;
  const owner = row.owner_id === actor.id;
  if (!owner && !granted) return null;
  if (role === "observer") return "view";
  if (owner || granted === "editor") return "edit";
  return "view";
}

async function gate(tx: Sql, workspaceId: string, actor: Actor, bundleId: string, lock: boolean, edit: boolean): Promise<Gate> {
  const role = await workspaceRole(tx, workspaceId, actor);
  const manager = await managerFlag(tx, workspaceId, actor, role);
  const bundle = await loadBundle(tx, workspaceId, bundleId, lock);
  const access = await bundleAccess(tx, actor, bundle, role, manager);
  if (!access) throw unavailable();
  if (edit && access === "view") throw readOnly();
  return { role, manager, native: nativeManager(role), bundle, access };
}

async function readablePage(r: Repository, tx: Sql, actor: Actor, workspaceId: string, pageId: string) {
  try {
    const page = await r.access(tx, pageId, actor, false);
    if (page.workspace_id !== workspaceId) return null;
    return page;
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

async function publishedRevision(tx: Sql, pageId: string, mode: BundleMode, pinnedVersion: number | null) {
  if (mode === "pinned") {
    const rows = await tx.query<{ version_no: number; revision_version: number }>(
      "SELECT version_no, revision_version FROM hs_published_versions WHERE page_id=$1 AND version_no=$2",
      [pageId, pinnedVersion],
    );
    return rows.rows[0] ?? null;
  }
  const rows = await tx.query<{ version_no: number; revision_version: number }>(
    `SELECT v.version_no, v.revision_version FROM hs_published_versions v
     LEFT JOIN hs_page_publication_state s ON s.page_id=v.page_id
     WHERE v.page_id=$1 AND COALESCE(s.live, true)=true
     ORDER BY v.version_no DESC LIMIT 1`,
    [pageId],
  );
  return rows.rows[0] ?? null;
}

async function resolveMember(tx: Sql, actorPageTitle: string, member: StoredMember, withDocument: boolean, frozen?: { publishedVersionNo: number; revisionVersion: number } | null): Promise<Resolved> {
  let publishedVersionNo: number | null = frozen?.publishedVersionNo ?? null;
  let revisionVersion: number | null = frozen?.revisionVersion ?? null;
  let availability: PackageAvailability = "ready";
  if (!frozen) {
    const published = await publishedRevision(tx, member.pageId, member.mode, member.pinnedVersion);
    if (!published) availability = member.mode === "pinned" ? "missing" : "unpublished";
    else {
      publishedVersionNo = published.version_no;
      revisionVersion = published.revision_version;
    }
  }
  let title = actorPageTitle;
  let document: RichNode | null = null;
  if (revisionVersion) {
    const revision = await tx.query<{ title: string; document: RichNode | string }>(
      `SELECT title${withDocument ? ", document" : ""} FROM hs_revisions WHERE page_id=$1 AND version=$2`,
      [member.pageId, revisionVersion],
    );
    if (!revision.rows.length) availability = "missing";
    else {
      title = revision.rows[0].title;
      if (withDocument) document = asJson<RichNode>(revision.rows[0].document);
    }
  }
  return {
    pageId: member.pageId,
    title,
    mode: member.mode,
    modeLabel: modeLabel(member.mode, member.pinnedVersion, frozen ? publishedVersionNo : null),
    publishedVersionNo,
    revisionVersion,
    availability,
    document,
    pinnedVersion: member.pinnedVersion,
  };
}

async function project(r: Repository, tx: Sql, actor: Actor, workspaceId: string, members: StoredMember[], withDocument: boolean, frozen: Map<string, { publishedVersionNo: number; revisionVersion: number }> | null) {
  const visible: Resolved[] = [];
  for (const member of members) {
    const page = await readablePage(r, tx, actor, workspaceId, member.pageId);
    if (!page) continue;
    visible.push(await resolveMember(tx, page.title, member, withDocument, frozen?.get(member.pageId) ?? null));
  }
  return visible;
}

function viewMember(member: Resolved): BundleMemberView {
  return {
    pageId: member.pageId,
    title: member.title,
    mode: member.mode,
    modeLabel: member.modeLabel,
    publishedVersionNo: member.publishedVersionNo,
    revisionVersion: member.revisionVersion,
    availability: member.availability,
  };
}

async function latestPublication(tx: Sql, bundleId: string) {
  const rows = await tx.query<{ id: string; publication_no: number; snapshot: { members?: SnapshotMember[] } | string }>(
    "SELECT id, publication_no, snapshot FROM hs_document_bundle_publications WHERE bundle_id=$1 ORDER BY publication_no DESC LIMIT 1",
    [bundleId],
  );
  return rows.rows[0] ?? null;
}

async function publicationById(tx: Sql, bundleId: string, publicationId: string) {
  if (!uuidPattern.test(publicationId)) throw unavailable();
  const rows = await tx.query<{ id: string; publication_no: number; config_version: number; name: string; snapshot: { members?: SnapshotMember[] } | string }>(
    "SELECT id, publication_no, config_version, name, snapshot FROM hs_document_bundle_publications WHERE id=$1 AND bundle_id=$2",
    [publicationId, bundleId],
  );
  if (!rows.rows.length) throw unavailable();
  return rows.rows[0];
}

type SnapshotMember = StoredMember & { publishedVersionNo: number; revisionVersion: number };

function snapshotMembers(snapshot: { members?: SnapshotMember[] } | string): SnapshotMember[] {
  return asJson<{ members?: SnapshotMember[] }>(snapshot).members ?? [];
}

async function draftView(r: Repository, tx: Sql, actor: Actor, workspaceId: string, bundleId: string) {
  const rows = await tx.query<{ base_version: number; name: string; description: string; owner_id: string; members: StoredMember[] | string; updated_at: string | Date }>(
    "SELECT base_version, name, description, owner_id, members, updated_at FROM hs_document_bundle_drafts WHERE bundle_id=$1 AND actor_id=$2",
    [bundleId, actor.id],
  );
  const draft = rows.rows[0];
  if (!draft) return null;
  const members = await project(r, tx, actor, workspaceId, asJson<StoredMember[]>(draft.members), false, null);
  return {
    baseVersion: draft.base_version,
    name: draft.name,
    description: draft.description,
    ownerId: draft.owner_id,
    members: members.map(viewMember),
    updatedAt: iso(draft.updated_at),
  };
}

async function present(r: Repository, tx: Sql, actor: Actor, workspaceId: string, bundleId: string): Promise<BundleView> {
  const opened = await gate(tx, workspaceId, actor, bundleId, false, false);
  const owner = await tx.query<{ name: string }>("SELECT name FROM hs_users WHERE id=$1", [opened.bundle.owner_id]);
  const publication = await latestPublication(tx, bundleId);
  const members = await project(r, tx, actor, workspaceId, membersOf(opened.bundle), false, null);
  return {
    id: opened.bundle.id,
    workspaceId,
    name: opened.bundle.name,
    description: opened.bundle.description,
    ownerId: opened.bundle.owner_id,
    ownerName: owner.rows[0]?.name ?? "",
    version: opened.bundle.version,
    state: publication ? "published" : "draft",
    access: opened.access,
    publicationId: publication?.id ?? null,
    publicationNo: publication?.publication_no ?? null,
    immutableSnapshot: Boolean(publication),
    members: members.map(viewMember),
    recoverableDraft: await draftView(r, tx, actor, workspaceId, bundleId),
  };
}

async function acceptMembers(r: Repository, tx: Sql, actor: Actor, workspaceId: string, stored: StoredMember[], submitted: MemberInput[]) {
  const readable = new Set<string>();
  for (const member of stored) {
    if (await readablePage(r, tx, actor, workspaceId, member.pageId)) readable.add(member.pageId);
  }
  const normalized: StoredMember[] = [];
  for (const member of submitted) {
    const page = await readablePage(r, tx, actor, workspaceId, member.pageId);
    if (!page) throw documentUnavailable();
    if (member.mode === "pinned") {
      const pin = member.pinnedVersion ?? null;
      if (!pin) throw new DocumentError("Choose a published revision to pin.", "bundle_pin", 422);
      const published = await publishedRevision(tx, member.pageId, "pinned", pin);
      if (!published) throw new DocumentError("Choose a published revision to pin.", "bundle_pin", 422);
      normalized.push({ pageId: member.pageId, mode: "pinned", pinnedVersion: pin });
    } else normalized.push({ pageId: member.pageId, mode: "live", pinnedVersion: null });
    readable.add(member.pageId);
  }
  const merged = mergeMembers(stored, normalized, readable);
  if (!merged.ok && merged.reason === "duplicate") throw new DocumentError("A document can appear once in a bundle.", "bundle_duplicate", 422);
  if (!merged.ok && merged.reason === "limit") throw new DocumentError("A bundle can reference at most 100 documents.", "bundle_limit", 422);
  if (!merged.ok) throw documentUnavailable();
  return merged.members;
}

async function requireOwner(tx: Sql, workspaceId: string, ownerId: string) {
  const member = await activeMember(tx, workspaceId, ownerId);
  if (!member) throw new DocumentError("Choose an active member of this workspace as the owner.", "bundle_owner", 422);
}

async function insertRevision(tx: Sql, bundle: BundleRow, version: number, action: string, actor: Actor, operationId: string, detail: Record<string, unknown>) {
  await tx.query(
    `INSERT INTO hs_document_bundle_revisions(bundle_id, version, action, name, description, owner_id, members, detail, actor_id, operation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [bundle.id, version, action, bundle.name, bundle.description, bundle.owner_id, JSON.stringify(membersOf(bundle)), JSON.stringify(detail), actor.id, operationId],
  );
}

function sameConfig(row: BundleRow, name: string, description: string, ownerId: string, members: StoredMember[]) {
  return row.name === name && row.description === description && row.owner_id === ownerId && digest(membersOf(row)) === digest(members);
}

export async function grantBundleManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = digest({ action: "grant-manager", workspaceId, ...input });
  return r.db.transaction(async tx => {
    const authority = await requireManager(tx, workspaceId, actor);
    if (!authority.native) throw new DocumentError("A native workspace administrator must appoint bundle managers.", "management_required", 403);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...prior.result, replayed: true };
    const member = await activeMember(tx, workspaceId, input.userId);
    if (!member) throw unavailable();
    if (member.role === "observer") throw new DocumentError("Observers cannot manage document bundles.", "read_only", 403);
    await tx.query(
      "INSERT INTO hs_document_bundle_managers(workspace_id, user_id, granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [workspaceId, input.userId, actor.id],
    );
    const result = { userId: input.userId, granted: true };
    await audit(tx, actor, "document-bundle.grant-manager", input.operationId, null, { workspaceId, userId: input.userId });
    await finish(tx, actor, input.operationId, requestHash, null, result);
    return { ...result, replayed: false };
  });
}

export async function revokeBundleManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = digest({ action: "revoke-manager", workspaceId, ...input });
  return r.db.transaction(async tx => {
    const authority = await requireManager(tx, workspaceId, actor);
    if (!authority.native) throw new DocumentError("A native workspace administrator must appoint bundle managers.", "management_required", 403);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...prior.result, replayed: true };
    if (!await activeMember(tx, workspaceId, input.userId)) throw unavailable();
    const removed = await tx.query("DELETE FROM hs_document_bundle_managers WHERE workspace_id=$1 AND user_id=$2 RETURNING user_id", [workspaceId, input.userId]);
    const result = { userId: input.userId, revoked: removed.rows.length > 0 };
    if (removed.rows.length) await audit(tx, actor, "document-bundle.revoke-manager", input.operationId, null, { workspaceId, userId: input.userId });
    await finish(tx, actor, input.operationId, requestHash, null, result);
    return { ...result, replayed: false };
  });
}

export async function listDocumentBundles(r: Repository, actor: Actor, workspaceId: string, query = "", pageId?: string | null) {
  return r.db.transaction(async tx => {
    const role = await workspaceRole(tx, workspaceId, actor);
    const manage = await managerFlag(tx, workspaceId, actor, role);
    const rows = await tx.query<{ id: string; name: string; description: string; owner_id: string; owner_name: string; version: number; state: string; members: StoredMember[] | string; publication_no: number | null }>(
      `SELECT b.id, b.name, b.description, b.owner_id, u.name AS owner_name, b.version, b.state, b.members,
        (SELECT p.publication_no FROM hs_document_bundle_publications p WHERE p.bundle_id=b.id ORDER BY p.publication_no DESC LIMIT 1) AS publication_no
       FROM hs_document_bundles b JOIN hs_users u ON u.id=b.owner_id
       WHERE b.workspace_id=$1 AND b.archived_at IS NULL
         AND ($2::boolean OR b.owner_id=$3 OR EXISTS (SELECT 1 FROM hs_document_bundle_grants g WHERE g.bundle_id=b.id AND g.subject=$3))
       ORDER BY lower(b.name), b.id`,
      [workspaceId, manage, actor.id],
    );
    const needle = query.trim().toLocaleLowerCase();
    const bundles = [];
    for (const row of rows.rows) {
      const summary = { id: row.id, name: row.name, description: row.description, ownerId: row.owner_id, ownerName: row.owner_name, version: row.version, state: row.publication_no ? "published" : "draft", publicationNo: row.publication_no };
      if (needle.length < 2) {
        bundles.push(summary);
        continue;
      }
      const nameHit = `${row.name}\n${row.description}`.toLocaleLowerCase().includes(needle);
      if (nameHit) {
        bundles.push(summary);
        continue;
      }
      const visible = await project(r, tx, actor, workspaceId, asJson<StoredMember[]>(row.members), false, null);
      const match = visible.find(member => member.title.toLocaleLowerCase().includes(needle));
      if (!match) continue;
      bundles.push({ ...summary, matchedDocumentTitle: match.title });
    }
    const colleagues = manage
      ? (await tx.query<{ id: string; name: string }>("SELECT u.id, u.name FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.active=true ORDER BY lower(u.name), u.id", [workspaceId])).rows
      : undefined;
    let currentPage: { id: string; title: string; publishedVersions: number[] } | undefined;
    if (pageId) {
      const page = await readablePage(r, tx, actor, workspaceId, pageId);
      if (page) {
        const versions = await tx.query<{ version_no: number }>("SELECT version_no FROM hs_published_versions WHERE page_id=$1 ORDER BY version_no", [pageId]);
        currentPage = { id: page.id, title: page.title, publishedVersions: versions.rows.map(version => version.version_no) };
      }
    }
    return { manage, bundles, ...(colleagues ? { colleagues } : {}), ...(currentPage ? { currentPage } : {}) };
  });
}

export async function readDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string) {
  return r.db.transaction(tx => present(r, tx, actor, workspaceId, bundleId));
}

export async function createDocumentBundle(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; name: string; description: string; ownerId: string; members: MemberInput[] }) {
  const name = input.name.trim();
  const description = input.description.trim();
  if (name.length < 1 || name.length > bundleLimits.name) throw new DocumentError("Enter a bundle name of 1–100 characters.", "bundle_name", 422);
  if (description.length > bundleLimits.description) throw new DocumentError("Shorten the bundle description.", "bundle_description", 422);
  const requestHash = digest({ action: "create", workspaceId, operationId: input.operationId, name, description, ownerId: input.ownerId, members: input.members });
  return r.db.transaction(async tx => {
    await requireManager(tx, workspaceId, actor);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior?.bundleId) return { ...(await present(r, tx, actor, workspaceId, prior.bundleId)), replayed: true };
    await requireOwner(tx, workspaceId, input.ownerId);
    const members = await acceptMembers(r, tx, actor, workspaceId, [], input.members);
    const id = randomUUID();
    try {
      await tx.query(
        `INSERT INTO hs_document_bundles(id, workspace_id, name, description, owner_id, state, version, members, created_by)
         VALUES($1,$2,$3,$4,$5,'draft',1,$6,$7)`,
        [id, workspaceId, name, description, input.ownerId, JSON.stringify(members), actor.id],
      );
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") throw new DocumentError("A bundle in this workspace already uses that name.", "bundle_name", 409);
      throw error;
    }
    const bundle = await loadBundle(tx, workspaceId, id, true);
    await insertRevision(tx, bundle, 1, "create", actor, input.operationId, {});
    await audit(tx, actor, "document-bundle.create", input.operationId, id, { workspaceId, version: 1, ownerId: input.ownerId });
    await finish(tx, actor, input.operationId, requestHash, id, { id, version: 1 });
    return { ...(await present(r, tx, actor, workspaceId, id)), replayed: false };
  });
}

async function writeConfig(tx: Sql, bundle: BundleRow, name: string, description: string, ownerId: string, members: StoredMember[], action: string, actor: Actor, operationId: string, detail: Record<string, unknown>) {
  const version = bundle.version + 1;
  await tx.query(
    "UPDATE hs_document_bundles SET name=$2, description=$3, owner_id=$4, members=$5, version=$6, updated_at=clock_timestamp() WHERE id=$1",
    [bundle.id, name, description, ownerId, JSON.stringify(members), version],
  );
  const next = { ...bundle, name, description, owner_id: ownerId, members, version };
  await insertRevision(tx, next, version, action, actor, operationId, detail);
  await tx.query("DELETE FROM hs_document_bundle_drafts WHERE bundle_id=$1 AND actor_id=$2", [bundle.id, actor.id]);
  return version;
}

export async function saveDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string, input: BundleSaveInput) {
  const name = input.name.trim();
  const description = input.description.trim();
  if (name.length < 1 || name.length > bundleLimits.name) throw new DocumentError("Enter a bundle name of 1–100 characters.", "bundle_name", 422);
  if (description.length > bundleLimits.description) throw new DocumentError("Shorten the bundle description.", "bundle_description", 422);
  const requestHash = digest({ action: "save", workspaceId, bundleId, ...input, name, description });
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, true, true);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: true };
    if (opened.bundle.version !== input.expectedVersion) throw conflict();
    await requireOwner(tx, workspaceId, input.ownerId);
    const members = await acceptMembers(r, tx, actor, workspaceId, membersOf(opened.bundle), input.members);
    if (sameConfig(opened.bundle, name, description, input.ownerId, members)) {
      await finish(tx, actor, input.operationId, requestHash, bundleId, { id: bundleId, version: opened.bundle.version, unchanged: true });
      return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: false, unchanged: true };
    }
    try {
      const version = await writeConfig(tx, opened.bundle, name, description, input.ownerId, members, "save", actor, input.operationId, {});
      await audit(tx, actor, "document-bundle.save", input.operationId, bundleId, { workspaceId, version, ownerId: input.ownerId });
      await finish(tx, actor, input.operationId, requestHash, bundleId, { id: bundleId, version });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") throw new DocumentError("A bundle in this workspace already uses that name.", "bundle_name", 409);
      throw error;
    }
    return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: false };
  });
}

export async function stashDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string, input: BundleSaveInput) {
  const name = input.name.trim();
  const description = input.description.trim();
  if (name.length < 1 || name.length > bundleLimits.name) throw new DocumentError("Enter a bundle name of 1–100 characters.", "bundle_name", 422);
  const requestHash = digest({ action: "stash", workspaceId, bundleId, ...input, name, description });
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, true, true);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: true };
    if (opened.bundle.version !== input.expectedVersion) throw conflict();
    await requireOwner(tx, workspaceId, input.ownerId);
    const members = await acceptMembers(r, tx, actor, workspaceId, membersOf(opened.bundle), input.members);
    await tx.query(
      `INSERT INTO hs_document_bundle_drafts(bundle_id, actor_id, base_version, name, description, owner_id, members, operation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (bundle_id, actor_id) DO UPDATE SET base_version=EXCLUDED.base_version, name=EXCLUDED.name, description=EXCLUDED.description, owner_id=EXCLUDED.owner_id, members=EXCLUDED.members, operation_id=EXCLUDED.operation_id, updated_at=clock_timestamp()`,
      [bundleId, actor.id, opened.bundle.version, name, description, input.ownerId, JSON.stringify(members), input.operationId],
    );
    await audit(tx, actor, "document-bundle.stash", input.operationId, bundleId, { workspaceId, version: opened.bundle.version });
    await finish(tx, actor, input.operationId, requestHash, bundleId, { id: bundleId, version: opened.bundle.version, stashed: true });
    return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: false };
  });
}

export async function discardDocumentBundleDraft(r: Repository, actor: Actor, workspaceId: string, bundleId: string, operationId: string) {
  const requestHash = digest({ action: "discard-draft", workspaceId, bundleId, operationId });
  return r.db.transaction(async tx => {
    await gate(tx, workspaceId, actor, bundleId, true, true);
    const prior = await priorOperation(tx, actor, operationId, requestHash);
    if (prior) return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: true };
    await tx.query("DELETE FROM hs_document_bundle_drafts WHERE bundle_id=$1 AND actor_id=$2", [bundleId, actor.id]);
    await audit(tx, actor, "document-bundle.discard-draft", operationId, bundleId, { workspaceId });
    await finish(tx, actor, operationId, requestHash, bundleId, { id: bundleId, discarded: true });
    return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: false };
  });
}

async function freezeMembers(r: Repository, tx: Sql, actor: Actor, workspaceId: string, members: StoredMember[]) {
  const frozen: SnapshotMember[] = [];
  let hidden = false;
  let missingPin = false;
  const unpublished: string[] = [];
  for (const member of members) {
    const page = await readablePage(r, tx, actor, workspaceId, member.pageId);
    if (!page) {
      hidden = true;
      continue;
    }
    const published = await publishedRevision(tx, member.pageId, member.mode, member.pinnedVersion);
    if (!published) {
      if (member.mode === "live") unpublished.push(page.title);
      else missingPin = true;
      continue;
    }
    frozen.push({ ...member, publishedVersionNo: published.version_no, revisionVersion: published.revision_version });
  }
  if (hidden) throw new DocumentError("A document in this bundle is not ready to package. The draft was kept.", "bundle_unpublished", 422);
  if (missingPin) throw new DocumentError("Choose a published revision that still exists. The draft was kept.", "bundle_unpublished", 422);
  if (unpublished.length || frozen.length !== members.length) throw new DocumentError(`Publish ${unpublished.join(", ")} before packaging a live reference. The draft was kept.`, "bundle_unpublished", 422);
  return frozen;
}

export async function publishDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string, input: { operationId: string; expectedVersion: number }) {
  const requestHash = digest({ action: "publish", workspaceId, bundleId, ...input });
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, true, true);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: true };
    if (opened.bundle.version !== input.expectedVersion) throw conflict();
    const snapshotMembers = await freezeMembers(r, tx, actor, workspaceId, membersOf(opened.bundle));
    const snapshot = { members: snapshotMembers };
    const version = opened.bundle.version + 1;
    const publicationNo = Number((await tx.query<{ n: number }>("SELECT COALESCE(MAX(publication_no),0)::int+1 AS n FROM hs_document_bundle_publications WHERE bundle_id=$1", [bundleId])).rows[0].n);
    const publicationId = randomUUID();
    await tx.query("UPDATE hs_document_bundles SET state='published', version=$2, updated_at=clock_timestamp() WHERE id=$1", [bundleId, version]);
    const next = { ...opened.bundle, version, state: "published" as const };
    await insertRevision(tx, next, version, "publish", actor, input.operationId, { publicationNo });
    await tx.query(
      `INSERT INTO hs_document_bundle_publications(id, bundle_id, publication_no, config_version, name, description, owner_id, snapshot, snapshot_hash, published_by, operation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [publicationId, bundleId, publicationNo, version, opened.bundle.name, opened.bundle.description, opened.bundle.owner_id, JSON.stringify(snapshot), digest(snapshot), actor.id, input.operationId],
    );
    await audit(tx, actor, "document-bundle.publish", input.operationId, bundleId, { workspaceId, version, publicationNo });
    await finish(tx, actor, input.operationId, requestHash, bundleId, { id: bundleId, version, publicationId, publicationNo });
    return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: false };
  });
}

export async function shareDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string, input: { operationId: string; expectedVersion: number; subjectId: string; role: "viewer" | "editor" }) {
  const requestHash = digest({ action: "share", workspaceId, bundleId, ...input });
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, true, true);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: true };
    if (opened.bundle.version !== input.expectedVersion) throw conflict();
    if (!await activeMember(tx, workspaceId, input.subjectId)) throw unavailable();
    const existing = await tx.query<{ role: string }>("SELECT role FROM hs_document_bundle_grants WHERE bundle_id=$1 AND subject=$2", [bundleId, input.subjectId]);
    if (existing.rows[0]?.role === input.role) {
      await finish(tx, actor, input.operationId, requestHash, bundleId, { id: bundleId, version: opened.bundle.version, unchanged: true });
      return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: false, unchanged: true };
    }
    await tx.query(
      `INSERT INTO hs_document_bundle_grants(bundle_id, subject, role) VALUES($1,$2,$3)
       ON CONFLICT (bundle_id, subject) DO UPDATE SET role=EXCLUDED.role`,
      [bundleId, input.subjectId, input.role],
    );
    const version = opened.bundle.version + 1;
    await tx.query("UPDATE hs_document_bundles SET version=$2, updated_at=clock_timestamp() WHERE id=$1", [bundleId, version]);
    await insertRevision(tx, { ...opened.bundle, version }, version, "share", actor, input.operationId, { subjectId: input.subjectId, role: input.role });
    await audit(tx, actor, "document-bundle.share", input.operationId, bundleId, { workspaceId, version, subjectId: input.subjectId, role: input.role });
    await finish(tx, actor, input.operationId, requestHash, bundleId, { id: bundleId, version });
    return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: false };
  });
}

export async function unshareDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string, input: { operationId: string; expectedVersion: number; subjectId: string }) {
  const requestHash = digest({ action: "unshare", workspaceId, bundleId, ...input });
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, true, true);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: true };
    if (opened.bundle.version !== input.expectedVersion) throw conflict();
    const removed = await tx.query("DELETE FROM hs_document_bundle_grants WHERE bundle_id=$1 AND subject=$2 RETURNING subject", [bundleId, input.subjectId]);
    if (!removed.rows.length) throw unavailable();
    const version = opened.bundle.version + 1;
    await tx.query("UPDATE hs_document_bundles SET version=$2, updated_at=clock_timestamp() WHERE id=$1", [bundleId, version]);
    await insertRevision(tx, { ...opened.bundle, version }, version, "unshare", actor, input.operationId, { subjectId: input.subjectId });
    await audit(tx, actor, "document-bundle.unshare", input.operationId, bundleId, { workspaceId, version, subjectId: input.subjectId });
    await finish(tx, actor, input.operationId, requestHash, bundleId, { id: bundleId, version });
    return { ...(await present(r, tx, actor, workspaceId, bundleId)), replayed: false };
  });
}

export async function archiveDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string, input: { operationId: string; expectedVersion: number }) {
  const requestHash = digest({ action: "archive", workspaceId, bundleId, ...input });
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, true, true);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { id: bundleId, archived: true, version: Number(prior.result.version ?? opened.bundle.version), replayed: true };
    if (opened.bundle.version !== input.expectedVersion) throw conflict();
    const version = opened.bundle.version + 1;
    await tx.query("UPDATE hs_document_bundles SET state='archived', archived_at=clock_timestamp(), version=$2, updated_at=clock_timestamp() WHERE id=$1", [bundleId, version]);
    await insertRevision(tx, { ...opened.bundle, version }, version, "archive", actor, input.operationId, {});
    await audit(tx, actor, "document-bundle.archive", input.operationId, bundleId, { workspaceId, version });
    const result = { id: bundleId, archived: true, version };
    await finish(tx, actor, input.operationId, requestHash, bundleId, result);
    return { ...result, replayed: false };
  });
}

async function selectedMembers(r: Repository, tx: Sql, actor: Actor, workspaceId: string, bundle: BundleRow, publicationId?: string | null) {
  if (!publicationId) {
    const members = await project(r, tx, actor, workspaceId, membersOf(bundle), true, null);
    return { immutable: false, publicationId: null as string | null, publicationNo: null as number | null, name: bundle.name, members };
  }
  const publication = await publicationById(tx, bundle.id, publicationId);
  const snapshot = snapshotMembers(publication.snapshot);
  const frozen = new Map(snapshot.map(member => [member.pageId, { publishedVersionNo: member.publishedVersionNo, revisionVersion: member.revisionVersion }]));
  const members = await project(r, tx, actor, workspaceId, snapshot, true, frozen);
  return { immutable: true, publicationId: publication.id, publicationNo: publication.publication_no, name: publication.name, members };
}

async function inspectMember(tx: Sql, actor: Actor, workspaceId: string, member: Resolved) {
  const policy = await tx.query<{ export_enabled: boolean }>("SELECT export_enabled FROM hs_workspaces WHERE id=$1", [workspaceId]);
  const exportRight = Boolean(policy.rows[0]?.export_enabled);
  let unavailableAssets = 0;
  let retention: PackageRetention = "clear";
  let hiddenFields = 0;
  let restrictedRecords = 0;
  const lines: string[] = [];
  if (member.document && member.revisionVersion) {
    const ids = documentBlocks(member.document).flatMap(block => (block.type === "image" || block.type === "file") && typeof block.node.attrs?.attachmentId === "string" ? [String(block.node.attrs.attachmentId)] : []);
    const valid = ids.filter(id => uuidPattern.test(id));
    unavailableAssets += ids.length - valid.length;
    if (valid.length) {
      const ready = await tx.query<{ id: string }>("SELECT id::text AS id FROM hs_media WHERE page_id=$1 AND state='ready' AND id::text = ANY($2::text[])", [member.pageId, valid]);
      unavailableAssets += valid.length - ready.rows.length;
    }
    const revision = await tx.query<{ superseded_at: string | Date | null }>("SELECT superseded_at FROM hs_revisions WHERE page_id=$1 AND version=$2", [member.pageId, member.revisionVersion]);
    const superseded = revision.rows[0]?.superseded_at;
    if (superseded && Date.now() - new Date(superseded).getTime() >= bundleLimits.retentionDays * 24 * 60 * 60 * 1000) retention = "elapsed";
    const slices = await exportRecordPageRefs(tx, actor, workspaceId, member.document, "https://holy-sheet.local");
    const visibleRecords: string[] = [];
    if (slices) {
      for (const [id, slice] of Object.entries(slices) as [string, RecordExportSlice][]) {
        if (slice.kind !== "record") continue;
        if (!slice.available) {
          restrictedRecords += 1;
          lines.push("Restricted record");
          continue;
        }
        if (uuidPattern.test(id)) visibleRecords.push(id);
        lines.push(slice.title);
        for (const field of slice.fields) {
          if (field.value === null) hiddenFields += 1;
          else lines.push(`${field.label}: ${field.value}`);
        }
      }
    }
    if (visibleRecords.length && retention === "clear") {
      const held = await tx.query("SELECT id::text AS id FROM hs_data_records WHERE id::text = ANY($1::text[]) AND retention_hold=true", [visibleRecords]);
      if (held.rows.length) retention = "held";
    }
    const prose = plainText(member.document).trim();
    if (prose) lines.unshift(prose);
  }
  const decision = packageDecision({ availability: member.availability, exportRight, unavailableAssets, retention });
  return { exportRight, unavailableAssets, retention, hiddenFields, restrictedRecords, lines, ...decision };
}

export async function previewDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string, publicationId?: string | null) {
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, false, false);
    const selected = await selectedMembers(r, tx, actor, workspaceId, opened.bundle, publicationId);
    const items = [];
    for (const member of selected.members) {
      const inspected = await inspectMember(tx, actor, workspaceId, member);
      items.push({
        pageId: member.pageId,
        title: member.title,
        mode: member.mode,
        modeLabel: member.modeLabel,
        publishedVersionNo: member.publishedVersionNo,
        revisionVersion: member.revisionVersion,
        exportRight: inspected.exportRight,
        unavailableAssets: inspected.unavailableAssets,
        retention: inspected.retention,
        hiddenFields: inspected.hiddenFields,
        restrictedRecords: inspected.restrictedRecords,
        exportable: inspected.exportable,
        reason: inspected.reason,
      });
    }
    return { source: selected.immutable ? "publication" as const : "draft" as const, immutable: selected.immutable, publicationId: selected.publicationId, publicationNo: selected.publicationNo, items };
  });
}

export async function downloadDocumentBundle(r: Repository, actor: Actor, workspaceId: string, bundleId: string, input: { operationId: string; expectedVersion: number; publicationId?: string | null }) {
  const requestHash = digest({ action: "download", workspaceId, bundleId, ...input });
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, false, false);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    const selected = await selectedMembers(r, tx, actor, workspaceId, opened.bundle, input.publicationId);
    const expected = selected.immutable ? selected.publicationNo : opened.bundle.version;
    if (!prior && expected !== input.expectedVersion) throw conflict();
    const included: string[] = [];
    const withheld: { title: string; reason: string }[] = [];
    const sections: string[] = [];
    for (const member of selected.members) {
      const inspected = await inspectMember(tx, actor, workspaceId, member);
      if (!inspected.exportable) {
        withheld.push({ title: member.title, reason: inspected.reason });
        continue;
      }
      included.push(member.pageId);
      const body = inspected.lines.join("\n").trim();
      sections.push(`## ${member.title}\n\nMode: ${member.modeLabel}\n\n${body}`.trim());
    }
    const heading = selected.immutable ? `# ${selected.name}\n\nPublished package snapshot ${selected.publicationNo}. This snapshot is immutable.\n` : `# ${selected.name}\n\nDraft bundle. This download is not a published snapshot.\n`;
    const body = [heading, ...sections].join("\n\n").trim() + "\n";
    const payload = { filename: bundleFilename(selected.name, selected.immutable), contentType: "text/markdown; charset=utf-8", body, withheld, immutable: selected.immutable, publicationNo: selected.publicationNo };
    if (prior) return { ...payload, replayed: true };
    await audit(tx, actor, "document-bundle.download", input.operationId, bundleId, { workspaceId, version: opened.bundle.version, publicationNo: selected.publicationNo, included });
    await finish(tx, actor, input.operationId, requestHash, bundleId, { id: bundleId, version: opened.bundle.version, included });
    return { ...payload, replayed: false };
  });
}

export async function bundleHistory(r: Repository, actor: Actor, workspaceId: string, bundleId: string) {
  return r.db.transaction(async tx => {
    await gate(tx, workspaceId, actor, bundleId, false, false);
    const rows = await tx.query<{ version: number; action: string; name: string; members: StoredMember[] | string; detail: Record<string, unknown> | string; actor_id: string; actor_name: string; operation_id: string; created_at: string | Date; publication_no: number | null }>(
      `SELECT v.version, v.action, v.name, v.members, v.detail, v.actor_id, u.name AS actor_name, v.operation_id, v.created_at, p.publication_no
       FROM hs_document_bundle_revisions v
       JOIN hs_users u ON u.id=v.actor_id
       LEFT JOIN hs_document_bundle_publications p ON p.bundle_id=v.bundle_id AND p.operation_id=v.operation_id
       WHERE v.bundle_id=$1 ORDER BY v.version`,
      [bundleId],
    );
    const events = [];
    for (const row of rows.rows) {
      const visible = await project(r, tx, actor, workspaceId, asJson<StoredMember[]>(row.members), false, null);
      const detail = asJson<Record<string, unknown>>(row.detail);
      const safeDetail: { subjectId?: string; role?: string } = {};
      if (typeof detail.subjectId === "string") safeDetail.subjectId = detail.subjectId;
      if (detail.role === "viewer" || detail.role === "editor") safeDetail.role = detail.role;
      events.push({
        version: row.version,
        action: row.action,
        actorId: row.actor_id,
        actorName: row.actor_name,
        operationId: row.operation_id,
        atIst: formatIst(row.created_at),
        source: "document-bundle" as const,
        name: row.name,
        publicationNo: row.publication_no,
        members: visible.map(viewMember),
        detail: safeDetail,
      });
    }
    return { events };
  });
}

export async function readPublishedSnapshot(r: Repository, actor: Actor, workspaceId: string, bundleId: string, publicationId: string) {
  return r.db.transaction(async tx => {
    const opened = await gate(tx, workspaceId, actor, bundleId, false, false);
    const publication = await publicationById(tx, opened.bundle.id, publicationId);
    const snapshot = snapshotMembers(publication.snapshot);
    const frozen = new Map(snapshot.map(member => [member.pageId, { publishedVersionNo: member.publishedVersionNo, revisionVersion: member.revisionVersion }]));
    const members = await project(r, tx, actor, workspaceId, snapshot, false, frozen);
    return { id: publication.id, publicationNo: publication.publication_no, immutable: true, name: publication.name, members: members.map(viewMember) };
  });
}
