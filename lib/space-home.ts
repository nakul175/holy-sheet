import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, ensureIds, plainText, stableStringify, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import { recordRefAttributeError } from "./record-page-refs";
import type { DocumentPage, Repository } from "./repository";
import {
  SPACE_HOME_NOT_ALLOWED,
  SPACE_HOME_PAGE_UNAVAILABLE,
  SPACE_HOME_PIN_LIMIT,
  SPACE_HOME_RECENT_LIMIT,
  SPACE_HOME_TEMPLATE_ID,
  SPACE_HOME_TITLE,
  SPACE_HOME_UNAVAILABLE,
  type SpaceHomeOwnerView,
  type SpaceHomePageView,
  type SpaceHomePinView,
  type SpaceHomeRecentView,
  type SpaceHomeRecordView,
  type SpaceHomeView,
} from "./space-home-shared";
import { spaceHomeTemplate } from "./template-starters";

export type { SpaceHomeOwnerView, SpaceHomePageView, SpaceHomePinView, SpaceHomeRecentView, SpaceHomeRecordView, SpaceHomeView };

const spaceUnavailable = () => new DocumentError(SPACE_HOME_UNAVAILABLE, "not_found", 404);
const pageUnavailable = () => new DocumentError(SPACE_HOME_PAGE_UNAVAILABLE, "not_found", 404);
const notAllowed = () => new DocumentError(SPACE_HOME_NOT_ALLOWED, "not_allowed", 403);
const mismatch = () => new DocumentError("This space home attempt was reused with different fields.", "operation_mismatch", 409);
const refreshPins = () => new DocumentError("Refresh pins and try again.", "space_home_conflict", 409);
const invalid = () => new DocumentError("Invalid space home request", "invalid_space_home", 400);

const pageId = z.string().min(1).max(200);
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-home"), operationId: z.string().uuid(), pageId }).strict(),
  z.object({ action: z.literal("pin"), operationId: z.string().uuid(), pageId }).strict(),
  z.object({ action: z.literal("unpin"), operationId: z.string().uuid(), pageId }).strict(),
  z.object({ action: z.literal("reorder"), operationId: z.string().uuid(), pageIds: z.array(pageId).max(SPACE_HOME_PIN_LIMIT) }).strict(),
]);

export type SpaceHomeCommand = z.infer<typeof commandSchema>;

type Scope = {
  id: string;
  name: string;
  workspace_id: string;
  home_page_id: string | null;
  workspace_role: string;
  space_role: string | null;
};

type Readable = { id: string; space_id: string; workspace_id: string };
type PinRow = { pageId: string; pinnedBy: string };

const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");

export function pageExcerpt(document: RichNode) {
  let summary = "";
  const headings: string[] = [];
  for (const node of document.content ?? []) {
    const text = plainText(node).replace(/\s+/g, " ").trim();
    if (node.type === "paragraph" && !summary && text) summary = text.slice(0, 180);
    if (node.type === "heading" && text && headings.length < 8) headings.push(text.slice(0, 120));
  }
  return { summary, headings };
}

function manageable(scope: Scope) {
  return scope.workspace_role !== "observer" && (scope.workspace_role === "owner" || scope.workspace_role === "admin" || scope.space_role === "leader");
}

function admitted(scope: Scope) {
  if (scope.workspace_role === "owner" || scope.workspace_role === "admin") return true;
  return scope.space_role === "leader" || scope.space_role === "editor" || scope.space_role === "viewer";
}

async function scope(tx: Sql, workspaceId: string, spaceId: string, actor: Actor, lock: boolean) {
  const rows = await tx.query<Scope>(`SELECT s.id, s.name, s.workspace_id, s.home_page_id, m.role AS workspace_role, sm.role AS space_role
    FROM hs_spaces s
    JOIN hs_workspaces w ON w.id = s.workspace_id
    JOIN hs_members m ON m.workspace_id = w.id AND m.user_id = $3 AND m.active = true
    LEFT JOIN hs_space_members sm ON sm.space_id = s.id AND sm.user_id = $3 AND sm.active = true
    WHERE s.id = $1 AND s.workspace_id = $2
    ${lock ? "FOR UPDATE OF w, m" : ""}`, [spaceId, workspaceId, actor.id]);
  return rows.rows[0] ?? null;
}

async function audit(tx: Sql, actorId: string, action: string, pageId: string | null, operationId: string, after: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_audit(id, actor_id, action, page_id, after_value, correlation_id) VALUES($1,$2,$3,$4,$5,$6)", [
    randomUUID(),
    actorId,
    action,
    pageId,
    JSON.stringify({ ...after, atIst: formatIst(new Date()) }),
    operationId,
  ]);
}

