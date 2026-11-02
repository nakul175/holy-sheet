import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { DocumentError, ensureIds } from "./document";
import { resolvePublishedPage } from "./published-pages";
import { readSpaceHome } from "./space-home";
import { Repository } from "./repository";
import {
  archiveSpace,
  joinSpace,
  listSpaceDirectory,
  previewSpaceMigration,
  readSpaceBySlug,
  requestSpaceAccess,
  resolveSpacePage,
  setSpaceVisibility,
  startSpaceMigration,
  stepSpaceMigration,
  type MigrationJob,
} from "./space-directory";
import { workspaceSearch } from "./workspace-search";
import { changeWorkspaceMember, previewMemberChange } from "./workspace-administration";

let db: Database;
let r: Repository;
const admin: Actor = { id: "n47-admin", name: "U-ADM" };
const owner: Actor = { id: "n47-owner", name: "U-OWN" };
const editor: Actor = { id: "n47-editor", name: "U-ED" };
const viewer: Actor = { id: "n47-viewer", name: "U-VI" };
const bolt: Actor = { id: "n47-bolt", name: "U-B" };
const ws = "ws-n47-a";
const boltWs = "ws-n47-b";
const secretName = "SECRET_SPACE_TOKEN";
let openSpace = "";
let discoverable = "";
let memberPrivate = "";
let secret = "";
let archiveSpaceId = "";
let sourceSpace = "";
let boltSpace = "";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const user of [admin, owner, editor, viewer, bolt]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES($1,'Acme Health'),($2,'Bolt Logistics')", [ws, boltWs]);
  await db.query(
    "INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'admin'),($1,$3,'owner'),($1,$4,'member'),($1,$5,'member'),($6,$7,'member')",
    [ws, admin.id, owner.id, editor.id, viewer.id, boltWs, bolt.id],
  );
  openSpace = (await r.createSpace(admin, "SP-OPEN", ws)).id;
  discoverable = (await r.createSpace(admin, "SP-DISC", ws)).id;
  memberPrivate = (await r.createSpace(admin, "SP-PRIV", ws)).id;
  secret = (await r.createSpace(admin, secretName, ws)).id;
  archiveSpaceId = (await r.createSpace(admin, "SP-ARCH", ws)).id;
  sourceSpace = (await r.createSpace(admin, "SP-OPS", ws)).id;
  boltSpace = (await r.createSpace(bolt, "SP-BOLT", boltWs)).id;
  await setSpaceVisibility(r, admin, ws, openSpace, "open", crypto.randomUUID());
  await setSpaceVisibility(r, admin, ws, discoverable, "discoverable", crypto.randomUUID());
  await setSpaceVisibility(r, admin, ws, memberPrivate, "private", crypto.randomUUID());
  await setSpaceVisibility(r, admin, ws, secret, "private", crypto.randomUUID());
  await setSpaceVisibility(r, admin, ws, sourceSpace, "open", crypto.randomUUID());
  await db.query("UPDATE hs_spaces SET slug = 'secret' WHERE id = $1", [secret]);
  await db.query("INSERT INTO hs_space_members(space_id, user_id, role, granted_by) VALUES($1,$2,'viewer',$3),($4,$2,'viewer',$3)", [memberPrivate, viewer.id, admin.id, archiveSpaceId]);
}, 30000);

afterAll(async () => { await db.close(); });

function shape(error: unknown) {
  expect(error).toBeInstanceOf(DocumentError);
  const caught = error as DocumentError;
  return { status: caught.status, code: caught.code, message: caught.message };
}

async function fail(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected failure");
}

