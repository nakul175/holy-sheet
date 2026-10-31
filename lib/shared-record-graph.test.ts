import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import { localActor as owner, type Actor } from "./auth";
import { acceptedRecordGraph } from "./record-graph-contract";
import { SharedRecordGraphRepository } from "./shared-record-graph";
import { SharedRecordRelationshipRepository } from "./shared-record-relationships";
import { SharedRecordRepository, type RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database, pages: Repository, ctx: RecordContext;
const viewer: Actor = { id: "graph-viewer" }, outsider: Actor = { id: "graph-outsider" };
const authority = { verify: vi.fn(async (c: RecordContext) => ({ subject: c.actor.id, tenantId: c.tenantId, workspaceId: c.workspaceId, active: true, tenantAdministrator: c.actor.id === owner.id, revision: "synthetic-graph-authority-v1" })) };
const records = () => new SharedRecordRepository(pages, authority);
const graph = () => new SharedRecordGraphRepository(pages, authority);
const relationships = () => new SharedRecordRelationshipRepository(pages, authority);
const as = (actor: Actor) => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const [actor, name] of [[viewer, "Graph Viewer"], [outsider, "Graph Outsider"]] as const) {
    await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [actor.id, name]);
    await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)", [actor.id]);
  }
});
beforeEach(async () => {
  vi.mocked(authority.verify).mockClear();
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: "graph-" + crypto.randomUUID() };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, viewer]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES($1,$2,'Graph pages')", [ctx.workspaceId + "-space", ctx.workspaceId]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [ctx.tenantId, "Synthetic graph tenant"]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [ctx.workspaceId, ctx.tenantId, "Synthetic graph fixture"]);
  for (const collection of ["organisations", "accounts", "contacts", "employees", "contracts"]) {
    await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,$2,$2,true)", [ctx.tenantId, collection]);
    await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, owner.id, collection, [...recordCapabilities]]);
  }
});
afterAll(async () => db.close());

async function organisation(name: string) {
  return (await records().create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: 1, values: {} })).record;
}
async function account(name: string, parentId: string) {
  return (await records().create(ctx, { operationId: crypto.randomUUID(), collection: "accounts", name, schemaVersion: 1, values: {}, parentOrganisationId: parentId })).record;
}
async function contact(name: string) {
  return (await records().create(ctx, { operationId: crypto.randomUUID(), collection: "contacts", name, schemaVersion: 1, values: {} })).record;
}
async function grant(recordId: string, actor: Actor) {
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, recordId, actor.id, ["view"]]);
}
function names(value: unknown) {
  return acceptedRecordGraph(value)?.nodes.map((node) => node.label) ?? [];
}

it("opens a graph of visible records, parents, incoming links and documents", async () => {
  const org = await organisation("Visible organisation"), hiddenOrg = await organisation("Hidden organisation"), covered = await account("Visible account", org.id), person = await contact("Visible contact");
  await relationships().mutateRelationship(ctx, person.id, { operationId: crypto.randomUUID(), expectedVersion: person.version, kind: "contact-account", targetId: covered.id, action: "upsert", role: "Buyer", primary: true, status: "active" });
  const pageId = "graph-visible-page";
  await db.query("INSERT INTO hs_pages(id,workspace_id,space_id,owner_id,title) VALUES($1,$2,$3,$4,$5)", [pageId, ctx.workspaceId, ctx.workspaceId + "-space", owner.id, "Visible graph brief"]);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')", [pageId, viewer.id]);
  await db.query("INSERT INTO hs_data_documents(id,tenant_id,record_id,page_id,created_by) VALUES($1,$2,$3,$4,$5)", [crypto.randomUUID(), ctx.tenantId, person.id, pageId, owner.id]);
  await grant(person.id, viewer);
  await grant(covered.id, viewer);
  await grant(org.id, viewer);
  const seen = await graph().graph(as(viewer), person.id);
  expect(seen.focalId).toBe(person.id);
  expect(names(seen)).toEqual(expect.arrayContaining(["Visible contact", "Visible account", "Visible graph brief"]));
  expect(seen.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "contact-account", fromId: person.id, toId: covered.id, role: "Buyer", primary: true, status: "active" })]));
  const accountGraph = await graph().graph(as(viewer), covered.id);
  expect(accountGraph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "contact-account", fromId: person.id, toId: covered.id }),
    expect.objectContaining({ kind: "parent-organisation", fromId: covered.id, toId: org.id }),
  ]));
  const orgGraph = await graph().graph(as(viewer), org.id);
  expect(orgGraph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "parent-organisation", fromId: covered.id, toId: org.id })]));
  expect(JSON.stringify(seen)).not.toContain(hiddenOrg.id);
  expect(JSON.stringify(seen)).not.toContain("Hidden organisation");
  expect(JSON.stringify(acceptedRecordGraph(seen))).not.toContain("hiddenCount");
});

