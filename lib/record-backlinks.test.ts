import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { localActor, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds, type RichNode } from "./document";
import {
  PAGE_BACKLINK_MISSING,
  RECORD_BACKLINK_MISSING,
  RECORD_BACKLINK_PAGE_SIZE,
  RECORD_BACKLINK_POLL_MS,
  RECORD_LINK_REJECTED,
  RECORD_VIEW_MENTION_LIMIT,
  clampSnippet,
  mentionedHeading,
  parseRecordBacklinkQuery,
  purgeRecordBacklinks,
  readRecordBacklinks,
  recordIdFromHref,
  type BacklinkQuery,
  type MentionList,
  type ViewMentionList,
} from "./record-backlinks";
import { Repository } from "./repository";
import { deletePageTree, previewPageDeletion } from "./trash";

const state = vi.hoisted(() => ({ repo: null as Repository | null }));
vi.mock("./auth", async () => {
  const actual = await vi.importActual<typeof import("./auth")>("./auth");
  return { ...actual, authenticate: async (request: Request) => ({ id: request.headers.get("x-test-actor") || actual.localActor.id }), localPreview: () => false };
});
vi.mock("./repository", async () => {
  const actual = await vi.importActual<typeof import("./repository")>("./repository");
  return { ...actual, repository: async () => { if (!state.repo) throw new Error("repository unavailable"); return state.repo; } };
});
import { GET } from "../app/api/records/[id]/backlinks/route";

let db: Database;
let r: Repository;
const owner = localActor;
const editor: Actor = { id: "holy87-editor", name: "Editor" };
const outsider: Actor = { id: "holy87-out", name: "Outside" };
const admin: Actor = { id: "holy87-admin", name: "Admin" };
const bolt: Actor = { id: "holy87-bolt", name: "Bolt" };
const ws = "ws-holy87";
const boltWs = "ws-holy87-b";
let tenant = "";
let boltTenant = "";
let record = "";
let hiddenRecord = "";
let spaceOps = "";
let chipPage = "";
let cardPage = "";
let linkPage = "";
let hiddenPage = "";
let trashedPage = "";
let viewPage = "";
let chipBlock = "";
let parentTitle = "";

