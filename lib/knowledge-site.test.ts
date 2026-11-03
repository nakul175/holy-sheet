import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds } from "./document";
import {
  activateKnowledgeSite,
  downloadKnowledgeSite,
  grantKnowledgeSiteManager,
  knowledgeSiteCatalogue,
  knowledgeSiteHistory,
  previewKnowledgeSite,
  publishKnowledgeSite,
  readKnowledgeAsset,
  rollbackKnowledgeSite,
  saveKnowledgeSite,
  searchKnowledgeSites,
  setKnowledgeSiteActions,
  unpublishKnowledgeSite,
} from "./knowledge-site";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const editor = { id: "knowledge-editor", name: "Eve Editor" };
const outsider = { id: "knowledge-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const visibleRecord = "00000000-0000-4000-8000-00000000f301";
const secretRecord = "00000000-0000-4000-8000-00000000f302";
const organisationRecord = "00000000-0000-4000-8000-00000000f305";
const accountRecord = "00000000-0000-4000-8000-00000000f304";
const scheduleId = "00000000-0000-4000-8000-00000000f306";
const objectKey = "tenants/secret/object-key";
let tenant = "";
let secretField = "";
let helpPage = "";
let approvedRevision = 0;
let secretRevision = 0;
let mediaId = "";
let siteId = "";
let siteVersion = 0;
let publishedGeneration = 0;
const actions = ["configure", "search", "preview", "download", "history", "publish", "unpublish", "rollback", "render"];
type Shown = {
  id: string;
  version: number;
  status: string;
  sharing: string;
  liveSite: boolean;
  domain: null;
  publicEnabled: boolean;
  audienceConfirmed: boolean;
  accessGranted: boolean;
  dryRun: boolean;
  autoPublished: boolean;
  publicText: string;
  body: string;
  cacheGeneration: number;
  invalidatedGeneration: number;
  thirdPartyRetraction: boolean;
  projection: { assets: { url: null; mediaId: string }[]; manifest: { kind: string; reason: string }[]; liveSite: boolean; sharing: string; domain: null };
  manifest: { kind: string; reason: string; included: false }[];
  replayed: boolean;
};
function shown(value: object) { return value as Shown; }
function exposed(value: unknown) { return JSON.stringify(value); }

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [editor, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member')", [workspace, editor.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  const other = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Synthetic Clinic'),($2,'Bolt')", [tenant, other]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, other]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'organisations','Organisations',true),($1,'accounts','Accounts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'accounts',$3)", [tenant, owner.id, ["view", "edit", "export", "history"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, field_values, created_by, updated_by) VALUES($1,$2,'organisations','Visible clinic',$3,$4,$4),($5,$2,'organisations','zzsecretrecord','{}',$4,$4),($6,$2,'organisations','Northwind','{}',$4,$4)", [visibleRecord, tenant, JSON.stringify({ "core:notes": "Visible note" }), owner.id, secretRecord, organisationRecord]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, parent_organisation_id, created_by, updated_by) VALUES($1,$2,'accounts','Northwind account',$3,$4,$4)", [accountRecord, tenant, organisationRecord, owner.id]);
  secretField = randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id, collection, field_key, label, kind, sensitive, created_by) VALUES($1,'organisations',$2,'Private salary','text',true,$3)", [tenant, secretField, owner.id]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id, collection, field_key, user_id, can_view, can_write, can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [tenant, secretField, owner.id]);
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE id=$1", [visibleRecord, JSON.stringify({ "core:notes": "Visible note", [secretField]: "hidden-salary-value" })]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
});
afterAll(async () => db.close());

