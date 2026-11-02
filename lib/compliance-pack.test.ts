import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import JSZip from "jszip";
import { ACK_GENESIS, acknowledgementRecordHash } from "./acknowledgement-chain";
import { localActor as owner } from "./auth";
import {
  ATTACHMENTS_EXCLUDED_NOTE,
  COMPLIANCE_READY_BODY,
  COMPLIANCE_READY_SUBJECT,
  RESTRICTED_RECORD,
  complianceSigningKey,
  sha256Bytes,
  verifyComplianceManifest,
} from "./compliance-pack-plan";
import {
  changeExportAttachmentPolicy,
  complianceSessionBinding,
  createComplianceExport,
  downloadComplianceExport,
  exportAttachmentPolicy,
  readComplianceExport,
} from "./compliance-pack";
import { createDatabase, type Database, type Sql } from "./database";
import { DocumentError, ensureIds, stableStringify, type RichNode } from "./document";
import type { ComplianceFormat, ComplianceScope } from "./compliance-pack";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
let tenant = "";
const admin = { id: "compliance-admin", name: "Ada Admin" };
const editor = { id: "compliance-editor", name: "Ed Editor" };
const outsider = { id: "compliance-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const space = "space-product";
const visibleRecord = "00000000-0000-4000-8000-0000000000c1";
const hiddenEmail = "hidden-r200@example.com";
const pdf = async () => Buffer.from("%PDF-1.4\ncompliance\n");
const bind = (actorId: string) => createHash("sha256").update(`hs-compliance-session:local:${actorId}`).digest("hex");

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const actor of [admin, editor, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'admin'),($1,$3,'member')", [workspace, admin.id, editor.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_spaces(id, workspace_id, name) VALUES('space-bolt','ws-b','Bolt')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Acme')", [tenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic')", [workspace, tenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'contacts','Contacts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'contacts',$3),($1,$4,'contacts',$3)", [tenant, owner.id, ["view"], admin.id]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, field_values, created_by, updated_by) VALUES($1,$2,'contacts',$3,$4::jsonb,$5,$5)", [visibleRecord, tenant, "R-200 Restricted Clinic", JSON.stringify({ "core:job-title": "Analyst Visible", "core:email": hiddenEmail }), owner.id]);
});
afterAll(async () => db.close());

async function savePage(title: string, document: RichNode, parentId?: string) {
  const created = await r.create(owner, title, space, parentId);
  const saved = await r.save(created.id, owner, { operationId: randomUUID(), baseVersion: created.version, title, document: ensureIds(document) });
  return saved.page;
}

async function saveWithMedia(title: string, mediaName: string, objectKey: string, checksum: string) {
  const created = await r.create(owner, title, space);
  const media = randomUUID();
  await db.query("INSERT INTO hs_media(id, page_id, uploader_id, operation_id, name, mime, size, object_key, state, sha256, scanned_at) VALUES($1,$2,$3,$4,$5,'text/plain',4,$6,'ready',$7,clock_timestamp())", [media, created.id, owner.id, randomUUID(), mediaName, objectKey, checksum]);
  const saved = await r.save(created.id, owner, { operationId: randomUUID(), baseVersion: created.version, title, document: ensureIds({ type: "doc", content: [{ type: "file", attrs: { attachmentId: media, title: mediaName } }] }) });
  return { page: saved.page, media };
}

function pack(actor: { id: string }, targetId: string, extra: Partial<{ scope: ComplianceScope; format: ComplianceFormat; includeDraft: boolean; includeTrash: boolean; allAttachmentVersions: boolean; operationId: string }> = {}, beforeItem?: (tx: Sql, index: number, jobId: string) => Promise<void>) {
  return createComplianceExport(r, actor, workspace, {
    operationId: extra.operationId ?? randomUUID(),
    scope: extra.scope ?? "space",
    format: extra.format ?? "compliance-pack",
    targetId,
    includeDraft: extra.includeDraft ?? false,
    includeTrash: extra.includeTrash ?? false,
    allAttachmentVersions: extra.allAttachmentVersions ?? false,
  }, bind(actor.id), { renderPdf: pdf, beforeItem });
}

async function filesOf(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const files = new Map<string, Buffer>();
  for (const [path, entry] of Object.entries(zip.files)) if (!entry.dir) files.set(path, await entry.async("nodebuffer"));
  return files;
}