const base = (): BacklinkQuery => ({ workspaceId: ws, tenantId: tenant, sort: "edited", order: "desc", spaceId: null, cursor: null, includeTrash: false, section: "mentions", openPageId: null });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  state.repo = r;
  await r.seedLocal();
  for (const user of [editor, outsider, admin, bolt]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,'Acme'),($2,'Bolt')", [ws, boltWs]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'member'),($1,$5,'admin'),($6,$7,'member')", [ws, owner.id, editor.id, outsider.id, admin.id, boltWs, bolt.id]);
  tenant = crypto.randomUUID();
  boltTenant = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Acme'),($2,'Bolt')", [tenant, boltTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'acme'),($3,$4,'bolt')", [ws, tenant, boltWs, boltTenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Clients',true),($2,'organisations','Clients',true)", [tenant, boltTenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',ARRAY['view','create']),($1,$3,'organisations',ARRAY['view']),($1,$4,'organisations',ARRAY['view']),($5,$6,'organisations',ARRAY['view','create'])", [tenant, owner.id, editor.id, admin.id, boltTenant, bolt.id]);
  spaceOps = (await r.createSpace(owner, "SP-OPS", ws)).id;
  const vault = (await r.createSpace(owner, "Owner vault", ws)).id;
  const parent = await r.create(owner, "Client notes", spaceOps);
  parentTitle = parent.title;
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor')", [parent.id, editor.id]);
  record = await makeRecord("R-100");
  hiddenRecord = await makeRecord("R-200");
  const context = "Renewal context for the client policy pack. ".repeat(4);
  chipBlock = crypto.randomUUID();
  const chip = await r.create(owner, "Chip page", spaceOps, parent.id);
  chipPage = chip.id;
  await save(chip, [{ type: "paragraph", content: [{ type: "text", text: context }] }, ref("chip", chipBlock)]);
  await db.query("UPDATE hs_pages SET updated_at=$2 WHERE id=$1", [chipPage, "2026-10-31T12:00:00.000Z"]);
  const card = await r.create(owner, "Card page", spaceOps);
  cardPage = card.id;
  await save(card, [{ type: "paragraph", content: [{ type: "text", text: "Card context for the renewal." }] }, ref("card", crypto.randomUUID())]);
  const link = await r.create(owner, "Link page", spaceOps);
  linkPage = link.id;
  await save(link, [linkParagraph("See the plain language note about this record before the quarterly review meeting happens.")]);
  const hidden = await r.create(owner, "Owner only page", vault);
  hiddenPage = hidden.id;
  await save(hidden, [ref("chip", crypto.randomUUID())]);
  const trashed = await r.create(owner, "Trashed mention", spaceOps);
  trashedPage = trashed.id;
  await save(trashed, [ref("chip", crypto.randomUUID())]);
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [trashedPage]);
  viewPage = (await r.create(editor, "Renewals page", spaceOps)).id;
  const viewId = crypto.randomUUID();
  const secretView = crypto.randomUUID();
  const definition = JSON.stringify({ columns: ["name"], filters: [{ field: "name", operator: "equal", value: "R-100" }], sort: [{ field: "name", direction: "asc" }], includeArchived: false });
  await db.query("INSERT INTO hs_data_views(id,tenant_id,workspace_id,collection,owner_id,scope,name,definition) VALUES($1,$2,$3,'organisations',$4,'workspace','Renewals this quarter',$5::jsonb),($6,$2,$3,'organisations',$4,'private','Secret renewals',$5::jsonb)", [viewId, tenant, ws, owner.id, definition, secretView]);
  await db.query("INSERT INTO hs_blocks(id,page_id,parent_id,position,type,node) VALUES($1,$2,NULL,4,'recordView',$3),($4,$2,NULL,5,'recordView',$5)", [crypto.randomUUID(), viewPage, JSON.stringify(viewNode(viewId)), crypto.randomUUID(), JSON.stringify(viewNode(secretView))]);
  for (const pageId of [chipPage, cardPage, linkPage]) await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor')", [pageId, editor.id]);
}, 30000);

afterAll(async () => { await db.close(); });

async function makeRecord(name: string, tenantId = tenant, actor = owner.id) {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_records(id,tenant_id,collection,name,created_by,updated_by) VALUES($1,$2,'organisations',$3,$4,$4)", [id, tenantId, name, actor]);
  return id;
}
function ref(display: "chip" | "card", id: string): RichNode {
  return { type: "recordRef", attrs: { id, nodeVersion: 1, recordId: record, collectionId: "organisations", display, fields: display === "card" ? ["core:notes"] : [] } };
}
function linkParagraph(text: string, recordId = record, id = crypto.randomUUID()): RichNode {
  return { type: "paragraph", attrs: { id }, content: [{ type: "text", text, marks: [{ type: "link", attrs: { href: `https://holy.example/workspaces/${ws}/tenants/${tenant}/records?collection=organisations&record=${recordId}` } }] }] };
}
function viewNode(viewId: string) {
  return { type: "recordView", attrs: { id: crypto.randomUUID(), nodeVersion: 1, viewId, collectionId: "organisations", layout: "table", columns: ["name"], limit: 10 } };
}
async function save(page: { id: string; version: number; title: string }, content: RichNode[], actor: Actor = owner) {
  const current = await r.get(page.id, actor);
  return r.save(page.id, actor, { operationId: crypto.randomUUID(), baseVersion: current.version, title: current.title, document: ensureIds({ type: "doc", content }) });
}
async function panel(actor: Actor, recordId = record, extra: Partial<BacklinkQuery> = {}) {
  const result = await readRecordBacklinks(r, actor, recordId, { ...base(), ...extra });
  expect(result).toHaveProperty("items");
  return result as MentionList;
}
function shape(error: unknown) {
  const failed = error as { status?: number; code?: string; message?: string; details?: unknown };
  return { status: failed.status, code: failed.code, message: failed.message, details: failed.details ?? null };
}
async function fails(run: () => Promise<unknown>) {
  try { await run(); } catch (error) { return shape(error); }
  throw new Error("expected a refusal");
}

