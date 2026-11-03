import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import {
  activateIntakeForm,
  commitIntake,
  disableIntakeForm,
  downloadIntakeReport,
  grantIntakeManager,
  intakeFormCatalogue,
  intakeFormHistory,
  issueIntakeChallenge,
  previewIntakeForm,
  readIntakeReceipt,
  reviewIntake,
  saveIntakeForm,
  searchIntakeForms,
  setIntakeActions,
  setIntakeAnonymousPolicy,
  submitIntake,
} from "./intake-form";
import { intakeReceiptText } from "./intake-form-plan";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const guest = { id: "intake-guest", name: "Gina Guest" };
const editor = { id: "intake-editor", name: "Eve Editor" };
const outsider = { id: "intake-outsider", name: "Bolt User" };
const visitor = { id: "intake-visitor", name: "Pat Visitor" };
const workspace = "ws-aplyd";
const visibleRecord = "00000000-0000-4000-8000-00000000e101";
const secretRecord = "00000000-0000-4000-8000-00000000e102";
const organisationRecord = "00000000-0000-4000-8000-00000000e105";
const accountRecord = "00000000-0000-4000-8000-00000000e104";
const scheduleId = "00000000-0000-4000-8000-00000000e106";
let tenant = "";
let secretField = "";
let emailField = "";
let clinic = "";
type Shown = {
  id: string;
  version: number;
  status: string;
  sharing: string;
  activated: boolean;
  accessGranted: boolean;
  liveActivation: boolean;
  anonymous: boolean;
  queue: { name: string; private: boolean };
  validation: { required: string[] };
  fields: { key: string }[];
  audience: string;
  token: string;
  receipt: string;
  code: string;
  recordCreated: boolean;
  quarantined: boolean;
  state: string;
  scans: { name: string; scan: string; quarantined: boolean; fetched: boolean }[];
  replayed: boolean;
  body: string;
  recordId: string;
  mode: string;
  allowed: boolean;
};
function shown(value: object) { return value as Shown; }

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [guest, editor, outsider, visitor]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member')", [workspace, guest.id, editor.id]);
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
  emailField = randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id, collection, field_key, label, kind, sensitive, created_by) VALUES($1,'organisations',$2,'Private salary','text',true,$3),($1,'organisations',$4,'Clinic email','email',false,$3)", [tenant, secretField, owner.id, emailField]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id, collection, field_key, user_id, can_view, can_write, can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [tenant, secretField, owner.id]);
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE id=$1", [visibleRecord, JSON.stringify({ "core:notes": "Visible note", [secretField]: "hidden-salary-value" })]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
});
afterAll(async () => db.close());

