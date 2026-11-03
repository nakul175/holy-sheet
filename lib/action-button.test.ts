import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actionButtonCatalogue,
  actionButtonHistory,
  applyActionButtonPreview,
  createActionButton,
  discardActionButtonDraft,
  downloadActionButton,
  grantActionButtonManager,
  previewActionButton,
  readActionReceipt,
  retryActionButtonLink,
  searchActionButtons,
  stashActionButton,
  type ActionButtonView,
  type ActionReceipt,
} from "./action-button";
import { receiptSeparatesLink } from "./action-button-plan";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const editor = { id: "action-editor", name: "Ed Editor" };
const reader = { id: "action-reader", name: "Rae Reader" };
const observer = { id: "action-observer", name: "Olivia Observer" };
const outsider = { id: "action-outsider", name: "Bolt User" };
const service = { id: "action-service", name: "Service Member" };
const workspace = "ws-aplyd";
const visibleRecord = "00000000-0000-4000-8000-00000000e101";
const secretRecord = "00000000-0000-4000-8000-00000000e102";
const idemRecord = "00000000-0000-4000-8000-00000000e103";
const linkRecord = "00000000-0000-4000-8000-00000000e104";
const staleRecord = "00000000-0000-4000-8000-00000000e105";
const requiredRecord = "00000000-0000-4000-8000-00000000e106";
const versionRecord = "00000000-0000-4000-8000-00000000e107";
const accountRecord = "00000000-0000-4000-8000-00000000e108";
const organisationRecord = "00000000-0000-4000-8000-00000000e109";
const scheduleId = "00000000-0000-4000-8000-00000000e10a";
let tenant = "";
let secretField = "";
let retiringField = "";

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
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'organisations','Organisations',true),($1,'accounts','Accounts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'accounts',$3)", [tenant, owner.id, ["view", "edit", "export", "history"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, created_by, updated_by) VALUES($1,$2,'organisations','Visible clinic',$3,$3),($4,$2,'organisations','zzsecretrecord',$3,$3),($5,$2,'organisations','Idempotent clinic',$3,$3),($6,$2,'organisations','Link clinic',$3,$3),($7,$2,'organisations','Stale clinic',$3,$3),($8,$2,'organisations','Required clinic',$3,$3),($9,$2,'organisations','Version clinic',$3,$3),($10,$2,'organisations','Northwind',$3,$3)", [visibleRecord, tenant, owner.id, secretRecord, idemRecord, linkRecord, staleRecord, requiredRecord, versionRecord, organisationRecord]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, parent_organisation_id, created_by, updated_by) VALUES($1,$2,'accounts','Northwind account',$3,$4,$4)", [accountRecord, tenant, organisationRecord, owner.id]);
  const edit = ["view", "edit", "export", "history"];
  const view = ["view", "history", "export"];
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4),($1,$2,$5,$6),($1,$7,$3,$4),($1,$8,$3,$4),($1,$9,$3,$4),($1,$10,$3,$4),($1,$11,$3,$4)", [tenant, visibleRecord, owner.id, edit, reader.id, view, idemRecord, linkRecord, staleRecord, requiredRecord, versionRecord]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4),($1,$5,$3,$4),($1,$6,$3,$4),($1,$7,$3,$4),($1,$8,$3,$4),($1,$9,$3,$4)", [tenant, visibleRecord, editor.id, edit, idemRecord, linkRecord, staleRecord, requiredRecord, versionRecord]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, accountRecord, owner.id, edit]);
  secretField = randomUUID();
  retiringField = randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id, collection, field_key, label, kind, sensitive, created_by) VALUES($1,'organisations',$2,'Private salary','text',true,$3)", [tenant, secretField, owner.id]);
  await db.query("INSERT INTO hs_data_fields(tenant_id, collection, field_key, label, kind, created_by) VALUES($1,'organisations',$2,'Retiring note','long-text',$3)", [tenant, retiringField, owner.id]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id, collection, field_key, user_id, can_view, can_write, can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [tenant, secretField, owner.id]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
  await db.query("INSERT INTO hs_pages(id, workspace_id, space_id, owner_id, title, visibility) VALUES('action-private-page',$1,'space-product',$2,'Private action','private'),('action-space-page',$1,'space-product',$2,'Space action','space')", [workspace, owner.id]);
});
afterAll(async () => db.close());

