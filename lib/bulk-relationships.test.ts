import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { localActor as owner, type Actor } from "./auth";
import { BulkRelationshipRepository } from "./bulk-relationships";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import { SharedRecordRepository, type CurrentSuiteTenantAuthority, type RecordContext } from "./shared-records";
import { recordCapabilities, standardCollections } from "./shared-record-types";

let db: Database;
let pages: Repository;
let data: SharedRecordRepository;
let bulk: BulkRelationshipRepository;
const tenant = crypto.randomUUID();
const otherTenant = crypto.randomUUID();
const viewer = { id: "bulk-viewer" };
const partial = { id: "bulk-partial" };
const historian = { id: "bulk-historian" };
const proof = (c: RecordContext) => ({ subject: c.actor.id, tenantId: c.tenantId, workspaceId: c.workspaceId, active: true, tenantAdministrator: c.actor.id === owner.id, revision: "synthetic-bulk-v1" });
const authority: CurrentSuiteTenantAuthority = { verify: vi.fn(async (c) => proof(c)) };
const context = (actor: Actor = owner, tenantId = tenant, workspaceId = "ws-aplyd"): RecordContext => ({ actor, tenantId, workspaceId });
const request = (collection = "organisations", patch: Record<string, unknown> = {}) => ({ operationId: crypto.randomUUID(), collection, name: "Synthetic " + crypto.randomUUID(), schemaVersion: 1, values: {}, ...patch });

async function create(collection = "organisations", patch: Record<string, unknown> = {}) {
  return (await data.create(context(), request(collection, patch))).record;
}
function selection(sourceIds: string[], targetId: string, patch: Record<string, unknown> = {}) {
  return { sourceIds, kind: "contact-account" as const, operation: "add" as const, targetId, role: "", primary: false, status: "active" as const, ...patch };
}
async function links(sourceId: string) {
  return db.query<{ kind: string; target_id: string; role: string; is_primary: boolean }>("SELECT kind,target_id,role,is_primary FROM hs_data_relationships WHERE tenant_id=$1 AND source_id=$2 ORDER BY kind,target_id", [tenant, sourceId]);
}

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const actor of [viewer, partial, historian]) {
    await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
    await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)", [actor.id]);
  }
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-data-other','Other synthetic workspace')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-data-other',$1)", [owner.id]);
  for (const [id, workspace] of [[tenant, "ws-aplyd"], [otherTenant, "ws-data-other"]] as const) {
    await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [id, "Synthetic suite tenant"]);
    await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [workspace, id, "Isolated bulk test mapping"]);
    for (const collection of standardCollections) {
      await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,$2,$2,true)", [id, collection]);
      await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,$3,$4)", [id, owner.id, collection, [...recordCapabilities]]);
    }
  }
  data = new SharedRecordRepository(pages, authority);
  bulk = new BulkRelationshipRepository(pages, authority);
});
beforeEach(() => {
  vi.mocked(authority.verify).mockReset().mockImplementation(async (c) => proof(c));
});
afterAll(async () => db.close());

function statements(sql: string) {
  const parts: string[] = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if ((line.split("$$").length - 1) % 2 === 1) dollar = !dollar;
    if (!dollar && line.trim().endsWith(";")) {
      const statement = current.trim();
      if (statement.replace(/^\s*--.*$/gm, "").trim()) parts.push(statement);
      current = "";
    }
  }
  return parts;
}

it("replays the bulk relationship migration", async () => {
  const replay = statements(await readFile("db/098_bulk_relationships.sql", "utf8"));
  for (const statement of replay) await db.query(statement);
  for (const statement of replay) await db.query(statement);
  expect((await db.query("SELECT to_regclass('public.hs_data_relationship_batches') AS name")).rows[0].name).toBe("hs_data_relationship_batches");
});