function siteDefinition(page = helpPage, revision = approvedRevision) {
  return {
    pages: [{ pageId: page, revision, path: "help/start", label: "Start" }],
    navigation: [{ path: "help/start", label: "Start", parent: null }],
    assets: [{ mediaId, pageId: page }],
    records: [{ recordId: visibleRecord, fields: ["core:notes", secretField] }],
    edge: { cache: "no-store", residency: "tenant", public: false },
    cacheBoundSeconds: 0,
  };
}
async function footprint() {
  const [records, collections, pages, parents, schedules, invitations, users] = await Promise.all([
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY 1,2"),
    db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records WHERE parent_organisation_id IS NOT NULL"),
    db.query("SELECT id::text, definition FROM hs_data_periodic_review_schedules ORDER BY 1"),
    db.query("SELECT count(*)::int AS n FROM hs_access_invitations"),
    db.query("SELECT count(*)::int AS n FROM hs_users"),
  ]);
  return JSON.stringify({ records: records.rows, collections: collections.rows, pages: pages.rows, parents: parents.rows, schedules: schedules.rows, invitations: invitations.rows[0].n, users: users.rows[0].n });
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

it("selects an approved revision, path, and public preview with a sensitive dependency manifest", async () => {
  const before = await footprint();
  const made = await r.create(owner, "Help article", "space-product");
  const secret = await r.create(owner, "SECRET_PAGE_TITLE", "space-product");
  helpPage = made.id;
  mediaId = randomUUID();
  await db.query("INSERT INTO hs_media(id,page_id,uploader_id,operation_id,name,mime,size,object_key,state,sha256,scanned_at) VALUES($1,$2,$3,$4,'help.png','image/png',4,$5,'ready',$6,clock_timestamp())", [mediaId, helpPage, owner.id, randomUUID(), objectKey, "a".repeat(64)]);
  const saved = await r.save(helpPage, owner, {
    operationId: randomUUID(), baseVersion: made.version, title: "Approved help",
    document: ensureIds({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "APPROVED_HELP_TEXT", marks: [{ type: "link", attrs: { href: "https://files.example/secret-object" } }] }] },
        { type: "image", attrs: { attachmentId: mediaId, src: `/api/media/${mediaId}`, alt: "Help diagram" } },
        { type: "pageLink", attrs: { pageId: secret.id } },
      ],
    }),
  });
  approvedRevision = saved.page.version;
  const thread = randomUUID();
  await db.query("INSERT INTO hs_threads(id,page_id,creator_id) VALUES($1,$2,$3)", [thread, helpPage, owner.id]);
  await db.query("INSERT INTO hs_comments(id,thread_id,author_id,body,is_root) VALUES($1,$2,$3,'CONFIDENTIAL_COMMENT',true)", [randomUUID(), thread, owner.id]);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,'secret-reader','viewer')", [helpPage]);
  const configured = shown(await saveKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Help centre", definition: siteDefinition() }));
  siteId = configured.id;
  siteVersion = configured.version;
  expect(configured).toMatchObject({ status: "draft", sharing: "off", liveSite: false, domain: null, publicEnabled: false, audienceConfirmed: false, accessGranted: false, dryRun: true });
  const preview = shown(await previewKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion }));
  expect(preview.publicText).toContain("APPROVED_HELP_TEXT");
  expect(preview.publicText).toContain("Visible note");
  expect(exposed(preview)).not.toContain("CONFIDENTIAL_COMMENT");
  expect(exposed(preview)).not.toContain("secret-reader");
  expect(exposed(preview)).not.toContain("SECRET_PAGE_TITLE");
  expect(exposed(preview)).not.toContain(objectKey);
  expect(exposed(preview)).not.toContain(`/api/media/${mediaId}`);
  expect(exposed(preview)).not.toContain("https://files.example/secret-object");
  expect(exposed(preview)).not.toContain("hidden-salary-value");
  expect(preview.manifest).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "comment", reason: "stripped", included: false }),
    expect.objectContaining({ kind: "acl", reason: "stripped", included: false }),
    expect.objectContaining({ kind: "page", reason: "private", included: false }),
    expect.objectContaining({ kind: "field", reason: "sensitive", included: false }),
    expect.objectContaining({ kind: "url", reason: "direct-url", included: false }),
  ]));
  expect(preview.projection.assets[0]).toMatchObject({ mediaId, url: null });
  expect(preview.projection.liveSite).toBe(false);
  expect(preview.projection.domain).toBeNull();
  await expect(saveKnowledgeSite(r, editor, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Other site", definition: siteDefinition() })).rejects.toMatchObject({ code: "not_found" });
  await expect(saveKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Public site", definition: { ...siteDefinition(), edge: { cache: "public", residency: "tenant", public: true } } })).rejects.toMatchObject({ code: "knowledge_site_edge" });
  const fixture = JSON.parse(await readFile("fixtures/knowledge-sites/staging.json", "utf8"));
  expect(fixture).toMatchObject({ sharing: "off", accessGranted: false, liveSite: false, domain: null, publicEnabled: false, thirdPartyRetraction: false });
  const grants = await footprint();
  expect(JSON.parse(grants).records).toEqual(JSON.parse(before).records);
  expect(JSON.parse(grants).collections).toEqual(JSON.parse(before).collections);
  expect(JSON.parse(grants).users).toBe(JSON.parse(before).users);
});

it("requires a separate publish capability and explicit public confirmation, and ignores internal edits", async () => {
  await expect(publishKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion, audience: "public" })).rejects.toMatchObject({ code: "action_forbidden" });
  await setKnowledgeSiteActions(r, owner, workspace, { operationId: randomUUID(), userId: owner.id, expectedVersion: 0, actions });
  await expect(publishKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion, audience: "internal" })).rejects.toMatchObject({ code: "knowledge_site_audience" });
  const published = shown(await publishKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion, audience: "public" }));
  siteVersion = published.version;
  publishedGeneration = published.cacheGeneration;
  expect(published).toMatchObject({ status: "published", sharing: "off", liveSite: false, domain: null, publicEnabled: false, audienceConfirmed: true, accessGranted: false, autoPublished: false });
  expect(exposed(published)).not.toContain("hidden-salary-value");
  expect(exposed(published)).not.toContain(objectKey);
  const row = await db.query<{ sharing: string; live_site: boolean; domain: string | null; public_enabled: boolean }>("SELECT sharing, live_site, domain, public_enabled FROM hs_knowledge_sites WHERE id=$1", [siteId]);
  expect(row.rows[0]).toEqual({ sharing: "off", live_site: false, domain: null, public_enabled: false });
  const current = await r.get(helpPage, owner);
  const internal = await r.save(helpPage, owner, { operationId: randomUUID(), baseVersion: current.version, title: "SECRET_INTERNAL_UPDATE", document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "SECRET_INTERNAL_UPDATE" }] }] }) });
  secretRevision = internal.page.version;
  const download = shown(await downloadKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion }));
  expect(download.body).toContain("APPROVED_HELP_TEXT");
  expect(download.body).toContain("Visible note");
  expect(download.body).toContain("do not retract copies already held by a third party");
  expect(download.body).not.toContain("SECRET_INTERNAL_UPDATE");
  expect(download.body).not.toContain("CONFIDENTIAL_COMMENT");
  expect(download.body).not.toContain(objectKey);
  expect(download.body).not.toContain("hidden-salary-value");
  const found = await searchKnowledgeSites(r, owner, workspace, "approved_help_text");
  expect(found.results.map(result => result.snippet).join("\n")).toContain("APPROVED_HELP_TEXT");
  expect(exposed(await searchKnowledgeSites(r, owner, workspace, "secret_internal"))).not.toContain("SECRET_INTERNAL_UPDATE");
  const preview = shown(await previewKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion }));
  expect(preview.manifest).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "newer-revision", included: false })]));
  expect(preview.publicText).not.toContain("SECRET_INTERNAL_UPDATE");
  const asset = await readKnowledgeAsset(r, owner, workspace, siteId, mediaId);
  expect(asset).toMatchObject({ url: null, objectKey: null, fetched: false, quarantined: false, route: "mediated" });
  expect(exposed(asset)).not.toContain(objectKey);
  await expect(activateKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion })).rejects.toMatchObject({ code: "knowledge_site_live" });
  expect((await db.query<{ live_site: boolean }>("SELECT live_site FROM hs_knowledge_sites WHERE id=$1", [siteId])).rows[0].live_site).toBe(false);
});