function definition(patch: Record<string, unknown> = {}) {
  return {
    context: { collection: "organisations", placement: "record" },
    inputs: [{ id: "note", field: "core:notes", required: true, default: "Hello" }],
    target: { actionId: "hs.record.append-note", field: "core:notes", inputId: "note" },
    link: null,
    ...patch,
  };
}

async function activate(button: { id: string; version: number }) {
  const preview = await previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: button.id, kind: "activate", expectedVersion: button.version });
  return applyActionButtonPreview(r, owner, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion: button.version }) as Promise<ActionButtonView>;
}

async function invoke(actor: { id: string; name?: string }, button: { id: string; version: number }, recordId: string, inputs?: Record<string, unknown>, pageId?: string) {
  const preview = await previewActionButton(r, actor, workspace, { operationId: randomUUID(), buttonId: button.id, kind: "invoke", expectedVersion: button.version, recordId, inputs, pageId });
  expect(preview.plan?.actionId).toBeTruthy();
  const before = await notes(recordId);
  expect(before.notes).toBe(before.notes);
  return applyActionButtonPreview(r, actor, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion: button.version }) as Promise<ActionReceipt>;
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
  const row = await db.query<{ field_values: { "core:notes"?: string }; updated_by: string; parent_organisation_id: string | null; version: number | string }>("SELECT field_values, updated_by, parent_organisation_id::text, version FROM hs_data_records WHERE id=$1", [recordId]);
  const values = typeof row.rows[0].field_values === "string" ? JSON.parse(row.rows[0].field_values) as { "core:notes"?: string } : row.rows[0].field_values;
  return { notes: values["core:notes"] ?? "", updatedBy: row.rows[0].updated_by, parent: row.rows[0].parent_organisation_id, version: Number(row.rows[0].version) };
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