it("previews and applies an add without duplicating an unchanged link on retry", async () => {
  const org = await create();
  const account = await create("accounts", { parentOrganisationId: org.id });
  const first = await create("contacts");
  const second = await create("contacts");
  await db.query("UPDATE hs_data_records SET field_values=$2 WHERE id=$1", [first.id, JSON.stringify({ "core:email": "hidden-bulk@example.org" })]);
  const grants = await db.query("SELECT count(*)::int AS n FROM hs_data_record_grants WHERE tenant_id=$1", [tenant]);
  const input = selection([first.id, second.id], account.id, { role: "Buyer" });
  const before = await links(first.id);
  const preview = await bulk.preview(context(), input);
  expect(await links(first.id)).toEqual(before);
  expect(preview.legalPartiesWillChange).toBe(false);
  expect(preview.counts).toEqual({ success: 2, skipped: 0, error: 0 });
  expect(JSON.stringify(preview)).not.toContain("hidden-bulk@example.org");
  const operationId = crypto.randomUUID();
  const applied = await bulk.execute(context(), { ...input, operationId, previewToken: preview.previewToken, confirmed: true });
  expect(applied.replayed).toBe(false);
  expect(applied.counts).toEqual({ success: 2, skipped: 0, error: 0 });
  expect((await links(first.id)).rows).toEqual([{ kind: "contact-account", target_id: account.id, role: "Buyer", is_primary: false }]);
  expect((await links(second.id)).rows).toHaveLength(1);
  const again = await bulk.execute(context(), { ...input, operationId, previewToken: preview.previewToken, confirmed: true });
  expect(again.replayed).toBe(true);
  expect((await links(first.id)).rows).toHaveLength(1);
  const repeat = await bulk.preview(context(), input);
  expect(repeat.rows.every((row) => row.outcome === "skipped" && row.code === "unchanged")).toBe(true);
  const skipped = await bulk.execute(context(), { ...input, operationId: crypto.randomUUID(), previewToken: repeat.previewToken, confirmed: true });
  expect(skipped.counts.skipped).toBe(2);
  expect((await links(first.id)).rows).toHaveLength(1);
  expect(await db.query("SELECT count(*)::int AS n FROM hs_data_record_grants WHERE tenant_id=$1", [tenant])).toEqual(grants);
  const audit = JSON.stringify((await db.query("SELECT action, after_value FROM hs_audit WHERE correlation_id=$1", [operationId])).rows);
  expect(audit).toContain(applied.batchId);
  expect(audit).toContain("shared-record.relationship-batch");
  expect(audit).not.toContain("hidden-bulk@example.org");
  const download = await bulk.download(context(), applied.batchId);
  expect(download.body).toContain(first.id);
  expect(download.body).not.toContain("hidden-bulk@example.org");
  await expect(bulk.execute(context(), { ...input, operationId, targetId: org.id, previewToken: preview.previewToken, confirmed: true })).rejects.toMatchObject({ code: "operation_mismatch" });
});

it("refuses a stale preview and a selection over 1000 or with duplicates", async () => {
  const org = await create();
  const account = await create("accounts", { parentOrganisationId: org.id });
  const contact = await create("contacts");
  const input = selection([contact.id], account.id);
  const preview = await bulk.preview(context(), input);
  await db.query("UPDATE hs_data_records SET version=version+1 WHERE id=$1", [contact.id]);
  await expect(bulk.execute(context(), { ...input, operationId: crypto.randomUUID(), previewToken: preview.previewToken, confirmed: true })).rejects.toMatchObject({ code: "record_relationship_preview_stale" });
  expect((await links(contact.id)).rows).toEqual([]);
  await expect(bulk.preview(context(), selection(Array.from({ length: 1001 }, () => crypto.randomUUID()), account.id))).rejects.toMatchObject({ code: "record_relationship_selection_limit" });
  await expect(bulk.preview(context(), selection([contact.id, contact.id], account.id))).rejects.toMatchObject({ code: "record_relationship_validation" });
  await expect(bulk.execute(context(), { ...input, operationId: crypto.randomUUID(), previewToken: "ab".repeat(32), confirmed: false })).rejects.toMatchObject({ code: "record_relationship_validation" });
});