it("invalidates search, download, and asset routes on unpublish and rollback without retracting third-party copies", async () => {
  const removed = shown(await unpublishKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion }));
  siteVersion = removed.version;
  expect(removed.thirdPartyRetraction).toBe(false);
  expect(removed.invalidatedGeneration).toBe(publishedGeneration);
  expect((await searchKnowledgeSites(r, owner, workspace, "approved_help_text")).results).toEqual([]);
  await expect(searchKnowledgeSites(r, owner, workspace, "approved_help_text", publishedGeneration)).rejects.toMatchObject({ code: "not_found" });
  await expect(downloadKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion })).rejects.toMatchObject({ code: "not_found" });
  await expect(readKnowledgeAsset(r, owner, workspace, siteId, mediaId, publishedGeneration)).rejects.toMatchObject({ code: "not_found" });
  const restored = shown(await rollbackKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion }));
  siteVersion = restored.version;
  expect(restored).toMatchObject({ status: "published", sharing: "off", liveSite: false, thirdPartyRetraction: false });
  expect(restored.cacheGeneration).not.toBe(removed.cacheGeneration);
  const found = await searchKnowledgeSites(r, owner, workspace, "approved_help_text", restored.cacheGeneration);
  expect(found.results.map(result => result.snippet).join("\n")).toContain("APPROVED_HELP_TEXT");
  await expect(searchKnowledgeSites(r, owner, workspace, "approved_help_text", removed.invalidatedGeneration)).rejects.toMatchObject({ code: "not_found" });
  const moved = shown(await saveKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion, name: "Help centre", definition: siteDefinition(helpPage, secretRevision) }));
  const republished = shown(await publishKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: moved.version, audience: "public" }));
  expect(exposed(await searchKnowledgeSites(r, owner, workspace, "secret_internal"))).toContain("SECRET_INTERNAL_UPDATE");
  const rolled = shown(await rollbackKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId, expectedVersion: republished.version }));
  siteVersion = rolled.version;
  const after = exposed(await searchKnowledgeSites(r, owner, workspace, "approved_help_text"));
  expect(after).toContain("APPROVED_HELP_TEXT");
  expect(after).not.toContain("SECRET_INTERNAL_UPDATE");
  await expect(readKnowledgeAsset(r, owner, workspace, siteId, mediaId, republished.cacheGeneration)).rejects.toMatchObject({ code: "not_found" });
  expect((await db.query<{ sharing: string; live_site: boolean }>("SELECT sharing, live_site FROM hs_knowledge_sites WHERE id=$1", [siteId])).rows[0]).toEqual({ sharing: "off", live_site: false });
});

