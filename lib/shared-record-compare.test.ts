import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { localActor as owner, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import { SharedRecordCompareRepository } from "./shared-record-compare";
import { SharedRecordRepository, type RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database, pages: Repository, ctx: RecordContext;
const viewer: Actor = { id: "compare-viewer" }, outsider: Actor = { id: "compare-outsider" };
const authority = { verify: vi.fn(async (c: RecordContext) => ({ subject: c.actor.id, tenantId: c.tenantId, workspaceId: c.workspaceId, active: true, tenantAdministrator: c.actor.id === owner.id, revision: "synthetic-compare-authority-v1" })) };
const records = () => new SharedRecordRepository(pages, authority);
const compare = () => new SharedRecordCompareRepository(pages, authority);
const as = (actor: Actor) => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const [actor, name] of [[viewer, "Compare Viewer"], [outsider, "Compare Outsider"]] as const) {
    await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [actor.id, name]);
    await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)", [actor.id]);
  }
});
beforeEach(async () => {
  vi.mocked(authority.verify).mockClear();
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: "compare-" + crypto.randomUUID() };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, viewer]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [ctx.tenantId, "Synthetic compare tenant"]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [ctx.workspaceId, ctx.tenantId, "Synthetic compare fixture"]);
  for (const collection of ["organisations", "accounts"]) {
    await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,$2,$2,true)", [ctx.tenantId, collection]);
    await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, owner.id, collection, [...recordCapabilities]]);
  }
});
afterAll(async () => db.close());

async function organisation(name: string, values: Record<string, unknown> = {}) {
  return (await records().create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: 1, values })).record;
}
async function account(name: string, parentId: string) {
  return (await records().create(ctx, { operationId: crypto.randomUUID(), collection: "accounts", name, schemaVersion: 1, values: {}, parentOrganisationId: parentId })).record;
}
async function grant(recordId: string, actor: Actor) {
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, recordId, actor.id, ["view"]]);
}
function fieldStatus(payload: { fields: { key: string; status: string }[] }, key: string) {
  return payload.fields.find((field) => field.key === key)?.status;
}

it("omits forbidden fields, formulas and hidden neighbours from the comparison", async () => {
  const secretKey = crypto.randomUUID();
  const formula = crypto.randomUUID();
  const linkKey = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,sensitive,created_by) VALUES($1,'organisations',$2,'Private salary','text',true,$3)", [ctx.tenantId, secretKey, owner.id]);
  await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,created_by) VALUES($1,'organisations',$2,'Related organisations','record',$3)", [ctx.tenantId, linkKey, owner.id]);
  await db.query("INSERT INTO hs_data_formula_fields(tenant_id,collection,field_key,version,definition,sensitive,created_by) VALUES($1,'organisations',$2,1,$3,false,$4)", [ctx.tenantId, formula, JSON.stringify({ id: formula, label: "Secret total", returnKind: "text", expression: { kind: "field", field: secretKey } }), owner.id]);
  const visible = await organisation("Visible partner");
  const secret = await organisation("Secret partner");
  const left = await organisation("Opened left", { "core:notes": "Public note" });
  const right = await organisation("Opened right");
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE tenant_id=$1 AND id=$3", [ctx.tenantId, JSON.stringify({ "core:notes": "Public note", [secretKey]: "hidden-salary-value", [linkKey]: [visible.id, secret.id] }), left.id]);
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE tenant_id=$1 AND id=$3", [ctx.tenantId, JSON.stringify({ [secretKey]: "other-hidden-salary" }), right.id]);
  await grant(left.id, viewer);
  await grant(right.id, viewer);
  await grant(visible.id, viewer);
  const hiddenOwner = JSON.stringify(await compare().compare(ctx, { recordIds: [left.id, right.id] }));
  const hiddenViewer = JSON.stringify(await compare().compare(as(viewer), { recordIds: [left.id, right.id] }));
  for (const payload of [hiddenOwner, hiddenViewer]) {
    expect(payload).not.toContain(secretKey);
    expect(payload).not.toContain(formula);
    expect(payload).not.toContain("Private salary");
    expect(payload).not.toContain("Secret total");
    expect(payload).not.toContain("hidden-salary-value");
    expect(payload).not.toContain("other-hidden-salary");
    expect(payload).toContain("Public note");
    expect(payload).toContain("Visible partner");
    expect(payload).toContain(visible.id);
  }
  expect(hiddenViewer).not.toContain(secret.id);
  expect(hiddenViewer).not.toContain("Secret partner");
  expect(hiddenOwner).toContain(secret.id);
  expect(hiddenOwner).toContain("Secret partner");
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view) VALUES($1,'organisations',$2,$3,true)", [ctx.tenantId, secretKey, viewer.id]);
  const opened = await compare().compare(as(viewer), { recordIds: [left.id, right.id] });
  const revealed = JSON.stringify(opened);
  expect(revealed).toContain("Private salary");
  expect(revealed).toContain("Secret total");
  expect(revealed).toContain("hidden-salary-value");
  expect(revealed).toContain("other-hidden-salary");
  expect(fieldStatus(opened, secretKey)).toBe("changed");
  expect(fieldStatus(opened, formula)).toBe("changed");
  expect(revealed).not.toContain(secret.id);
  expect(revealed).not.toContain("Secret partner");
  await db.query("UPDATE hs_data_records SET state='trashed',before_trash_state='active',deleted_at=statement_timestamp(),trash_deadline=statement_timestamp()+interval '30 days',deleted_by=$3 WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, secret.id, owner.id]);
  const afterTrash = JSON.stringify(await compare().compare(ctx, { recordIds: [left.id, right.id] }));
  expect(afterTrash).not.toContain(secret.id);
  expect(afterTrash).not.toContain("Secret partner");
  expect(afterTrash).toContain("Visible partner");
  expect((await db.query("SELECT field_values->$2 FROM hs_data_records WHERE tenant_id=$1 AND id=$3", [ctx.tenantId, linkKey, left.id])).rows).toHaveLength(1);
});