function formDefinition(hours = 72, anonymous = false) {
  return {
    collection: "organisations",
    fields: [
      { key: "core:notes", type: "text" as const, required: false, maxLength: 200 },
      { key: emailField, type: "email" as const, required: true, maxLength: 200 },
      { key: secretField, type: "text" as const, required: false, maxLength: 200 },
    ],
    validation: { required: [emailField] },
    queue: { name: "clinic-intake", private: true as const },
    audience: "public" as const,
    anonymous,
    expiry: { hours },
    consent: null as { text: string; version: number } | null,
    limits: { bytes: 100000, types: ["pdf", "png", "txt"] as ("pdf" | "png" | "txt")[] },
    edge: { cache: "no-store" as const, residency: "tenant" as const, public: false as const },
    bot: { required: true as const },
  };
}
async function footprint() {
  const [records, collections, pages, parents, schedules, invitations] = await Promise.all([
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY 1,2"),
    db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records WHERE parent_organisation_id IS NOT NULL"),
    db.query("SELECT id::text, definition FROM hs_data_periodic_review_schedules ORDER BY 1"),
    db.query("SELECT count(*)::int AS n FROM hs_access_invitations"),
  ]);
  return JSON.stringify({ records: records.rows, collections: collections.rows, pages: pages.rows, parents: parents.rows, schedules: schedules.rows, invitations: invitations.rows[0].n });
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
async function recordCount() {
  return num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_data_records WHERE tenant_id=$1", [tenant])).rows[0].n);
}
async function valueOf(recordId: string, key: string) {
  const row = await db.query<{ field_values: Record<string, string> | string; version: number; name: string }>("SELECT field_values, version, name FROM hs_data_records WHERE id=$1", [recordId]);
  const values = typeof row.rows[0].field_values === "string" ? JSON.parse(row.rows[0].field_values) : row.rows[0].field_values;
  return { value: values[key] as string | undefined, version: num(row.rows[0].version), name: row.rows[0].name };
}
async function challenge(formId: string, actor = guest) {
  return shown(await issueIntakeChallenge(r, actor, workspace, { operationId: randomUUID(), formId })).token;
}
function values(note = "Visible note") {
  return { "core:notes": note, [emailField]: "person@clinic.example" };
}

it("lets a form manager configure allowlisted fields, validation, a private queue, and an explicit audience", async () => {
  const before = await footprint();
  const saved = shown(await saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Clinic intake", definition: formDefinition() }));
  clinic = saved.id;
  expect(saved).toMatchObject({ sharing: "off", activated: false, accessGranted: false, liveActivation: false, status: "draft", anonymous: false, audience: "public" });
  expect(saved.queue).toEqual({ name: "clinic-intake", private: true });
  expect(saved.validation.required).toEqual([emailField]);
  expect(saved.fields.map(field => field.key)).toEqual(["core:notes", emailField, secretField]);
  await expect(saveIntakeForm(r, guest, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Other intake", definition: formDefinition() })).rejects.toMatchObject({ code: "not_found" });
  await expect(saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Public intake", definition: { ...formDefinition(), edge: { cache: "public", residency: "tenant", public: true } } })).rejects.toMatchObject({ code: "intake_edge" });
  await expect(saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Anonymous intake", definition: formDefinition(72, true) })).rejects.toMatchObject({ code: "intake_anonymous" });
  await expect(saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Unbound intake", definition: { ...formDefinition(), fields: [{ key: randomUUID(), type: "text", required: false, maxLength: 20 }], validation: { required: [] } } })).rejects.toMatchObject({ code: "intake_validation" });
  expect(await footprint()).toBe(before);
  const fixture = JSON.parse(await readFile("fixtures/intake-forms/staging.json", "utf8"));
  expect(fixture).toMatchObject({ sharing: "off", activated: false, accessGranted: false, queuePrivate: true, anonymous: false, liveActivation: false });
  const preview = shown(await previewIntakeForm(r, owner, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1 }));
  expect(preview).toMatchObject({ sharing: "off", activated: false, accessGranted: false, audience: "public" });
});

it("applies size, type, rate, bot, and intent controls and returns a generic receipt", async () => {
  const beforeRecords = await recordCount();
  const bot = await challenge(clinic);
  const intent = randomUUID();
  const first = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1, intentToken: intent, botToken: bot, recordName: "Intake clinic", values: values() }));
  expect(first).toMatchObject({ recordCreated: false, quarantined: true, state: "quarantine", receipt: intakeReceiptText });
  expect(JSON.stringify(first)).not.toContain("person@clinic.example");
  expect(JSON.stringify(first)).not.toContain("hidden-salary");
  const again = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1, intentToken: intent, botToken: bot, recordName: "Intake clinic", values: values() }));
  expect(again).toMatchObject({ replayed: true, code: first.code, recordCreated: false });
  await expect(submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1, intentToken: intent, botToken: bot, recordName: "Different clinic", values: values("Other") })).rejects.toMatchObject({ code: "intake_intent" });
  await expect(submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1, intentToken: randomUUID(), botToken: randomUUID(), recordName: "Intake clinic", values: values() })).rejects.toMatchObject({ code: "intake_bot" });
  const scanForm = shown(await saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Scan intake", definition: formDefinition() }));
  await expect(submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: scanForm.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(scanForm.id), recordName: "Intake clinic", values: { ...values(), "core:notes": "javascript:alert(1)" } })).rejects.toMatchObject({ code: "intake_link" });
  await expect(submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: scanForm.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(scanForm.id), recordName: "Intake clinic", values: values(), attachments: [{ name: "brief.pdf", mediaType: "application/pdf", byteSize: 250_000 }] })).rejects.toMatchObject({ code: "intake_limit" });
  const oversized = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: scanForm.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(scanForm.id), recordName: "Intake clinic", values: values(), attachments: [{ name: "brief.pdf", mediaType: "application/pdf", byteSize: 150_000 }] }));
  expect(oversized).toMatchObject({ recordCreated: false, state: "rejected", quarantined: true });
  expect(oversized.scans[0]).toMatchObject({ scan: "rejected", quarantined: true, fetched: false });
  const mistyped = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: scanForm.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(scanForm.id), recordName: "Intake clinic", values: values(), attachments: [{ name: "photo.gif", mediaType: "image/gif", byteSize: 40 }] }));
  expect(mistyped.scans[0]).toMatchObject({ scan: "rejected", quarantined: true, fetched: false });
  expect(mistyped.state).toBe("rejected");
  const unsafe = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: scanForm.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(scanForm.id), recordName: "Intake clinic", values: values(), attachments: [{ name: "eicar.txt", mediaType: "text/plain", byteSize: 68 }] }));
  expect(unsafe.scans[0].scan).toBe("rejected");
  expect(await recordCount()).toBe(beforeRecords);
  const rateForm = shown(await saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Rate intake", definition: formDefinition() }));
  for (let index = 0; index < 5; index += 1) {
    const accepted = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: rateForm.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(rateForm.id), recordName: `Rate ${index}`, values: values() }));
    expect(accepted.recordCreated).toBe(false);
  }
  await expect(submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: rateForm.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(rateForm.id), recordName: "Rate overflow", values: values() })).rejects.toMatchObject({ code: "intake_rate" });
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_intake_submissions WHERE form_id=$1", [rateForm.id])).rows[0].n)).toBe(5);
  expect(await recordCount()).toBe(beforeRecords);
});

