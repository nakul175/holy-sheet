import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import {
  applyQuickCapture,
  downloadQuickCapture,
  grantQuickCaptureOperator,
  previewQuickCapture,
  quickCaptureCatalogue,
  quickCaptureHistory,
  quickCaptureSourcePreview,
  saveQuickCaptureFieldPolicy,
  saveQuickCapturePolicy,
  searchQuickCapture,
  setQuickCaptureActions,
} from "./quick-capture";

let db: Database;
let r: Repository;
const reader = { id: "capture-reader", name: "Rae Reader" };
const editor = { id: "capture-editor", name: "Eve Editor" };
const quiet = { id: "capture-quiet", name: "Quinn Quiet" };
const outsider = { id: "capture-outsider", name: "Bolt User" };
const observer = { id: "capture-observer", name: "Olive Observer" };
const workspace = "ws-aplyd";
const scheduleId = "00000000-0000-4000-8000-00000000e105";
let tenant = "";
let formId = "";
let visiblePage = "";
let secretPage = "";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [reader, editor, quiet, outsider, observer]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'member'),($1,$5,'observer')", [workspace, reader.id, editor.id, quiet.id, observer.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  const other = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Synthetic Clinic'),($2,'Bolt')", [tenant, other]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, other]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'organisations','Organisations',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'organisations',$3),($1,$4,'organisations',$5),($1,$6,'organisations',$7)", [tenant, owner.id, ["view", "create", "edit", "export", "history"], reader.id, ["view"], editor.id, ["view", "create", "export", "history"]]);
  formId = randomUUID();
  await db.query("INSERT INTO hs_data_intake_forms(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Synthetic organisation intake',$3,$4)", [formId, tenant, JSON.stringify({ purpose: "create", fields: ["core:notes"] }), owner.id]);
  await db.query("INSERT INTO hs_spaces(id, workspace_id, name, directory_visibility) VALUES('space-secret',$1,'Secret space','private')", [workspace]);
  visiblePage = (await r.create(owner, "Visible handbook", "space-product")).id;
  await r.save(visiblePage, owner, { operationId: randomUUID(), baseVersion: 1, title: "Visible handbook", document: doc("HANDBOOKBODY") });
  secretPage = (await r.create(owner, "zzsecretpage", "space-product")).id;
  await r.save(secretPage, owner, { operationId: randomUUID(), baseVersion: 1, title: "zzsecretpage", document: doc("PAGEBODYSECRET") });
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer')", [visiblePage, reader.id]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
  await saveQuickCapturePolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, kinds: ["text", "link", "note"], defaultDestination: "space" });
});
afterAll(async () => db.close());

function doc(text: string) {
  return { type: "doc", content: [{ type: "paragraph", attrs: { id: randomUUID() }, content: [{ type: "text", text }] }] };
}
const html = `<p>Visible note</p><input type="hidden" name="csrf" value="secret-token"><script>document.cookie='session=abc'</script><a href="javascript:alert(1)">click</a><a href="https://example.com/clip">Safe</a><img src="https://tracker.example/pixel.png" alt="Diagram"><img src="https://tracker.example/other.png" alt="Skipped">`;