it("highlights field differences and keeps archived records", async () => {
  const left = await organisation("Left record", { "core:notes": "Left only note" });
  const right = await organisation("Right record", { "core:registration": "REG-9" });
  await db.query("UPDATE hs_data_records SET state='archived' WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, right.id]);
  const result = await compare().compare(ctx, { recordIds: [left.id, right.id] });
  expect(result.mixedCollections).toBe(false);
  expect(result.records.find((record) => record.id === right.id)).toMatchObject({ state: "archived" });
  expect(fieldStatus(result, "name")).toBe("changed");
  expect(fieldStatus(result, "state")).toBe("changed");
  expect(fieldStatus(result, "core:notes")).toBe("only-left");
  expect(fieldStatus(result, "core:registration")).toBe("only-right");
  expect(result.fields.find((field) => field.key === "core:notes")?.values).toEqual([
    { recordId: left.id, present: true, value: "Left only note" },
    { recordId: right.id, present: false },
  ]);
});

it("refuses trashed records the same way record reads do, without returning field values", async () => {
  const kept = await organisation("Kept record", { "core:notes": "Public note" });
  const gone = await organisation("Trashed record", { "core:notes": "Trash secret note" });
  await db.query("UPDATE hs_data_records SET state='trashed',before_trash_state='active',deleted_at=statement_timestamp(),trash_deadline=statement_timestamp()+interval '30 days',deleted_by=$3 WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, gone.id, owner.id]);
  await expect(compare().compare(ctx, { recordIds: [kept.id, gone.id] })).rejects.toMatchObject({ status: 404, code: "record_not_found", message: "Record is restricted or unavailable." });
  await expect(records().get(ctx, gone.id)).rejects.toMatchObject({ status: 404, code: "record_not_found" });
  expect((await records().list(ctx, { collection: "organisations", includeArchived: true })).results.map((record) => record.id)).toEqual([kept.id]);
  expect((await db.query<{ state: string }>("SELECT state FROM hs_data_records WHERE id=$1", [gone.id])).rows).toEqual([{ state: "trashed" }]);
  await expect(compare().compare(as(outsider), { recordIds: [kept.id, gone.id] })).rejects.toMatchObject({ status: 404 });
});

it("omits a parent the viewer cannot open and allows another collection", async () => {
  const parent = await organisation("Secret parent organisation");
  const left = await account("Left account", parent.id);
  const right = await account("Right account", parent.id);
  const other = await organisation("Visible organisation");
  await grant(left.id, viewer);
  await grant(right.id, viewer);
  await grant(other.id, viewer);
  const hidden = JSON.stringify(await compare().compare(as(viewer), { recordIds: [left.id, other.id] }));
  expect(hidden).not.toContain(parent.id);
  expect(hidden).not.toContain("Secret parent organisation");
  expect(JSON.parse(hidden).mixedCollections).toBe(true);
  const ownerView = await compare().compare(ctx, { recordIds: [left.id, right.id] });
  expect(JSON.stringify(ownerView)).toContain("Secret parent organisation");
  expect(fieldStatus(ownerView, "parentOrganisation")).toBe("same");
  await expect(compare().compare(ctx, { recordIds: [left.id] })).rejects.toMatchObject({ status: 400, code: "record_compare_validation" });
  await expect(compare().compare(ctx, { recordIds: [left.id, left.id] })).rejects.toMatchObject({ status: 400, code: "record_compare_validation" });
  await expect(compare().compare(ctx, { recordIds: [left.id, right.id], secret: "hidden-salary-value" })).rejects.toMatchObject({ status: 400, code: "record_compare_validation" });
});
