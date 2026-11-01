import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, ensureIds, idTypes, plainText, schemaVersion, stableStringify, validateDocument, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import {
  SNIPPET_DELETED_BADGE,
  SNIPPET_HIDDEN_MESSAGE,
  SNIPPET_RESTRICTED_LABEL,
  SNIPPET_RETIRED_BADGE,
  SNIPPET_UPDATE_LABEL,
  retireSnippetCopy,
  snippetUsageCsv,
} from "./snippet-copy";
import { canEdit } from "./types";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const blockPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const banned = new Set(["syncedBlock", "image", "file", "pageLink", "recordRef", "recordView", "tableOfContents"]);

type SnippetRow = {
  id: string;
  workspace_id: string;
  space_id: string;
  title: string;
  synced_id: string;
  retired_at: string | null;
  deleted_at: string | null;
  purge_after: string | null;
};
type VersionRow = {
  id: string;
  snippet_id: string;
  version_number: number;
  state: "draft" | "in_review" | "approved";
  content: RichNode;
  created_by: string;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
};
type PlacementRow = { page_id: string; block_id: string; snippet_id: string; pin_version: number | null; created_by: string };
type Tier = "none" | "approved" | "govern";
type VersionState = "draft" | "in review" | "approved";
type SnippetState = VersionState | "retired";

export type SnippetVersionView = {
  id: string;
  number: number;
  state: VersionState;
  note: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAtIst: string | null;
  contentText: string | null;
};
export type SnippetLibraryItem = {
  id: string;
  title: string;
  spaceId: string;
  state: SnippetState;
  retired: boolean;
  deleted: boolean;
  restoreOpen: boolean;
  canManage: boolean;
  canApprove: boolean;
  versions: SnippetVersionView[];
};
export type SnippetPlacementView =
  | { state: "restricted"; label: typeof SNIPPET_RESTRICTED_LABEL; blockId: string }
  | {
      state: "live";
      label: string;
      blockId: string;
      snippetId: string;
      versionNumber: number;
      mode: "latest" | "pinned";
      pinVersion: number | null;
      latestApproved: number;
      badge: typeof SNIPPET_RETIRED_BADGE | typeof SNIPPET_DELETED_BADGE | null;
      updateLabel: typeof SNIPPET_UPDATE_LABEL | null;
      canManage: boolean;
      canDetach: boolean;
      editHref: string | null;
      approvedAtIst: string | null;
      content: RichNode[];
    };

const hidden = () => new DocumentError(SNIPPET_HIDDEN_MESSAGE, "not_found", 404);