it("denies every affected end and does not reveal records the actor cannot view", async () => {
  const org = await create();
  const visible = await create("accounts", { parentOrganisationId: org.id });
  const secret = await create("accounts", { parentOrganisationId: org.id });
  const allowed = await create("contacts");
  const limited = await create("contacts");
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4),($1,$5,$3,$6),($1,$7,$3,$8)", [tenant, visible.id, partial.id, ["view", "link"], allowed.id, ["view", "edit", "link", "bulk"], limited.id, ["view", "edit", "link"]]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [tenant, allowed.id, historian.id, ["view", "history"]]);
  const missingId = crypto.randomUUID();
  const input = selection([allowed.id, limited.id, missingId], visible.id);
  const preview = await bulk.preview(context(partial), input);
  expect(preview.rows.map((row) => [row.sourceId, row.outcome, row.code])).toEqual([
    [allowed.id, "success", "applied"],
    [limited.id, "error", "record_forbidden"],
    [missingId, "error", "record_not_found"],
  ]);
  expect(JSON.stringify(preview)).not.toContain(secret.id);
  const applied = await bulk.execute(context(partial), { ...input, operationId: crypto.randomUUID(), previewToken: preview.previewToken, confirmed: true });
  expect(applied.counts).toEqual({ success: 1, skipped: 0, error: 2 });
  expect((await links(allowed.id)).rows).toHaveLength(1);
  expect((await links(limited.id)).rows).toEqual([]);
  const seen = await bulk.batchHistory(context(historian), applied.batchId);
  expect(seen.rows.map((row) => row.sourceId)).toEqual([allowed.id]);
  expect(seen.hiddenRows).toBe(true);
  expect(JSON.stringify(seen)).not.toContain(limited.id);
  expect(JSON.stringify(seen)).not.toContain(missingId);
  expect(JSON.stringify(seen)).not.toContain(secret.id);
  const found = await bulk.searchTargets(context(partial), { kind: "contact-account", query: "" });
  expect(found.results.map((row) => row.id)).toEqual([visible.id]);
  const foreign = (await data.create(context(owner, otherTenant, "ws-data-other"), request("accounts", { parentOrganisationId: (await data.create(context(owner, otherTenant, "ws-data-other"), request())).record.id }))).record;
  await expect(bulk.preview(context(), selection([allowed.id], foreign.id))).rejects.toMatchObject({ status: 404 });
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'accounts',$3),($1,$2,'contacts',$3) ON CONFLICT DO NOTHING", [tenant, viewer.id, ["view"]]);
  await expect(bulk.preview(context(viewer), selection([allowed.id], visible.id))).rejects.toMatchObject({ status: 403 });
});

it("keeps account one-parent and contract legal-party rules, including a mixed batch", async () => {
  const orgA = await create("organisations", { name: "Legal A " + crypto.randomUUID() });
  const orgB = await create("organisations", { name: "Legal B " + crypto.randomUUID() });
  const account = await create("accounts", { parentOrganisationId: orgA.id });
  const covered = await create("contracts", { legalOrganisationIds: [orgA.id], accountIds: [account.id] });
  await db.query("INSERT INTO hs_data_references(id,tenant_id,record_id,source_app,source_type,source_id) VALUES($1,$2,$3,'sho','project','project-bulk')", [crypto.randomUUID(), tenant, account.id]);
  const parentInput = selection([account.id], orgB.id, { kind: "parent-organisation", operation: "replace", role: "", primary: false });
  const parentPreview = await bulk.preview(context(), parentInput);
  expect(parentPreview.legalPartiesWillChange).toBe(false);
  expect(parentPreview.rows[0].affectedContracts).toEqual([{ id: covered.id, name: covered.name }]);
  expect(parentPreview.rows[0].contextReferences).toEqual(expect.arrayContaining([{ recordId: account.id, sourceApp: "sho", sourceType: "project", sourceId: "project-bulk" }]));
  expect(parentPreview.rows[0].deletionConstraints.some((item) => item.code === "deletion_blocked")).toBe(true);
  expect(parentPreview.rows[0].currentParent).toEqual({ id: orgA.id, name: orgA.name });
  const moved = await bulk.execute(context(), { ...parentInput, operationId: crypto.randomUUID(), previewToken: parentPreview.previewToken, confirmed: true });
  expect(moved.rows[0].outcome).toBe("success");
  expect((await db.query<{ parent_organisation_id: string }>("SELECT parent_organisation_id FROM hs_data_records WHERE id=$1", [account.id])).rows[0].parent_organisation_id).toBe(orgB.id);
  expect((await links(covered.id)).rows.find((row) => row.kind === "contract-legal-party")?.target_id).toBe(orgA.id);
  const addParent = await bulk.preview(context(), selection([account.id], orgA.id, { kind: "parent-organisation", operation: "add" }));
  expect(addParent.rows[0]).toMatchObject({ outcome: "error", code: "account_one_parent" });
  const removeParent = await bulk.preview(context(), selection([account.id], orgB.id, { kind: "parent-organisation", operation: "remove" }));
  expect(removeParent.rows[0]).toMatchObject({ outcome: "error", code: "account_one_parent" });
  await bulk.execute(context(), { ...selection([account.id], orgA.id, { kind: "parent-organisation", operation: "add" }), operationId: crypto.randomUUID(), previewToken: addParent.previewToken, confirmed: true });
  expect((await db.query<{ parent_organisation_id: string }>("SELECT parent_organisation_id FROM hs_data_records WHERE id=$1", [account.id])).rows[0].parent_organisation_id).toBe(orgB.id);

  const only = await create("contracts", { legalOrganisationIds: [orgA.id] });
  const both = await create("contracts", { legalOrganisationIds: [orgA.id, orgB.id] });
  const removal = selection([only.id, both.id], orgA.id, { kind: "contract-legal-party", operation: "remove" });
  const removalPreview = await bulk.preview(context(), removal);
  expect(removalPreview.rows.map((row) => row.outcome)).toEqual(["error", "success"]);
  const removed = await bulk.execute(context(), { ...removal, operationId: crypto.randomUUID(), previewToken: removalPreview.previewToken, confirmed: true });
  expect(removed.counts).toEqual({ success: 1, skipped: 0, error: 1 });
  expect((await links(only.id)).rows.filter((row) => row.kind === "contract-legal-party")).toHaveLength(1);
  expect((await links(both.id)).rows.filter((row) => row.kind === "contract-legal-party").map((row) => row.target_id)).toEqual([orgB.id]);
});

