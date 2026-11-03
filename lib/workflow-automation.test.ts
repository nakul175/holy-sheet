import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import {
  advanceWorkflowRun,
  applyWorkflowPreview,
  createWorkflow,
  downloadWorkflow,
  grantWorkflowManager,
  ingestWorkflow,
  previewWorkflow,
  searchWorkflows,
  stashWorkflow,
  workflowCatalogue,
  workflowHistory,
  type WorkflowView,
} from "./workflow-automation";

let db: Database;
let r: Repository;
const editor = { id: "workflow-editor", name: "Ed Editor" };
const reader = { id: "workflow-reader", name: "Rae Reader" };
const observer = { id: "workflow-observer", name: "Olivia Observer" };
const outsider = { id: "workflow-outsider", name: "Bolt User" };
const service = { id: "workflow-service", name: "Service Identity" };
const workspace = "ws-aplyd";
const visibleRecord = "00000000-0000-4000-8000-00000000d101";
const secretRecord = "00000000-0000-4000-8000-00000000d102";
const idemRecord = "00000000-0000-4000-8000-00000000d103";
const accountRecord = "00000000-0000-4000-8000-00000000d104";
const organisationRecord = "00000000-0000-4000-8000-00000000d105";
const reviewRecord = "00000000-0000-4000-8000-00000000d106";
const scheduleId = "00000000-0000-4000-8000-00000000d107";
let tenant = "";
let secretField = "";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [editor, reader, observer, outsider, service]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'observer'),($1,$5,'member')", [workspace, editor.id, reader.id, observer.id, service.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  const other = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Acme'),($2,'Bolt')", [tenant, other]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, other]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'organisations','Organisations',true),($1,'accounts','Accounts',true),($1,'reviews','Reviews',false)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'accounts',$3),($1,$2,'reviews',$3)", [tenant, owner.id, ["view", "edit", "export", "history"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, created_by, updated_by) VALUES($1,$2,'organisations','Visible clinic',$3,$3),($4,$2,'organisations','zzsecretrecord',$3,$3),($5,$2,'organisations','Idempotent clinic',$3,$3),($6,$2,'organisations','Northwind',$3,$3),($7,$2,'organisations','Review root',$3,$3)", [visibleRecord, tenant, owner.id, secretRecord, idemRecord, organisationRecord, reviewRecord]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, parent_organisation_id, created_by, updated_by) VALUES($1,$2,'accounts','Northwind account',$3,$4,$4)", [accountRecord, tenant, organisationRecord, owner.id]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4),($1,$5,$3,$4),($1,$2,$6,$7),($1,$2,$8,$9),($1,$10,$11,$4),($1,$12,$3,$4),($1,$12,$11,$13),($1,$14,$3,$4)", [tenant, visibleRecord, owner.id, ["view", "edit", "export", "history"], secretRecord, editor.id, ["view"], reader.id, ["view", "history", "export"], accountRecord, service.id, idemRecord, ["view", "edit"], reviewRecord]);
  secretField = randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id, collection, field_key, label, kind, sensitive, created_by) VALUES($1,'organisations',$2,'Private salary','text',true,$3)", [tenant, secretField, owner.id]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id, collection, field_key, user_id, can_view, can_write, can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [tenant, secretField, owner.id]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
});
afterAll(async () => db.close());

function definition(identity: { kind: "delegated" | "service"; subjectId: string }, patch: Record<string, unknown> = {}) {
  return {
    trigger: { event: "record.created" },
    conditions: { all: [] },
    actions: [{ type: "set-field", field: "core:notes", value: "Hello" }],
    identity,
    ...patch,
  };
}

async function activate(workflow: { id: string; version: number }) {
  const preview = await previewWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: workflow.id, kind: "activate", expectedVersion: workflow.version });
  return applyWorkflowPreview(r, owner, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion: workflow.version }) as Promise<WorkflowView>;
}