it("lists open spaces and memberships, offers request access, and hides private spaces", async () => {
  const directory = await listSpaceDirectory(r, viewer, ws);
  const names = directory.spaces.map(space => space.name);
  expect(names).toContain("SP-OPEN");
  expect(names).toContain("SP-DISC");
  expect(names).toContain("SP-PRIV");
  expect(names).not.toContain(secretName);
  expect(JSON.stringify(directory)).not.toContain(secret);
  expect(directory.spaces.find(space => space.name === "SP-OPEN")?.action).toBe("join");
  expect(directory.spaces.find(space => space.name === "SP-DISC")?.action).toBe("request");
  expect(directory.spaces.find(space => space.name === "SP-PRIV")?.action).toBe("open");
  const joined = await joinSpace(r, viewer, ws, openSpace, crypto.randomUUID());
  expect(joined.action).toBe("open");
  expect((await listSpaceDirectory(r, viewer, ws)).spaces.find(space => space.id === openSpace)?.action).toBe("open");
  const requested = await requestSpaceAccess(r, viewer, ws, discoverable, crypto.randomUUID());
  expect(requested.requestPending).toBe(true);
  expect((await listSpaceDirectory(r, viewer, ws)).spaces.find(space => space.id === discoverable)?.requestPending).toBe(true);
  const hiddenSlug = await fail(() => readSpaceBySlug(r, viewer, "secret", ws));
  const missingSlug = await fail(() => readSpaceBySlug(r, viewer, "missing-slug", ws));
  const hiddenJoin = await fail(() => joinSpace(r, viewer, ws, secret, crypto.randomUUID()));
  const missingJoin = await fail(() => joinSpace(r, viewer, ws, crypto.randomUUID(), crypto.randomUUID()));
  expect(shape(hiddenSlug)).toEqual(shape(missingSlug));
  expect(shape(hiddenJoin)).toEqual(shape(missingJoin));
  expect(JSON.stringify(shape(hiddenSlug))).not.toContain(secretName);
  const listed = await r.spaces(viewer);
  expect(listed.some(space => space.id === secret)).toBe(false);
  const audits = JSON.stringify((await db.query("SELECT action, after_value FROM hs_audit WHERE action IN ('space.join','space.request-access','space.visibility')")).rows);
  expect(audits).toContain("atIst");
  expect(audits).not.toContain(secretName);
});

it("archives a space read-only, drops it from search, and restores it", async () => {
  const page = await r.create(admin, "N47archivedneedle", archiveSpaceId);
  const operationId = crypto.randomUUID();
  const archived = await archiveSpace(r, admin, ws, archiveSpaceId, operationId, true);
  expect(archived.archived).toBe(true);
  expect(archived.archivedAtIst).toContain("IST");
  expect((await archiveSpace(r, admin, ws, archiveSpaceId, operationId, true)).replayed).toBe(true);
  expect((await db.query("SELECT id FROM hs_audit WHERE correlation_id = $1 AND action = 'space.archive'", [operationId])).rows).toHaveLength(1);
  const home = await readSpaceHome(r, viewer, ws, archiveSpaceId);
  expect(home.archived).toBe(true);
  expect(home.canManage).toBe(false);
  await expect(r.save(page.id, admin, { operationId: crypto.randomUUID(), baseVersion: page.version, title: page.title, document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "edit" }] }] }) })).rejects.toMatchObject({ code: "read_only", status: 403 });
  expect((await listSpaceDirectory(r, viewer, ws)).spaces.some(space => space.id === archiveSpaceId)).toBe(false);
  expect((await listSpaceDirectory(r, viewer, ws, true)).spaces.find(space => space.id === archiveSpaceId)?.archived).toBe(true);
  expect((await workspaceSearch(r, admin, { query: "N47archivedneedle", workspaceId: ws })).results.some(result => result.id === page.id)).toBe(false);
  expect((await workspaceSearch(r, admin, { query: "N47archivedneedle", workspaceId: ws, includeArchived: true })).results.some(result => result.id === page.id)).toBe(true);
  const restored = await archiveSpace(r, admin, ws, archiveSpaceId, crypto.randomUUID(), false);
  expect(restored.archived).toBe(false);
  const current = await r.get(page.id, admin);
  await r.save(page.id, admin, { operationId: crypto.randomUUID(), baseVersion: current.version, title: current.title, document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "restored" }] }] }) });
  expect((await workspaceSearch(r, admin, { query: "N47archivedneedle", workspaceId: ws })).results.some(result => result.id === page.id)).toBe(true);
  expect((await readSpaceHome(r, viewer, ws, archiveSpaceId)).archived).toBe(false);
});

