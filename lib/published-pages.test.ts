import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localActor, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds, type RichNode } from "./document";
import { previewPageLocation, movePageTree } from "./page-organisation";
import {
  PUBLISHED_NOT_FOUND,
  PUBLISHED_NOT_FOUND_TITLE,
  NOT_LATEST_BANNER,
  TRASH_MESSAGE,
  UNPUBLISHED_CHANGES,
  UNPUBLISHED_MESSAGE,
  assignSpaceSlug,
  changePublishedPage,
  draftPublication,
  formatPublishedAt,
  publishedBanner,
  publishedDocumentMetadata,
  publishedRedirectResponse,
  resolvePublishedPage,
  suggestSlug,
  valuesAsOf,
  type PublishedResolution,
} from "./published-pages";
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
import { GET } from "../app/api/v1/published/[space]/[slug]/route";

let db: Database;
let r: Repository;
const owner = localActor;
const editor: Actor = { id: "holy88-ed", name: "U-ED" };
const viewer: Actor = { id: "holy88-vi", name: "U-VI" };
const outsider: Actor = { id: "holy88-out", name: "U-OUT" };
const admin: Actor = { id: "holy88-adm", name: "U-ADM" };
const bolt: Actor = { id: "holy88-b", name: "U-B" };
const ws = "ws-holy88";
const boltWs = "ws-holy88-b";
let tenant = "";
let record = "";
let ops = "";
let open = "";
let boltOps = "";
let pageId = "";
let secretId = "";
let spareId = "";
let boltPage = "";
const blockId = "holy88-record-card";
const approved = "Approved runbook text";
const draftSentence = "Draft secret sentence";
const second = "Second published text";
const third = "Third published text";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  state.repo = r;
  await r.seedLocal();
  await db.query("UPDATE hs_users SET name='U-OWN' WHERE id=$1", [owner.id]);
  for (const user of [editor, viewer, outsider, admin, bolt]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,'Acme Health'),($2,'Bolt Logistics')", [ws, boltWs]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member'),($1,$6,'admin'),($7,$8,'member')", [ws, owner.id, editor.id, viewer.id, outsider.id, admin.id, boltWs, bolt.id]);
  tenant = crypto.randomUUID();
  const boltTenant = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Acme'),($2,'Bolt')", [tenant, boltTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'acme'),($3,$4,'bolt')", [ws, tenant, boltWs, boltTenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'contacts','Contacts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'contacts',ARRAY['view','create','edit']),($1,$3,'contacts',ARRAY['view']),($1,$4,'contacts',ARRAY['view'])", [tenant, owner.id, editor.id, viewer.id]);
  record = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_records(id,tenant_id,collection,name,field_values,created_by,updated_by) VALUES($1,$2,'contacts','R-100',$3::jsonb,$4,$4)", [record, tenant, JSON.stringify({ "core:job-title": "Nurse", "core:email": "secret@acme.test" }), owner.id]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write) VALUES($1,'contacts','core:email',$2,true,true)", [tenant, owner.id]);
  ops = (await r.createSpace(owner, "SP-OPS", ws)).id;
  open = (await r.createSpace(owner, "SP-OPEN", ws)).id;
  boltOps = (await r.createSpace(bolt, "SP-OPS", boltWs)).id;
  await assignSpaceSlug(r, owner, ops, "ops");
  await assignSpaceSlug(r, owner, open, "open");
  await assignSpaceSlug(r, bolt, boltOps, "ops");
  pageId = (await r.create(owner, "Onboarding runbook", ops)).id;
  secretId = (await r.create(owner, "Board minutes", ops)).id;
  spareId = (await r.create(owner, "Spare page", ops)).id;
  boltPage = (await r.create(bolt, "Bolt runbook", boltOps)).id;
  await save(owner, pageId, approved);
  await save(owner, secretId, "Secret minutes", undefined, false);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor'),($1,$3,'viewer')", [pageId, editor.id, viewer.id]);
}, 30000);

afterAll(async () => { await db.close(); });