it("quarantines attachments and reviews values before creating a record, without overwriting a matching name", async () => {
  const before = await valueOf(visibleRecord, "core:notes");
  const beforeCount = await recordCount();
  const form = shown(await saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Quarantine intake", definition: formDefinition() }));
  const submitted = shown(await submitIntake(r, guest, workspace, {
    operationId: randomUUID(), formId: form.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(form.id),
    recordName: "Visible clinic", values: values("Queued note"), attachments: [{ name: "brief.pdf", mediaType: "application/pdf", byteSize: 120 }],
  }));
  expect(submitted).toMatchObject({ state: "quarantine", recordCreated: false, quarantined: true });
  expect(submitted.scans[0]).toMatchObject({ scan: "clean", quarantined: true, fetched: false });
  expect(await recordCount()).toBe(beforeCount);
  expect(await valueOf(visibleRecord, "core:notes")).toEqual(before);
  await expect(commitIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: submitted.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "intake_review" });
  const reviewed = shown(await reviewIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: submitted.id, expectedVersion: 1 }));
  expect(reviewed).toMatchObject({ state: "reviewed", recordCreated: false, quarantined: true });
  expect(await recordCount()).toBe(beforeCount);
  await expect(commitIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: submitted.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "action_forbidden" });
  expect(await valueOf(visibleRecord, "core:notes")).toEqual(before);
  await db.query("UPDATE hs_data_collection_grants SET capabilities=array_append(capabilities,'create') WHERE tenant_id=$1 AND user_id=$2 AND collection='organisations' AND NOT ('create'=ANY(capabilities))", [tenant, owner.id]);
  const committed = shown(await commitIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: submitted.id, expectedVersion: 1 }));
  expect(committed).toMatchObject({ recordCreated: true, mode: "insert", state: "committed" });
  expect(committed.recordId).not.toBe(visibleRecord);
  expect(await valueOf(visibleRecord, "core:notes")).toEqual(before);
  expect((await valueOf(visibleRecord, secretField)).value).toBe("hidden-salary-value");
  const created = await valueOf(committed.recordId, "core:notes");
  expect(created).toMatchObject({ value: "Queued note", name: "Visible clinic", version: 1 });
  const rejected = shown(await submitIntake(r, guest, workspace, {
    operationId: randomUUID(), formId: form.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(form.id),
    recordName: "Unsafe clinic", values: values(), attachments: [{ name: "eicar.txt", mediaType: "text/plain", byteSize: 40 }],
  }));
  await expect(reviewIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: rejected.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "intake_scan" });
  const explicit = shown(await submitIntake(r, guest, workspace, {
    operationId: randomUUID(), formId: form.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(form.id),
    recordName: "Visible clinic", values: values("Updated by id"),
  }));
  await reviewIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: explicit.id, expectedVersion: 1 });
  const updated = shown(await commitIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: explicit.id, expectedVersion: 1, recordId: secretRecord, expectedRecordVersion: 1 }));
  expect(updated).toMatchObject({ mode: "update", recordId: secretRecord, recordCreated: true });
  expect((await valueOf(secretRecord, "core:notes")).value).toBe("Updated by id");
  expect(await valueOf(visibleRecord, "core:notes")).toEqual(before);
  expect((await valueOf(visibleRecord, secretField)).value).toBe("hidden-salary-value");
});