const textOf = (files: Map<string, Buffer>) => [...files.values()].map(value => value.toString("utf8")).join("\n");

it("queues a space compliance pack with progress, a 24 hour session link, and a content-free email", async () => {
  const page = await savePage("Ops home", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ops body" }] }] });
  const operationId = randomUUID();
  const job = await pack(admin, space, { operationId });
  expect(job).toMatchObject({ state: "ready", progress: 100, etaSeconds: 0, scope: "space", format: "compliance-pack", replayed: false });
  expect(job.downloadToken).toBeTruthy();
  expect(job.atIst).toMatch(/IST$/);
  const again = await pack(admin, space, { operationId });
  expect(again.replayed).toBe(true);
  expect(again.id).toBe(job.id);
  const span = await db.query<{ seconds: string }>("SELECT extract(epoch FROM (expires_at - completed_at))::text AS seconds FROM hs_compliance_jobs WHERE id=$1", [job.id]);
  expect(Number(span.rows[0].seconds)).toBeGreaterThan(23 * 3600);
  expect(Number(span.rows[0].seconds)).toBeLessThan(25 * 3600);
  const mail = await db.query<{ subject: string; body: string }>("SELECT subject, body FROM hs_compliance_email_outbox WHERE job_id=$1", [job.id]);
  expect(mail.rows).toEqual([{ subject: COMPLIANCE_READY_SUBJECT, body: COMPLIANCE_READY_BODY }]);
  expect(mail.rows[0].body).not.toContain("Ops body");
  const downloaded = await downloadComplianceExport(r, admin, job.id, job.downloadToken!, bind(admin.id));
  expect(downloaded.contentType).toBe("application/zip");
  const files = await filesOf(downloaded.bytes);
  expect(files.get(`pages/${page.id}/current.html`)?.toString("utf8")).toContain("Ops body");
  expect(files.get(`pages/${page.id}/current.pdf`)?.subarray(0, 5).toString("utf8")).toBe("%PDF-");
  await expect(downloadComplianceExport(r, admin, job.id, job.downloadToken!, bind("other-session"))).rejects.toMatchObject({ status: 404, code: "not_found" });
  await expect(readComplianceExport(r, admin, job.id, bind("other-session"))).rejects.toMatchObject({ status: 404 });
  expect(complianceSessionBinding(new Request("http://localhost:3000"), admin.id)).toBe(bind(admin.id));
});

it("packs html, pdf, visible record fields, attachment versions, acknowledgement chain hashes, audit rows, and a signed manifest", async () => {
  const created = await r.create(owner, "Pack page", space);
  const media = randomUUID();
  await db.query("INSERT INTO hs_media(id, page_id, uploader_id, operation_id, name, mime, size, object_key, state, sha256, scanned_at) VALUES($1,$2,$3,$4,'evidence.txt','text/plain',4,'private-object-key','ready',$5,clock_timestamp())", [media, created.id, owner.id, randomUUID(), "c".repeat(64)]);
  const saved = await r.save(created.id, owner, {
    operationId: randomUUID(),
    baseVersion: created.version,
    title: "Pack page",
    document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Pack sentence" }] }, { type: "recordRef", attrs: { nodeVersion: 1, recordId: visibleRecord, collectionId: "contacts", display: "card", fields: ["core:job-title", "core:email"] } }, { type: "file", attrs: { attachmentId: media, title: "Evidence file" } }] }),
  });
  const page = saved.page;
  const fileId = randomUUID();
  const older = randomUUID();
  const newer = randomUUID();
  await db.query("INSERT INTO hs_linked_files(id, workspace_id, tenant_id, name, owner_id, media_id) VALUES($1,$2,$3,'evidence.txt',$4,$5)", [fileId, workspace, tenant, owner.id, media]);
  await db.query("INSERT INTO hs_attachment_versions(id, file_id, workspace_id, tenant_id, version_no, blob_key, checksum, size, mime, name, scan_status, uploader_id) VALUES($1,$2,$3,$4,1,$5,$6,4,'text/plain','old.txt','clean',$7),($8,$2,$3,$4,2,$9,$10,4,'text/plain','evidence.txt','clean',$7)", [older, fileId, workspace, tenant, randomUUID(), "b".repeat(64), owner.id, newer, randomUUID(), "c".repeat(64)]);
  await db.query("UPDATE hs_linked_files SET current_version_id=$2 WHERE id=$1", [fileId, newer]);
  await db.query("INSERT INTO hs_audit(id, actor_id, action, page_id, after_value, correlation_id) VALUES($1,$2,'page.note',$3,$4,$5)", [randomUUID(), admin.id, page.id, JSON.stringify({ secretBody: "SHOULD-NOT-LEAK" }), randomUUID()]);
  const publishedDocument = ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Published sentence" }] }] });
  const manifestPins: unknown[] = [];
  const snapshotHash = createHash("sha256").update(stableStringify({ title: "Pack page", document: publishedDocument, manifest: manifestPins })).digest("hex");
  const publication = randomUUID();
  const review = randomUUID();
  const campaign = randomUUID();
  const assignment = randomUUID();
  const ack = randomUUID();
  await db.query("INSERT INTO hs_document_workflows(page_id, version, reviewers) VALUES($1,1,$2::jsonb)", [page.id, JSON.stringify([admin.id])]);
  await db.query("INSERT INTO hs_document_reviews(id, page_id, source_version, policy_version, submitted_by, title, document, manifest, snapshot_hash, state) VALUES($1,$2,1,1,$3,'Pack page',$4::jsonb,'[]'::jsonb,$5,'pending')", [review, page.id, admin.id, JSON.stringify(publishedDocument), snapshotHash]);
  await db.query("INSERT INTO hs_document_publications(id, page_id, review_id, source_version, title, document, manifest, snapshot_hash, published_by, version_number, bump) VALUES($1,$2,$3,1,'Pack page',$4::jsonb,'[]'::jsonb,$5,$6,1,'major')", [publication, page.id, review, JSON.stringify(publishedDocument), snapshotHash, admin.id]);
  await db.query("UPDATE hs_document_workflows SET publication_id=$2 WHERE page_id=$1", [page.id, publication]);
  await db.query("INSERT INTO hs_ack_campaigns(id, page_id, workspace_id, version_id, version_number, audience, due_at, status, created_by) VALUES($1,$2,$3,$4,1,'[]'::jsonb,clock_timestamp(),'active',$5)", [campaign, page.id, workspace, publication, admin.id]);
  await db.query("INSERT INTO hs_ack_assignments(id, campaign_id, user_id, status) VALUES($1,$2,$3,'acknowledged')", [assignment, campaign, admin.id]);
  const chain = acknowledgementRecordHash({ id: ack, campaignId: campaign, assignmentId: assignment, pageId: page.id, versionId: publication, userId: admin.id, acknowledgedAt: "2026-10-31T12:00:00.000Z", contentHash: "e".repeat(64), ipCountry: null, prevHash: ACK_GENESIS });
  await db.query("INSERT INTO hs_ack_records(id, workspace_id, campaign_id, assignment_id, page_id, version_id, version_number, user_id, acknowledged_at, at_iso, content_hash, prev_hash, hash) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8::timestamptz,$9,$10,$11,$12)", [ack, workspace, campaign, assignment, page.id, publication, admin.id, "2026-10-31T12:00:00.000Z", "2026-10-31T12:00:00.000Z", "e".repeat(64), ACK_GENESIS, chain]);
  const operationId = randomUUID();
  const job = await pack(admin, page.id, { scope: "page", includeDraft: true, allAttachmentVersions: true, operationId });
  const files = await filesOf((await downloadComplianceExport(r, admin, job.id, job.downloadToken!, bind(admin.id))).bytes);
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
  expect(verifyComplianceManifest(manifest, complianceSigningKey())).toBe(true);
  expect(sha256Bytes(files.get("manifest.json")!)).toBe(job.manifestHash);
  for (const entry of manifest.files as { path: string; sha256: string }[]) expect(sha256Bytes(files.get(entry.path)!)).toBe(entry.sha256);
  expect(files.get(`pages/${page.id}/published.html`)!.toString("utf8")).toContain("Published sentence");
  expect(files.get(`pages/${page.id}/draft.html`)!.toString("utf8")).toContain("Pack sentence");
  expect([...files.keys()].some(path => path.endsWith(".pdf"))).toBe(true);
  const packed = textOf(files);
  expect(packed).toContain("Analyst Visible");
  expect(packed).toContain("R-200 Restricted Clinic");
  expect(packed).not.toContain(hiddenEmail);
  expect(packed).not.toContain("private-object-key");
  expect(packed).toContain("evidence.txt");
  expect(packed).toContain("old.txt");
  expect(files.get("acknowledgements.csv")!.toString("utf8")).toContain(chain);
  expect(files.get("audit.csv")!.toString("utf8")).toContain("page.note");
  expect(files.get("audit.csv")!.toString("utf8")).not.toContain("SHOULD-NOT-LEAK");
  expect(job.counts).toMatchObject({ pages: 1, records: 1, acknowledgements: 1 });
  expect(job.counts.attachments).toBeGreaterThan(0);
  const audit = await db.query<{ actor_id: string; after_value: Record<string, unknown> | string }>("SELECT actor_id, after_value FROM hs_audit WHERE action='compliance-export.complete' AND correlation_id=$1", [operationId]);
  const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) as Record<string, unknown> : audit.rows[0].after_value;
  expect(audit.rows[0].actor_id).toBe(admin.id);
  expect(after.scope).toBe("page");
  expect(after.manifestHash).toBe(job.manifestHash);
  expect(after.atIst).toMatch(/IST$/);
  expect(JSON.stringify(after)).not.toContain("Pack sentence");
  expect(JSON.stringify(after)).not.toContain(hiddenEmail);
});

