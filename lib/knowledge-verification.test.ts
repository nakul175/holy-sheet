import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { renderRoleInterface } from "./role-interface";
import { Repository } from "./repository";
import {
  applyKnowledgeVerification,
  downloadKnowledgeVerification,
  grantKnowledgeSteward,
  knowledgeVerificationCatalogue,
  knowledgeVerificationHistory,
  knowledgeVerificationSourcePreview,
  previewKnowledgeVerification,
  projectKnowledgeVerification,
  readKnowledgeBadge,
  reportKnowledgeConcern,
  saveKnowledgeVerificationFieldPolicy,
  saveKnowledgeVerificationPolicy,
  searchKnowledgeVerification,
  setKnowledgeVerificationActions,
  stashKnowledgeVerification,
} from "./knowledge-verification";

let db: Database;
let r: Repository;
const steward = { id: "verification-steward", name: "Ada Steward" };
const reader = { id: "verification-reader", name: "Rae Reader" };
const editor = { id: "verification-editor", name: "Eve Editor" };
const outsider = { id: "verification-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const scheduleId = "00000000-0000-4000-8000-00000000e201";
let tenant = "";
let visible = "";
let secret = "";
let sourceRecord = "";
let pageId = "";
let sourcePage = "";
let secretPage = "";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [steward, reader, editor, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'member')", [workspace, steward.id, reader.id, editor.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  const other = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Synthetic Clinic'),($2,'Bolt')", [tenant, other]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, other]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'organisations','Organisations',true),($1,'accounts','Accounts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'accounts',$3)", [tenant, owner.id, ["view", "edit", "export", "history"]]);
  visible = await record("Visible clinic", { "core:notes": "original hours", "source:dossier": "file-a", "core:salary": "hidden-salary" });
  secret = await record("zzsecretrecord", { "core:notes": "secret hours" });
  sourceRecord = await record("Source clinic", { "core:notes": "stable", "source:dossier": "file-a" });
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, parent_organisation_id, created_by, updated_by) VALUES($1,$2,'accounts','Synthetic account',$3,$4,$4)", [randomUUID(), tenant, visible, owner.id]);
  const view = ["view"];
  const edit = ["view", "edit", "export", "history"];
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4),($1,$2,$5,$6),($1,$2,$7,$8),($1,$9,$3,$4),($1,$9,$5,$6),($1,$9,$7,$8)", [tenant, visible, steward.id, view, reader.id, view, editor.id, edit, sourceRecord]);
  pageId = await page("Clinic handbook");
  sourcePage = await page("Source handbook");
  secretPage = (await r.create(owner, "Secret handbook", "space-product")).id;
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer'),($1,$3,'viewer'),($1,$4,'editor'),($5,$2,'viewer'),($5,$3,'viewer'),($5,$4,'editor')", [pageId, steward.id, reader.id, editor.id, sourcePage]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
  await saveKnowledgeVerificationPolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, bases: ["source-reviewed", "owner-confirmed", "steward-attested"], defaultExpiryDays: 90 });
  await grantKnowledgeSteward(r, owner, workspace, { operationId: randomUUID(), userId: steward.id });
});
afterAll(async () => db.close());