it("lists chip, card and plain link with snippet, breadcrumb and IST highlight target", async () => {
  const result = await panel(editor);
  expect(result.heading).toBe("Mentioned in 3 pages you can see");
  expect(result.count).toBe(3);
  const byTitle = Object.fromEntries(result.items.map(item => [item.title, item]));
  expect(byTitle["Chip page"].referenceType).toBe("chip");
  expect(byTitle["Chip page"].icon).toBe("▣");
  expect(byTitle["Chip page"].referenceLabel).toBe("Chip");
  expect(byTitle["Card page"].referenceType).toBe("card");
  expect(byTitle["Link page"].referenceType).toBe("link");
  expect(byTitle["Chip page"].spaceName).toBe("SP-OPS");
  expect(byTitle["Chip page"].breadcrumb).toContain("SP-OPS");
  expect(byTitle["Chip page"].breadcrumb).toContain(parentTitle);
  expect(byTitle["Chip page"].snippet.length).toBeLessThanOrEqual(120);
  expect(byTitle["Chip page"].snippet.startsWith("Renewal context")).toBe(true);
  expect(byTitle["Link page"].snippet.length).toBeLessThanOrEqual(120);
  expect(byTitle["Chip page"].editedAtIst).toBe("31 Oct 2026, 17:30 IST");
  expect(byTitle["Chip page"].href).toBe(`/pages/${encodeURIComponent(chipPage)}#block-${encodeURIComponent(chipBlock)}`);
  expect(result.items.map(item => item.pageId).sort()).toEqual([cardPage, chipPage, linkPage].sort());
  const audits = await db.query<{ after_value: unknown }>("SELECT after_value FROM hs_audit WHERE action='record-backlink.index'");
  expect(JSON.stringify(audits.rows)).not.toContain("Renewal context");
  expect(JSON.stringify(audits.rows)).toContain(record);
});