function hashCommand(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
function withoutIds(node: RichNode): RichNode {
  const attrs = { ...(node.attrs ?? {}) };
  delete attrs.id;
  const next: RichNode = { ...node, ...(node.content ? { content: node.content.map(withoutIds) } : {}) };
  if (Object.keys(attrs).length) next.attrs = attrs;
  else delete next.attrs;
  return next;
}
function assertUuid(value: string) {
  if (!uuidPattern.test(value)) throw new DocumentError("Invalid snippet operation");
}
function snippetDocument(input: unknown) {
  const document = validateDocument(ensureIds(input as RichNode));
  if (Buffer.byteLength(JSON.stringify(document)) > 200_000) throw new DocumentError("Snippet content is too large");
  function walk(node: RichNode) {
    if (banned.has(node.type) || node.attrs?.snippetId) throw new DocumentError("Snippet content cannot include synced blocks, media, or page references");
    node.content?.forEach(walk);
  }
  walk(document);
  return document;
}
function purged(row: { deleted_at: string | null; purge_after: string | null }) {
  return !!row.deleted_at && !!row.purge_after && new Date(row.purge_after).getTime() <= Date.now();
}
function versionState(state: VersionRow["state"]): VersionState {
  return state === "in_review" ? "in review" : state;
}
function choose(versions: VersionRow[], pin: number | null) {
  const approved = versions.filter(version => version.state === "approved").sort((a, b) => b.version_number - a.version_number);
  if (!approved.length) return null;
  const latest = approved[0];
  if (pin == null) return { chosen: latest, latest: latest.version_number, mode: "latest" as const };
  const chosen = approved.find(version => version.version_number === pin);
  if (!chosen) return null;
  return { chosen, latest: latest.version_number, mode: "pinned" as const };
}

async function audit(tx: Sql, actor: Actor, pageId: string | null, action: string, after: Record<string, unknown>, operationId: string, subjectId?: string) {
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,subject_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), actor.id, action, pageId, subjectId ?? null, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId]);
}
async function withOperation<T extends Record<string, unknown>>(tx: Sql, scope: string, actor: Actor, operationId: string, hash: string, work: () => Promise<T>): Promise<T> {
  const prior = await tx.query<{ actor_id: string; request_hash: string; result: T }>("SELECT actor_id,request_hash,result FROM hs_snippet_operations WHERE scope_id=$1 AND operation_id=$2", [scope, operationId]);
  if (prior.rows[0]) {
    if (prior.rows[0].actor_id !== actor.id || prior.rows[0].request_hash !== hash) throw new DocumentError("Operation ID was reused with a different snippet change", "operation_mismatch", 409);
    return prior.rows[0].result;
  }
  const result = await work();
  await tx.query("INSERT INTO hs_snippet_operations(scope_id,operation_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)", [scope, operationId, actor.id, hash, JSON.stringify(result)]);
  return result;
}
async function membership(tx: Sql, workspaceId: string, actor: Actor) {
  const { rows } = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, actor.id]);
  return rows[0]?.role ?? null;
}
async function loadTier(tx: Sql, actor: Actor, workspaceId: string, spaceId: string): Promise<Tier> {
  const space = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM hs_spaces WHERE id=$1", [spaceId]);
  if (space.rows[0]?.workspace_id !== workspaceId) return "none";
  const role = await membership(tx, workspaceId, actor);
  if (!role) return "none";
  const granted = await tx.query("SELECT role FROM hs_snippet_roles WHERE space_id=$1 AND user_id=$2", [spaceId, actor.id]);
  if (granted.rows.length) return "govern";
  if (role === "owner" || role === "admin") return "approved";
  const spaceMember = await tx.query("SELECT 1 FROM hs_space_members WHERE space_id=$1 AND user_id=$2 AND active=true", [spaceId, actor.id]);
  if (spaceMember.rows.length) return "approved";
  const readable = await tx.query("SELECT 1 FROM hs_pages p WHERE p.space_id=$1 AND p.workspace_id=$2 AND p.deleted_at IS NULL AND (p.owner_id=$3 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$3 OR (p.visibility='space' AND g.subject='space')))) LIMIT 1", [spaceId, workspaceId, actor.id]);
  return readable.rows.length ? "approved" : "none";
}
async function roleFlags(tx: Sql, spaceId: string, actor: Actor) {
  const { rows } = await tx.query<{ role: string }>("SELECT role FROM hs_snippet_roles WHERE space_id=$1 AND user_id=$2", [spaceId, actor.id]);
  const roles = new Set(rows.map(row => row.role));
  return { canManage: roles.has("manager"), canApprove: roles.has("approver"), canReview: roles.has("manager") || roles.has("approver") || roles.has("reviewer") };
}
async function requireManager(tx: Sql, spaceId: string, actor: Actor) {
  const { rows } = await tx.query("SELECT role FROM hs_snippet_roles WHERE space_id=$1 AND user_id=$2 AND role='manager' FOR UPDATE", [spaceId, actor.id]);
  if (!rows.length) throw hidden();
}
async function lockSnippet(tx: Sql, snippetId: string) {
  const { rows } = await tx.query<SnippetRow>("SELECT id,workspace_id,space_id,title,synced_id,retired_at,deleted_at,purge_after FROM hs_snippets WHERE id=$1 FOR UPDATE", [snippetId]);
  return rows[0] ?? null;
}
async function versionsOf(tx: Sql, snippetIds: string[]) {
  if (!snippetIds.length) return [] as VersionRow[];
  const { rows } = await tx.query<VersionRow>("SELECT id,snippet_id,version_number,state,content,created_by,submitted_at,approved_by,approved_at,approval_note FROM hs_snippet_versions WHERE snippet_id = ANY($1::text[]) ORDER BY snippet_id,version_number", [snippetIds]);
  return rows.map(row => ({ ...row, version_number: Number(row.version_number), content: row.content }));
}
async function namesOf(tx: Sql, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, string>();
  const { rows } = await tx.query<{ id: string; name: string }>("SELECT id,name FROM hs_users WHERE id = ANY($1::text[])", [unique]);
  return new Map(rows.map(row => [row.id, row.name]));
}
function toVersionView(row: VersionRow, names: Map<string, string>, includeNote: boolean, includeText: boolean): SnippetVersionView {
  return {
    id: row.id,
    number: Number(row.version_number),
    state: versionState(row.state),
    note: includeNote ? row.approval_note : null,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by ? names.get(row.approved_by) ?? null : null,
    approvedAtIst: row.approved_at ? formatIst(row.approved_at) : null,
    contentText: includeText ? plainText(row.content) : null,
  };
}
function itemState(snippet: SnippetRow, versions: VersionRow[]): SnippetState {
  if (snippet.retired_at) return "retired";
  const latest = [...versions].sort((a, b) => b.version_number - a.version_number)[0];
  if (!latest || latest.state === "draft") return "draft";
  return latest.state === "in_review" ? "in review" : "approved";
}
async function libraryItem(tx: Sql, actor: Actor, snippet: SnippetRow, versions: VersionRow[], tier: Tier): Promise<SnippetLibraryItem> {
  const flags = await roleFlags(tx, snippet.space_id, actor);
  const names = await namesOf(tx, versions.map(version => version.approved_by ?? ""));
  const visible = versions.filter(version => tier === "govern" || version.state === "approved");
  return {
    id: snippet.id,
    title: snippet.title,
    spaceId: snippet.space_id,
    state: itemState(snippet, versions),
    retired: !!snippet.retired_at,
    deleted: !!snippet.deleted_at,
    restoreOpen: !!snippet.deleted_at && !purged(snippet),
    canManage: flags.canManage,
    canApprove: flags.canApprove,
    versions: visible.map(version => toVersionView(version, names, tier === "govern", true)),
  };
}
async function storedDocument(tx: Sql, pageId: string): Promise<RichNode> {
  const { rows } = await tx.query<{ node: RichNode }>("SELECT node FROM hs_blocks WHERE page_id=$1 AND parent_id IS NULL ORDER BY position", [pageId]);
  return { type: "doc", content: rows.map(row => row.node) };
}
async function writePage(r: Repository, tx: Sql, actor: Actor, pageId: string, document: RichNode, surface: string) {
  const page = await r.access(tx, pageId, actor, true, true);
  if (page.schema_version !== schemaVersion) throw new DocumentError("This document requires a newer editor", "schema_version", 409);
  const version = page.version + 1;
  await r.writeDocument(tx, pageId, document, version, page.title, actor.id, surface);
  await tx.query("UPDATE hs_pages SET version=$2,updated_at=clock_timestamp() WHERE id=$1", [pageId, version]);
  return version;
}
function snippetNodes(document: RichNode) {
  const nodes: { blockId: string; snippetId: string; pinVersion: number | null }[] = [];
  function walk(node: RichNode) {
    if (node.type === "syncedBlock" && typeof node.attrs?.snippetId === "string" && uuidPattern.test(node.attrs.snippetId)) {
      const blockId = String(node.attrs.id ?? "");
      if (!blockPattern.test(blockId)) throw new DocumentError("Snippet placement is missing its block id");
      const pin = node.attrs.pinVersion;
      nodes.push({ blockId, snippetId: node.attrs.snippetId, pinVersion: typeof pin === "number" ? pin : null });
      return;
    }
    node.content?.forEach(walk);
  }
  walk(document);
  return nodes;
}
function shellDocument(document: RichNode): RichNode {
  function walk(node: RichNode): RichNode {
    if (node.type === "syncedBlock" && typeof node.attrs?.snippetId === "string") {
      const attrs: Record<string, unknown> = { id: node.attrs.id, snippetId: node.attrs.snippetId };
      if (typeof node.attrs.pinVersion === "number") attrs.pinVersion = node.attrs.pinVersion;
      return { type: "syncedBlock", attrs };
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(walk) };
  }
  return walk(document);
}
async function assertInsertable(tx: Sql, actor: Actor, snippet: SnippetRow, pin: number | null) {
  if (snippet.retired_at || snippet.deleted_at || purged(snippet)) throw hidden();
  if (await loadTier(tx, actor, snippet.workspace_id, snippet.space_id) === "none") throw hidden();
  const versions = await versionsOf(tx, [snippet.id]);
  const picked = choose(versions, pin);
  if (!picked) throw hidden();
  return picked;
}
function placementContent(version: VersionRow, used: Set<string>) {
  let index = 0;
  const source = structuredClone(version.content.content ?? []);
  function walk(node: RichNode): RichNode {
    const attrs = { ...(node.attrs ?? {}) };
    if (idTypes.includes(node.type)) {
      let id = `snp_${version.id.replace(/-/g, "")}_${index++}`;
      while (used.has(id) || !blockPattern.test(id)) id = `${id}x`;
      const stable = id.slice(0, 100);
      attrs.id = stable;
      used.add(stable);
    }
    const next: RichNode = { ...node, ...(node.content ? { content: node.content.map(walk) } : {}) };
    if (idTypes.includes(node.type)) next.attrs = attrs;
    return next;
  }
  return source.map(walk);
}
function takenIds(document: RichNode) {
  const used = new Set<string>();
  function walk(node: RichNode) {
    if (node.type === "syncedBlock" && typeof node.attrs?.snippetId === "string") {
      if (typeof node.attrs.id === "string") used.add(node.attrs.id);
      return;
    }
    if (typeof node.attrs?.id === "string") used.add(node.attrs.id);
    node.content?.forEach(walk);
  }
  walk(document);
  return used;
}
async function placementRows(tx: Sql, pageId: string) {
  const { rows } = await tx.query<PlacementRow>("SELECT page_id,block_id,snippet_id,pin_version,created_by FROM hs_snippet_placements WHERE page_id=$1 ORDER BY block_id", [pageId]);
  return rows.map(row => ({ ...row, pin_version: row.pin_version == null ? null : Number(row.pin_version) }));
}
async function describePlacement(tx: Sql, actor: Actor, pageId: string, blockId: string, snippet: SnippetRow | null, versions: VersionRow[], pin: number | null, editable: boolean): Promise<SnippetPlacementView> {
  const page = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM hs_pages WHERE id=$1", [pageId]);
  const picked = snippet && page.rows[0] && snippet.workspace_id === page.rows[0].workspace_id && !purged(snippet) ? choose(versions, pin) : null;
  if (!snippet || !picked) return { state: "restricted", label: SNIPPET_RESTRICTED_LABEL, blockId };
  const flags = await roleFlags(tx, snippet.space_id, actor);
  const badge = !editable ? null : snippet.deleted_at ? SNIPPET_DELETED_BADGE : snippet.retired_at ? SNIPPET_RETIRED_BADGE : null;
  return {
    state: "live",
    label: snippet.title,
    blockId,
    snippetId: snippet.id,
    versionNumber: picked.chosen.version_number,
    mode: picked.mode,
    pinVersion: pin,
    latestApproved: picked.latest,
    badge,
    updateLabel: editable && picked.mode === "pinned" && picked.chosen.version_number < picked.latest ? SNIPPET_UPDATE_LABEL : null,
    canManage: flags.canManage,
    canDetach: editable,
    editHref: flags.canManage ? `/workspaces/${snippet.workspace_id}/snippets?snippet=${snippet.id}` : null,
    approvedAtIst: picked.chosen.approved_at ? formatIst(picked.chosen.approved_at) : null,
    content: placementContent(picked.chosen, takenIds({ type: "doc" })),
  };
}