async function readable(r: Repository, tx: Sql, pageId: string, actor: Actor): Promise<Readable | null> {
  if (!pageId || pageId.length > 200) return null;
  try {
    const page = await r.access(tx, pageId, actor);
    return { id: page.id, space_id: page.space_id, workspace_id: page.workspace_id };
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

async function shown(r: Repository, tx: Sql, actor: Actor, scopeId: string, workspaceId: string, pageId: string, cache: Map<string, DocumentPage | null>) {
  if (cache.has(pageId)) return cache.get(pageId) ?? null;
  try {
    const page = await r.get(pageId, actor, tx, undefined, false);
    const allowed = page.spaceId === scopeId && page.workspaceId === workspaceId ? page : null;
    cache.set(pageId, allowed);
    return allowed;
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) {
      cache.set(pageId, null);
      return null;
    }
    throw error;
  }
}

async function pinRows(tx: Sql, spaceId: string) {
  const rows = await tx.query<{ page_id: string; pinned_by: string }>("SELECT page_id, pinned_by FROM hs_space_pins WHERE space_id = $1 ORDER BY position, page_id", [spaceId]);
  return rows.rows;
}

async function splitPins(r: Repository, tx: Sql, actor: Actor, scope: Scope) {
  const visible: PinRow[] = [];
  const hidden: PinRow[] = [];
  for (const row of await pinRows(tx, scope.id)) {
    const page = await readable(r, tx, row.page_id, actor);
    const entry = { pageId: row.page_id, pinnedBy: row.pinned_by };
    if (page && page.space_id === scope.id && page.workspace_id === scope.workspace_id) visible.push(entry);
    else hidden.push(entry);
  }
  return { visible, hidden };
}

async function replacePins(tx: Sql, spaceId: string, rows: PinRow[]) {
  await tx.query("DELETE FROM hs_space_pins WHERE space_id = $1", [spaceId]);
  for (let position = 0; position < rows.length; position += 1) {
    await tx.query("INSERT INTO hs_space_pins(space_id, page_id, position, pinned_by) VALUES($1,$2,$3,$4)", [spaceId, rows[position].pageId, position, rows[position].pinnedBy]);
  }
}

function nodeOf(value: unknown): RichNode {
  if (typeof value === "string") return JSON.parse(value) as RichNode;
  return value as RichNode;
}

async function loadView(r: Repository, tx: Sql, actor: Actor, found: Scope, replayed = false): Promise<SpaceHomeView> {
  const cache = new Map<string, DocumentPage | null>();
  const open = (id: string) => shown(r, tx, actor, found.id, found.workspace_id, id, cache);
  const scanned = await tx.query<{ id: string; owner_id: string; owner_name: string; editor_name: string | null }>(`SELECT p.id, p.owner_id, u.name AS owner_name, editor.name AS editor_name
    FROM hs_pages p
    JOIN hs_users u ON u.id = p.owner_id
    LEFT JOIN hs_revisions rev ON rev.page_id = p.id AND rev.version = p.version
    LEFT JOIN hs_users editor ON editor.id = rev.actor_id
    WHERE p.space_id = $1 AND p.workspace_id = $2 AND p.deleted_at IS NULL
    ORDER BY p.updated_at DESC, p.id
    LIMIT 80`, [found.id, found.workspace_id]);
  const readablePages: { page: DocumentPage; ownerId: string; ownerName: string; editorName: string | null }[] = [];
  for (const row of scanned.rows) {
    const page = await open(row.id);
    if (!page) continue;
    readablePages.push({ page, ownerId: row.owner_id, ownerName: row.owner_name, editorName: row.editor_name });
  }
  const meta = new Map(readablePages.map(row => [row.page.id, row]));
  const visiblePins: DocumentPage[] = [];
  for (const row of await pinRows(tx, found.id)) {
    const page = await open(row.page_id);
    if (page) visiblePins.push(page);
  }
  const pinned: SpaceHomePinView[] = visiblePins.map(page => ({
    pageId: page.id,
    title: page.title,
    summary: pageExcerpt(page.document).summary,
    icon: "document",
    updatedAtIst: formatIst(page.updatedAt),
  }));
  const recent: SpaceHomeRecentView[] = readablePages.slice(0, SPACE_HOME_RECENT_LIMIT).map(row => ({
    pageId: row.page.id,
    title: row.page.title,
    editorName: row.editorName,
    updatedAtIst: formatIst(row.page.updatedAt),
  }));
  const leaders = await tx.query<{ user_id: string; name: string }>(`SELECT sm.user_id, u.name
    FROM hs_space_members sm
    JOIN hs_users u ON u.id = sm.user_id
    JOIN hs_members m ON m.workspace_id = $2 AND m.user_id = sm.user_id AND m.active = true
    WHERE sm.space_id = $1 AND sm.role = 'leader' AND sm.active = true
    ORDER BY u.name, sm.user_id`, [found.id, found.workspace_id]);
  const seen = new Set<string>();
  const owners: SpaceHomeOwnerView[] = [];
  for (const leader of leaders.rows) {
    seen.add(leader.user_id);
    owners.push({ userId: leader.user_id, name: leader.name, role: "leader" });
  }
  const pageOwners = readablePages
    .filter(row => !seen.has(row.ownerId))
    .map(row => ({ userId: row.ownerId, name: row.ownerName, role: "page-owner" as const }));
  for (const owner of pageOwners) seen.add(owner.userId);
  owners.push(...pageOwners.filter((owner, index) => pageOwners.findIndex(item => item.userId === owner.userId) === index).sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)));
  const viewRows = await tx.query<{ page_id: string; node: unknown }>(`SELECT b.page_id, b.node
    FROM hs_blocks b
    JOIN hs_pages p ON p.id = b.page_id
    WHERE p.space_id = $1 AND p.workspace_id = $2 AND p.deleted_at IS NULL AND b.type = 'recordView'
    ORDER BY p.updated_at DESC, b.position
    LIMIT 40`, [found.id, found.workspace_id]);
  const recordViews: SpaceHomeRecordView[] = [];
  for (const row of viewRows.rows) {
    if (recordViews.length >= 10) break;
    const page = await open(row.page_id);
    if (!page) continue;
    const attrs = nodeOf(row.node).attrs ?? {};
    if (recordRefAttributeError("recordView", attrs)) continue;
    recordViews.push({
      pageId: page.id,
      pageTitle: page.title,
      viewId: String(attrs.viewId),
      collectionId: String(attrs.collectionId),
      layout: attrs.layout === "list" ? "list" : "table",
      icon: "grid",
    });
  }
  let home: SpaceHomePageView | null = null;
  if (found.home_page_id) {
    const page = await open(found.home_page_id);
    if (page) {
      const excerpt = pageExcerpt(page.document);
      const source = await tx.query<{ template_id: string }>("SELECT template_id FROM hs_page_template_sources WHERE page_id = $1", [page.id]);
      home = {
        pageId: page.id,
        title: page.title,
        summary: excerpt.summary,
        headings: excerpt.headings,
        templateName: source.rows[0]?.template_id === SPACE_HOME_TEMPLATE_ID ? SPACE_HOME_TITLE : null,
        role: page.role,
        updatedAtIst: formatIst(page.updatedAt),
      };
    }
  }
  const pinnedIds = new Set(pinned.map(pin => pin.pageId));
  const pinCandidates = manageable(found)
    ? readablePages.filter(row => !pinnedIds.has(row.page.id)).slice(0, 30).map(row => ({ pageId: row.page.id, title: row.page.title }))
    : [];
  return {
    workspaceId: found.workspace_id,
    spaceId: found.id,
    spaceName: found.name,
    canManage: manageable(found),
    home,
    widgets: { pinned, recent, recordViews, owners },
    pinCandidates,
    ...(replayed ? { replayed: true } : {}),
  };
}