it("fences in-flight submissions on revision, disable, and expiry, and scopes receipts", async () => {
  const consent = { ...formDefinition(), consent: { text: "Synthetic notice v1.", version: 1 } };
  const form = shown(await saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Consent intake", definition: consent }));
  await expect(submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: form.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(form.id), recordName: "Consent clinic", values: values() })).rejects.toMatchObject({ code: "intake_consent" });
  const submitted = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: form.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(form.id), recordName: "Consent clinic", values: values(), consentAccepted: true, consentVersion: 1 }));
  expect(submitted.recordCreated).toBe(false);
  const revised = shown(await saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), formId: form.id, expectedVersion: 1, name: "Consent intake", definition: { ...consent, consent: { text: "Synthetic notice v2.", version: 2 } } }));
  expect(revised.version).toBe(2);
  expect((await db.query<{ state: string }>("SELECT state FROM hs_intake_submissions WHERE id=$1", [submitted.id])).rows[0].state).toBe("fenced");
  await expect(reviewIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: submitted.id, expectedVersion: 2 })).rejects.toMatchObject({ code: "intake_fenced" });
  await expect(commitIntake(r, owner, workspace, { operationId: randomUUID(), formId: form.id, submissionId: submitted.id, expectedVersion: 2 })).rejects.toMatchObject({ code: "intake_fenced" });
  const lateBot = await challenge(form.id);
  const held = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: form.id, expectedVersion: 2, intentToken: randomUUID(), botToken: await challenge(form.id), recordName: "Held clinic", values: values(), consentAccepted: true, consentVersion: 2 }));
  await disableIntakeForm(r, owner, workspace, { operationId: randomUUID(), formId: form.id, expectedVersion: 2 });
  expect((await db.query<{ state: string }>("SELECT state FROM hs_intake_submissions WHERE id=$1", [held.id])).rows[0].state).toBe("fenced");
  await expect(submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: form.id, expectedVersion: 3, intentToken: randomUUID(), botToken: lateBot, recordName: "Late clinic", values: values(), consentAccepted: true, consentVersion: 2 })).rejects.toMatchObject({ code: "intake_fenced" });
  const expiring = shown(await saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Expiring intake", definition: formDefinition(1) }));
  const open = shown(await submitIntake(r, guest, workspace, { operationId: randomUUID(), formId: expiring.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(expiring.id), recordName: "Open clinic", values: values() }));
  await db.query("UPDATE hs_intake_forms SET expires_at=clock_timestamp() - interval '1 minute' WHERE id=$1", [expiring.id]);
  await expect(reviewIntake(r, owner, workspace, { operationId: randomUUID(), formId: expiring.id, submissionId: open.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "intake_fenced" });
  expect((await db.query<{ state: string; status: string }>("SELECT s.state, f.status FROM hs_intake_submissions s JOIN hs_intake_forms f ON f.id=s.form_id WHERE s.id=$1", [open.id])).rows[0]).toMatchObject({ state: "fenced", status: "expired" });
  const receipt = await readIntakeReceipt(r, owner, workspace, submitted.code);
  expect(receipt).toMatchObject({ receipt: intakeReceiptText, recordCreated: false });
  expect(JSON.stringify(receipt)).not.toContain("person@clinic.example");
  await grantIntakeManager(r, owner, workspace, { operationId: randomUUID(), userId: editor.id });
  await setIntakeActions(r, owner, workspace, { operationId: randomUUID(), userId: editor.id, expectedVersion: 0, actions: ["search"] });
  await expect(readIntakeReceipt(r, editor, workspace, submitted.code)).rejects.toMatchObject({ code: "not_found" });
  await expect(readIntakeReceipt(r, outsider, workspace, submitted.code)).rejects.toMatchObject({ code: "not_found" });
  await expect(readIntakeReceipt(r, outsider, "ws-b", submitted.code)).rejects.toMatchObject({ code: "not_found" });
  const audit = await db.query<{ actor_id: string; after_value: { consentVersion?: number; source?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='intake-form.submit' AND subject_id=$1", [form.id]);
  const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
  expect(after.consentVersion).toBe(1);
  expect(after.source).toBe("intake-form");
});

it("enforces tenant, record, field, and action checks without turning configuration into access", async () => {
  const before = await footprint();
  expect(await footprint()).toBe(before);
  const found = await searchIntakeForms(r, editor, workspace, "visible note");
  expect(found.results.some(result => result.name === "Clinic intake" || result.name === "Consent intake")).toBe(true);
  expect(JSON.stringify(await searchIntakeForms(r, editor, workspace, "hidden-salary"))).not.toContain("hidden-salary");
  expect(JSON.stringify(await searchIntakeForms(r, editor, workspace, "zzsecret"))).not.toContain("zzsecretrecord");
  await expect(downloadIntakeReport(r, editor, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1 })).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(intakeFormHistory(r, editor, workspace, clinic)).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(searchIntakeForms(r, outsider, workspace, "clinic")).rejects.toMatchObject({ code: "not_found" });
  expect((await searchIntakeForms(r, outsider, "ws-b", "clinic")).results).toEqual([]);
  await expect(searchIntakeForms(r, visitor, workspace, "clinic")).rejects.toMatchObject({ code: "not_found" });
  const report = shown(await downloadIntakeReport(r, owner, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1 }));
  expect(report.body).toContain("Sharing: off");
  expect(report.body).toContain("Activation: none");
  expect(report.body).not.toContain("hidden-salary");
  await expect(activateIntakeForm(r, owner, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1 })).rejects.toMatchObject({ code: "intake_activation" });
  const row = await db.query<{ status: string; sharing: string; activated: boolean }>("SELECT status, sharing, activated FROM hs_intake_forms WHERE id=$1", [clinic]);
  expect(row.rows[0]).toMatchObject({ sharing: "off", activated: false });
  expect(await footprint()).toBe(before);
});