export async function presentSnippetDocument(r: Repository, tx: Sql, actor: Actor, pageId: string, document: RichNode): Promise<RichNode> {
  const nodes = snippetNodes(document);
  if (!nodes.length) return document;
  const page = await r.access(tx, pageId, actor, false);
  const editable = canEdit(page.role);
  const placements = await placementRows(tx, pageId);
  const byBlock = new Map(placements.map(row => [row.block_id, row]));
  const ids = [...new Set(nodes.map(node => node.snippetId))];
  const snippets = new Map((await tx.query<SnippetRow>("SELECT id,workspace_id,space_id,title,synced_id,retired_at,deleted_at,purge_after FROM hs_snippets WHERE id = ANY($1::text[])", [ids])).rows.map(row => [row.id, row]));
  const versions = await versionsOf(tx, ids);
  const used = takenIds(document);
  async function walk(node: RichNode): Promise<RichNode> {
    if (node.type !== "syncedBlock" || typeof node.attrs?.snippetId !== "string") {
      if (!node.content) return node;
      const content: RichNode[] = [];
      for (const child of node.content) content.push(await walk(child));
      return { ...node, content };
    }
    const blockId = String(node.attrs.id ?? "");
    const snippet = snippets.get(String(node.attrs.snippetId)) ?? null;
    const pin = byBlock.get(blockId)?.pin_version ?? (typeof node.attrs.pinVersion === "number" ? node.attrs.pinVersion : null);
    const view = await describePlacement(tx, actor, pageId, blockId, snippet, versions.filter(version => version.snippet_id === snippet?.id), pin, editable);
    if (view.state !== "live") return { type: "syncedBlock", attrs: { id: blockId, snippetId: node.attrs.snippetId, syncState: "restricted", syncLocked: true } };
    const content = placementContent(versions.find(version => version.snippet_id === view.snippetId && version.version_number === view.versionNumber)!, used);
    const attrs: Record<string, unknown> = { id: blockId, snippetId: view.snippetId, syncLocked: true, syncState: "live", syncVersion: view.versionNumber };
    if (view.pinVersion != null) attrs.pinVersion = view.pinVersion;
    return { type: "syncedBlock", attrs, content };
  }
  const content: RichNode[] = [];
  for (const child of document.content ?? []) content.push(await walk(child));
  return { type: "doc", content };
}