async function requireSpace(tx: Sql, workspaceId: string, spaceId: string, actor: Actor, lock: boolean) {
  const found = await scope(tx, workspaceId, spaceId, actor, lock);
  if (!found || !admitted(found)) throw spaceUnavailable();
  return found;
}

export async function readSpaceHome(r: Repository, actor: Actor, workspaceId: string, spaceId: string) {
  if (!workspaceId || workspaceId.length > 200 || !spaceId || spaceId.length > 200) throw spaceUnavailable();
  return r.db.transaction(async tx => loadView(r, tx, actor, await requireSpace(tx, workspaceId, spaceId, actor, false)));
}

export async function changeSpaceHome(r: Repository, actor: Actor, workspaceId: string, spaceId: string, input: unknown) {
  if (!workspaceId || workspaceId.length > 200 || !spaceId || spaceId.length > 200) throw spaceUnavailable();
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const command = parsed.data;
  const requestHash = hash(command);
  return r.db.transaction(async tx => {
    const found = await requireSpace(tx, workspaceId, spaceId, actor, true);
    if (!manageable(found)) throw notAllowed();
    const prior = await tx.query<{ actor_id: string; request_hash: string }>("SELECT actor_id, request_hash FROM hs_space_home_operations WHERE space_id = $1 AND operation_id = $2", [found.id, command.operationId]);
    if (prior.rows.length) {
      const previous = prior.rows[0];
      if (previous.actor_id !== actor.id || previous.request_hash !== requestHash) throw mismatch();
      return loadView(r, tx, actor, found, true);
    }
    const sameSpace = async (id: string) => {
      const page = await readable(r, tx, id, actor);
      if (!page || page.space_id !== found.id || page.workspace_id !== found.workspace_id) throw pageUnavailable();
      return page;
    };
    let auditPage: string | null = null;
    let auditAfter: Record<string, unknown> = { spaceId: found.id, action: command.action };
    if (command.action === "set-home") {
      const page = await sameSpace(command.pageId);
      await tx.query("UPDATE hs_spaces SET home_page_id = $2 WHERE id = $1", [found.id, page.id]);
      found.home_page_id = page.id;
      auditPage = page.id;
      auditAfter = { spaceId: found.id, pageId: page.id, action: command.action };
    } else if (command.action === "pin" || command.action === "unpin") {
      const page = await sameSpace(command.pageId);
      const pins = await splitPins(r, tx, actor, found);
      const already = pins.visible.some(pin => pin.pageId === page.id);
      if (command.action === "pin" && !already) {
        if (pins.visible.length >= SPACE_HOME_PIN_LIMIT || pins.visible.length + pins.hidden.length >= SPACE_HOME_PIN_LIMIT * 2) throw new DocumentError("Choose fewer pinned pages.", "invalid_space_home", 422);
        await replacePins(tx, found.id, [...pins.visible, { pageId: page.id, pinnedBy: actor.id }, ...pins.hidden]);
      } else if (command.action === "unpin" && already) {
        await replacePins(tx, found.id, [...pins.visible.filter(pin => pin.pageId !== page.id), ...pins.hidden]);
      }
      auditPage = page.id;
      auditAfter = { spaceId: found.id, pageId: page.id, action: command.action };
    } else {
      const pins = await splitPins(r, tx, actor, found);
      const visibleIds = pins.visible.map(pin => pin.pageId);
      const submitted = command.pageIds;
      const same = submitted.length === visibleIds.length && new Set(submitted).size === submitted.length && submitted.every(id => visibleIds.includes(id));
      if (!same) throw refreshPins();
      const byId = new Map(pins.visible.map(pin => [pin.pageId, pin]));
      await replacePins(tx, found.id, [...submitted.map(id => byId.get(id)!), ...pins.hidden]);
      auditAfter = { spaceId: found.id, pageIds: submitted, action: command.action };
    }
    const view = await loadView(r, tx, actor, found, false);
    const stored = { action: command.action, homePageId: view.home?.pageId ?? null, pinPageIds: view.widgets.pinned.map(pin => pin.pageId) };
    await tx.query("INSERT INTO hs_space_home_operations(space_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5)", [found.id, command.operationId, actor.id, requestHash, JSON.stringify(stored)]);
    await audit(tx, actor.id, `space-home.${command.action}`, auditPage, command.operationId, auditAfter);
    return view;
  });
}