it("omits attachments when the space export policy forbids them and says so in the manifest", async () => {
  const { page } = await saveWithMedia("Policy page", "secret.bin", "object-key-should-not-leak", "f".repeat(64));
  const current = await exportAttachmentPolicy(r, admin, workspace, space);
  const changed = await changeExportAttachmentPolicy(r, admin, workspace, { operationId: randomUUID(), spaceId: space, attachments: false, expectedVersion: current.version });
  expect(changed.attachments).toBe(false);
  try {
    const job = await pack(admin, page.id, { scope: "page" });
    const files = await filesOf((await downloadComplianceExport(r, admin, job.id, job.downloadToken!, bind(admin.id))).bytes);
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    expect(manifest.notes).toContain(ATTACHMENTS_EXCLUDED_NOTE);
    expect([...files.keys()].some(path => path.startsWith("attachments/"))).toBe(false);
    const packed = textOf(files);
    expect(packed).not.toContain("object-key-should-not-leak");
    expect(packed).toContain("Attachment excluded by export policy.");
    expect(job.counts.attachments).toBe(0);
  } finally {
    const now = await exportAttachmentPolicy(r, admin, workspace, space);
    await changeExportAttachmentPolicy(r, admin, workspace, { operationId: randomUUID(), spaceId: space, attachments: true, expectedVersion: now.version });
  }
});