export async function commitSnippetPlacements(r: Repository, tx: Sql, actor: Actor, pageId: string, document: RichNode, operationId: string) {
  const page = await r.access(tx, pageId, actor, true, true);
  const nodes = snippetNodes(document);
  const existing = await tx.query<PlacementRow>("SELECT page_id,block_id,snippet_id,pin_version,created_by FROM hs_snippet_placements WHERE page_id=$1 ORDER BY block_id FOR UPDATE", [pageId]);
  const prior = existing.rows.map(row => ({ ...row, pin_version: row.pin_version == null ? null : Number(row.pin_version) }));
  if (!nodes.length && !prior.length) return { stored: document, changed: false };
  const ids = [...new Set([...nodes.map(node => node.snippetId), ...prior.map(row => row.snippet_id)])].sort();
  if (ids.length) await tx.query("SELECT id FROM hs_snippets WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE", [ids]);
  let changed = false;
  const kept = new Set<string>();
  for (const node of nodes) {
    kept.add(node.blockId);
    const snippet = await lockSnippet(tx, node.snippetId);
    if (!snippet || snippet.workspace_id !== page.workspace_id) throw hidden();
    const current = prior.find(row => row.block_id === node.blockId);
    if (!current) {
      await assertInsertable(tx, actor, snippet, node.pinVersion);
      await tx.query("INSERT INTO hs_snippet_placements(page_id,block_id,snippet_id,pin_version,created_by) VALUES($1,$2,$3,$4,$5)", [pageId, node.blockId, snippet.id, node.pinVersion, actor.id]);
      changed = true;
      await audit(tx, actor, pageId, "snippet.place", { snippetId: snippet.id, blockId: node.blockId, pinVersion: node.pinVersion }, operationId);
      continue;
    }
    if (current.snippet_id !== snippet.id) throw hidden();
    if (current.pin_version !== node.pinVersion) {
      if (purged(snippet) || await loadTier(tx, actor, snippet.workspace_id, snippet.space_id) === "none") throw hidden();
      if (!choose(await versionsOf(tx, [snippet.id]), node.pinVersion)) throw hidden();
      await tx.query("UPDATE hs_snippet_placements SET pin_version=$3 WHERE page_id=$1 AND block_id=$2", [pageId, node.blockId, node.pinVersion]);
      changed = true;
      await audit(tx, actor, pageId, "snippet.pin", { snippetId: snippet.id, blockId: node.blockId, pinVersion: node.pinVersion }, operationId);
    }
  }
  for (const row of prior) {
    if (kept.has(row.block_id)) continue;
    await tx.query("DELETE FROM hs_snippet_placements WHERE page_id=$1 AND block_id=$2", [pageId, row.block_id]);
    changed = true;
    await audit(tx, actor, pageId, "snippet.remove-placement", { snippetId: row.snippet_id, blockId: row.block_id }, operationId);
  }
  return { stored: shellDocument(document), changed };
}

async function visibleSnippets(tx: Sql, actor: Actor, workspaceId: string, spaceId?: string) {
  const role = await membership(tx, workspaceId, actor);
  if (!role) throw hidden();
  const spaces = spaceId
    ? await tx.query<{ id: string; name: string }>("SELECT id,name FROM hs_spaces WHERE id=$1 AND workspace_id=$2", [spaceId, workspaceId])
    : await tx.query<{ id: string; name: string }>("SELECT id,name FROM hs_spaces WHERE workspace_id=$1 ORDER BY name,id", [workspaceId]);
  if (spaceId && !spaces.rows.length) throw hidden();
  const visible: { id: string; name: string; tier: Tier; canManage: boolean; canApprove: boolean }[] = [];
  for (const space of spaces.rows) {
    const tier = await loadTier(tx, actor, workspaceId, space.id);
    if (tier === "none") {
      if (spaceId) throw hidden();
      continue;
    }
    const flags = await roleFlags(tx, space.id, actor);
    visible.push({ id: space.id, name: space.name, tier, canManage: flags.canManage, canApprove: flags.canApprove });
  }
  return { canGrant: role === "owner" || role === "admin", spaces: visible };
}

export async function listSnippetLibrary(r: Repository, actor: Actor, workspaceId: string, spaceId?: string) {
  return r.db.transaction(async tx => {
    const access = await visibleSnippets(tx, actor, workspaceId, spaceId);
    const spaceIds = access.spaces.map(space => space.id);
    const snippets = spaceIds.length
      ? (await tx.query<SnippetRow>("SELECT id,workspace_id,space_id,title,synced_id,retired_at,deleted_at,purge_after FROM hs_snippets WHERE workspace_id=$1 AND space_id = ANY($2::text[]) ORDER BY title,id", [workspaceId, spaceIds])).rows
      : [];
    const versions = await versionsOf(tx, snippets.map(snippet => snippet.id));
    const items: SnippetLibraryItem[] = [];
    for (const snippet of snippets) {
      const tier = access.spaces.find(space => space.id === snippet.space_id)?.tier ?? "none";
      if (tier !== "govern" && (snippet.retired_at || snippet.deleted_at || !versions.some(version => version.snippet_id === snippet.id && version.state === "approved"))) continue;
      items.push(await libraryItem(tx, actor, snippet, versions.filter(version => version.snippet_id === snippet.id), tier));
    }
    return { canGrant: access.canGrant, spaces: access.spaces, snippets: items };
  });
}

export async function getSnippet(r: Repository, actor: Actor, workspaceId: string, snippetId: string) {
  if (!uuidPattern.test(snippetId)) throw hidden();
  return r.db.transaction(async tx => {
    const snippet = (await tx.query<SnippetRow>("SELECT id,workspace_id,space_id,title,synced_id,retired_at,deleted_at,purge_after FROM hs_snippets WHERE id=$1", [snippetId])).rows[0];
    if (!snippet || snippet.workspace_id !== workspaceId) throw hidden();
    const tier = await loadTier(tx, actor, workspaceId, snippet.space_id);
    if (tier === "none") throw hidden();
    if (tier !== "govern" && (snippet.retired_at || snippet.deleted_at)) throw hidden();
    const versions = await versionsOf(tx, [snippet.id]);
    if (tier !== "govern" && !versions.some(version => version.state === "approved")) throw hidden();
    return libraryItem(tx, actor, snippet, versions, tier);
  });
}

export async function createSnippet(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; spaceId: string; title: string; content: unknown }) {
  assertUuid(input.operationId);
  const title = input.title.trim();
  if (!title || title.length > 120 || !input.spaceId) throw new DocumentError("Invalid snippet");
  const content = snippetDocument(input.content);
  const hash = hashCommand({ action: "create", workspaceId, spaceId: input.spaceId, title, content: withoutIds(content) });
  return r.db.transaction(async tx => {
    if (!await membership(tx, workspaceId, actor)) throw hidden();
    const space = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM hs_spaces WHERE id=$1", [input.spaceId]);
    if (space.rows[0]?.workspace_id !== workspaceId) throw hidden();
    return withOperation(tx, `workspace:${workspaceId}`, actor, input.operationId, hash, async () => {
      await requireManager(tx, input.spaceId, actor);
      const snippetId = randomUUID();
      const syncedId = randomUUID();
      const versionId = randomUUID();
      await tx.query("INSERT INTO hs_synced_blocks(id,workspace_id,source_page_id,content,version,updated_by,kind) VALUES($1,$2,NULL,$3::jsonb,1,$4,'snippet')", [syncedId, workspaceId, JSON.stringify({ type: "doc", content: [] }), actor.id]);
      await tx.query("INSERT INTO hs_snippets(id,workspace_id,space_id,title,synced_id,created_by) VALUES($1,$2,$3,$4,$5,$6)", [snippetId, workspaceId, input.spaceId, title, syncedId, actor.id]);
      await tx.query("INSERT INTO hs_snippet_versions(id,snippet_id,version_number,state,content,created_by) VALUES($1,$2,1,'draft',$3::jsonb,$4)", [versionId, snippetId, JSON.stringify(content), actor.id]);
      await audit(tx, actor, null, "snippet.create", { snippetId, versionId, versionNumber: 1, spaceId: input.spaceId }, input.operationId);
      return { snippetId, versionId, versionNumber: 1, state: "draft" };
    });
  });
}