it("enforces tenant, record, field, and action checks without turning configuration into access", async () => {
  const before = await footprint();
  await grantKnowledgeSiteManager(r, owner, workspace, { operationId: randomUUID(), userId: editor.id });
  await setKnowledgeSiteActions(r, owner, workspace, { operationId: randomUUID(), userId: editor.id, expectedVersion: 0, actions: ["search"] });
  expect(await footprint()).toBe(before);
  expect(exposed(await searchKnowledgeSites(r, editor, workspace, "approved_help_text"))).not.toContain("APPROVED_HELP_TEXT");
  expect(exposed(await searchKnowledgeSites(r, editor, workspace, "hidden-salary"))).not.toContain("hidden-salary");
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')", [helpPage, editor.id]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, visibleRecord, editor.id, ["view"]]);
  expect(exposed(await searchKnowledgeSites(r, editor, workspace, "approved_help_text"))).toContain("APPROVED_HELP_TEXT");
  expect(exposed(await searchKnowledgeSites(r, editor, workspace, "hidden-salary"))).not.toContain("hidden-salary-value");
  await expect(downloadKnowledgeSite(r, editor, workspace, { operationId: randomUUID(), siteId, expectedVersion: siteVersion })).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(knowledgeSiteHistory(r, editor, workspace, siteId)).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(readKnowledgeAsset(r, editor, workspace, siteId, mediaId)).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(searchKnowledgeSites(r, outsider, workspace, "help")).rejects.toMatchObject({ code: "not_found" });
  expect((await searchKnowledgeSites(r, outsider, "ws-b", "help")).results).toEqual([]);
  const history = await knowledgeSiteHistory(r, owner, workspace, siteId);
  expect(exposed(history)).not.toContain("CONFIDENTIAL_COMMENT");
  expect(exposed(history)).not.toContain("hidden-salary-value");
  expect(exposed(history)).not.toContain(objectKey);
});