async function tree(title: string) {
  const sourceParent = await r.create(owner, `${title} source`, sourceSpace);
  const root = await r.create(owner, title, sourceSpace, sourceParent.id);
  const child = await r.create(owner, `${title} child`, sourceSpace, root.id);
  const trashed = await r.create(owner, `${title} trash`, sourceSpace, root.id);
  const outside = await r.create(owner, `${title} outside`, sourceSpace);
  const destination = await r.create(owner, `${title} destination`, openSpace);
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer'),($3,$4,'editor')", [sourceParent.id, viewer.id, destination.id, editor.id]);
  const saved = await r.save(root.id, owner, {
    operationId: crypto.randomUUID(),
    baseVersion: root.version,
    title,
    document: ensureIds({ type: "doc", content: [{ type: "pageLink", attrs: { pageId: outside.id } }, { type: "pageLink", attrs: { pageId: child.id } }] }),
  });
  await db.query("UPDATE hs_pages SET deleted_at = clock_timestamp() WHERE id = $1 OR id = $2", [trashed.id, outside.id]);
  return { root: saved.page, child, trashed, destination, outside };
}

async function runJob(previewDigest: string, rootPageId: string, parentId: string) {
  let job = await startSpaceMigration(r, admin, ws, { rootPageId, targetSpaceId: openSpace, parentId, operationId: crypto.randomUUID(), previewDigest, confirmAccess: true });
  let guard = 0;
  while (job.status === "running" && guard < 20) {
    guard += 1;
    job = await stepSpaceMigration(r, admin, ws, { jobId: job.jobId, operationId: crypto.randomUUID() });
  }
  return job;
}

it("previews access changes and moves a page tree with redirects, keeping trash trashed", async () => {
  const pages = await tree("P-100");
  await db.query("UPDATE hs_spaces SET slug = 'ops-n47' WHERE id = $1", [sourceSpace]);
  await db.query("UPDATE hs_spaces SET slug = 'open-n47' WHERE id = $1", [openSpace]);
  await db.query("INSERT INTO hs_page_slugs(space_id, slug, page_id, active) VALUES($1,'page-100',$2,true)", [sourceSpace, pages.root.id]);
  await db.query("INSERT INTO hs_page_publication_state(page_id, live) VALUES($1,true)", [pages.root.id]);
  const preview = await previewSpaceMigration(r, admin, ws, { rootPageId: pages.root.id, targetSpaceId: openSpace, parentId: pages.destination.id });
  expect(preview.pageCount).toBe(3);
  expect(preview.trashedCount).toBe(1);
  expect(preview.brokenReferences).toBe(1);
  expect(preview.redirectCount).toBe(3);
  expect(preview.gains.map(person => person.userId)).toContain(editor.id);
  expect(preview.loses.map(person => person.userId)).toContain(viewer.id);
  const finished = await runJob(preview.digest, pages.root.id, pages.destination.id);
  expect(finished.status).toBe("completed");
  expect(finished.movedPageIds).toHaveLength(3);
  const moved = await db.query<{ space_id: string; deleted_at: string | null; parent_id: string | null }>("SELECT space_id, deleted_at, parent_id FROM hs_pages WHERE id = $1", [pages.trashed.id]);
  expect(moved.rows[0].space_id).toBe(openSpace);
  expect(moved.rows[0].deleted_at).toBeTruthy();
  expect((await db.query("SELECT to_space_id FROM hs_space_page_redirects WHERE workspace_id = $1 AND page_id = $2 AND from_space_id = $3", [ws, pages.root.id, sourceSpace])).rows[0].to_space_id).toBe(openSpace);
  const resolved = await resolveSpacePage(r, admin, ws, sourceSpace, pages.root.id);
  expect(resolved.redirect).toBe(true);
  expect(resolved.location).toBe(`/pages/${encodeURIComponent(pages.root.id)}`);
  const published = await resolvePublishedPage(r, admin, { workspaceId: ws, spaceSlug: "ops-n47", pageSlug: "page-100" });
  expect(published).toMatchObject({ kind: "redirect", location: "/s/open-n47/page-100" });
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action LIKE 'space.migration.%'")).rows);
  expect(audit).toContain("atIst");
  expect(audit).not.toContain("P-100");
  expect(audit).not.toContain("SECRET");
});