async function openVersion(tx: Sql, snippet: SnippetRow, versionNumber: number, state?: VersionRow["state"]) {
  const { rows } = await tx.query<VersionRow>("SELECT id,snippet_id,version_number,state,content,created_by,submitted_at,approved_by,approved_at,approval_note FROM hs_snippet_versions WHERE snippet_id=$1 AND version_number=$2 FOR UPDATE", [snippet.id, versionNumber]);
  const version = rows[0];
  if (!version || (state && version.state !== state)) throw hidden();
  return version;
}

export async function saveSnippetDraft(r: Repository, actor: Actor, workspaceId: string, snippetId: string, input: { operationId: string; versionNumber: number; content: unknown }) {
  assertUuid(input.operationId);
  assertUuid(snippetId);
  const content = snippetDocument(input.content);
  const hash = hashCommand({ action: "save-draft", workspaceId, snippetId, versionNumber: input.versionNumber, content: withoutIds(content) });
  return r.db.transaction(async tx => withOperation(tx, snippetId, actor, input.operationId, hash, async () => {
    const snippet = await lockSnippet(tx, snippetId);
    if (!snippet || snippet.workspace_id !== workspaceId || snippet.retired_at || snippet.deleted_at) throw hidden();
    await requireManager(tx, snippet.space_id, actor);
    const version = await openVersion(tx, snippet, input.versionNumber, "draft");
    await tx.query("UPDATE hs_snippet_versions SET content=$2::jsonb WHERE id=$1", [version.id, JSON.stringify(content)]);
    await tx.query("UPDATE hs_snippets SET updated_at=clock_timestamp() WHERE id=$1", [snippet.id]);
    await audit(tx, actor, null, "snippet.save-draft", { snippetId, versionId: version.id, versionNumber: input.versionNumber }, input.operationId);
    return { snippetId, versionId: version.id, versionNumber: input.versionNumber, state: "draft" };
  }));
}

export async function submitSnippetVersion(r: Repository, actor: Actor, workspaceId: string, snippetId: string, input: { operationId: string; versionNumber: number }) {
  assertUuid(input.operationId);
  assertUuid(snippetId);
  const hash = hashCommand({ action: "submit", workspaceId, snippetId, versionNumber: input.versionNumber });
  return r.db.transaction(async tx => withOperation(tx, snippetId, actor, input.operationId, hash, async () => {
    const snippet = await lockSnippet(tx, snippetId);
    if (!snippet || snippet.workspace_id !== workspaceId || snippet.retired_at || snippet.deleted_at) throw hidden();
    await requireManager(tx, snippet.space_id, actor);
    const version = await openVersion(tx, snippet, input.versionNumber, "draft");
    await tx.query("UPDATE hs_snippet_versions SET state='in_review',submitted_by=$2,submitted_at=clock_timestamp() WHERE id=$1", [version.id, actor.id]);
    await audit(tx, actor, null, "snippet.submit", { snippetId, versionId: version.id, versionNumber: input.versionNumber }, input.operationId);
    return { snippetId, versionId: version.id, versionNumber: input.versionNumber, state: "in review" };
  }));
}

export async function approveSnippetVersion(r: Repository, actor: Actor, workspaceId: string, snippetId: string, input: { operationId: string; versionNumber: number; note: string }) {
  assertUuid(input.operationId);
  assertUuid(snippetId);
  const note = input.note.trim();
  if (!note || note.length > 500) throw new DocumentError("Approval note is required");
  const hash = hashCommand({ action: "approve", workspaceId, snippetId, versionNumber: input.versionNumber, note });
  return r.db.transaction(async tx => withOperation(tx, snippetId, actor, input.operationId, hash, async () => {
    const snippet = await lockSnippet(tx, snippetId);
    if (!snippet || snippet.workspace_id !== workspaceId || snippet.retired_at || snippet.deleted_at) throw hidden();
    const approver = await tx.query("SELECT role FROM hs_snippet_roles WHERE space_id=$1 AND user_id=$2 AND role='approver' FOR UPDATE", [snippet.space_id, actor.id]);
    if (!approver.rows.length) throw hidden();
    const version = await openVersion(tx, snippet, input.versionNumber, "in_review");
    const approved = await tx.query<{ approved_at: string }>("UPDATE hs_snippet_versions SET state='approved',approved_by=$2,approved_at=clock_timestamp(),approval_note=$3 WHERE id=$1 RETURNING approved_at", [version.id, actor.id, note]);
    await tx.query("UPDATE hs_synced_blocks SET previous_content=content,previous_version=version,content=$2::jsonb,version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1", [snippet.synced_id, JSON.stringify(version.content), actor.id]);
    await tx.query("UPDATE hs_snippets SET updated_at=clock_timestamp() WHERE id=$1", [snippet.id]);
    const approvedAtIst = formatIst(approved.rows[0].approved_at);
    await audit(tx, actor, null, "snippet.approve", { snippetId, versionId: version.id, versionNumber: input.versionNumber, approvedBy: actor.id }, input.operationId);
    return { snippetId, versionId: version.id, versionNumber: input.versionNumber, state: "approved", approvedBy: actor.id, approvedAtIst };
  }));
}