async function grants() {
  const [pages, records, collections, fields, parents, schedules] = await Promise.all([
    db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY 1,2,3"),
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT field_key, user_id, can_view, can_write FROM hs_data_field_permissions ORDER BY 1,2"),
    db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records ORDER BY 1"),
    db.query("SELECT id::text, deprecated, definition FROM hs_data_periodic_review_schedules ORDER BY 1"),
  ]);
  return JSON.stringify({ pages: pages.rows, records: records.rows, collections: collections.rows, fields: fields.rows, parents: parents.rows, schedules: schedules.rows });
}

async function notes(recordId: string) {
  const row = await db.query<{ field_values: { "core:notes"?: string }; updated_by: string; parent_organisation_id: string | null }>("SELECT field_values, updated_by, parent_organisation_id::text FROM hs_data_records WHERE id=$1", [recordId]);
  const values = typeof row.rows[0].field_values === "string" ? JSON.parse(row.rows[0].field_values) as { "core:notes"?: string } : row.rows[0].field_values;
  return { notes: values["core:notes"] ?? "", updatedBy: row.rows[0].updated_by, parent: row.rows[0].parent_organisation_id };
}

describe("workflow rules", () => {
  describe("identity", () => {
    it("runs as the delegated or service identity and ignores the creator's rights", async () => {
      const before = await grants();
      const delegated = await createWorkflow(r, owner, workspace, { operationId: randomUUID(), collection: "organisations", name: "Delegated notes", definition: definition({ kind: "delegated", subjectId: editor.id }) });
      expect(delegated).toMatchObject({ status: "draft", version: 1, identitySubject: editor.id, createdBy: owner.id });
      const active = await activate(delegated);
      const started = new Date("2026-11-03T00:00:00.000Z");
      const blocked = await ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: active.id, recordId: visibleRecord, event: "record.created", sourceKey: "delegated-1" }, { now: started });
      expect(blocked).toMatchObject({ status: "retrying", outcome: "blocked-action", identitySubject: editor.id, revision: active.version });
      expect((await notes(visibleRecord)).notes).toBe("");
      expect(await db.query("SELECT count(*)::int AS n FROM hs_data_events WHERE record_id=$1", [visibleRecord])).toMatchObject({ rows: [{ n: 0 }] });
      await db.query("UPDATE hs_data_record_grants SET capabilities=$3 WHERE tenant_id=$1 AND record_id=$2 AND user_id=$4", [tenant, visibleRecord, ["view", "edit"], editor.id]);
      const early = await advanceWorkflowRun(r, owner, workspace, { operationId: randomUUID(), runId: blocked.id }, { now: new Date(started.getTime() + 999) });
      expect(early).toMatchObject({ replayed: true, status: "retrying" });
      expect((await notes(visibleRecord)).notes).toBe("");
      const wrote = await advanceWorkflowRun(r, owner, workspace, { operationId: randomUUID(), runId: blocked.id }, { now: new Date(started.getTime() + 1000) });
      expect(wrote).toMatchObject({ status: "completed", outcome: "completed", identityKind: "delegated", identitySubject: editor.id });
      expect(await notes(visibleRecord)).toMatchObject({ notes: "Hello", updatedBy: editor.id });
      expect(await db.query("SELECT actor_id, source_app, service_subject FROM hs_data_events WHERE record_id=$1", [visibleRecord])).toMatchObject({ rows: [{ actor_id: editor.id, source_app: "workflow-automation", service_subject: null }] });

      await db.query("UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2 AND collection='organisations'", [tenant, owner.id, ["view", "export", "history"]]);
      await db.query("UPDATE hs_data_record_grants SET capabilities=$3 WHERE tenant_id=$1 AND record_id=$2 AND user_id=$4", [tenant, visibleRecord, ["view"], owner.id]);
      const serviceWorkflow = await activate(await createWorkflow(r, owner, workspace, { operationId: randomUUID(), collection: "organisations", name: "Service notes", definition: definition({ kind: "service", subjectId: service.id }, { actions: [{ type: "set-field", field: "core:notes", value: "Service" }] }) }));
      await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, visibleRecord, service.id, ["view", "edit"]]);
      const ran = await ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: serviceWorkflow.id, recordId: visibleRecord, event: "record.created", sourceKey: "service-1" });
      expect(ran).toMatchObject({ status: "completed", identityKind: "service", identitySubject: service.id });
      expect(await notes(visibleRecord)).toMatchObject({ notes: "Service", updatedBy: service.id });
      expect(await db.query("SELECT actor_id, service_subject FROM hs_data_events WHERE record_id=$1 ORDER BY record_version DESC LIMIT 1", [visibleRecord])).toMatchObject({ rows: [{ actor_id: service.id, service_subject: service.id }] });
      expect(await grants()).not.toBe(before);
      const access = await grants();
      expect(access).not.toContain("workflow-editor\",\"capabilities\":[\"view\",\"edit\",\"export\"");
      expect(JSON.parse(access).parents.find((row: { id: string }) => row.id === accountRecord).parent_organisation_id).toBe(organisationRecord);
    });
  });

  describe("idempotency", () => {
    it("replays an event key once and does not repeat a completed step", async () => {
      const workflow = await activate(await createWorkflow(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", name: "Append once",
        definition: definition({ kind: "delegated", subjectId: service.id }, { actions: [{ type: "append-note", field: "core:notes", text: "once" }] }),
      }));
      const operationId = randomUUID();
      const input = { operationId, workflowId: workflow.id, recordId: idemRecord, event: "record.created" as const, sourceKey: "same-event" };
      const first = await ingestWorkflow(r, owner, workspace, input);
      const again = await ingestWorkflow(r, owner, workspace, input);
      const otherOperation = await ingestWorkflow(r, owner, workspace, { ...input, operationId: randomUUID() });
      expect(first.replayed).toBe(false);
      expect(again).toMatchObject({ replayed: true, id: first.id, outcome: "completed" });
      expect(otherOperation).toMatchObject({ replayed: true, id: first.id });
      expect((await notes(idemRecord)).notes).toBe("once");
      expect(await db.query("SELECT count(*)::int AS n FROM hs_workflow_steps WHERE run_id=$1", [first.id])).toMatchObject({ rows: [{ n: 1 }] });
      await expect(ingestWorkflow(r, owner, workspace, { ...input, sourceKey: "different" })).rejects.toMatchObject({ code: "operation_mismatch" });
      await expect(db.query("UPDATE hs_workflow_steps SET outcome='rewritten' WHERE run_id=$1", [first.id])).rejects.toThrow(/immutable/i);
    });

    it("dead-letters the third failure and replays only through impact review", async () => {
      const workflow = await activate(await createWorkflow(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", name: "Retry salary",
        definition: definition({ kind: "delegated", subjectId: reader.id }, { actions: [{ type: "set-field", field: secretField, value: "hidden-salary-value" }] }),
      }));
      const start = new Date("2026-11-03T01:00:00.000Z");
      const first = await ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: workflow.id, recordId: visibleRecord, event: "record.created", sourceKey: "retry-1" }, { now: start });
      expect(first).toMatchObject({ status: "retrying", attempt: 1, outcome: "blocked-action" });
      const second = await advanceWorkflowRun(r, owner, workspace, { operationId: randomUUID(), runId: first.id }, { now: new Date(start.getTime() + 1000) });
      expect(second).toMatchObject({ status: "retrying", attempt: 2 });
      const third = await advanceWorkflowRun(r, owner, workspace, { operationId: randomUUID(), runId: first.id }, { now: new Date(start.getTime() + 1000 + 4000) });
      expect(third).toMatchObject({ status: "dead-letter", attempt: 3, outcome: "blocked-action", revision: workflow.version });
      expect(JSON.stringify(await notes(visibleRecord))).not.toContain("hidden-salary-value");
      const duplicate = await advanceWorkflowRun(r, owner, workspace, { operationId: randomUUID(), runId: first.id }, { now: new Date(start.getTime() + 60_000) });
      expect(duplicate).toMatchObject({ replayed: true, status: "dead-letter" });
      await db.query("INSERT INTO hs_data_field_permissions(tenant_id, collection, field_key, user_id, can_view, can_write, can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [tenant, secretField, reader.id]);
      await db.query("UPDATE hs_data_record_grants SET capabilities=$3 WHERE tenant_id=$1 AND record_id=$2 AND user_id=$4", [tenant, visibleRecord, ["view", "edit"], reader.id]);
      const reviewed = await previewWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: workflow.id, kind: "replay", expectedVersion: workflow.version, runId: first.id });
      const replayed = await applyWorkflowPreview(r, owner, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: workflow.version });
      expect(replayed).toMatchObject({ status: "completed", outcome: "completed", revision: workflow.version });
      const stored = typeof (await db.query("SELECT field_values FROM hs_data_records WHERE id=$1", [visibleRecord])).rows[0].field_values === "string"
        ? JSON.parse(String((await db.query("SELECT field_values FROM hs_data_records WHERE id=$1", [visibleRecord])).rows[0].field_values))
        : (await db.query("SELECT field_values FROM hs_data_records WHERE id=$1", [visibleRecord])).rows[0].field_values;
      expect(stored[secretField]).toBe("hidden-salary-value");
    });

    it("stops a cascade at depth 10 and keeps the dead letter", async () => {
      await db.query("UPDATE hs_workflows SET status='paused' WHERE tenant_id=$1 AND status='active'", [tenant]);
      const workflow = await activate(await createWorkflow(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", name: "Loop notes",
        definition: definition({ kind: "delegated", subjectId: owner.id }, { trigger: { event: "record.updated" }, actions: [{ type: "append-note", field: "core:notes", text: "x" }] }),
      }));
      const run = await ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: workflow.id, recordId: reviewRecord, event: "record.updated", sourceKey: "loop-1" });
      expect(run).toMatchObject({ status: "completed", depth: 1 });
      expect((await notes(reviewRecord)).notes.split("\n")).toHaveLength(10);
      const dead = await db.query<{ depth: number; outcome: string; n: number }>("SELECT max(depth)::int AS depth, count(*) FILTER (WHERE outcome='loop-depth')::int AS n, count(*)::int AS runs FROM hs_workflow_runs WHERE workflow_id=$1", [workflow.id]);
      expect(dead.rows[0]).toMatchObject({ depth: 11, n: 1, runs: 11 });
      const replay = await ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: workflow.id, recordId: reviewRecord, event: "record.updated", sourceKey: "loop-1" });
      expect(replay).toMatchObject({ replayed: true, id: run.id });
      expect((await notes(reviewRecord)).notes.split("\n")).toHaveLength(10);
    });
  });

  describe("permissions", () => {
    it("enforces tenant, record, field, and action checks without granting access", async () => {
      const before = await grants();
      await expect(createWorkflow(r, editor, workspace, { operationId: randomUUID(), collection: "organisations", name: "Needs admin", definition: definition({ kind: "delegated", subjectId: editor.id }) })).rejects.toMatchObject({ code: "management_required" });
      await expect(createWorkflow(r, observer, workspace, { operationId: randomUUID(), collection: "organisations", name: "Observer", definition: definition({ kind: "delegated", subjectId: editor.id }) })).rejects.toMatchObject({ code: "read_only" });
      await expect(createWorkflow(r, outsider, workspace, { operationId: randomUUID(), collection: "organisations", name: "Outside", definition: definition({ kind: "delegated", subjectId: editor.id }) })).rejects.toMatchObject({ status: 404 });
      await expect(workflowCatalogue(r, outsider, "ws-b")).resolves.toMatchObject({ workflows: [] });
      const grantOperation = randomUUID();
      const granted = await grantWorkflowManager(r, owner, workspace, { operationId: grantOperation, userId: editor.id });
      const grantedAgain = await grantWorkflowManager(r, owner, workspace, { operationId: grantOperation, userId: editor.id });
      expect(granted).toMatchObject({ granted: true, replayed: false, userId: editor.id });
      expect(grantedAgain).toMatchObject({ replayed: true, userId: editor.id });
      expect(await grants()).toBe(before);
      await db.query("DELETE FROM hs_data_field_permissions WHERE tenant_id=$1 AND field_key=$2 AND user_id=$3", [tenant, secretField, reader.id]);

      const secret = "hidden-salary-value";
      const workflow = await createWorkflow(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", name: "Salary rule",
        definition: definition({ kind: "delegated", subjectId: owner.id }, { conditions: { all: [{ field: secretField, operator: "equals", value: secret }] }, actions: [{ type: "set-field", field: "core:notes", value: "Seen" }] }),
      });
      const ownerView = await workflowCatalogue(r, owner, workspace);
      expect(JSON.stringify(ownerView.workflows.find(item => item.id === workflow.id))).toContain(secret);
      const readerView = await workflowCatalogue(r, reader, workspace);
      expect(JSON.stringify(readerView)).not.toContain(secret);
      expect(JSON.stringify(readerView)).not.toContain(secretField);
      const found = await searchWorkflows(r, reader, workspace, "salary");
      expect(found.results.map(item => item.id)).toContain(workflow.id);
      expect(JSON.stringify(found)).not.toContain(secret);
      const file = await downloadWorkflow(r, reader, workspace, { operationId: randomUUID(), workflowId: workflow.id, expectedVersion: workflow.version });
      expect(file.body).not.toContain(secret);
      expect(file.body).toContain("does not grant access");
      await expect(downloadWorkflow(r, outsider, "ws-b", { operationId: randomUUID(), workflowId: workflow.id, expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });

      const active = await activate(workflow);
      await ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: active.id, recordId: secretRecord, event: "record.created", sourceKey: "secret-run" });
      const readerHistory = await workflowHistory(r, reader, workspace, workflow.id);
      expect(JSON.stringify(readerHistory)).not.toContain(secretRecord);
      expect(JSON.stringify(readerHistory)).not.toContain("zzsecretrecord");
      expect(JSON.stringify(readerHistory)).not.toContain(secret);
      const ownerHistory = await workflowHistory(r, owner, workspace, workflow.id);
      expect(ownerHistory.runs.map(run => run.recordId)).toContain(secretRecord);
      expect(ownerHistory.events[0]).toMatchObject({ source: "workflow-automation" });
      expect(ownerHistory.events[0].atIst).toMatch(/IST$/);
      await expect(ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: active.id, recordId: secretRecord, event: "record.created", sourceKey: "secret-run" })).resolves.toMatchObject({ replayed: true });
      await expect(ingestWorkflow(r, editor, workspace, { operationId: randomUUID(), workflowId: active.id, recordId: secretRecord, event: "record.created", sourceKey: "editor-hidden" })).rejects.toMatchObject({ status: 404 });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_workflow_runs WHERE record_id=$1", [secretRecord])).toMatchObject({ rows: [{ n: 1 }] });
    });

    it("does not activate an existing schedule or change an account organisation", async () => {
      await expect(db.query("INSERT INTO hs_workflows(id, tenant_id, collection, name, status, definition, created_by) VALUES($1,$2,'reviews','Illegal active','active',$3,$4)", [randomUUID(), tenant, JSON.stringify(definition({ kind: "delegated", subjectId: owner.id })), owner.id])).rejects.toThrow(/draft/i);
      const workflow = await activate(await createWorkflow(r, owner, workspace, { operationId: randomUUID(), collection: "accounts", name: "Account notes", definition: definition({ kind: "service", subjectId: service.id }) }));
      await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [tenant, accountRecord, service.id, ["view", "edit"]]);
      await ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: workflow.id, recordId: accountRecord, event: "record.created", sourceKey: "account-1" });
      expect(await notes(accountRecord)).toMatchObject({ notes: "Hello", parent: organisationRecord });
      expect(await db.query("SELECT definition, deprecated FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).toMatchObject({ rows: [{ definition: { paused: true }, deprecated: false }] });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_data_periodic_review_schedules")).toMatchObject({ rows: [{ n: 1 }] });
    });
  });

  describe("versioning and drafts", () => {
    it("keeps drafts, requires impact review, and records the revision", async () => {
      const operationId = randomUUID();
      const body = definition({ kind: "delegated", subjectId: service.id });
      const created = await createWorkflow(r, owner, workspace, { operationId, collection: "organisations", name: "Versioned notes", definition: body });
      const replay = await createWorkflow(r, owner, workspace, { operationId, collection: "organisations", name: "Versioned notes", definition: body });
      expect(replay).toMatchObject({ replayed: true, id: created.id });
      await expect(createWorkflow(r, owner, workspace, { operationId, collection: "organisations", name: "Other", definition: definition({ kind: "delegated", subjectId: service.id }) })).rejects.toMatchObject({ code: "operation_mismatch" });
      await expect(ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: created.id, recordId: idemRecord, event: "record.created", sourceKey: "draft-run" })).rejects.toMatchObject({ code: "workflow_paused" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_workflow_runs WHERE workflow_id=$1", [created.id])).toMatchObject({ rows: [{ n: 0 }] });

      const stash = await stashWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: created.id, expectedVersion: created.version, definition: definition({ kind: "delegated", subjectId: service.id }, { actions: [{ type: "set-field", field: "core:notes", value: "Draft" }] }) });
      expect(stash).toMatchObject({ conflict: false, version: 1 });
      expect(await db.query("SELECT version, status FROM hs_workflows WHERE id=$1", [created.id])).toMatchObject({ rows: [{ version: 1, status: "draft" }] });
      const preview = await previewWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: created.id, kind: "dry-run", expectedVersion: created.version, recordId: idemRecord, useDraft: true });
      expect(preview.plan?.matched).toBe(true);
      expect((await notes(idemRecord)).notes).toBe("once");
      const stale = await stashWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: created.id, expectedVersion: 99, definition: definition({ kind: "delegated", subjectId: service.id }, { actions: [{ type: "set-field", field: "core:notes", value: "Kept" }] }) });
      expect(stale.conflict).toBe(true);
      expect(stale.recoverableDraft.definition.actions[0]).toMatchObject({ value: "Kept" });
      expect(await db.query("SELECT version FROM hs_workflows WHERE id=$1", [created.id])).toMatchObject({ rows: [{ version: 1 }] });

      const reviewed = await previewWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: created.id, kind: "version-change", expectedVersion: created.version, definition: definition({ kind: "delegated", subjectId: service.id }, { actions: [{ type: "set-field", field: "core:notes", value: "Saved" }] }) });
      await expect(applyWorkflowPreview(r, owner, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: 99 })).rejects.toMatchObject({ code: "workflow_conflict" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_workflow_drafts WHERE workflow_id=$1 AND actor_id=$2", [created.id, owner.id])).toMatchObject({ rows: [{ n: 1 }] });
      const saved = await applyWorkflowPreview(r, owner, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: created.version }) as WorkflowView;
      expect(saved).toMatchObject({ status: "draft", version: 2 });
      const active = await activate(saved);
      expect(active.status).toBe("active");
      const changed = await previewWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: active.id, kind: "version-change", expectedVersion: active.version, definition: definition({ kind: "delegated", subjectId: service.id }, { actions: [{ type: "set-field", field: "core:notes", value: "Paused" }] }) });
      const paused = await applyWorkflowPreview(r, owner, workspace, { operationId: randomUUID(), previewId: changed.previewId, expectedVersion: active.version }) as WorkflowView;
      expect(paused.status).toBe("paused");
      await expect(ingestWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: paused.id, recordId: idemRecord, event: "record.created", sourceKey: "paused-run" })).rejects.toMatchObject({ code: "workflow_paused" });
      const rolled = await previewWorkflow(r, owner, workspace, { operationId: randomUUID(), workflowId: paused.id, kind: "rollback", expectedVersion: paused.version, targetVersion: 1 });
      const restored = await applyWorkflowPreview(r, owner, workspace, { operationId: randomUUID(), previewId: rolled.previewId, expectedVersion: paused.version }) as WorkflowView;
      expect(restored).toMatchObject({ status: "paused", version: paused.version + 1 });
      expect(restored.definition.actions[0]).toMatchObject({ value: "Hello" });
      const history = await workflowHistory(r, owner, workspace, created.id);
      expect(history.events.some(event => event.action === "activate" && event.revision === active.version && event.source === "workflow-automation" && /IST$/.test(event.atIst))).toBe(true);
      const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='workflow.activate' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [created.id]);
      const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
      expect(audit.rows[0].actor_id).toBe(owner.id);
      expect(after).toMatchObject({ source: "workflow-automation" });
      expect(after.atIst).toMatch(/IST$/);
      expect(after.operationId).toBeTruthy();
      expect(await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).toMatchObject({ rows: [{ definition: { paused: true } }] });
    });
  });
});