async function record(name: string, fields: Record<string, unknown>) {
  const id = randomUUID();
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, created_by, updated_by, field_values) VALUES($1,$2,'organisations',$3,$4,$4,$5)", [id, tenant, name, owner.id, JSON.stringify(fields)]);
  return id;
}
function handbook(text: string, source = "welcome") {
  return { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text }] }, { type: "pageLink", attrs: { id: "l1", pageId: source } }] };
}
async function page(title: string) {
  const created = await r.create(owner, title, "space-product");
  await addRevision(created.id, title, handbook("Clinic hours"));
  return created.id;
}
async function addRevision(id: string, title: string, document: unknown) {
  const current = await db.query<{ version: number | string }>("SELECT COALESCE(MAX(version),0) AS version FROM hs_revisions WHERE page_id=$1", [id]);
  const version = Number(current.rows[0].version) + 1;
  await db.query("INSERT INTO hs_revisions(page_id, version, title, document, actor_id, source_surface, schema_version) VALUES($1,$2,$3,$4,$5,'api',2)", [id, version, title, JSON.stringify(document), owner.id]);
  const next = await db.query<{ n: number | string }>("SELECT COALESCE(MAX(version_no),0)+1 AS n FROM hs_published_versions WHERE page_id=$1", [id]);
  await db.query("INSERT INTO hs_published_versions(id, page_id, version_no, revision_id, revision_version, published_by, note) VALUES($1,$2,$3,$4,$5,$6,'Synthetic publication')", [randomUUID(), id, Number(next.rows[0].n), `rev-${version}-${id.slice(0, 8)}`, version, owner.id]);
  await db.query("INSERT INTO hs_page_publication_state(page_id, live) VALUES($1, true) ON CONFLICT (page_id) DO UPDATE SET live=true, unpublished_at=NULL", [id]);
  return version;
}
async function verify(actor: { id: string }, kind: "page" | "record", id: string, expiryDays = 90, expectedVersion = 0) {
  const preview = await previewKnowledgeVerification(r, actor, workspace, {
    operationId: randomUUID(), kind: "verify", expectedVersion, targetKind: kind, targetId: id, ownerId: owner.id,
    basis: "source-reviewed", basisNote: "Synthetic source was read for this revision.", expiryDays,
  });
  return applyKnowledgeVerification(r, actor, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion });
}
async function grants() {
  const [records, collections, fields, parents, schedules] = await Promise.all([
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT field_key, user_id, can_view FROM hs_data_field_permissions ORDER BY 1,2"),
    db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records WHERE collection='accounts' ORDER BY 1"),
    db.query("SELECT id::text, definition FROM hs_data_periodic_review_schedules ORDER BY 1"),
  ]);
  return JSON.stringify({ records: records.rows, collections: collections.rows, fields: fields.rows, parents: parents.rows, schedules: schedules.rows });
}
function statements(sql: string) {
  const parts: string[] = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if ((line.split("$$").length - 1) % 2 === 1) dollar = !dollar;
    if (!dollar && line.trim().endsWith(";")) {
      if (current.replace(/^\s*--.*$/gm, "").trim()) parts.push(current.trim());
      current = "";
    }
  }
  return parts;
}

it("verifies a published page and record with owner, basis, and a 1–365 day expiry", async () => {
  const pageBadge = await verify(steward, "page", pageId);
  const recordBadge = await verify(steward, "record", visible, 365);
  expect(pageBadge).toMatchObject({ status: "current", label: "Verified", ownerId: owner.id, basis: "source-reviewed", expiryDays: 90, titleOnlyPolicy: "preserve", targetKind: "page" });
  expect(pageBadge.statement).toContain("Not a legal certification");
  expect(recordBadge).toMatchObject({ status: "current", expiryDays: 365, targetKind: "record", title: "Visible clinic" });
  await expect(previewKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), kind: "verify", expectedVersion: 0, targetKind: "record", targetId: visible, ownerId: owner.id, basis: "source-reviewed", basisNote: "Again", expiryDays: 0 })).rejects.toMatchObject({ code: "knowledge_verification_expiry" });
  await expect(previewKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), kind: "verify", expectedVersion: 0, targetKind: "record", targetId: visible, ownerId: owner.id, basis: "source-reviewed", basisNote: "Again", expiryDays: 400 })).rejects.toMatchObject({ code: "knowledge_verification_expiry" });
  await expect(previewKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), kind: "verify", expectedVersion: 0, targetKind: "page", targetId: secretPage, ownerId: owner.id, basis: "source-reviewed", basisNote: "Hidden", expiryDays: 30 })).rejects.toMatchObject({ code: "not_found" });
  await expect(previewKnowledgeVerification(r, reader, workspace, { operationId: randomUUID(), kind: "verify", expectedVersion: 0, targetKind: "record", targetId: visible, ownerId: owner.id, basis: "source-reviewed", basisNote: "Not a steward", expiryDays: 30 })).rejects.toMatchObject({ code: "knowledge_verification_authority" });
  await expect(previewKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), kind: "verify", expectedVersion: 0, targetKind: "record", targetId: secret, ownerId: owner.id, basis: "source-reviewed", basisNote: "No grant", expiryDays: 30 })).rejects.toMatchObject({ code: "not_found" });
  const operationId = randomUUID();
  const preview = await previewKnowledgeVerification(r, owner, workspace, { operationId, kind: "verify", expectedVersion: 0, targetKind: "record", targetId: secret, ownerId: owner.id, basis: "owner-confirmed", basisNote: "Owner can see this record.", expiryDays: 10 });
  const applyId = randomUUID();
  const first = await applyKnowledgeVerification(r, owner, workspace, { operationId: applyId, previewId: preview.previewId, expectedVersion: 0 });
  const duplicate = await applyKnowledgeVerification(r, owner, workspace, { operationId: applyId, previewId: preview.previewId, expectedVersion: 0 });
  expect(duplicate).toMatchObject({ replayed: true, id: first.id });
  await expect(applyKnowledgeVerification(r, owner, workspace, { operationId: applyId, previewId: preview.previewId, expectedVersion: 4 })).rejects.toMatchObject({ code: "operation_mismatch" });
  const rows = await db.query("SELECT count(*)::int AS n FROM hs_knowledge_verification_badges WHERE target_id=$1", [secret]);
  expect(rows.rows[0].n).toBe(1);
});