it("versions configuration, keeps recoverable drafts, and audits actor, source, time, and operation", async () => {
  const before = await footprint();
  const operationId = randomUUID();
  const saved = shown(await saveIntakeForm(r, owner, workspace, { operationId, expectedVersion: 0, name: "Audited intake", definition: formDefinition() }));
  const replayed = await saveIntakeForm(r, owner, workspace, { operationId, expectedVersion: 0, name: "Audited intake", definition: formDefinition() });
  expect(replayed).toMatchObject({ replayed: true, id: saved.id, version: saved.version });
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_intake_forms WHERE id=$1", [saved.id])).rows[0].n)).toBe(1);
  await expect(saveIntakeForm(r, owner, workspace, { operationId, expectedVersion: 1, name: "Audited intake", definition: formDefinition() })).rejects.toMatchObject({ code: "operation_mismatch" });
  await expect(saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), formId: saved.id, expectedVersion: 0, name: "Audited intake renamed", definition: formDefinition() })).rejects.toMatchObject({ code: "intake_conflict" });
  const catalogue = await intakeFormCatalogue(r, owner, workspace);
  expect(catalogue.drafts.some(draft => draft.formKey === saved.id && draft.kind === "configure")).toBe(true);
  expect(catalogue.sharing).toBe("off");
  expect(catalogue.activated).toBe(false);
  expect(catalogue.recoverable).toContain("draft");
  const history = await intakeFormHistory(r, owner, workspace, saved.id);
  expect(history.events.some(event => event.action === "configure" && event.source === "intake-form" && event.actorId === owner.id && /IST$/.test(event.atIst))).toBe(true);
  const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='intake-form.configure' AND subject_id=$1", [saved.id]);
  const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
  expect(audit.rows[0].actor_id).toBe(owner.id);
  expect(after).toMatchObject({ source: "intake-form", accessGranted: false, sharing: "off", activated: false });
  expect(after.atIst).toMatch(/IST$/);
  expect(after.operationId).toBe(operationId);
  await expect(db.query("UPDATE hs_intake_form_revisions SET name='rewritten' WHERE form_id=$1", [saved.id])).rejects.toThrow(/immutable/i);
  const policy = shown(await setIntakeAnonymousPolicy(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, allowed: true }));
  expect(policy).toMatchObject({ allowed: true, accessGranted: false, activated: false });
  const opened = shown(await saveIntakeForm(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Anonymous intake", definition: { ...formDefinition(), audience: "public", anonymous: true } }));
  const anon = shown(await submitIntake(r, visitor, workspace, { operationId: randomUUID(), formId: opened.id, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(opened.id, visitor), anonymous: true, recordName: "Anon clinic", values: values() }));
  expect(anon).toMatchObject({ anonymous: true, recordCreated: false, quarantined: true });
  expect((await db.query<{ actor_id: string | null; anonymous: boolean }>("SELECT actor_id, anonymous FROM hs_intake_submissions WHERE id=$1", [anon.id])).rows[0]).toEqual({ actor_id: null, anonymous: true });
  await expect(readIntakeReceipt(r, visitor, workspace, anon.code)).rejects.toMatchObject({ code: "not_found" });
  await expect(submitIntake(r, visitor, workspace, { operationId: randomUUID(), formId: clinic, expectedVersion: 1, intentToken: randomUUID(), botToken: await challenge(clinic, visitor), anonymous: true, recordName: "Blocked", values: values() })).rejects.toMatchObject({ code: "not_found" });
  const sql = await readFile("db/133_external_intake.sql", "utf8");
  const executable = sql.replace(/--.*$/gm, "");
  expect(executable).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(executable).not.toMatch(/parent_organisation_id/);
  expect(executable).not.toMatch(/release\.py/);
  for (const statement of statements(sql)) await db.query(statement);
  expect((await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).rows[0].definition).toMatchObject({ paused: true });
  expect((await db.query<{ parent_organisation_id: string }>("SELECT parent_organisation_id::text FROM hs_data_records WHERE id=$1", [accountRecord])).rows[0].parent_organisation_id).toBe(organisationRecord);
  expect(JSON.parse(await footprint()).schedules).toEqual(JSON.parse(before).schedules);
  expect(JSON.parse(await footprint()).parents).toEqual(JSON.parse(before).parents);
});

function num(value: number | string) { return Number(value); }