async function capture(actor: { id: string }, input: Record<string, unknown>, expectedVersion = 1) {
  const preview = await previewQuickCapture(r, actor, workspace, { operationId: randomUUID(), expectedVersion, kind: "note", title: "Clinic note", body: "Visible note", ...input });
  return applyQuickCapture(r, actor, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion: preview.version });
}
async function grants() {
  const [records, collections, pages, parents, schedules] = await Promise.all([
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY 1,2"),
    db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records WHERE parent_organisation_id IS NOT NULL"),
    db.query("SELECT id::text, definition FROM hs_data_periodic_review_schedules ORDER BY 1"),
  ]);
  return JSON.stringify({ records: records.rows, collections: collections.rows, pages: pages.rows, parents: parents.rows, schedules: schedules.rows });
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

it("captures selected text, a link, and a note into a permitted private destination", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("capture must not fetch"));
  try {
    const note = await capture(reader, {});
    expect(note).toMatchObject({ kind: "note", visibility: "private", externalShare: false, sourceAccess: "not-opened", destinationKind: "space" });
    expect(note.sourceStatement).toContain("No external page was fetched");
    const page = await db.query<{ visibility: string; space_id: string }>("SELECT visibility, space_id FROM hs_pages WHERE id=$1", [note.pageId]);
    expect(page.rows[0]).toEqual({ visibility: "private", space_id: "space-private" });
    expect((await db.query("SELECT 1 FROM hs_grants WHERE page_id=$1", [note.pageId])).rows).toEqual([]);
    const linked = await capture(reader, { kind: "link", title: "Clinic link", body: "Safe", sourceUrl: "https://example.com/clip", sourceTitle: "Public hours" });
    expect(linked.body).toContain("https://example.com/clip");
    expect(linked.body).toContain("not opened");
    expect(linked.body).not.toContain("HANDBOOKBODY");
    const preview = await previewQuickCapture(r, reader, workspace, { operationId: randomUUID(), expectedVersion: 1, kind: "text", title: "From the handbook", body: "selected sentence", sourcePageId: visiblePage, sourceTitle: "Visible handbook" });
    expect(preview.sourceAccess).toBe("permitted");
    expect(preview.review).toContain("private");
    const applied = await applyQuickCapture(r, reader, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion: preview.version });
    expect(applied.body).toContain("selected sentence");
    expect(applied.body).not.toContain("HANDBOOKBODY");
    const intake = await capture(editor, { kind: "note", title: "Intake note", body: "From intake", destinationKind: "intake", destinationId: formId });
    expect(intake).toMatchObject({ destinationKind: "intake", recordId: expect.any(String), pageId: null, externalShare: false });
    expect((await db.query("SELECT 1 FROM hs_data_record_grants WHERE record_id=$1", [intake.recordId])).rows).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

it("enforces create, link, and upload rules and does not inherit external sharing", async () => {
  const beforePages = num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_pages")).rows[0].n);
  const beforeMedia = num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_media")).rows[0].n);
  await expect(capture(reader, { destinationKind: "space", destinationId: "space-secret" })).rejects.toMatchObject({ code: "quick_capture_destination" });
  await expect(capture(reader, { destinationKind: "intake", destinationId: formId })).rejects.toMatchObject({ code: "quick_capture_destination" });
  await expect(previewQuickCapture(r, reader, workspace, { operationId: randomUUID(), expectedVersion: 1, kind: "link", title: "Bad", sourceUrl: "javascript:alert(1)" })).rejects.toMatchObject({ code: "quick_capture_link" });
  await expect(previewQuickCapture(r, observer, workspace, { operationId: randomUUID(), expectedVersion: 1, kind: "note", title: "No", body: "No" })).rejects.toMatchObject({ code: "not_found" });
  expect(num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_pages")).rows[0].n)).toBe(beforePages);
  expect(num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_media")).rows[0].n)).toBe(beforeMedia);
  const saved = await capture(reader, { body: html, assets: [{ name: "Diagram", selected: true }, { name: "Skipped", selected: false }] });
  expect(saved.body).toContain("Visible note");
  expect(saved.body).toContain("Selected asset: Diagram");
  expect(saved.assets).toEqual([{ name: "Diagram", imported: true, fetched: false }]);
  expect(JSON.stringify(saved)).not.toContain("secret-token");
  expect(JSON.stringify(saved)).not.toContain("tracker.example");
  expect(JSON.stringify(saved)).not.toContain("document.cookie");
  expect(JSON.stringify(saved)).not.toContain("javascript:");
  const detail = await db.query("SELECT detail FROM hs_quick_capture_previews ORDER BY created_at DESC LIMIT 1");
  expect(JSON.stringify(detail.rows[0].detail)).not.toContain("secret-token");
  expect(num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_media")).rows[0].n)).toBe(beforeMedia);
  const page = await db.query<{ visibility: string }>("SELECT visibility FROM hs_pages WHERE id=$1", [saved.pageId]);
  expect(page.rows[0].visibility).toBe("private");
  expect((await db.query("SELECT subject FROM hs_grants WHERE page_id=$1", [saved.pageId])).rows).toEqual([]);
});

it("reports an unavailable source truthfully and dedupes the retry", async () => {
  const operationId = randomUUID();
  const before = num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_pages")).rows[0].n);
  const input = { operationId, expectedVersion: 1, kind: "text" as const, title: "Hidden source", body: "Visible note", sourcePageId: secretPage, sourceUrl: "https://example.com/hidden" };
  await expect(previewQuickCapture(r, reader, workspace, input)).rejects.toMatchObject({ code: "quick_capture_source", message: expect.stringMatching(/Nothing was fetched/) });
  await expect(previewQuickCapture(r, reader, workspace, input)).rejects.toMatchObject({ code: "quick_capture_source" });
  expect(num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_quick_capture_drafts WHERE actor_id=$1", [reader.id])).rows[0].n)).toBe(1);
  expect(num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_pages")).rows[0].n)).toBe(before);
  const catalogue = await quickCaptureCatalogue(r, reader, workspace);
  expect(JSON.stringify(catalogue)).not.toContain("PAGEBODYSECRET");
  expect(JSON.stringify(catalogue)).not.toContain("zzsecretpage");
  expect(catalogue.drafts.some(draft => draft.payload.text === "Visible note" && draft.payload.sourceAccess === "unavailable")).toBe(true);
  await expect(previewQuickCapture(r, reader, workspace, { ...input, operationId: randomUUID(), body: "Different note" })).rejects.toMatchObject({ code: "quick_capture_source" });
  expect(catalogue.offline).toContain("local draft");
});

it("enforces tenant, record, field, and action checks without turning configuration into access", async () => {
  const before = await grants();
  await grantQuickCaptureOperator(r, owner, workspace, { operationId: randomUUID(), userId: quiet.id });
  await setQuickCaptureActions(r, owner, workspace, { operationId: randomUUID(), userId: editor.id, expectedVersion: 0, actions: ["search"] });
  expect(await grants()).toBe(before);
  const found = (await searchQuickCapture(r, reader, workspace, "intake note")).results[0];
  expect(found.title).toBe("Intake note");
  expect(JSON.stringify(await searchQuickCapture(r, quiet, workspace, "intake"))).not.toContain("Intake note");
  expect(JSON.stringify(await searchQuickCapture(r, quiet, workspace, "clinic"))).not.toContain("Clinic note");
  expect(JSON.stringify(await searchQuickCapture(r, quiet, workspace, "secret"))).not.toContain("zzsecretpage");
  await expect(searchQuickCapture(r, outsider, workspace, "clinic")).rejects.toMatchObject({ code: "not_found" });
  expect((await searchQuickCapture(r, outsider, "ws-b", "clinic")).results).toEqual([]);
  const readable = await quickCaptureSourcePreview(r, reader, workspace, found.id);
  expect(readable.text).toContain("From intake");
  expect(readable.externalShare).toBe(false);
  await expect(downloadQuickCapture(r, editor, workspace, { operationId: randomUUID(), captureId: found.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(quickCaptureHistory(r, editor, workspace, found.id)).rejects.toMatchObject({ code: "action_forbidden" });
  await saveQuickCaptureFieldPolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, sensitive: true, access: [{ userId: owner.id, canView: true, canWrite: true, canHistory: true }, { userId: editor.id, canView: true, canWrite: true, canHistory: true }] });
  expect((await searchQuickCapture(r, reader, workspace, "intake")).results).toEqual([]);
  await expect(quickCaptureSourcePreview(r, reader, workspace, found.id)).rejects.toMatchObject({ code: "not_found" });
  const ownerView = await quickCaptureSourcePreview(r, owner, workspace, found.id);
  expect(ownerView.text).toContain("From intake");
  expect(ownerView.text).not.toContain("secret-token");
  await saveQuickCaptureFieldPolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 1, sensitive: false, access: [] });
  await setQuickCaptureActions(r, owner, workspace, { operationId: randomUUID(), userId: editor.id, expectedVersion: 1, actions: ["search", "download", "history", "preview", "commit", "capture"] });
  expect(await grants()).toBe(before);
});

it("versions configuration, keeps a recoverable draft, and audits actor, source, time, and operation", async () => {
  const before = await grants();
  await expect(saveQuickCapturePolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 1, kinds: ["note"], defaultDestination: "space", visibility: "space" })).rejects.toMatchObject({ code: "quick_capture_sharing" });
  await expect(saveQuickCapturePolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 1, kinds: ["note"], defaultDestination: "space", inheritExternal: true })).rejects.toMatchObject({ code: "quick_capture_sharing" });
  await expect(saveQuickCapturePolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, kinds: ["note"], defaultDestination: "space" })).rejects.toMatchObject({ code: "quick_capture_conflict" });
  const catalogue = await quickCaptureCatalogue(r, owner, workspace);
  expect(catalogue.policy?.version).toBe(1);
  expect(catalogue.policy?.recoverableDraft?.kinds).toEqual(["note"]);
  expect(catalogue.policy?.visibility).toBe("private");
  expect(catalogue.policy?.offlinePolicy).toBe("local-draft");
  const operationId = randomUUID();
  const saved = await saveQuickCapturePolicy(r, owner, workspace, { operationId, expectedVersion: 1, kinds: ["text", "link", "note"], defaultDestination: "space" });
  const replayed = await saveQuickCapturePolicy(r, owner, workspace, { operationId, expectedVersion: 1, kinds: ["text", "link", "note"], defaultDestination: "space" });
  expect(replayed).toMatchObject({ replayed: true, version: saved.version });
  const preview = await previewQuickCapture(r, editor, workspace, { operationId: randomUUID(), expectedVersion: saved.version, kind: "note", title: "Audited note", body: "Kept once", destinationKind: "intake", destinationId: formId });
  const applyId = randomUUID();
  const first = await applyQuickCapture(r, editor, workspace, { operationId: applyId, previewId: preview.previewId, expectedVersion: preview.version });
  const duplicate = await applyQuickCapture(r, editor, workspace, { operationId: applyId, previewId: preview.previewId, expectedVersion: preview.version });
  expect(duplicate).toMatchObject({ replayed: true, id: first.id });
  expect(num((await db.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_quick_captures WHERE id=$1", [first.id])).rows[0].n)).toBe(1);
  await expect(applyQuickCapture(r, editor, workspace, { operationId: applyId, previewId: preview.previewId, expectedVersion: preview.version + 1 })).rejects.toMatchObject({ code: "operation_mismatch" });
  const history = await quickCaptureHistory(r, editor, workspace, first.id);
  expect(history.events.some(event => event.action === "commit" && event.source === "quick-capture" && event.actorId === editor.id && /IST$/.test(event.atIst))).toBe(true);
  const downloaded = await downloadQuickCapture(r, editor, workspace, { operationId: randomUUID(), captureId: first.id, expectedVersion: first.version });
  expect(downloaded.body).toContain("Audience: private");
  expect(downloaded.body).toContain("External sharing: none");
  expect(downloaded.body).not.toContain("secret-token");
  const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='quick-capture.commit' AND subject_id=$1", [first.id]);
  const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
  expect(audit.rows[0].actor_id).toBe(editor.id);
  expect(after).toMatchObject({ source: "quick-capture", visibility: "private", externalShare: false });
  expect(after.atIst).toMatch(/IST$/);
  expect(after.operationId).toBe(applyId);
  await expect(db.query("UPDATE hs_quick_capture_revisions SET body='rewritten' WHERE capture_id=$1", [first.id])).rejects.toThrow(/immutable/i);
  const sql = await readFile("db/131_quick_capture.sql", "utf8");
  const executable = sql.replace(/--.*$/gm, "");
  expect(executable).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(executable).not.toMatch(/parent_organisation_id/);
  expect(executable).not.toMatch(/release\.py/);
  for (const statement of statements(sql)) await db.query(statement);
  expect(await grants()).toBe(before);
  expect((await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).rows[0].definition).toMatchObject({ paused: true });
});

function num(value: number | string) { return Number(value); }