it("marks content and source changes stale and keeps a title-only change current", async () => {
  const pageBadge = await readKnowledgeBadge(r, reader, workspace, (await searchKnowledgeVerification(r, reader, workspace, "handbook")).results.find(item => item.targetId === pageId)!.id);
  expect(pageBadge.titleOnlyRule).toContain("title-only change keeps the badge current");
  await addRevision(pageId, "Renamed handbook", handbook("Clinic hours"));
  const titled = await readKnowledgeBadge(r, reader, workspace, pageBadge.id);
  expect(titled).toMatchObject({ status: "current", titleChanged: true, reason: "title-only", titleOnlyPolicy: "preserve" });
  await addRevision(pageId, "Renamed handbook", handbook("Changed hours"));
  expect(await readKnowledgeBadge(r, reader, workspace, pageBadge.id)).toMatchObject({ status: "stale", reason: "content-changed" });
  const sourced = await verify(steward, "page", sourcePage);
  await addRevision(sourcePage, "Source handbook", handbook("Clinic hours", "other-page"));
  expect(await readKnowledgeBadge(r, reader, workspace, sourced.id)).toMatchObject({ status: "stale", reason: "source-changed" });
  const recordBadge = (await searchKnowledgeVerification(r, reader, workspace, "visible clinic")).results[0];
  await db.query("UPDATE hs_data_records SET name='Visible clinic renamed', version=version+1 WHERE id=$1", [visible]);
  expect(await readKnowledgeBadge(r, reader, workspace, recordBadge.id)).toMatchObject({ status: "current", titleChanged: true, reason: "title-only" });
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb, version=version+1 WHERE id=$1", [visible, JSON.stringify({ "core:notes": "changed hours", "source:dossier": "file-a", "core:salary": "hidden-salary" })]);
  expect(await readKnowledgeBadge(r, reader, workspace, recordBadge.id)).toMatchObject({ status: "stale", reason: "content-changed" });
  const sourceBadge = await verify(steward, "record", sourceRecord);
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb, version=version+1 WHERE id=$1", [sourceRecord, JSON.stringify({ "core:notes": "stable", "source:dossier": "file-b" })]);
  expect(await readKnowledgeBadge(r, reader, workspace, sourceBadge.id)).toMatchObject({ status: "stale", reason: "source-changed" });
  await db.query("UPDATE hs_page_publication_state SET live=false WHERE page_id=$1", [sourcePage]);
  expect(await readKnowledgeBadge(r, reader, workspace, sourced.id)).toMatchObject({ status: "stale", reason: "unpublished" });
});