function card(): RichNode {
  return { type: "recordRef", attrs: { id: blockId, nodeVersion: 1, recordId: record, collectionId: "contacts", display: "card", fields: ["core:job-title", "core:email"] } };
}
async function save(actor: Actor, id: string, text: string, title?: string, withCard = true) {
  const current = await r.get(id, actor);
  const content: RichNode[] = [{ type: "paragraph", content: [{ type: "text", text }] }];
  if (withCard) content.push(card());
  return r.save(id, actor, { operationId: crypto.randomUUID(), baseVersion: current.version, title: title ?? current.title, document: ensureIds({ type: "doc", content }) });
}
async function publish(id: string, slug: string, note: string, freezeValues = false, actor: Actor = owner) {
  return changePublishedPage(r, actor, id, { action: "publish", operationId: crypto.randomUUID(), slug, note, freezeValues });
}
function openPath(actor: Actor, space: string, slug: string, workspaceId: string | null = null) {
  return resolvePublishedPage(r, actor, { workspaceId, spaceSlug: space, pageSlug: slug });
}
async function http(actor: Actor, space: string, slug: string, workspace?: string) {
  const response = await GET(new Request(`https://holy.example/api/v1/published/${space}/${encodeURIComponent(slug)}${workspace ? `?workspace=${workspace}` : ""}`, { headers: { "x-test-actor": actor.id } }), { params: Promise.resolve({ space, slug }) });
  const text = await response.text();
  return { status: response.status, location: response.headers.get("location"), body: text ? JSON.parse(text) as Record<string, unknown> : null };
}
function denyMeta(result: PublishedResolution) {
  const metadata = publishedDocumentMetadata(result);
  return { kind: result.kind, title: metadata.title, openGraph: "openGraph" in metadata ? metadata.openGraph : null };
}