it("leaves out pages and record fields the exporter cannot read", async () => {
  const secret = await savePage("P-200 Secret Title ZZ", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Secret page body ZZ" }] }] });
  const hidden = randomUUID();
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, field_values, created_by, updated_by) VALUES($1,$2,'contacts','Hidden Clinic ZZ','{}'::jsonb,$3,$3)", [hidden, tenant, owner.id]);
  const visible = await savePage("Editor page", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Editor can read this" }] }, { type: "recordRef", attrs: { nodeVersion: 1, recordId: hidden, collectionId: "contacts", display: "chip", fields: [] } }] });
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'editor')", [visible.id, editor.id]);
  const job = await pack(editor, space);
  const packed = textOf(await filesOf((await downloadComplianceExport(r, editor, job.id, job.downloadToken!, bind(editor.id))).bytes));
  expect(packed).toContain("Editor can read this");
  expect(packed).toContain(RESTRICTED_RECORD);
  expect(packed).not.toContain("P-200 Secret Title ZZ");
  expect(packed).not.toContain("Secret page body ZZ");
  expect(packed).not.toContain(secret.id);
  expect(packed).not.toContain("Hidden Clinic ZZ");
  expect(JSON.stringify(job.counts)).not.toContain("omitted");
  const missing = await createComplianceExport(r, editor, workspace, { operationId: randomUUID(), scope: "page", format: "compliance-pack", targetId: randomUUID(), includeDraft: false, includeTrash: false, allAttachmentVersions: false }, bind(editor.id), { renderPdf: pdf }).then(() => null, error => error);
  const denied = await createComplianceExport(r, editor, workspace, { operationId: randomUUID(), scope: "page", format: "compliance-pack", targetId: secret.id, includeDraft: false, includeTrash: false, allAttachmentVersions: false }, bind(editor.id), { renderPdf: pdf }).then(() => null, error => error);
  expect(denied).toMatchObject({ status: missing.status, code: missing.code, message: missing.message });
});