export async function draftSnippetVersion(r: Repository, actor: Actor, workspaceId: string, snippetId: string, input: { operationId: string; content: unknown }) {
  assertUuid(input.operationId);
  assertUuid(snippetId);
  const content = snippetDocument(input.content);
  const hash = hashCommand({ action: "draft-version", workspaceId, snippetId, content: withoutIds(content) });
  return r.db.transaction(async tx => withOperation(tx, snippetId, actor, input.operationId, hash, async () => {
    const snippet = await lockSnippet(tx, snippetId);
    if (!snippet || snippet.workspace_id !== workspaceId || snippet.retired_at || snippet.deleted_at) throw hidden();
    await requireManager(tx, snippet.space_id, actor);
    const versions = await versionsOf(tx, [snippet.id]);
    if (versions.some(version => version.state !== "approved")) throw new DocumentError("Finish the open snippet version before drafting another", "snippet_version_open", 409);
    if (!versions.some(version => version.state === "approved")) throw hidden();
    const versionNumber = Math.max(...versions.map(version => version.version_number)) + 1;
    const versionId = randomUUID();
    await tx.query("INSERT INTO hs_snippet_versions(id,snippet_id,version_number,state,content,created_by) VALUES($1,$2,$3,'draft',$4::jsonb,$5)", [versionId, snippet.id, versionNumber, JSON.stringify(content), actor.id]);
    await audit(tx, actor, null, "snippet.draft-version", { snippetId, versionId, versionNumber }, input.operationId);
    return { snippetId, versionId, versionNumber, state: "draft" };
  }));
}

async function retirePreview(r: Repository, tx: Sql, actor: Actor, snippet: SnippetRow) {
  const { rows } = await tx.query<{ page_id: string; title: string }>("SELECT pl.page_id,p.title FROM hs_snippet_placements pl JOIN hs_pages p ON p.id=pl.page_id WHERE pl.snippet_id=$1 ORDER BY p.title,pl.page_id", [snippet.id]);
  const titles: string[] = [];
  let hiddenCount = 0;
  const pageIds: string[] = [];
  for (const row of rows) {
    pageIds.push(row.page_id);
    try {
      await r.access(tx, row.page_id, actor, false);
      titles.push(row.title);
    } catch (error) {
      if (!(error instanceof DocumentError) || error.status !== 404) throw error;
      hiddenCount += 1;
    }
  }
  return { titles, hiddenCount, placementCount: rows.length, pageIds, confirm: retireSnippetCopy(titles, hiddenCount) };
}

export async function previewSnippetRetire(r: Repository, actor: Actor, workspaceId: string, snippetId: string) {
  if (!uuidPattern.test(snippetId)) throw hidden();
  return r.db.transaction(async tx => {
    const snippet = await lockSnippet(tx, snippetId);
    if (!snippet || snippet.workspace_id !== workspaceId) throw hidden();
    await requireManager(tx, snippet.space_id, actor);
    const preview = await retirePreview(r, tx, actor, snippet);
    return { titles: preview.titles, hiddenCount: preview.hiddenCount, placementCount: preview.placementCount, confirm: preview.confirm };
  });
}

export async function retireSnippet(r: Repository, actor: Actor, workspaceId: string, snippetId: string, input: { operationId: string; titles: string[]; hiddenCount: number }) {
  assertUuid(input.operationId);
  assertUuid(snippetId);
  const hash = hashCommand({ action: "retire", workspaceId, snippetId, titles: [...input.titles].sort(), hiddenCount: input.hiddenCount });
  return r.db.transaction(async tx => withOperation(tx, snippetId, actor, input.operationId, hash, async () => {
    const snippet = await lockSnippet(tx, snippetId);
    if (!snippet || snippet.workspace_id !== workspaceId || snippet.deleted_at) throw hidden();
    await requireManager(tx, snippet.space_id, actor);
    const versions = await versionsOf(tx, [snippet.id]);
    if (versions.some(version => version.state !== "approved")) throw new DocumentError("Finish the open snippet version before retiring it", "snippet_version_open", 409);
    const preview = await retirePreview(r, tx, actor, snippet);
    if (preview.hiddenCount !== input.hiddenCount || stableStringify([...preview.titles].sort()) !== stableStringify([...input.titles].sort())) throw new DocumentError("The page list changed. Review the confirmation again.", "snippet_confirm_stale", 409);
    await tx.query("UPDATE hs_snippets SET retired_at=COALESCE(retired_at,clock_timestamp()),retired_by=COALESCE(retired_by,$2),updated_at=clock_timestamp() WHERE id=$1", [snippet.id, actor.id]);
    await audit(tx, actor, null, "snippet.retire", { snippetId, placementPageIds: preview.pageIds, hiddenCount: preview.hiddenCount }, input.operationId);
    return { retired: true, snippetId, titles: preview.titles, hiddenCount: preview.hiddenCount };
  }));
}

export async function deleteSnippet(r: Repository, actor: Actor, workspaceId: string, snippetId: string, input: { operationId: string }) {
  assertUuid(input.operationId);
  assertUuid(snippetId);
  const hash = hashCommand({ action: "delete", workspaceId, snippetId });
  return r.db.transaction(async tx => withOperation(tx, snippetId, actor, input.operationId, hash, async () => {
    const snippet = await lockSnippet(tx, snippetId);
    if (!snippet || snippet.workspace_id !== workspaceId) throw hidden();
    await requireManager(tx, snippet.space_id, actor);
    if (!snippet.deleted_at) await tx.query("UPDATE hs_snippets SET deleted_at=clock_timestamp(),deleted_by=$2,purge_after=clock_timestamp()+interval '30 days',updated_at=clock_timestamp() WHERE id=$1", [snippet.id, actor.id]);
    await audit(tx, actor, null, "snippet.delete", { snippetId, restoreDays: 30 }, input.operationId);
    return { deleted: true, snippetId, restoreDays: 30 };
  }));
}

export async function restoreSnippet(r: Repository, actor: Actor, workspaceId: string, snippetId: string, input: { operationId: string }) {
  assertUuid(input.operationId);
  assertUuid(snippetId);
  const hash = hashCommand({ action: "restore", workspaceId, snippetId });
  return r.db.transaction(async tx => withOperation(tx, snippetId, actor, input.operationId, hash, async () => {
    const snippet = await lockSnippet(tx, snippetId);
    if (!snippet || snippet.workspace_id !== workspaceId || !snippet.deleted_at) throw hidden();
    await requireManager(tx, snippet.space_id, actor);
    if (purged(snippet)) throw new DocumentError("The 30-day restore window has ended", "snippet_restore_expired", 409);
    await tx.query("UPDATE hs_snippets SET deleted_at=NULL,deleted_by=NULL,purge_after=NULL,updated_at=clock_timestamp() WHERE id=$1", [snippet.id]);
    await audit(tx, actor, null, "snippet.restore", { snippetId }, input.operationId);
    return { restored: true, snippetId };
  }));
}