describe("HOLY-88 published page stable URL", () => {
  it("formats the published banner in IST", () => {
    expect(suggestSlug("Onboarding runbook")).toBe("onboarding-runbook");
    expect(formatPublishedAt("2026-10-31T15:40:00.000Z")).toBe("31 Oct 2026, 9:10 PM IST");
    expect(publishedBanner("2026-10-31T15:40:00.000Z", "U-OWN")).toBe("Published 31 Oct 2026, 9:10 PM IST by U-OWN");
    expect(valuesAsOf("2026-10-31T15:40:00.000Z")).toBe("Values as of 31 Oct 2026, 9:10 PM IST");
  });

  it("HS-AC-N43-01 publishes v1 at a stable URL and copies that address", async () => {
    const operationId = crypto.randomUUID();
    const input = { action: "publish" as const, operationId, slug: "onboarding-runbook", note: "Initial publication", freezeValues: false };
    const first = await changePublishedPage(r, owner, pageId, input);
    const retry = await changePublishedPage(r, owner, pageId, input);
    expect(first).toMatchObject({ replayed: false, versionNo: 1, revisionId: `${pageId}:2` });
    expect(retry).toMatchObject({ replayed: true, versionNo: 1, revisionId: `${pageId}:2` });
    expect((await db.query("SELECT id FROM hs_published_versions WHERE page_id=$1", [pageId])).rows).toHaveLength(1);
    expect((await db.query("SELECT id FROM hs_document_publications WHERE page_id=$1", [pageId])).rows).toHaveLength(0);
    await expect(db.query("UPDATE hs_published_versions SET note='forged' WHERE page_id=$1", [pageId])).rejects.toThrow(/immutable/i);
    const viewed = await openPath(viewer, "ops", "onboarding-runbook");
    expect(viewed.kind).toBe("published");
    if (viewed.kind !== "published") return;
    expect(viewed.versionNo).toBe(1);
    expect(viewed.revisionId).toBe(`${pageId}:${(await db.query<{ revision_version: number }>("SELECT revision_version FROM hs_published_versions WHERE page_id=$1", [pageId])).rows[0].revision_version}`);
    expect(viewed.text).toContain(approved);
    expect(viewed.banner).toMatch(/^Published \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} [AP]M IST by U-OWN$/);
    expect(viewed.stablePath).toBe("/s/ops/onboarding-runbook");
    expect(viewed.canonicalPath).toBe(`/p/${encodeURIComponent(pageId)}`);
    expect((await r.get(pageId, viewer)).id).toBe(pageId);
    const audits = (await db.query<{ after_value: unknown }>("SELECT after_value FROM hs_audit WHERE action='published-page.publish' AND page_id=$1", [pageId])).rows.map(row => JSON.stringify(row.after_value));
    expect(audits.join(" ")).not.toContain("Initial publication");
    expect(audits.join(" ")).not.toContain(approved);
  });

  it("HS-AC-N43-10 resolves the same slug inside the caller's workspace only", async () => {
    await save(bolt, boltPage, "Bolt only text", "Bolt runbook", false);
    await publish(boltPage, "onboarding-runbook", "Bolt publication", false, bolt);
    const acme = await openPath(viewer, "ops", "onboarding-runbook");
    const logistics = await openPath(bolt, "ops", "onboarding-runbook");
    expect(acme.kind).toBe("published");
    expect(logistics.kind).toBe("published");
    if (acme.kind !== "published" || logistics.kind !== "published") return;
    expect(acme.pageId).toBe(pageId);
    expect(logistics.pageId).toBe(boltPage);
    expect(acme.text).toContain(approved);
    expect(acme.text).not.toContain("Bolt only text");
    expect(logistics.text).toContain("Bolt only text");
    expect(logistics.text).not.toContain(approved);
    expect(await openPath(viewer, "ops", "onboarding-runbook", boltWs)).toEqual({ kind: "missing" });
    expect(await openPath(bolt, "ops", "onboarding-runbook", ws)).toEqual({ kind: "missing" });
    const crossed = await http(viewer, "ops", "onboarding-runbook", boltWs);
    expect(crossed).toMatchObject({ status: 404, location: null, body: PUBLISHED_NOT_FOUND });
  });

  it("HS-AC-N43-02 keeps draft edits off the stable URL until republish", async () => {
    await save(editor, pageId, draftSentence);
    const reader = await openPath(viewer, "ops", "onboarding-runbook");
    const draft = await draftPublication(r, editor, pageId);
    const hidden = await draftPublication(r, viewer, pageId);
    expect(reader.kind).toBe("published");
    if (reader.kind !== "published") return;
    expect(reader.text).toContain(approved);
    expect(JSON.stringify(reader)).not.toContain(draftSentence);
    expect(draft.unpublishedChanges).toBe(true);
    expect(draft.diff.lines.some(line => line.kind === "added" && line.text.includes(draftSentence))).toBe(true);
    expect(hidden.unpublishedChanges).toBe(false);
    expect(JSON.stringify(hidden)).not.toContain(draftSentence);
    await save(editor, pageId, second);
    const next = await changePublishedPage(r, owner, pageId, { action: "republish", operationId: crypto.randomUUID(), note: "Second publication", freezeValues: false });
    expect(next).toMatchObject({ versionNo: 2, replayed: false });
    const updated = await openPath(viewer, "ops", "onboarding-runbook");
    if (updated.kind !== "published") throw new Error("expected v2");
    expect(updated.stablePath).toBe("/s/ops/onboarding-runbook");
    expect(updated.versionNo).toBe(2);
    expect(updated.text).toContain(second);
    expect(updated.text).not.toContain(draftSentence);
    expect((await draftPublication(r, editor, pageId)).unpublishedChanges).toBe(false);
  });

  it("HS-AC-N43-06 keeps record cards live unless values are frozen for fields the reader can see", async () => {
    const live = await openPath(viewer, "ops", "onboarding-runbook");
    if (live.kind !== "published") throw new Error("expected live publication");
    const job = live.records[0]?.fields.find(field => field.key === "core:job-title");
    const email = live.records[0]?.fields.find(field => field.key === "core:email");
    expect(job).toMatchObject({ access: "visible", value: "Nurse" });
    expect(email).toMatchObject({ access: "hidden" });
    expect(JSON.stringify(live.records)).not.toContain("secret@acme.test");
    await db.query("UPDATE hs_data_records SET field_values = field_values || $2::jsonb WHERE id=$1", [record, JSON.stringify({ "core:job-title": "Surgeon" })]);
    const changed = await openPath(viewer, "ops", "onboarding-runbook");
    if (changed.kind !== "published") throw new Error("expected live update");
    expect(changed.records[0]?.fields.find(field => field.key === "core:job-title")?.value).toBe("Surgeon");
    expect(changed.records[0]?.valuesAsOf).toBeNull();
    await changePublishedPage(r, owner, pageId, { action: "republish", operationId: crypto.randomUUID(), note: "Freeze values", freezeValues: true });
    await db.query("UPDATE hs_data_records SET field_values = field_values || $2::jsonb WHERE id=$1", [record, JSON.stringify({ "core:job-title": "Intern", "core:email": "later@acme.test" })]);
    const frozen = await openPath(viewer, "ops", "onboarding-runbook");
    if (frozen.kind !== "published") throw new Error("expected frozen publication");
    expect(frozen.records[0]?.fields.find(field => field.key === "core:job-title")?.value).toBe("Surgeon");
    expect(frozen.records[0]?.fields.find(field => field.key === "core:email")).toMatchObject({ access: "hidden" });
    expect(frozen.records[0]?.valuesAsOf).toMatch(/^Values as of .+ IST$/);
    expect(JSON.stringify(frozen.records)).not.toContain("later@acme.test");
    expect(JSON.stringify(frozen.records)).not.toContain("secret@acme.test");
    const stored = (await db.query<{ freeze_values: { blocks: { fields: Record<string, string> }[] } }>("SELECT freeze_values FROM hs_published_versions WHERE page_id=$1 AND version_no=3", [pageId])).rows[0].freeze_values;
    expect(stored.blocks[0].fields["core:email"]).toBe("secret@acme.test");
    expect(stored.blocks[0].fields["core:job-title"]).toBe("Surgeon");
  });

  it("HS-AC-N43-03 enforces slug rules and keeps old URLs redirecting", async () => {
    await expect(changePublishedPage(r, editor, pageId, { action: "rename", operationId: crypto.randomUUID(), slug: "new-joiner-runbook" })).rejects.toMatchObject({ code: "stable_url_owner_required", status: 403 });
    await expect(changePublishedPage(r, owner, spareId, { action: "publish", operationId: crypto.randomUUID(), slug: "No", note: "Bad", freezeValues: false })).rejects.toMatchObject({ code: "slug_invalid" });
    await expect(changePublishedPage(r, owner, spareId, { action: "publish", operationId: crypto.randomUUID(), slug: "onboarding-runbook", note: "Duplicate", freezeValues: false })).rejects.toMatchObject({ code: "slug_taken" });
    await save(owner, pageId, third);
    await changePublishedPage(r, owner, pageId, { action: "republish", operationId: crypto.randomUUID(), note: "Third publication", freezeValues: false });
    await changePublishedPage(r, owner, pageId, { action: "rename", operationId: crypto.randomUUID(), slug: "new-joiner-runbook" });
    const renamed = await http(owner, "ops", "onboarding-runbook", ws);
    expect(renamed.status).toBe(301);
    expect(renamed.location && new URL(renamed.location).pathname).toBe("/s/ops/new-joiner-runbook");
    expect(renamed.body).toBeNull();
    const preview = await previewPageLocation(r, owner, pageId, { spaceId: open, parentId: null, index: 0 });
    await movePageTree(r, owner, pageId, { spaceId: open, parentId: null, index: 0, operationId: crypto.randomUUID(), expectedTreeVersion: preview.treeVersion, previewDigest: preview.digest, confirmExpanded: true });
    const hiddenOld = await http(outsider, "ops", "onboarding-runbook", ws);
    expect(hiddenOld.status).toBe(404);
    expect(hiddenOld.location).toBeNull();
    expect(hiddenOld.body).toEqual(PUBLISHED_NOT_FOUND);
    for (const slug of ["onboarding-runbook", "new-joiner-runbook"]) {
      const old = await http(viewer, "ops", slug, ws);
      expect(old.status).toBe(301);
      expect(old.location && new URL(old.location).pathname).toBe("/s/open/new-joiner-runbook");
    }
    const pinned = await http(owner, "ops", "onboarding-runbook@v1", ws);
    expect(pinned.status).toBe(301);
    expect(pinned.location && new URL(pinned.location).pathname).toBe("/s/open/new-joiner-runbook@v1");
    const current = await openPath(viewer, "open", "new-joiner-runbook", ws);
    if (current.kind !== "published") throw new Error("expected moved page");
    expect(current.pageId).toBe(pageId);
    expect(current.canonicalPath).toBe(`/p/${encodeURIComponent(pageId)}`);
    expect((await db.query("SELECT page_slug FROM hs_slug_redirects WHERE page_id=$1", [pageId])).rows.length).toBeGreaterThanOrEqual(2);
    const direct = publishedRedirectResponse(new Request("https://holy.example/s/ops/onboarding-runbook?workspace=ws-holy88"), "/s/open/new-joiner-runbook");
    expect(direct.status).toBe(301);
    expect(direct.headers.get("location")).toBe("https://holy.example/s/open/new-joiner-runbook?workspace=ws-holy88");
  });

  it("HS-AC-N43-04 lists versions and pins an older URL", async () => {
    const latest = await openPath(viewer, "open", "new-joiner-runbook", ws);
    if (latest.kind !== "published") throw new Error("expected latest");
    expect(latest.versions.map(version => version.versionNo)).toEqual([1, 2, 3, 4]);
    expect(latest.versions[0]).toMatchObject({ publisher: "U-OWN", note: "Initial publication" });
    expect(latest.versions[0].publishedAtIst).toMatch(/ IST$/);
    expect(latest.notLatestBanner).toBeNull();
    const pinned = await openPath(owner, "open", "new-joiner-runbook@v1", ws);
    if (pinned.kind !== "published") throw new Error("expected v1");
    expect(pinned.versionNo).toBe(1);
    expect(pinned.text).toContain(approved);
    expect(pinned.text).not.toContain(third);
    expect(pinned.notLatestBanner).toBe(NOT_LATEST_BANNER);
    expect(pinned.latestPath).toBe("/s/open/new-joiner-runbook");
  });

  it("HS-AC-N43-05 unpublishes for readers and restores the same URL", async () => {
    await changePublishedPage(r, owner, pageId, { action: "unpublish", operationId: crypto.randomUUID(), reason: "Superseded by handbook" });
    const reader = await openPath(viewer, "open", "new-joiner-runbook", ws);
    const stranger = await openPath(outsider, "open", "new-joiner-runbook", ws);
    const missing = await openPath(outsider, "ops", "no-such-page", ws);
    expect(reader).toMatchObject({ kind: "unpublished" });
    expect(stranger).toEqual(missing);
    expect(JSON.stringify(reader)).not.toContain(third);
    expect(JSON.stringify(reader)).not.toContain("Superseded by handbook");
    const history = await draftPublication(r, owner, pageId);
    expect(history.versions.map(version => version.versionNo)).toEqual([1, 2, 3, 4]);
    expect(history.unpublishReason).toBe("Superseded by handbook");
    expect((await draftPublication(r, viewer, pageId)).versions).toEqual([]);
    const audits = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='published-page.unpublish' AND page_id=$1", [pageId])).rows);
    expect(audits).not.toContain("Superseded by handbook");
    await changePublishedPage(r, owner, pageId, { action: "republish", operationId: crypto.randomUUID(), note: "Restored publication", freezeValues: false });
    const restored = await openPath(viewer, "open", "new-joiner-runbook", ws);
    if (restored.kind !== "published") throw new Error("expected restored URL");
    expect(restored.stablePath).toBe("/s/open/new-joiner-runbook");
    expect(restored.versionNo).toBe(5);
    expect(restored.text).toContain(third);
  });

  it("HS-AC-N43-07 returns one generic not-found for hidden, missing and unknown spaces", async () => {
    await publish(secretId, "board-minutes", "Minutes", false);
    const hidden = await http(outsider, "ops", "board-minutes", ws);
    const absent = await http(outsider, "ops", "no-such-page", ws);
    const secret = await http(outsider, "secret-space", "x", ws);
    expect(hidden).toEqual(absent);
    expect(absent).toEqual(secret);
    expect(hidden.status).toBe(404);
    expect(hidden.location).toBeNull();
    expect(hidden.body).toEqual(PUBLISHED_NOT_FOUND);
    expect(JSON.stringify(hidden)).not.toContain("Board minutes");
    expect(JSON.stringify(hidden)).not.toContain("Secret minutes");
    expect(JSON.stringify(hidden)).not.toContain("board-minutes");
    const meta = [await openPath(outsider, "ops", "board-minutes", ws), await openPath(outsider, "ops", "no-such-page", ws), await openPath(outsider, "secret-space", "x", ws)].map(denyMeta);
    expect(meta[0]).toEqual(meta[1]);
    expect(meta[1]).toEqual(meta[2]);
    expect(meta[0]).toEqual({ kind: "missing", title: PUBLISHED_NOT_FOUND_TITLE, openGraph: null });
    expect(meta[0].title).not.toContain("Board");
  });

  it("HS-AC-N43-08 clears a revoked reader on the next read", async () => {
    const before = await openPath(viewer, "open", "new-joiner-runbook", ws);
    expect(before.kind).toBe("published");
    await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2", [pageId, viewer.id]);
    const revoked = await openPath(viewer, "open", "new-joiner-runbook", ws);
    const control = await openPath(viewer, "ops", "no-such-page", ws);
    expect(revoked).toEqual(control);
    expect(revoked).toEqual({ kind: "missing" });
    await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')", [pageId, viewer.id]);
    expect((await openPath(viewer, "open", "new-joiner-runbook", ws)).kind).toBe("published");
  });

  it("HS-AC-N43-09 hides a trashed page and restores the same URL", async () => {
    const preview = await previewPageDeletion(r, owner, ws, pageId);
    await deletePageTree(r, owner, ws, pageId, { operationId: crypto.randomUUID(), expectedTreeVersion: preview.treeVersion, previewDigest: preview.digest });
    const reader = await openPath(viewer, "open", "new-joiner-runbook", ws);
    const control = await openPath(viewer, "ops", "no-such-page", ws);
    const ownerView = await openPath(owner, "open", "new-joiner-runbook", ws);
    expect(reader).toEqual(control);
    expect(ownerView).toMatchObject({ kind: "trashed", pageId });
    expect(JSON.stringify(reader)).not.toContain(third);
    const response = await http(owner, "open", "new-joiner-runbook", ws);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ kind: "trashed" });
    const { POST } = await import("../app/api/v1/published/[space]/[slug]/route");
    const restored = await POST(new Request("https://holy.example/api/v1/published/open/new-joiner-runbook?workspace=ws-holy88", { method: "POST", headers: { "x-test-actor": owner.id, origin: "https://holy.example", "content-type": "application/json" }, body: JSON.stringify({ action: "restore", operationId: crypto.randomUUID() }) }), { params: Promise.resolve({ space: "open", slug: "new-joiner-runbook" }) });
    expect(restored.status).toBe(200);
    const again = await openPath(viewer, "open", "new-joiner-runbook", ws);
    if (again.kind !== "published") throw new Error("expected restored publication");
    expect(again.stablePath).toBe("/s/open/new-joiner-runbook");
    expect(again.text).toContain(third);
    expect(again.versionNo).toBe(5);
  });

  it("keeps the unpublished and trash copy exact", () => {
    expect(UNPUBLISHED_MESSAGE).toBe("This page is no longer published");
    expect(TRASH_MESSAGE).toBe("In trash — Restore");
    expect(UNPUBLISHED_CHANGES).toBe("Unpublished changes");
    expect(NOT_LATEST_BANNER).toBe("This is not the latest version");
  });
});