it("versions configuration, keeps recoverable drafts, and audits actor, source, time, and operation", async () => {
  const before = await footprint();
  const operationId = randomUUID();
  const saved = shown(await saveKnowledgeSite(r, owner, workspace, { operationId, expectedVersion: 0, name: "Audited site", definition: siteDefinition() }));
  const replayed = shown(await saveKnowledgeSite(r, owner, workspace, { operationId, expectedVersion: 0, name: "Audited site", definition: siteDefinition() }));
  expect(replayed).toMatchObject({ replayed: true, id: saved.id, version: saved.version });
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_knowledge_sites WHERE id=$1", [saved.id])).rows[0].n)).toBe(1);
  await expect(saveKnowledgeSite(r, owner, workspace, { operationId, expectedVersion: 1, name: "Audited site", definition: siteDefinition() })).rejects.toMatchObject({ code: "operation_mismatch" });
  await expect(saveKnowledgeSite(r, owner, workspace, { operationId: randomUUID(), siteId: saved.id, expectedVersion: 0, name: "Audited site renamed", definition: siteDefinition() })).rejects.toMatchObject({ code: "knowledge_site_conflict" });
  const catalogue = await knowledgeSiteCatalogue(r, owner, workspace);
  expect(catalogue.drafts.some(draft => draft.siteKey === saved.id && draft.kind === "configure")).toBe(true);
  const history = await knowledgeSiteHistory(r, owner, workspace, saved.id);
  expect(history.events.some(event => event.action === "configure" && event.source === "knowledge-site" && event.actorId === owner.id && /IST$/.test(event.atIst))).toBe(true);
  const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='knowledge-site.configure' AND subject_id=$1", [saved.id]);
  const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
  expect(audit.rows[0].actor_id).toBe(owner.id);
  expect(after).toMatchObject({ source: "knowledge-site", accessGranted: false, sharing: "off", liveSite: false });
  expect(after.atIst).toMatch(/IST$/);
  expect(after.operationId).toBe(operationId);
  await expect(db.query("UPDATE hs_knowledge_site_revisions SET name='rewritten' WHERE site_id=$1", [saved.id])).rejects.toThrow(/immutable/i);
  const sql = await readFile("db/135_public_knowledge_sites.sql", "utf8");
  const executable = sql.replace(/--.*$/gm, "");
  expect(executable).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(executable).not.toMatch(/parent_organisation_id/);
  expect(executable).not.toMatch(/release\.py/);
  for (const statement of statements(sql)) await db.query(statement);
  expect((await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).rows[0].definition).toMatchObject({ paused: true });
  expect((await db.query<{ parent_organisation_id: string }>("SELECT parent_organisation_id::text FROM hs_data_records WHERE id=$1", [accountRecord])).rows[0].parent_organisation_id).toBe(organisationRecord);
  expect(JSON.parse(await footprint()).schedules).toEqual(JSON.parse(before).schedules);
});

function num(value: number | string) { return Number(value); }