async function requireAdmin(tx: Sql, workspaceId: string, actor: Actor) {
  const role = await membership(tx, workspaceId, actor);
  if (role !== "owner" && role !== "admin") throw hidden();
  return role;
}

export async function grantSnippetRole(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; spaceId: string; userId: string; role: "manager" | "approver" | "reviewer" }) {
  assertUuid(input.operationId);
  const hash = hashCommand({ action: "grant", workspaceId, ...input });
  return r.db.transaction(async tx => withOperation(tx, `space:${input.spaceId}`, actor, input.operationId, hash, async () => {
    await requireAdmin(tx, workspaceId, actor);
    const space = await tx.query("SELECT id FROM hs_spaces WHERE id=$1 AND workspace_id=$2", [input.spaceId, workspaceId]);
    const member = await tx.query("SELECT user_id FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, input.userId]);
    if (!space.rows.length || !member.rows.length) throw hidden();
    await tx.query("INSERT INTO hs_snippet_roles(space_id,user_id,role,granted_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [input.spaceId, input.userId, input.role, actor.id]);
    await audit(tx, actor, null, "snippet.grant-role", { spaceId: input.spaceId, role: input.role }, input.operationId, input.userId);
    return { granted: true, spaceId: input.spaceId, role: input.role };
  }));
}

export async function revokeSnippetRole(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; spaceId: string; userId: string; role: "manager" | "approver" | "reviewer" }) {
  assertUuid(input.operationId);
  const hash = hashCommand({ action: "revoke", workspaceId, ...input });
  return r.db.transaction(async tx => withOperation(tx, `space:${input.spaceId}`, actor, input.operationId, hash, async () => {
    await requireAdmin(tx, workspaceId, actor);
    const removed = await tx.query("DELETE FROM hs_snippet_roles WHERE space_id=$1 AND user_id=$2 AND role=$3 RETURNING role", [input.spaceId, input.userId, input.role]);
    if (!removed.rows.length) throw hidden();
    await audit(tx, actor, null, "snippet.revoke-role", { spaceId: input.spaceId, role: input.role }, input.operationId, input.userId);
    return { revoked: true, spaceId: input.spaceId, role: input.role };
  }));
}

export async function listSnippetPlacements(r: Repository, actor: Actor, pageId: string) {
  return r.db.transaction(async tx => {
    const page = await r.access(tx, pageId, actor, false);
    const document = await storedDocument(tx, pageId);
    const editable = canEdit(page.role);
    const nodes = snippetNodes(document);
    if (!nodes.length) return { placements: [] };
    const snippets = new Map((await tx.query<SnippetRow>("SELECT id,workspace_id,space_id,title,synced_id,retired_at,deleted_at,purge_after FROM hs_snippets WHERE id = ANY($1::text[])", [nodes.map(node => node.snippetId)])).rows.map(row => [row.id, row]));
    const versions = await versionsOf(tx, [...snippets.keys()]);
    const placements = await placementRows(tx, pageId);
    const views: SnippetPlacementView[] = [];
    for (const node of nodes) {
      const pin = placements.find(row => row.block_id === node.blockId)?.pin_version ?? node.pinVersion;
      views.push(await describePlacement(tx, actor, pageId, node.blockId, snippets.get(node.snippetId) ?? null, versions.filter(version => version.snippet_id === node.snippetId), pin, editable));
    }
    return { placements: views };
  });
}

export async function listSnippetPicker(r: Repository, actor: Actor, pageId: string) {
  return r.db.transaction(async tx => {
    const page = await r.access(tx, pageId, actor, false);
    const spaces = await tx.query<{ id: string }>("SELECT id FROM hs_spaces WHERE workspace_id=$1", [page.workspace_id]);
    const readable: string[] = [];
    for (const space of spaces.rows) if (await loadTier(tx, actor, page.workspace_id, space.id) !== "none") readable.push(space.id);
    if (!readable.length) return { snippets: [] as { id: string; title: string; versions: { number: number }[] }[] };
    const snippets = (await tx.query<SnippetRow>("SELECT id,workspace_id,space_id,title,synced_id,retired_at,deleted_at,purge_after FROM hs_snippets WHERE workspace_id=$1 AND space_id = ANY($2::text[]) AND retired_at IS NULL AND deleted_at IS NULL ORDER BY title,id LIMIT 200", [page.workspace_id, readable])).rows;
    const versions = await versionsOf(tx, snippets.map(snippet => snippet.id));
    return {
      snippets: snippets.flatMap(snippet => {
        const approved = versions.filter(version => version.snippet_id === snippet.id && version.state === "approved");
        if (!approved.length) return [];
        return [{ id: snippet.id, title: snippet.title, versions: approved.map(version => ({ number: version.version_number })) }];
      }),
    };
  });
}

export async function insertSnippetPlacement(r: Repository, actor: Actor, pageId: string, input: { operationId: string; snippetId: string; pinVersion?: number | null; blockId?: string }) {
  assertUuid(input.operationId);
  assertUuid(input.snippetId);
  if (input.blockId && !blockPattern.test(input.blockId)) throw new DocumentError("Invalid snippet placement");
  const pinVersion = input.pinVersion ?? null;
  const hash = hashCommand({ action: "insert", pageId, snippetId: input.snippetId, pinVersion, blockId: input.blockId ?? null });
  return r.db.transaction(async tx => {
    const page = await r.access(tx, pageId, actor, true, true);
    return withOperation(tx, input.snippetId, actor, input.operationId, hash, async () => {
      const snippet = await lockSnippet(tx, input.snippetId);
      if (!snippet || snippet.workspace_id !== page.workspace_id) throw hidden();
      await assertInsertable(tx, actor, snippet, pinVersion);
      const document = await storedDocument(tx, pageId);
      const blockId = input.blockId ?? randomUUID();
      if (snippetNodes(document).some(node => node.blockId === blockId) || takenIds(document).has(blockId)) throw new DocumentError("Invalid snippet placement");
      const attrs: Record<string, unknown> = { id: blockId, snippetId: snippet.id };
      if (pinVersion != null) attrs.pinVersion = pinVersion;
      await tx.query("INSERT INTO hs_snippet_placements(page_id,block_id,snippet_id,pin_version,created_by) VALUES($1,$2,$3,$4,$5)", [pageId, blockId, snippet.id, pinVersion, actor.id]);
      const pageVersion = await writePage(r, tx, actor, pageId, { type: "doc", content: [...(document.content ?? []), { type: "syncedBlock", attrs }] }, "snippet-insert");
      await audit(tx, actor, pageId, "snippet.place", { snippetId: snippet.id, blockId, pinVersion }, input.operationId);
      return { inserted: true, snippetId: snippet.id, blockId, pageVersion, mode: pinVersion == null ? "latest" : "pinned" };
    });
  });
}

function freshIds(node: RichNode): RichNode {
  const attrs = { ...(node.attrs ?? {}) };
  if (typeof attrs.id === "string") attrs.id = randomUUID();
  delete attrs.snippetId;
  delete attrs.pinVersion;
  delete attrs.syncedId;
  return { ...node, attrs, ...(node.content ? { content: node.content.map(freshIds) } : {}) };
}

export async function detachSnippetPlacement(r: Repository, actor: Actor, pageId: string, input: { operationId: string; blockId: string }) {
  assertUuid(input.operationId);
  if (!blockPattern.test(input.blockId)) throw hidden();
  const hash = hashCommand({ action: "detach", pageId, blockId: input.blockId });
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, true, true);
    const placement = (await placementRows(tx, pageId)).find(row => row.block_id === input.blockId);
    if (!placement) throw hidden();
    return withOperation(tx, placement.snippet_id, actor, input.operationId, hash, async () => {
      const snippet = await lockSnippet(tx, placement.snippet_id);
      const page = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM hs_pages WHERE id=$1", [pageId]);
      if (!snippet || snippet.workspace_id !== page.rows[0]?.workspace_id || purged(snippet)) throw hidden();
      const picked = choose(await versionsOf(tx, [snippet.id]), placement.pin_version);
      if (!picked) throw hidden();
      const source = picked.chosen.content.content ?? [];
      const document = await storedDocument(tx, pageId);
      let replaced = false;
      function walk(node: RichNode): RichNode[] {
        if (node.type === "syncedBlock" && node.attrs?.id === input.blockId) {
          replaced = true;
          return structuredClone(source).map(child => freshIds(child));
        }
        if (!node.content) return [node];
        return [{ ...node, content: node.content.flatMap(walk) }];
      }
      const content = (document.content ?? []).flatMap(walk);
      if (!replaced) throw hidden();
      await tx.query("DELETE FROM hs_snippet_placements WHERE page_id=$1 AND block_id=$2", [pageId, input.blockId]);
      await writePage(r, tx, actor, pageId, { type: "doc", content: content.length ? content : [{ type: "paragraph", attrs: { id: randomUUID() } }] }, "snippet-detach");
      await audit(tx, actor, pageId, "snippet.detach", { snippetId: snippet.id, blockId: input.blockId, versionNumber: picked.chosen.version_number }, input.operationId);
      return { detached: true, snippetId: snippet.id, blockId: input.blockId, versionNumber: picked.chosen.version_number };
    });
  });
}