it("replaces many account links and refuses a second primary", async () => {
  const org = await create();
  const accountA = await create("accounts", { parentOrganisationId: org.id });
  const accountB = await create("accounts", { parentOrganisationId: org.id });
  const accountC = await create("accounts", { parentOrganisationId: org.id });
  const contact = await create("contacts");
  for (const [target, primary] of [[accountA, true], [accountB, false]] as const) {
    const preview = await bulk.preview(context(), selection([contact.id], target.id, { primary, role: primary ? "Buyer" : "" }));
    await bulk.execute(context(), { ...selection([contact.id], target.id, { primary, role: primary ? "Buyer" : "" }), operationId: crypto.randomUUID(), previewToken: preview.previewToken, confirmed: true });
  }
  const secondPrimary = await bulk.preview(context(), selection([contact.id], accountC.id, { primary: true }));
  expect(secondPrimary.rows[0]).toMatchObject({ outcome: "error", code: "record_relationship_cardinality" });
  await bulk.execute(context(), { ...selection([contact.id], accountC.id, { primary: true }), operationId: crypto.randomUUID(), previewToken: secondPrimary.previewToken, confirmed: true });
  expect((await links(contact.id)).rows.filter((row) => row.is_primary)).toHaveLength(1);
  const replacement = selection([contact.id], accountC.id, { operation: "replace", role: "Owner" });
  const preview = await bulk.preview(context(), replacement);
  expect(preview.rows[0].outcome).toBe("success");
  await bulk.execute(context(), { ...replacement, operationId: crypto.randomUUID(), previewToken: preview.previewToken, confirmed: true });
  expect((await links(contact.id)).rows).toEqual([{ kind: "contact-account", target_id: accountC.id, role: "Owner", is_primary: false }]);
});

it("versions recoverable drafts and refuses a silent overwrite", async () => {
  const draftId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const payload = { collection: "contacts" as const, sourceIds: [crypto.randomUUID()], kind: "contact-account" as const, operation: "add" as const, targetId: "", role: "Buyer", primary: false, status: "active" as const };
  const saved = await bulk.saveDraft(context(), { draftId, operationId, expectedVersion: 0, payload });
  expect(saved).toMatchObject({ version: 1, replayed: false });
  expect(await bulk.saveDraft(context(), { draftId, operationId, expectedVersion: 0, payload })).toMatchObject({ version: 1, replayed: true });
  await expect(bulk.saveDraft(context(), { draftId, operationId: crypto.randomUUID(), expectedVersion: 0, payload })).rejects.toMatchObject({ code: "record_relationship_draft_conflict" });
  const next = { ...payload, role: "Sponsor" };
  const updated = await bulk.saveDraft(context(), { draftId, operationId: crypto.randomUUID(), expectedVersion: 1, payload: next });
  expect(updated.version).toBe(2);
  expect((await bulk.readDraft(context(), draftId)).payload).toMatchObject({ role: "Sponsor" });
  expect((await bulk.listDrafts(context())).drafts.some((draft) => draft.draftId === draftId)).toBe(true);
  const discardOperation = crypto.randomUUID();
  expect(await bulk.discardDraft(context(), { draftId, operationId: discardOperation, expectedVersion: 2 })).toMatchObject({ discarded: true, replayed: false });
  expect(await bulk.discardDraft(context(), { draftId, operationId: discardOperation, expectedVersion: 2 })).toMatchObject({ discarded: true, replayed: true });
  await expect(bulk.readDraft(context(), draftId)).rejects.toMatchObject({ status: 404 });
  expect((await bulk.listDrafts(context())).drafts.some((draft) => draft.draftId === draftId)).toBe(false);
});