it("halts a running migration when admin authority is removed and can resume later", async () => {
  const sourceParent = await r.create(owner, "Revoke source", sourceSpace);
  const root = await r.create(owner, "Revoke root", sourceSpace, sourceParent.id);
  const child = await r.create(owner, "Revoke child", sourceSpace, root.id);
  const destination = await r.create(owner, "Revoke destination", openSpace);
  const preview = await previewSpaceMigration(r, admin, ws, { rootPageId: root.id, targetSpaceId: openSpace, parentId: destination.id });
  const started = await startSpaceMigration(r, admin, ws, { rootPageId: root.id, targetSpaceId: openSpace, parentId: destination.id, operationId: crypto.randomUUID(), previewDigest: preview.digest, confirmAccess: true });
  const first = await stepSpaceMigration(r, admin, ws, { jobId: started.jobId, operationId: crypto.randomUUID() });
  expect(first.movedPageIds).toEqual([root.id]);
  const demotion = await previewMemberChange(r, owner, ws, { subjectId: admin.id, role: "member", active: true });
  await changeWorkspaceMember(r, owner, ws, { subjectId: admin.id, role: "member", active: true, operationId: crypto.randomUUID(), expectedVersion: demotion.version, previewDigest: demotion.digest });
  const halted = await stepSpaceMigration(r, admin, ws, { jobId: started.jobId, operationId: crypto.randomUUID() });
  expect(halted.status).toBe("halted");
  expect(halted.haltReason).toBe("authority_revoked");
  expect(halted.movedPageIds).toEqual([root.id]);
  expect(halted.remainingPageIds).toEqual([child.id]);
  expect((await db.query<{ space_id: string }>("SELECT space_id FROM hs_pages WHERE id = $1", [child.id])).rows[0].space_id).toBe(sourceSpace);
  expect((await db.query<{ space_id: string }>("SELECT space_id FROM hs_pages WHERE id = $1", [root.id])).rows[0].space_id).toBe(openSpace);
  const promotion = await previewMemberChange(r, owner, ws, { subjectId: admin.id, role: "admin", active: true });
  await changeWorkspaceMember(r, owner, ws, { subjectId: admin.id, role: "admin", active: true, operationId: crypto.randomUUID(), expectedVersion: promotion.version, previewDigest: promotion.digest });
  const resumed = await stepSpaceMigration(r, admin, ws, { jobId: started.jobId, operationId: crypto.randomUUID(), resume: true });
  expect(resumed.status).toBe("completed");
  expect(resumed.remainingPageIds).toEqual([]);
  expect(resumed.movedPageIds).toEqual([root.id, child.id]);
});

it("rejects a cross-tenant destination with the same response as an unknown space", async () => {
  const root = await r.create(owner, "Cross root", sourceSpace);
  const foreign = await fail(() => previewSpaceMigration(r, admin, ws, { rootPageId: root.id, targetSpaceId: boltSpace }));
  const unknown = await fail(() => previewSpaceMigration(r, admin, ws, { rootPageId: root.id, targetSpaceId: crypto.randomUUID() }));
  const otherWorkspace = await fail(() => previewSpaceMigration(r, admin, boltWs, { rootPageId: root.id, targetSpaceId: openSpace }));
  const missingWorkspace = await fail(() => previewSpaceMigration(r, admin, crypto.randomUUID(), { rootPageId: root.id, targetSpaceId: openSpace }));
  expect(shape(foreign)).toEqual(shape(unknown));
  expect(shape(otherWorkspace)).toEqual(shape(missingWorkspace));
  expect(JSON.stringify(shape(foreign))).not.toContain("Bolt");
  expect(JSON.stringify(shape(foreign))).not.toContain(boltSpace);
  const job = await fail(() => stepSpaceMigration(r, admin, ws, { jobId: crypto.randomUUID(), operationId: crypto.randomUUID() }));
  const missingJob = job as DocumentError;
  expect(missingJob.status).toBe(404);
  expect(missingJob.code).toBe("not_found");
  void (undefined as unknown as MigrationJob);
});