it("omits forbidden records, sensitive fields and inaccessible documents without revealing them", async () => {
  const org = await organisation("Field owner"), visible = await organisation("Permitted partner"), secret = await organisation("Secret field partner"), parent = await organisation("Secret parent organisation"), child = await account("Secret child account", parent.id), person = await contact("Secret incoming contact"), focal = await account("Opened account", parent.id);
  const fieldKey = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,sensitive,created_by) VALUES($1,'organisations',$2,'Confidential partners','record',true,$3)", [ctx.tenantId, fieldKey, owner.id]);
  const referrer = await organisation("Secret referrer"), visibleReferrer = await organisation("Visible referrer");
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE tenant_id=$1 AND id=$3", [ctx.tenantId, JSON.stringify({ [fieldKey]: [visible.id, secret.id] }), org.id]);
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE tenant_id=$1 AND id=ANY($3::uuid[])", [ctx.tenantId, JSON.stringify({ [fieldKey]: [org.id] }), [referrer.id, visibleReferrer.id]]);
  await relationships().mutateRelationship(ctx, person.id, { operationId: crypto.randomUUID(), expectedVersion: person.version, kind: "contact-account", targetId: focal.id, action: "upsert", role: "Secret role", primary: true, status: "inactive" });
  const pageId = "graph-secret-page";
  await db.query("INSERT INTO hs_pages(id,workspace_id,space_id,owner_id,title) VALUES($1,$2,$3,$4,$5)", [pageId, ctx.workspaceId, ctx.workspaceId + "-space", owner.id, "Private graph brief"]);
  await db.query("INSERT INTO hs_data_documents(id,tenant_id,record_id,page_id,created_by) VALUES($1,$2,$3,$4,$5)", [crypto.randomUUID(), ctx.tenantId, focal.id, pageId, owner.id]);
  await grant(org.id, viewer);
  await grant(visible.id, viewer);
  await grant(visibleReferrer.id, viewer);
  await grant(focal.id, viewer);
  const hiddenField = JSON.stringify(await graph().graph(as(viewer), org.id));
  expect(hiddenField).not.toContain(visible.id);
  expect(hiddenField).not.toContain(secret.id);
  expect(hiddenField).not.toContain("Permitted partner");
  expect(hiddenField).not.toContain("Secret field partner");
  expect(hiddenField).not.toContain(fieldKey);
  expect(hiddenField).not.toContain("Confidential partners");
  expect(hiddenField).not.toContain(referrer.id);
  expect(hiddenField).not.toContain("Secret referrer");
  expect(hiddenField).not.toContain(visibleReferrer.id);
  expect(hiddenField).not.toContain("Visible referrer");
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view) VALUES($1,'organisations',$2,$3,true)", [ctx.tenantId, fieldKey, viewer.id]);
  const openedField = await graph().graph(as(viewer), org.id);
  expect(names(openedField)).toEqual(expect.arrayContaining(["Permitted partner", "Visible referrer"]));
  expect(openedField.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "record-field", fromId: visibleReferrer.id, toId: org.id, fieldKey })]));
  expect(openedField.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "record-field", fromId: org.id, toId: visible.id, fieldKey, fieldLabel: "Confidential partners" })]));
  const revealed = JSON.stringify(openedField);
  expect(revealed).not.toContain(secret.id);
  expect(revealed).not.toContain("Secret field partner");
  expect(revealed).not.toContain(referrer.id);
  expect(revealed).not.toContain("Secret referrer");
  const accountGraph = JSON.stringify(await graph().graph(as(viewer), focal.id));
  for (const secretText of [parent.id, child.id, person.id, "Secret parent organisation", "Secret child account", "Secret incoming contact", "Secret role", "Private graph brief", pageId]) expect(accountGraph).not.toContain(secretText);
  expect(accountGraph).not.toContain("unavailable");
  await expect(graph().graph(as(viewer), secret.id)).rejects.toMatchObject({ status: 404, code: "record_not_found" });
  await expect(graph().graph(as(outsider), focal.id)).rejects.toMatchObject({ status: 404 });
  const ownerGraph = await graph().graph(ctx, focal.id);
  expect(names(ownerGraph)).toEqual(expect.arrayContaining(["Secret parent organisation", "Secret incoming contact", "Private graph brief"]));
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [pageId]);
  expect(JSON.stringify(await graph().graph(ctx, focal.id))).not.toContain("Private graph brief");
});

it("keeps archived neighbors, drops Trash, and follows relationship changes", async () => {
  const org = await organisation("Archive organisation"), kept = await account("Archived account", org.id), removed = await account("Removed account", org.id), person = await contact("Changing contact");
  let version = person.version;
  const link = async (targetId: string, action: "upsert" | "remove") => {
    const done = await relationships().mutateRelationship(ctx, person.id, { operationId: crypto.randomUUID(), expectedVersion: version, kind: "contact-account", targetId, action, role: "Buyer", primary: false, status: "active" });
    version = done.record.version;
  };
  await link(kept.id, "upsert");
  await link(removed.id, "upsert");
  await db.query("UPDATE hs_data_records SET state='archived' WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, kept.id]);
  const before = await graph().graph(ctx, person.id);
  expect(before.nodes.find((node) => node.id === kept.id)).toMatchObject({ state: "archived", label: "Archived account" });
  expect(before.nodes.map((node) => node.id)).toContain(removed.id);
  await link(removed.id, "remove");
  const after = await graph().graph(ctx, person.id);
  expect(after.nodes.map((node) => node.id)).not.toContain(removed.id);
  expect(after.edges.some((edge) => edge.toId === removed.id)).toBe(false);
  await db.query("UPDATE hs_data_records SET state='trashed',before_trash_state='archived',deleted_at=statement_timestamp(),trash_deadline=statement_timestamp()+interval '30 days',deleted_by=$3 WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, kept.id, owner.id]);
  const trashed = JSON.stringify(await graph().graph(ctx, person.id));
  expect(trashed).not.toContain(kept.id);
  expect(trashed).not.toContain("Archived account");
  expect((await db.query("SELECT id FROM hs_data_relationships WHERE tenant_id=$1 AND target_id=$2", [ctx.tenantId, kept.id])).rows).toHaveLength(1);
});