it("shows the badge in search, interfaces, and source preview only with content and metadata access", async () => {
  const readerSearch = await searchKnowledgeVerification(r, reader, workspace, "clinic");
  expect(readerSearch.results.some(item => item.targetId === visible)).toBe(true);
  expect(JSON.stringify(readerSearch)).not.toContain("zzsecretrecord");
  expect(JSON.stringify(readerSearch)).not.toContain("hidden-salary");
  const secretBadge = (await searchKnowledgeVerification(r, owner, workspace, "zzsecret")).results[0];
  await expect(knowledgeVerificationSourcePreview(r, reader, workspace, secretBadge.id)).rejects.toMatchObject({ code: "not_found" });
  const visibleBadge = (await searchKnowledgeVerification(r, reader, workspace, "visible clinic")).results[0];
  const preview = await knowledgeVerificationSourcePreview(r, reader, workspace, visibleBadge.id);
  expect(preview.badge).toMatchObject({ label: "Stale", titleOnlyPolicy: "preserve" });
  expect(preview.excerpt).toBe("Visible clinic renamed");
  expect(JSON.stringify(preview)).not.toContain("hidden-salary");
  const projected = await projectKnowledgeVerification(r, reader, workspace, { recordIds: [visible, secret], pageIds: [pageId, secretPage] });
  expect(projected.records.map(item => item.id)).toEqual([visible]);
  expect(projected.records[0].verification?.status).toBe("stale");
  expect(projected.pages.map(item => item.id)).toEqual([pageId]);
  expect(projected.pages[0].verification).toMatchObject({ status: "stale" });
  await saveKnowledgeVerificationFieldPolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, sensitive: true, access: [{ userId: owner.id, canView: true, canWrite: true, canHistory: true }, { userId: editor.id, canView: true, canWrite: false, canHistory: true }, { userId: steward.id, canView: true, canWrite: true, canHistory: true }] });
  const hidden = await projectKnowledgeVerification(r, reader, workspace, { recordIds: [visible], pageIds: [pageId] });
  expect(hidden.records).toEqual([{ id: visible, verification: null }]);
  expect(JSON.stringify(hidden)).not.toContain("source-reviewed");
  expect((await searchKnowledgeVerification(r, reader, workspace, "visible clinic")).results).toEqual([]);
  await expect(knowledgeVerificationSourcePreview(r, reader, workspace, visibleBadge.id)).rejects.toMatchObject({ code: "not_found" });
  const iface = randomUUID();
  const definition = { navigation: [{ id: "home", label: "Clinic", screenId: "clinic" }], screens: [{ id: "clinic", name: "Clinic", components: [{ id: "roster", kind: "list", collection: "organisations", viewId: null, fields: [{ key: "core:registration", version: 1 }] }] }], roles: ["member"] };
  await db.query("INSERT INTO hs_role_interfaces(id, tenant_id, name, status, sharing, version, definition, created_by) VALUES($1,$2,'Clinic desk','draft','private',1,$3,$4)", [iface, tenant, JSON.stringify(definition), owner.id]);
  await db.query("UPDATE hs_role_interfaces SET status='published' WHERE id=$1", [iface]);
  await db.query("INSERT INTO hs_role_interface_roles(interface_id, role, assigned_by) VALUES($1,'member',$2)", [iface, owner.id]);
  const rendered = await renderRoleInterface(r, reader, workspace, iface);
  const records = rendered.screens[0].components[0].records ?? [];
  expect(records.some(item => item.id === visible)).toBe(true);
  expect(records.find(item => item.id === visible)?.verification).toBeNull();
  expect(JSON.stringify(rendered)).not.toContain("zzsecretrecord");
  expect(JSON.stringify(rendered)).not.toContain("source-reviewed");
  await saveKnowledgeVerificationFieldPolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 1, sensitive: false, access: [] });
  const restored = await renderRoleInterface(r, editor, workspace, iface);
  expect(restored.screens[0].components[0].records?.find(item => item.id === visible)?.verification).toMatchObject({ status: "stale", basis: "source-reviewed" });
});