it("aborts a running export when access is revoked and deletes partial files", async () => {
  const parent = await savePage("Revoke parent", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Revoke parent body" }] }] });
  const child = await savePage("Revoke child", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Revoke child body" }] }] }, parent.id);
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$3,'editor'),($2,$3,'editor')", [parent.id, child.id, editor.id]);
  let partial = 0;
  const job = await pack(editor, parent.id, { scope: "tree", format: "html" }, async (tx, index) => {
    if (index !== 1) return;
    partial = (await tx.query("SELECT path FROM hs_compliance_files f JOIN hs_compliance_jobs j ON j.id=f.job_id WHERE j.actor_id=$1 AND j.state='running'", [editor.id])).rows.length;
    await tx.query("UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2", [workspace, editor.id]);
  });
  try {
    expect(partial).toBeGreaterThan(0);
    expect(job.state).toBe("aborted");
    expect(job.downloadToken).toBeNull();
    expect((await db.query("SELECT path FROM hs_compliance_files WHERE job_id=$1", [job.id])).rows).toHaveLength(0);
    expect((await db.query("SELECT id FROM hs_compliance_email_outbox WHERE job_id=$1", [job.id])).rows).toHaveLength(0);
    await expect(downloadComplianceExport(r, editor, job.id, "x".repeat(32), bind(editor.id))).rejects.toMatchObject({ status: 404, message: "Export unavailable" });
  } finally {
    await db.query("UPDATE hs_members SET active=true WHERE workspace_id=$1 AND user_id=$2", [workspace, editor.id]);
  }
});

it("excludes trash unless a restorer asks for it", async () => {
  await savePage("Live beside trash", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Still live" }] }] });
  const trashed = await savePage("Trashed SOP title", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Trashed SOP body" }] }] });
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [trashed.id]);
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'editor')", [trashed.id, editor.id]);
  const editorJob = await pack(editor, space, { includeTrash: true });
  const editorText = textOf(await filesOf((await downloadComplianceExport(r, editor, editorJob.id, editorJob.downloadToken!, bind(editor.id))).bytes));
  expect(editorText).not.toContain("Trashed SOP title");
  expect(editorText).not.toContain("Trashed SOP body");
  const without = await pack(admin, space, { includeTrash: false });
  expect(textOf(await filesOf((await downloadComplianceExport(r, admin, without.id, without.downloadToken!, bind(admin.id))).bytes))).not.toContain("Trashed SOP body");
  const withTrash = await pack(admin, space, { includeTrash: true });
  expect(textOf(await filesOf((await downloadComplianceExport(r, admin, withTrash.id, withTrash.downloadToken!, bind(admin.id))).bytes))).toContain("Trashed SOP body");
  expect(withTrash.counts.pages).toBeGreaterThan(without.counts.pages);
});

it("returns the same not-found response for a foreign workspace download and a missing job", async () => {
  const page = await savePage("Tenant A page", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Workspace A only" }] }] });
  const job = await pack(admin, page.id, { scope: "page" });
  const missing = await downloadComplianceExport(r, outsider, randomUUID(), job.downloadToken!, bind(outsider.id)).then(() => null, error => error);
  const foreign = await downloadComplianceExport(r, outsider, job.id, job.downloadToken!, bind(outsider.id)).then(() => null, error => error);
  expect(foreign).toBeInstanceOf(DocumentError);
  expect(foreign).toMatchObject({ status: missing.status, code: missing.code, message: missing.message });
  expect(foreign.status).toBe(404);
  await expect(createComplianceExport(r, outsider, workspace, { operationId: randomUUID(), scope: "space", format: "compliance-pack", targetId: space, includeDraft: false, includeTrash: false, allAttachmentVersions: false }, bind(outsider.id), { renderPdf: pdf })).rejects.toMatchObject({ status: 404, message: "Export unavailable" });
});