describe("action buttons", () => {
  describe("N61-01", () => {
    it("lets a manager define a draft button with stable field and action ids", async () => {
      const created = await createActionButton(r, owner, workspace, { operationId: randomUUID(), collection: "organisations", label: "Add a note", definition: definition() });
      expect(created).toMatchObject({ status: "draft", version: 1, label: "Add a note", definition: { context: { collection: "organisations", placement: "record" }, target: { actionId: "hs.record.append-note", field: "core:notes", inputId: "note" } } });
      expect(created.availability).toEqual({ enabled: false, reason: "draft" });
      await expect(createActionButton(r, editor, workspace, { operationId: randomUUID(), collection: "organisations", label: "Editor draft", definition: definition() })).rejects.toMatchObject({ code: "management_required" });
      const secret = "hidden-salary-value";
      await expect(createActionButton(r, owner, workspace, { operationId: randomUUID(), collection: "organisations", label: "Scripted", definition: definition({ target: { actionId: "hs.script.run", field: "core:notes", script: secret } }) })).rejects.toMatchObject({ code: "action_button_validation" });
      await expect(createActionButton(r, owner, workspace, { operationId: randomUUID(), collection: "organisations", label: "Legacy", definition: definition({ target: { actionId: "hs.record.legacy-note", field: "core:notes", inputId: "note" } }) })).rejects.toMatchObject({ code: "action_button_deprecated" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_action_buttons WHERE label IN ('Scripted','Legacy')")).toMatchObject({ rows: [{ n: 0 }] });
    });
  });

  describe("N61-02", () => {
    it("previews a mutation, then confirms it with the caller's current rights", async () => {
      const button = await activate(await createActionButton(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", label: "Confirm note",
        definition: definition({ inputs: [{ id: "note", field: "core:notes", required: true }] }),
      }));
      await expect(previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: button.id, kind: "invoke", expectedVersion: button.version, recordId: requiredRecord })).rejects.toMatchObject({ code: "action_button_validation" });
      expect(await notes(requiredRecord)).toMatchObject({ notes: "", version: 1 });
      const preview = await previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: button.id, kind: "invoke", expectedVersion: button.version, recordId: requiredRecord, inputs: { note: "Confirmed" } });
      expect(preview.plan).toMatchObject({ actionId: "hs.record.append-note", field: "core:notes", audience: "current-user", rights: { record: "edit", field: "write", action: "hs.record.append-note" } });
      expect(preview.review).toContain("Confirming");
      expect(await notes(requiredRecord)).toMatchObject({ notes: "" });
      const saved = await applyActionButtonPreview(r, owner, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion: button.version }) as ActionReceipt;
      expect(saved).toMatchObject({ actionStatus: "succeeded", linkStatus: "none", source: "action-button", recoverable: true, revision: button.version });
      expect(await notes(requiredRecord)).toMatchObject({ notes: "Confirmed", updatedBy: owner.id });

      await db.query("UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2 AND collection='organisations'", [tenant, owner.id, ["view", "export", "history"]]);
      await db.query("UPDATE hs_data_record_grants SET capabilities=$3 WHERE tenant_id=$1 AND record_id=$2 AND user_id=$4", [tenant, visibleRecord, ["view"], owner.id]);
      try {
        await expect(previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: button.id, kind: "invoke", expectedVersion: button.version, recordId: visibleRecord, inputs: { note: "Denied" } })).rejects.toMatchObject({ code: "action_forbidden" });
        expect(await notes(visibleRecord)).toMatchObject({ notes: "" });
        const ran = await invoke(editor, button, visibleRecord, { note: "By editor" });
        expect(ran).toMatchObject({ actionStatus: "succeeded", revision: button.version });
        expect(await notes(visibleRecord)).toMatchObject({ notes: "By editor", updatedBy: editor.id });
        expect(await db.query("SELECT actor_id, source_app, service_subject FROM hs_data_events WHERE record_id=$1", [visibleRecord])).toMatchObject({ rows: [{ actor_id: editor.id, source_app: "action-button", service_subject: null }] });
      } finally {
        await db.query("UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2 AND collection='organisations'", [tenant, owner.id, ["view", "edit", "export", "history"]]);
        await db.query("UPDATE hs_data_record_grants SET capabilities=$3 WHERE tenant_id=$1 AND record_id=$2 AND user_id=$4", [tenant, visibleRecord, ["view", "edit", "export", "history"], owner.id]);
      }
    });
  });

  describe("N61-03", () => {
    it("replays one operation and keeps a recoverable receipt when the follow-up link fails", async () => {
      const button = await activate(await createActionButton(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", label: "Note then open",
        definition: definition({
          inputs: [
            { id: "note", field: "core:notes", required: true, default: "Hello" },
            { id: "target", field: "core:registration", required: false },
          ],
          link: { linkId: "hs.record.open", inputId: "target" },
        }),
      }));
      const operationId = randomUUID();
      const input = { operationId: randomUUID(), buttonId: button.id, kind: "invoke" as const, expectedVersion: button.version, recordId: idemRecord, inputs: { note: "Saved", target: secretRecord } };
      const preview = await previewActionButton(r, editor, workspace, input);
      expect(await notes(idemRecord)).toMatchObject({ notes: "", version: 1 });
      const first = await applyActionButtonPreview(r, editor, workspace, { operationId, previewId: preview.previewId, expectedVersion: button.version }) as ActionReceipt;
      const again = await applyActionButtonPreview(r, editor, workspace, { operationId, previewId: preview.previewId, expectedVersion: button.version }) as ActionReceipt;
      expect(first.replayed).toBe(false);
      expect(again).toMatchObject({ replayed: true, id: first.id, actionStatus: "succeeded", linkStatus: "failed", linkError: "unavailable" });
      expect(receiptSeparatesLink(first)).toBe(true);
      expect(first.openedRecordId).toBeUndefined();
      expect(JSON.stringify(first)).not.toContain(secretRecord);
      expect(await notes(idemRecord)).toMatchObject({ notes: "Saved", updatedBy: editor.id, version: 2, parent: null });
      await expect(applyActionButtonPreview(r, editor, workspace, { operationId, previewId: randomUUID(), expectedVersion: button.version })).rejects.toMatchObject({ code: "operation_mismatch" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_data_events WHERE record_id=$1", [idemRecord])).toMatchObject({ rows: [{ n: 1 }] });
      await expect(readActionReceipt(r, reader, workspace, first.id)).rejects.toMatchObject({ status: 404 });
      const retried = await retryActionButtonLink(r, editor, workspace, { operationId: randomUUID(), receiptId: first.id });
      expect(retried).toMatchObject({ actionStatus: "succeeded", linkStatus: "failed", follows: first.id, revision: button.version });
      expect(await notes(idemRecord)).toMatchObject({ notes: "Saved", version: 2 });
      await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, secretRecord, editor.id, ["view"]]);
      const opened = await retryActionButtonLink(r, editor, workspace, { operationId: randomUUID(), receiptId: first.id });
      expect(opened).toMatchObject({ actionStatus: "succeeded", linkStatus: "succeeded", openedRecordId: secretRecord, follows: first.id });
      expect(await notes(idemRecord)).toMatchObject({ notes: "Saved", version: 2 });
      const repeated = await retryActionButtonLink(r, editor, workspace, { operationId: opened.operationId, receiptId: first.id });
      expect(repeated).toMatchObject({ replayed: true, id: opened.id });
      expect(await notes(idemRecord)).toMatchObject({ version: 2 });
      await expect(db.query("UPDATE hs_action_button_receipts SET link_status='none' WHERE id=$1", [first.id])).rejects.toThrow(/immutable/i);

      const pageButton = await activate(await createActionButton(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", label: "Note then page",
        definition: definition({
          context: { collection: "organisations", placement: "page" },
          link: { linkId: "hs.page.open", pageId: "action-private-page" },
        }),
      }));
      await expect(previewActionButton(r, editor, workspace, { operationId: randomUUID(), buttonId: pageButton.id, kind: "invoke", expectedVersion: pageButton.version, recordId: linkRecord, inputs: { note: "Page" } })).rejects.toMatchObject({ code: "action_button_validation" });
      await expect(previewActionButton(r, editor, workspace, { operationId: randomUUID(), buttonId: pageButton.id, kind: "invoke", expectedVersion: pageButton.version, recordId: linkRecord, pageId: "action-private-page", inputs: { note: "Page" } })).rejects.toMatchObject({ status: 404 });
      expect(await notes(linkRecord)).toMatchObject({ notes: "" });
      const linked = await invoke(editor, pageButton, linkRecord, { note: "Page" }, "action-space-page");
      expect(linked).toMatchObject({ actionStatus: "succeeded", linkStatus: "failed", linkError: "unavailable" });
      expect(linked.pageId).toBeUndefined();
      expect(await notes(linkRecord)).toMatchObject({ notes: "Page", version: 2 });
      const spaceButton = await activate(await createActionButton(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", label: "Open space page",
        definition: definition({ link: { linkId: "hs.page.open", pageId: "action-space-page" } }),
      }));
      await expect(previewActionButton(r, editor, workspace, { operationId: randomUUID(), buttonId: spaceButton.id, kind: "invoke", expectedVersion: spaceButton.version, recordId: versionRecord, pageId: "action-space-page", inputs: { note: "Nope" } })).rejects.toMatchObject({ code: "action_button_validation" });
      const openedPage = await invoke(editor, spaceButton, versionRecord, { note: "Space" });
      expect(openedPage).toMatchObject({ actionStatus: "succeeded", linkStatus: "succeeded", pageId: "action-space-page" });
      expect(await notes(versionRecord)).toMatchObject({ notes: "Space", parent: null });
    });
  });

  describe("N61-04", () => {
    it("stops deprecated and stale targets and records the action, source, and revision", async () => {
      const retiring = await activate(await createActionButton(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", label: "Retiring note",
        definition: definition({
          inputs: [{ id: "note", field: retiringField, required: true, default: "Later" }],
          target: { actionId: "hs.record.append-note", field: retiringField, inputId: "note" },
        }),
      }));
      await db.query("UPDATE hs_data_fields SET deprecated=true WHERE tenant_id=$1 AND field_key=$2", [tenant, retiringField]);
      await expect(previewActionButton(r, editor, workspace, { operationId: randomUUID(), buttonId: retiring.id, kind: "invoke", expectedVersion: retiring.version, recordId: staleRecord, inputs: { note: "Later" } })).rejects.toMatchObject({ code: "action_button_disabled" });
      expect((await actionButtonCatalogue(r, editor, workspace)).buttons.find(button => button.id === retiring.id)?.availability).toEqual({ enabled: false, reason: "deprecated-target" });
      expect(await notes(staleRecord)).toMatchObject({ notes: "" });
      const legacyId = randomUUID();
      await db.query("INSERT INTO hs_action_buttons(id, tenant_id, collection, label, status, definition, created_by) VALUES($1,$2,'organisations','Stored legacy','draft',$3,$4)", [legacyId, tenant, JSON.stringify(definition({ target: { actionId: "hs.record.legacy-note", field: "core:notes", inputId: "note" } })), owner.id]);
      await db.query("UPDATE hs_action_buttons SET status='active', version=2 WHERE id=$1", [legacyId]);
      await expect(previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: legacyId, kind: "invoke", expectedVersion: 2, recordId: staleRecord, inputs: { note: "Legacy" } })).rejects.toMatchObject({ code: "action_button_disabled" });

      const button = await activate(await createActionButton(r, owner, workspace, { operationId: randomUUID(), collection: "organisations", label: "Stale note", definition: definition() }));
      const preview = await previewActionButton(r, editor, workspace, { operationId: randomUUID(), buttonId: button.id, kind: "invoke", expectedVersion: button.version, recordId: staleRecord, inputs: { note: "Waiting" } });
      await db.query("UPDATE hs_data_records SET version=version+1 WHERE id=$1", [staleRecord]);
      await expect(applyActionButtonPreview(r, editor, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion: button.version })).rejects.toMatchObject({ code: "action_button_stale" });
      expect(await notes(staleRecord)).toMatchObject({ notes: "" });
      const staleDraft = await stashActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: button.id, expectedVersion: 99, definition: definition({ inputs: [{ id: "note", field: "core:notes", required: true, default: "Kept" }] }) });
      expect(staleDraft.conflict).toBe(true);
      expect(staleDraft.recoverableDraft.definition.inputs[0]).toMatchObject({ default: "Kept" });
      expect(await db.query("SELECT version FROM hs_action_buttons WHERE id=$1", [button.id])).toMatchObject({ rows: [{ version: button.version }] });

      const ran = await invoke(editor, button, linkRecord, { note: "Audited" });
      const history = await actionButtonHistory(r, owner, workspace, button.id);
      expect(history.events.some(event => event.action === "invoke" && event.actionId === "hs.record.append-note" && event.revision === button.version && event.source === "action-button" && /IST$/.test(event.atIst))).toBe(true);
      expect(history.receipts.some(receipt => receipt.id === ran.id && receipt.revision === button.version)).toBe(true);
      const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string; actionId?: string; revision?: number } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='action-button.invoke' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [button.id]);
      const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
      expect(audit.rows[0].actor_id).toBe(editor.id);
      expect(after).toMatchObject({ source: "action-button", actionId: "hs.record.append-note", revision: button.version });
      expect(after.atIst).toMatch(/IST$/);
      expect(after.operationId).toBeTruthy();
    });
  });

  describe("N61-05", () => {
    it("enforces tenant, record, field, and action checks without granting access", async () => {
      const before = await grants();
      await expect(createActionButton(r, observer, workspace, { operationId: randomUUID(), collection: "organisations", label: "Observer", definition: definition() })).rejects.toMatchObject({ code: "read_only" });
      await expect(createActionButton(r, outsider, workspace, { operationId: randomUUID(), collection: "organisations", label: "Outside", definition: definition() })).rejects.toMatchObject({ status: 404 });
      await expect(actionButtonCatalogue(r, outsider, "ws-b")).resolves.toMatchObject({ buttons: [] });
      const grantOperation = randomUUID();
      const granted = await grantActionButtonManager(r, owner, workspace, { operationId: grantOperation, userId: editor.id });
      const grantedAgain = await grantActionButtonManager(r, owner, workspace, { operationId: grantOperation, userId: editor.id });
      expect(granted).toMatchObject({ granted: true, replayed: false, userId: editor.id });
      expect(grantedAgain).toMatchObject({ replayed: true, userId: editor.id });
      expect(await grants()).toBe(before);
      const editorDraft = await createActionButton(r, editor, workspace, { operationId: randomUUID(), collection: "organisations", label: "Editor managed", definition: definition() });
      await expect(previewActionButton(r, editor, workspace, { operationId: randomUUID(), buttonId: editorDraft.id, kind: "invoke", expectedVersion: editorDraft.version, recordId: visibleRecord, inputs: { note: "No" } })).rejects.toMatchObject({ code: "action_button_paused" });

      const secret = "hidden-salary-value";
      const hidden = await activate(await createActionButton(r, owner, workspace, {
        operationId: randomUUID(), collection: "organisations", label: "Salary action",
        definition: definition({
          inputs: [{ id: "pay", field: secretField, required: true, default: secret }],
          target: { actionId: "hs.record.set-field", field: secretField, inputId: "pay" },
        }),
      }));
      const ownerView = await actionButtonCatalogue(r, owner, workspace);
      expect(JSON.stringify(ownerView.buttons.find(button => button.id === hidden.id))).toContain(secret);
      const readerView = await actionButtonCatalogue(r, reader, workspace);
      expect(JSON.stringify(readerView)).not.toContain(secret);
      expect(JSON.stringify(readerView)).not.toContain(secretField);
      expect(readerView.buttons.some(button => button.status === "draft")).toBe(false);
      const found = await searchActionButtons(r, reader, workspace, "salary");
      expect(found.results.map(item => item.id)).toContain(hidden.id);
      expect(JSON.stringify(found)).not.toContain(secret);
      const file = await downloadActionButton(r, reader, workspace, { operationId: randomUUID(), buttonId: hidden.id, expectedVersion: hidden.version });
      expect(file.body).not.toContain(secret);
      expect(file.body).toContain("does not grant access");
      await expect(downloadActionButton(r, outsider, "ws-b", { operationId: randomUUID(), buttonId: hidden.id, expectedVersion: hidden.version })).rejects.toMatchObject({ status: 404 });
      await expect(previewActionButton(r, reader, workspace, { operationId: randomUUID(), buttonId: hidden.id, kind: "invoke", expectedVersion: hidden.version, recordId: visibleRecord, inputs: { pay: secret } })).rejects.toMatchObject({ code: "action_forbidden" });
      expect(JSON.stringify(await notes(visibleRecord))).not.toContain(secret);

      const noted = await activate(await createActionButton(r, owner, workspace, { operationId: randomUUID(), collection: "organisations", label: "Secret record note", definition: definition() }));
      const secretRun = await invoke(owner, noted, secretRecord, { note: "Hidden run" });
      const readerHistory = await actionButtonHistory(r, reader, workspace, noted.id);
      expect(JSON.stringify(readerHistory)).not.toContain(secretRecord);
      expect(JSON.stringify(readerHistory)).not.toContain("zzsecretrecord");
      expect(JSON.stringify(readerHistory)).not.toContain("Hidden run");
      const ownerHistory = await actionButtonHistory(r, owner, workspace, noted.id);
      expect(ownerHistory.receipts.map(receipt => receipt.recordId)).toContain(secretRecord);
      expect(ownerHistory.events[0]).toMatchObject({ source: "action-button" });
      expect(ownerHistory.events[0].atIst).toMatch(/IST$/);
      await expect(readActionReceipt(r, reader, workspace, secretRun.id)).rejects.toMatchObject({ status: 404 });
      await db.query("DELETE FROM hs_data_record_grants WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3", [tenant, secretRecord, editor.id]);
      await expect(previewActionButton(r, editor, workspace, { operationId: randomUUID(), buttonId: noted.id, kind: "invoke", expectedVersion: noted.version, recordId: secretRecord, inputs: { note: "Nope" } })).rejects.toMatchObject({ status: 404 });
      expect(await notes(secretRecord)).toMatchObject({ notes: "Hidden run" });
      await expect(previewActionButton(r, service, workspace, { operationId: randomUUID(), buttonId: noted.id, kind: "invoke", expectedVersion: noted.version, recordId: visibleRecord, inputs: { note: "Member" } })).rejects.toMatchObject({ status: 404 });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_action_button_receipts WHERE record_id=$1", [secretRecord])).toMatchObject({ rows: [{ n: 1 }] });

      const account = await activate(await createActionButton(r, owner, workspace, { operationId: randomUUID(), collection: "accounts", label: "Account note", definition: definition({ context: { collection: "accounts", placement: "record" } }) }));
      await invoke(owner, account, accountRecord, { note: "Account" });
      expect(await notes(accountRecord)).toMatchObject({ notes: "Account", parent: organisationRecord });
      expect(await db.query("SELECT definition, deprecated FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).toMatchObject({ rows: [{ definition: { paused: true }, deprecated: false }] });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_data_periodic_review_schedules")).toMatchObject({ rows: [{ n: 1 }] });
      await expect(db.query("INSERT INTO hs_action_buttons(id, tenant_id, collection, label, status, definition, created_by) VALUES($1,$2,'organisations','Illegal active','active',$3,$4)", [randomUUID(), tenant, JSON.stringify(definition()), owner.id])).rejects.toThrow(/draft/i);
    });
  });

  describe("N61-06", () => {
    it("versions configuration, keeps drafts, and audits the actor, source, time, and operation", async () => {
      const operationId = randomUUID();
      const body = definition();
      const created = await createActionButton(r, owner, workspace, { operationId, collection: "organisations", label: "Versioned note", definition: body });
      const replay = await createActionButton(r, owner, workspace, { operationId, collection: "organisations", label: "Versioned note", definition: body });
      expect(replay).toMatchObject({ replayed: true, id: created.id, status: "draft" });
      await expect(createActionButton(r, owner, workspace, { operationId, collection: "organisations", label: "Other note", definition: definition() })).rejects.toMatchObject({ code: "operation_mismatch" });
      await expect(previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: created.id, kind: "invoke", expectedVersion: created.version, recordId: versionRecord, inputs: { note: "Early" } })).rejects.toMatchObject({ code: "action_button_paused" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_action_button_receipts WHERE button_id=$1", [created.id])).toMatchObject({ rows: [{ n: 0 }] });

      const stash = await stashActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: created.id, expectedVersion: created.version, definition: definition({ inputs: [{ id: "note", field: "core:notes", required: true, default: "Draft" }] }) });
      expect(stash).toMatchObject({ conflict: false, version: 1 });
      expect(await db.query("SELECT version, status FROM hs_action_buttons WHERE id=$1", [created.id])).toMatchObject({ rows: [{ version: 1, status: "draft" }] });
      const stale = await stashActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: created.id, expectedVersion: 99, definition: definition({ inputs: [{ id: "note", field: "core:notes", required: true, default: "Kept" }] }) });
      expect(stale.conflict).toBe(true);
      expect(stale.recoverableDraft.definition.inputs[0]).toMatchObject({ default: "Kept" });
      const reviewed = await previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: created.id, kind: "version-change", expectedVersion: created.version, definition: definition({ inputs: [{ id: "note", field: "core:notes", required: true, default: "Saved" }] }) });
      await expect(applyActionButtonPreview(r, owner, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: 99 })).rejects.toMatchObject({ code: "action_button_conflict" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_action_button_drafts WHERE button_id=$1 AND actor_id=$2", [created.id, owner.id])).toMatchObject({ rows: [{ n: 1 }] });
      const saved = await applyActionButtonPreview(r, owner, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: created.version }) as ActionButtonView;
      expect(saved).toMatchObject({ status: "draft", version: 2 });
      expect(saved.definition.inputs[0]).toMatchObject({ default: "Saved" });
      await discardActionButtonDraft(r, owner, workspace, { operationId: randomUUID(), buttonId: created.id });
      const active = await activate(saved);
      expect(active.status).toBe("active");
      const changed = await previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: active.id, kind: "version-change", expectedVersion: active.version, definition: definition({ inputs: [{ id: "note", field: "core:notes", required: true, default: "Paused" }] }) });
      const paused = await applyActionButtonPreview(r, owner, workspace, { operationId: randomUUID(), previewId: changed.previewId, expectedVersion: active.version }) as ActionButtonView;
      expect(paused.status).toBe("paused");
      await expect(previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: paused.id, kind: "invoke", expectedVersion: paused.version, recordId: versionRecord, inputs: { note: "Paused" } })).rejects.toMatchObject({ code: "action_button_paused" });
      const rolled = await previewActionButton(r, owner, workspace, { operationId: randomUUID(), buttonId: paused.id, kind: "rollback", expectedVersion: paused.version, targetVersion: 1 });
      const restored = await applyActionButtonPreview(r, owner, workspace, { operationId: randomUUID(), previewId: rolled.previewId, expectedVersion: paused.version }) as ActionButtonView;
      expect(restored).toMatchObject({ status: "paused", version: paused.version + 1 });
      expect(restored.definition.inputs[0]).toMatchObject({ default: "Hello" });
      const history = await actionButtonHistory(r, owner, workspace, created.id);
      expect(history.events.some(event => event.action === "activate" && event.revision === active.version && event.source === "action-button" && /IST$/.test(event.atIst))).toBe(true);
      const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='action-button.activate' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [created.id]);
      const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
      expect(audit.rows[0].actor_id).toBe(owner.id);
      expect(after).toMatchObject({ source: "action-button" });
      expect(after.atIst).toMatch(/IST$/);
      expect(after.operationId).toBeTruthy();
      await expect(db.query("UPDATE hs_action_button_revisions SET label='rewritten' WHERE button_id=$1", [created.id])).rejects.toThrow(/immutable/i);
      const sql = await readFile("db/128_action_buttons.sql", "utf8");
      for (const statement of statements(sql)) await db.query(statement);
      expect(await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).toMatchObject({ rows: [{ definition: { paused: true } }] });
    });
  });
});