it("drops a removed chip, hides trash, restores it, and purges the index", async () => {
  const id = await makeRecord("Mutable");
  const kept = await r.create(editor, "Kept mention", spaceOps);
  const removed = await r.create(editor, "Removed chip", spaceOps);
  const chipId = crypto.randomUUID();
  await save(removed, [{ type: "recordRef", attrs: { id: chipId, nodeVersion: 1, recordId: id, collectionId: "organisations", display: "chip", fields: [] } }], editor);
  await save(kept, [{ type: "recordRef", attrs: { id: crypto.randomUUID(), nodeVersion: 1, recordId: id, collectionId: "organisations", display: "card", fields: [] } }], editor);
  expect((await panel(editor, id)).items.map(item => item.pageId).sort()).toEqual([kept.id, removed.id].sort());
  const cleared = await r.get(removed.id, editor);
  await r.save(removed.id, editor, { operationId: crypto.randomUUID(), baseVersion: cleared.version, title: cleared.title, document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Chip gone" }] }] }) });
  expect((await panel(editor, id)).items.map(item => item.pageId)).toEqual([kept.id]);
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [kept.id]);
  expect((await panel(editor, id)).items).toEqual([]);
  await db.query("UPDATE hs_pages SET deleted_at=NULL WHERE id=$1", [kept.id]);
  expect((await panel(editor, id)).items.map(item => item.pageId)).toEqual([kept.id]);
  await db.transaction(tx => purgeRecordBacklinks(tx, editor, kept.id, crypto.randomUUID()));
  expect((await panel(editor, id)).items).toEqual([]);
  expect((await db.query("SELECT block_id FROM hs_record_backlinks WHERE page_id=$1", [kept.id])).rows).toEqual([]);
  const owned = await r.create(admin, "Admin trashed mention", spaceOps);
  await save(owned, [{ type: "recordRef", attrs: { id: crypto.randomUUID(), nodeVersion: 1, recordId: id, collectionId: "organisations", display: "chip", fields: [] } }], admin);
  const preview = await previewPageDeletion(r, admin, ws, owned.id);
  await deletePageTree(r, admin, ws, owned.id, { operationId: crypto.randomUUID(), expectedTreeVersion: preview.treeVersion, previewDigest: preview.digest });
  expect((await panel(admin, id)).items.some(item => item.pageId === owned.id)).toBe(false);
  expect((await panel(admin, id, { includeTrash: true })).items.find(item => item.pageId === owned.id)?.trashLabel).toBe("In trash");
  await db.query("UPDATE hs_pages SET deleted_at=NULL, deletion_batch_id=NULL WHERE id=$1", [owned.id]);
  expect((await panel(admin, id)).items.some(item => item.pageId === owned.id)).toBe(true);
  expect(RECORD_BACKLINK_POLL_MS).toBeLessThan(5000);
});

it("counts only pages the reader can see", async () => {
  const editorView = await panel(editor);
  const ownerView = await panel(owner);
  expect(editorView.count).toBe(3);
  expect(editorView.heading).toBe(mentionedHeading(3));
  expect(ownerView.count).toBe(4);
  expect(ownerView.heading).toBe("Mentioned in 4 pages you can see");
  const serialized = JSON.stringify(editorView);
  expect(serialized).not.toContain(hiddenPage);
  expect(serialized).not.toContain("Owner only page");
  expect(serialized).not.toContain("Owner vault");
  expect(serialized).not.toContain("Trashed mention");
  expect(serialized).not.toContain("+1 more");
  expect(serialized).not.toContain("avatar");
  expect(editorView.spaces.map(space => space.name)).toEqual(["SP-OPS"]);
  expect(editorView.canIncludeTrash).toBe(false);
});

it("computes view membership on demand and drops a record that leaves the filter", async () => {
  const first = await readRecordBacklinks(r, editor, record, { ...base(), section: "views" }) as ViewMentionList;
  expect(first.heading).toBe("Appears in view blocks");
  expect(first.items.map(item => item.pageId)).toContain(viewPage);
  expect(first.items.find(item => item.pageId === viewPage)?.viewName).toBe("Renewals this quarter");
  expect(JSON.stringify(first)).not.toContain("Secret renewals");
  expect(first.items.length).toBeLessThanOrEqual(RECORD_VIEW_MENTION_LIMIT);
  await db.query("UPDATE hs_data_records SET name='R-100 moved' WHERE id=$1", [record]);
  const gone = await readRecordBacklinks(r, editor, record, { ...base(), section: "views" }) as ViewMentionList;
  expect(gone.items.some(item => item.pageId === viewPage)).toBe(false);
  await db.query("UPDATE hs_data_records SET name='R-100' WHERE id=$1", [record]);
  const back = await readRecordBacklinks(r, editor, record, { ...base(), section: "views" }) as ViewMentionList;
  expect(back.items.some(item => item.pageId === viewPage)).toBe(true);
  const capped: string[] = [];
  for (let index = 0; index < RECORD_VIEW_MENTION_LIMIT + 1; index++) {
    const title = `View cap ${String(index).padStart(2, "0")}`;
    const page = await r.create(editor, title, spaceOps);
    const blockId = crypto.randomUUID();
    await db.query("INSERT INTO hs_blocks(id,page_id,parent_id,position,type,node) VALUES($1,$2,NULL,4,'recordView',$3::jsonb)", [blockId, page.id, JSON.stringify({ type: "recordView", attrs: { id: blockId, nodeVersion: 1, viewId: (await db.query<{ id: string }>("SELECT id FROM hs_data_views WHERE name='Renewals this quarter' AND tenant_id=$1", [tenant])).rows[0].id, collectionId: "organisations", layout: "table", columns: ["name"], limit: 10 } })]);
    capped.push(title);
  }
  const limited = await readRecordBacklinks(r, editor, record, { ...base(), section: "views" }) as ViewMentionList;
  expect(new Set(limited.items.map(item => item.pageId)).size).toBeLessThanOrEqual(RECORD_VIEW_MENTION_LIMIT);
  expect(limited.items.some(item => item.title === capped.at(-1))).toBe(false);
});

it("paginates, sorts and filters on the server", async () => {
  const id = await makeRecord("Paged");
  const ops = (await r.createSpace(owner, "Page ops", ws)).id;
  const other = (await r.createSpace(owner, "Page open", ws)).id;
  const pages: { id: string; title: string }[] = [];
  for (let index = 0; index < 60; index++) {
    const title = `Mention ${String(index).padStart(2, "0")}`;
    const space = index < 40 ? ops : other;
    const page = await r.create(editor, title, space);
    await save(page, [{ type: "recordRef", attrs: { id: crypto.randomUUID(), nodeVersion: 1, recordId: id, collectionId: "organisations", display: "chip", fields: [] } }], editor);
    await db.query("UPDATE hs_pages SET updated_at=$2 WHERE id=$1", [page.id, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()]);
    pages.push({ id: page.id, title });
  }
  const titled = await panel(editor, id, { sort: "title", order: "asc" });
  expect(titled.count).toBe(60);
  expect(titled.items).toHaveLength(RECORD_BACKLINK_PAGE_SIZE);
  expect(titled.items.map(item => item.title)).toEqual(pages.slice(0, 20).map(item => item.title));
  const second = await panel(editor, id, { sort: "title", order: "asc", cursor: titled.nextCursor });
  const third = await panel(editor, id, { sort: "title", order: "asc", cursor: second.nextCursor });
  const seen = [...titled.items, ...second.items, ...third.items];
  expect(new Set(seen.map(item => item.pageId)).size).toBe(60);
  expect(third.nextCursor).toBeNull();
  const filtered = await panel(editor, id, { sort: "title", order: "asc", spaceId: ops });
  expect(filtered.count).toBe(40);
  expect(filtered.heading).toBe("Mentioned in 40 pages you can see");
  expect(filtered.items.every(item => item.spaceId === ops)).toBe(true);
  const edited = await panel(editor, id, { sort: "edited", order: "desc" });
  expect(edited.items[0].title).toBe("Mention 59");
  expect(edited.items.at(-1)?.title).toBe("Mention 40");
}, 60000);

it("uses a labelled list and a mobile bottom sheet", async () => {
  expect(clampSnippet("a".repeat(150)).length).toBe(120);
  expect(recordIdFromHref(`https://holy.example/workspaces/${ws}/tenants/${tenant}/records?collection=organisations&record=${record}`)).toBe(record);
  expect(parseRecordBacklinkQuery(new URL("https://hs.example/api/records/x?sort=title")).sort).toBe("title");
  expect(() => parseRecordBacklinkQuery(new URL("https://hs.example/api/records/x?secret=hidden-salary"))).toThrow(/Invalid backlink request/);
});

it("returns one not-found shape for an unreadable record and a random id", async () => {
  const denied = await fails(() => panel(outsider, hiddenRecord));
  const random = await fails(() => panel(outsider, crypto.randomUUID()));
  const malformed = await fails(() => panel(outsider, "not-a-uuid"));
  expect(denied).toEqual({ status: 404, code: "record_not_found", message: RECORD_BACKLINK_MISSING, details: null });
  expect(random).toEqual(denied);
  expect(malformed).toEqual(denied);
  const request = (id: string) => new Request(`http://localhost/api/records/${id}/backlinks`, { headers: { "x-test-actor": outsider.id } });
  const hiddenResponse = await GET(request(hiddenRecord), { params: Promise.resolve({ id: hiddenRecord }) });
  const randomResponse = await GET(request(crypto.randomUUID()), { params: Promise.resolve({ id: crypto.randomUUID() }) });
  const hiddenBody = await hiddenResponse.json();
  const randomBody = await randomResponse.json();
  expect(hiddenResponse.status).toBe(404);
  expect(randomResponse.status).toBe(hiddenResponse.status);
  expect(randomBody).toEqual(hiddenBody);
  expect(hiddenResponse.headers.get("cache-control")).toBe(randomResponse.headers.get("cache-control"));
  expect(hiddenBody).toEqual({ error: RECORD_BACKLINK_MISSING, code: "record_not_found", retryable: false });
  expect(JSON.stringify(hiddenBody)).not.toContain("Chip page");
  const leaked = await GET(new Request(`http://localhost/api/records/${record}/backlinks?secret=hidden-salary`, { headers: { "x-test-actor": editor.id } }), { params: Promise.resolve({ id: record }) });
  expect(leaked.status).toBe(400);
  expect(JSON.stringify(await leaked.json())).not.toContain("hidden-salary");
});

it("removes a page after access is revoked and rejects a stale open", async () => {
  const id = await makeRecord("Revoked target");
  const page = await r.create(owner, "Revoked ops page", spaceOps);
  await save(page, [{ type: "recordRef", attrs: { id: crypto.randomUUID(), nodeVersion: 1, recordId: id, collectionId: "organisations", display: "chip", fields: [] } }]);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor')", [page.id, editor.id]);
  const before = await panel(editor, id);
  expect(before.items.map(item => item.pageId)).toEqual([page.id]);
  await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2", [page.id, editor.id]);
  const after = await panel(editor, id);
  expect(after.items).toEqual([]);
  expect(after.count).toBe(0);
  const stale = await fails(() => readRecordBacklinks(r, editor, id, { ...base(), openPageId: page.id }));
  const unknown = await fails(() => readRecordBacklinks(r, editor, id, { ...base(), openPageId: crypto.randomUUID() }));
  expect(stale).toEqual({ status: 404, code: "not_found", message: PAGE_BACKLINK_MISSING, details: null });
  expect(unknown).toEqual(stale);
  expect(JSON.stringify(stale)).not.toContain("Revoked ops page");
});

it("hides trashed sources unless an admin includes trash", async () => {
  const editorView = await panel(editor, record, { includeTrash: true });
  const adminDefault = await panel(admin);
  const adminTrash = await panel(admin, record, { includeTrash: true });
  expect(editorView.items.some(item => item.pageId === trashedPage)).toBe(false);
  expect(JSON.stringify(editorView)).not.toContain("Trashed mention");
  expect(adminDefault.items.some(item => item.pageId === trashedPage)).toBe(false);
  expect(adminDefault.canIncludeTrash).toBe(true);
  const trashed = adminTrash.items.find(item => item.pageId === trashedPage);
  expect(trashed?.trashLabel).toBe("In trash");
  expect(trashed?.title).toBe("Trashed mention");
});

it("rejects a cross-tenant reference with the same shape as a missing record", async () => {
  const page = await r.create(bolt, "Bolt crafted page", (await r.createSpace(bolt, "Bolt ops", boltWs)).id);
  const foreignChip = ensureIds({ type: "doc", content: [{ type: "recordRef", attrs: { nodeVersion: 1, recordId: record, collectionId: "organisations", display: "chip", fields: [] } }] });
  const missingChip = ensureIds({ type: "doc", content: [{ type: "recordRef", attrs: { nodeVersion: 1, recordId: crypto.randomUUID(), collectionId: "organisations", display: "chip", fields: [] } }] });
  const foreignLink = ensureIds({ type: "doc", content: [linkParagraph("foreign", record)] });
  const missingLink = ensureIds({ type: "doc", content: [linkParagraph("missing", crypto.randomUUID())] });
  const saveAs = (document: RichNode) => r.save(page.id, bolt, { operationId: crypto.randomUUID(), baseVersion: 1, title: page.title, document });
  const foreign = await fails(() => saveAs(foreignChip));
  const missing = await fails(() => saveAs(missingChip));
  const foreignPlain = await fails(() => saveAs(foreignLink));
  const missingPlain = await fails(() => saveAs(missingLink));
  expect(foreign).toEqual({ status: 422, code: "reference_unavailable", message: RECORD_LINK_REJECTED, details: null });
  expect(missing).toEqual(foreign);
  expect(foreignPlain).toEqual(foreign);
  expect(missingPlain).toEqual(foreign);
  expect((await db.query("SELECT page_id FROM hs_record_backlinks WHERE record_id=$1 AND page_id=$2", [record, page.id])).rows).toEqual([]);
  await db.query("INSERT INTO hs_record_backlinks(workspace_id,record_id,page_id,block_id,ref_type) VALUES($1,$2,$3,'crafted','chip')", [ws, record, page.id]);
  const listed = await panel(editor);
  expect(JSON.stringify(listed)).not.toContain(page.id);
  expect(JSON.stringify(listed)).not.toContain("Bolt crafted page");
});