it("requires authority and a reason to renew or revoke, and lets a reader inspect scope and report a concern", async () => {
  const badge = (await searchKnowledgeVerification(r, reader, workspace, "visible clinic")).results[0];
  const scope = await readKnowledgeBadge(r, reader, workspace, badge.id);
  expect(scope).toMatchObject({ owner: "Your workspace", basis: "source-reviewed", titleOnlyPolicy: "preserve", attestedRevision: scope.attestedRevision });
  expect(scope.titleOnlyRule).toContain("title-only");
  expect(scope.statement).toContain("Not an AI truth score");
  await expect(previewKnowledgeVerification(r, reader, workspace, { operationId: randomUUID(), kind: "renew", badgeId: badge.id, expectedVersion: scope.version, expiryDays: 30, reason: "Still current." })).rejects.toMatchObject({ code: "knowledge_verification_authority" });
  await expect(previewKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), kind: "renew", badgeId: badge.id, expectedVersion: scope.version, expiryDays: 30, reason: " " })).rejects.toMatchObject({ code: "knowledge_verification_reason" });
  const reviewed = await previewKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), kind: "renew", badgeId: badge.id, expectedVersion: scope.version, expiryDays: 45, reason: "The renamed record still matches the attested body." });
  const renewed = await applyKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: scope.version });
  expect(renewed).toMatchObject({ status: "current", expiryDays: 45, version: scope.version + 1 });
  await expect(reportKnowledgeConcern(r, reader, workspace, { operationId: randomUUID(), badgeId: badge.id, reason: " " })).rejects.toMatchObject({ code: "knowledge_verification_reason" });
  await reportKnowledgeConcern(r, reader, workspace, { operationId: randomUUID(), badgeId: badge.id, reason: "The hours still look wrong." });
  const history = await knowledgeVerificationHistory(r, editor, workspace, badge.id);
  expect(history.events.some(event => event.action === "renew" && event.reason === "The renamed record still matches the attested body." && event.source === "knowledge-verification" && /IST$/.test(event.atIst))).toBe(true);
  expect(history.events.some(event => event.action === "concern" && event.reason === "The hours still look wrong." && event.actorId === reader.id)).toBe(true);
  expect(history.scope.ownerId).toBe(owner.id);
  await expect(knowledgeVerificationHistory(r, reader, workspace, badge.id)).rejects.toMatchObject({ code: "action_forbidden" });
  const revokedPreview = await previewKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), kind: "revoke", badgeId: badge.id, expectedVersion: renewed.version, reason: "The source was withdrawn." });
  const revoked = await applyKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), previewId: revokedPreview.previewId, expectedVersion: renewed.version });
  expect(revoked).toMatchObject({ status: "revoked", reason: "revoked" });
  const after = await knowledgeVerificationHistory(r, editor, workspace, badge.id);
  expect(after.events.some(event => event.action === "revoke" && event.reason === "The source was withdrawn.")).toBe(true);
});

it("enforces tenant, record, field, and action checks without turning configuration into access", async () => {
  const before = await grants();
  await grantKnowledgeSteward(r, owner, workspace, { operationId: randomUUID(), userId: reader.id });
  await setKnowledgeVerificationActions(r, owner, workspace, { operationId: randomUUID(), userId: reader.id, expectedVersion: 0, actions: ["verify", "download", "history"] });
  expect(await grants()).toBe(before);
  await expect(readKnowledgeBadge(r, reader, workspace, (await searchKnowledgeVerification(r, owner, workspace, "zzsecret")).results[0].id)).rejects.toMatchObject({ code: "not_found" });
  await expect(searchKnowledgeVerification(r, outsider, "ws-b", "clinic")).resolves.toMatchObject({ results: [] });
  await expect(searchKnowledgeVerification(r, outsider, workspace, "clinic")).rejects.toMatchObject({ code: "not_found" });
  const found = (await searchKnowledgeVerification(r, editor, workspace, "source clinic")).results[0];
  const readable = await readKnowledgeBadge(r, editor, workspace, found.id);
  await expect(downloadKnowledgeVerification(r, reader, workspace, { operationId: randomUUID(), badgeId: found.id, expectedVersion: readable.version })).rejects.toMatchObject({ code: "action_forbidden" });
  const current = readable;
  const downloaded = await downloadKnowledgeVerification(r, editor, workspace, { operationId: randomUUID(), badgeId: found.id, expectedVersion: current.version });
  expect(downloaded.body).toContain("Not a legal certification");
  expect(downloaded.body).toContain("Title-only policy: preserve");
  expect(downloaded.body).not.toContain("hidden-salary");
  await setKnowledgeVerificationActions(r, owner, workspace, { operationId: randomUUID(), userId: editor.id, expectedVersion: 0, actions: ["report"] });
  await expect(downloadKnowledgeVerification(r, editor, workspace, { operationId: randomUUID(), badgeId: found.id, expectedVersion: current.version })).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(knowledgeVerificationHistory(r, editor, workspace, found.id)).rejects.toMatchObject({ code: "action_forbidden" });
  expect(await grants()).toBe(before);
  await db.query("DELETE FROM hs_knowledge_verification_actions WHERE user_id=$1 OR user_id=$2", [reader.id, editor.id]);
  await db.query("DELETE FROM hs_knowledge_verification_action_sets WHERE user_id=$1 OR user_id=$2", [reader.id, editor.id]);
  await db.query("DELETE FROM hs_knowledge_verification_stewards WHERE user_id=$1", [reader.id]);
});