export async function updateSnippetPlacement(r: Repository, actor: Actor, pageId: string, input: { operationId: string; blockId: string }) {
  assertUuid(input.operationId);
  if (!blockPattern.test(input.blockId)) throw hidden();
  const hash = hashCommand({ action: "update", pageId, blockId: input.blockId });
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, true, true);
    const placement = (await placementRows(tx, pageId)).find(row => row.block_id === input.blockId);
    if (!placement) throw hidden();
    return withOperation(tx, placement.snippet_id, actor, input.operationId, hash, async () => {
      const snippet = await lockSnippet(tx, placement.snippet_id);
      if (!snippet || purged(snippet)) throw hidden();
      const picked = choose(await versionsOf(tx, [snippet.id]), null);
      if (!picked) throw hidden();
      await tx.query("UPDATE hs_snippet_placements SET pin_version=$3 WHERE page_id=$1 AND block_id=$2", [pageId, input.blockId, picked.chosen.version_number]);
      await audit(tx, actor, pageId, "snippet.update", { snippetId: snippet.id, blockId: input.blockId, versionNumber: picked.chosen.version_number }, input.operationId);
      return { updated: true, snippetId: snippet.id, blockId: input.blockId, versionNumber: picked.chosen.version_number };
    });
  });
}

export async function snippetUsageReport(r: Repository, actor: Actor, workspaceId: string, snippetId: string) {
  if (!uuidPattern.test(snippetId)) throw hidden();
  return r.db.transaction(async tx => {
    const snippet = (await tx.query<SnippetRow>("SELECT id,workspace_id,space_id,title,synced_id,retired_at,deleted_at,purge_after FROM hs_snippets WHERE id=$1", [snippetId])).rows[0];
    if (!snippet || snippet.workspace_id !== workspaceId) throw hidden();
    await requireManager(tx, snippet.space_id, actor);
    const versions = await versionsOf(tx, [snippet.id]);
    const { rows } = await tx.query<{ page_id: string; title: string; owner_id: string; owner_name: string | null; pin_version: number | null }>("SELECT pl.page_id,p.title,p.owner_id,u.name AS owner_name,pl.pin_version FROM hs_snippet_placements pl JOIN hs_pages p ON p.id=pl.page_id LEFT JOIN hs_users u ON u.id=p.owner_id WHERE pl.snippet_id=$1 ORDER BY p.title,pl.page_id", [snippet.id]);
    const placements: { pageId: string; pageTitle: string; pageOwnerId: string; pageOwnerName: string; versionMode: "latest" | "pinned"; versionNumber: number }[] = [];
    for (const row of rows) {
      try { await r.access(tx, row.page_id, actor, false); } catch (error) {
        if (!(error instanceof DocumentError) || error.status !== 404) throw error;
        continue;
      }
      const pin = row.pin_version == null ? null : Number(row.pin_version);
      const picked = choose(versions, pin);
      if (!picked) continue;
      placements.push({ pageId: row.page_id, pageTitle: row.title, pageOwnerId: row.owner_id, pageOwnerName: row.owner_name ?? "", versionMode: picked.mode, versionNumber: picked.chosen.version_number });
    }
    return { snippetId, placements };
  });
}

export function snippetUsageCsvText(placements: { pageId: string; pageTitle: string; pageOwnerId: string; pageOwnerName: string; versionMode: string; versionNumber: number }[]) {
  return snippetUsageCsv(placements);
}