export async function provisionSpaceHome(r: Repository, tx: Sql, actor: Actor, spaceId: string, workspaceId: string) {
  const pageId = randomUUID();
  const document = ensureIds(spaceHomeTemplate.document, true);
  await tx.query("INSERT INTO hs_pages(id, workspace_id, space_id, owner_id, title, visibility) VALUES($1,$2,$3,$4,$5,'private')", [pageId, workspaceId, spaceId, actor.id, SPACE_HOME_TITLE]);
  await r.writeDocument(tx, pageId, document, 1, SPACE_HOME_TITLE, actor.id, "template");
  await tx.query("INSERT INTO hs_page_template_sources(page_id, template_id, template_revision) VALUES($1,$2,$3)", [pageId, spaceHomeTemplate.id, spaceHomeTemplate.revision]);
  await tx.query("UPDATE hs_spaces SET home_page_id = $2 WHERE id = $1", [spaceId, pageId]);
  await tx.query("INSERT INTO hs_space_members(space_id, user_id, role, granted_by) VALUES($1,$2,'leader',$2) ON CONFLICT(space_id, user_id) DO NOTHING", [spaceId, actor.id]);
  const operationId = randomUUID();
  await audit(tx, actor.id, "space-home.provision", pageId, operationId, { spaceId, pageId, templateId: SPACE_HOME_TEMPLATE_ID, templateRevision: spaceHomeTemplate.revision });
  return { pageId };
}