it("versions configuration, keeps a recoverable draft, and audits actor, source, time, and operation", async () => {
  const before = await grants();
  await expect(saveKnowledgeVerificationPolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, bases: ["source-reviewed"], defaultExpiryDays: 30, titleOnly: "invalidate" })).rejects.toMatchObject({ code: "knowledge_verification_title" });
  await expect(saveKnowledgeVerificationPolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, bases: ["source-reviewed"], defaultExpiryDays: 30 })).rejects.toMatchObject({ code: "knowledge_verification_conflict" });
  const catalogue = await knowledgeVerificationCatalogue(r, owner, workspace);
  expect(catalogue.policy?.version).toBe(1);
  expect(catalogue.policy?.recoverableDraft?.bases).toEqual(["source-reviewed"]);
  expect(catalogue.policy?.titleOnlyPolicy).toBe("preserve");
  const badge = (await searchKnowledgeVerification(r, steward, workspace, "source clinic")).results[0];
  const current = await readKnowledgeBadge(r, steward, workspace, badge.id);
  await expect(stashKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), targetKind: "record", targetId: sourceRecord, expectedVersion: current.version + 9, ownerId: owner.id, basis: "source-reviewed", basisNote: "Kept aside", expiryDays: 12 })).rejects.toMatchObject({ code: "knowledge_verification_conflict" });
  expect((await readKnowledgeBadge(r, steward, workspace, badge.id)).version).toBe(current.version);
  expect((await readKnowledgeBadge(r, steward, workspace, badge.id)).recoverableDraft?.payload.basisNote).toBe("Kept aside");
  const operationId = randomUUID();
  const saved = await saveKnowledgeVerificationPolicy(r, owner, workspace, { operationId, expectedVersion: 1, bases: ["source-reviewed", "owner-confirmed"], defaultExpiryDays: 60 });
  const replayed = await saveKnowledgeVerificationPolicy(r, owner, workspace, { operationId, expectedVersion: 1, bases: ["source-reviewed", "owner-confirmed"], defaultExpiryDays: 60 });
  expect(replayed).toMatchObject({ replayed: true, version: saved.version });
  const renewedPreview = await previewKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), kind: "renew", badgeId: badge.id, expectedVersion: current.version, expiryDays: 20, reason: "Attest the current source again." });
  const renewed = await applyKnowledgeVerification(r, steward, workspace, { operationId: randomUUID(), previewId: renewedPreview.previewId, expectedVersion: current.version });
  await db.query("UPDATE hs_knowledge_verification_badges SET expires_at=clock_timestamp() - interval '1 day' WHERE id=$1", [renewed.id]);
  expect((await readKnowledgeBadge(r, editor, workspace, renewed.id)).status).toBe("expired");
  const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='knowledge-verification.verify' AND subject_id=$1 ORDER BY created_at LIMIT 1", [badge.id]);
  const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
  expect(audit.rows[0].actor_id).toBe(steward.id);
  expect(after).toMatchObject({ source: "knowledge-verification" });
  expect(after.atIst).toMatch(/IST$/);
  expect(after.operationId).toBeTruthy();
  await expect(db.query("UPDATE hs_knowledge_verification_revisions SET basis='rewritten' WHERE badge_id=$1", [badge.id])).rejects.toThrow(/immutable/i);
  const sql = await readFile("db/130_knowledge_verification.sql", "utf8");
  const executable = sql.replace(/--.*$/gm, "");
  expect(executable).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(executable).not.toMatch(/parent_organisation_id/);
  expect(executable).not.toMatch(/release\.py/);
  for (const statement of statements(sql)) await db.query(statement);
  expect(await grants()).toBe(before);
  expect((await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).rows[0].definition).toMatchObject({ paused: true });
});
