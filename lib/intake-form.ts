import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import {
  assertConsentAdvance,
  assertIntakeEmail,
  assertIntakeText,
  commitTarget,
  compileIntakeForm,
  decideAbuse,
  decideAnonymous,
  decideFence,
  genericReceipt,
  intakeActivation,
  intakeActorActions,
  intakeAnonymousCopy,
  intakeAssignment,
  intakeBoundary,
  intakeEdge,
  intakeLimits,
  intakeMedia,
  intakeName,
  intakeQuarantine,
  intakeQuery,
  intakeRateLimit,
  intakeReceiptText,
  intakeRecordName,
  intakeRecoverable,
  intakeReport,
  intakeSchedules,
  intakeSharing,
  intakeSource,
  intakeUuid,
  scanIntakeAttachment,
  type IntakeActorAction,
  type IntakeDefinition,
  type IntakeStatus,
} from "./intake-form-plan";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash, standardRecordFields } from "./shared-record-types";

const unavailable = () => new DocumentError("Intake forms are restricted or unavailable.", "not_found", 404);
const forbidden = () => new DocumentError("This action is not permitted.", "action_forbidden", 403);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const conflictMessage = "The form version changed. The draft is kept.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { workspaceId: string; tenantId: string; role: string };
type FormRow = {
  id: string;
  name: string;
  status: IntakeStatus;
  sharing: string;
  activated: boolean;
  version: number | string;
  cache_generation: number | string;
  definition: unknown;
  created_by: string;
  expires_at: string | Date;
};
type SubmissionRow = {
  id: string;
  form_id: string;
  form_version: number | string;
  actor_id: string | null;
  anonymous: boolean;
  state: string;
  record_name: string;
  values: unknown;
  consent_version: number | null;
  receipt_code: string;
  request_hash: string;
  committed_record_id: string | null;
};
type Outcome = { conflict?: boolean; failed?: boolean; message?: string; code?: string };
type AttachmentInput = { name: string; mediaType: string; byteSize: number };

const copy = () => ({
  boundary: intakeBoundary,
  assignment: intakeAssignment,
  anonymousPolicy: intakeAnonymousCopy,
  activation: intakeActivation,
  quarantine: intakeQuarantine,
  schedules: intakeSchedules,
  recoverable: intakeRecoverable,
  edge: intakeEdge,
  receipt: intakeReceiptText,
  sharing: intakeSharing,
  accessGranted: false as const,
  activated: false as const,
  liveActivation: false as const,
});

function settle<T extends object>(result: T): T {
  const value = result as T & Outcome;
  if (value.failed) throw new DocumentError(value.message ?? "Check the form.", value.code ?? "intake_validation", 409);
  if (value.conflict) throw new DocumentError(conflictMessage, "intake_conflict", 409);
  return result;
}
function fail(code: string, message: string) {
  return { failed: true as const, code, message };
}
function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asJson<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function flags(extra: Record<string, unknown> = {}) {
  return { sharing: intakeSharing, accessGranted: false as const, activated: false as const, liveActivation: false as const, recordCreated: false as const, cache: "no-store" as const, ...extra };
}
function kept(message: string) { return `${message} The draft is kept.`; }

async function tenantOf(tx: Sql, workspaceId: string) {
  if (!workspaceId || workspaceId.length > 200) throw unavailable();
  const row = await tx.query<{ tenant_id: string | null }>(
    `SELECT b.tenant_id FROM hs_workspaces w
     LEFT JOIN hs_data_workspaces b ON b.workspace_id=w.id
     WHERE w.id=$1`,
    [workspaceId],
  );
  if (!row.rows[0]?.tenant_id) throw unavailable();
  return { workspaceId, tenantId: row.rows[0].tenant_id };
}
async function scopeOf(tx: Sql, workspaceId: string, actor: Actor): Promise<Scope> {
  const located = await tenantOf(tx, workspaceId);
  const row = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, actor.id]);
  if (!row.rows[0]) throw unavailable();
  return { ...located, role: row.rows[0].role };
}
async function hold(tx: Sql, tenantId: string) {
  await tx.query("SELECT id FROM hs_data_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
}
async function isMember(tx: Sql, workspaceId: string, userId: string) {
  const row = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, userId]);
  return row.rows.length > 0;
}
async function isManager(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "owner" || here.role === "admin") return true;
  const row = await tx.query("SELECT 1 FROM hs_intake_form_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
  return row.rows.length > 0;
}
async function requireManager(tx: Sql, here: Scope, actor: Actor) {
  if (!await isManager(tx, here, actor)) throw unavailable();
}
async function actionAllowed(tx: Sql, tenantId: string, userId: string, action: IntakeActorAction, base: boolean) {
  if (!base) return false;
  const rows = await tx.query<{ action: string }>("SELECT action FROM hs_intake_form_actor_actions WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  if (!rows.rows.length) return true;
  return rows.rows.some(row => row.action === action);
}
async function policyAllows(tx: Sql, tenantId: string) {
  const row = await tx.query<{ allowed: boolean }>("SELECT allowed FROM hs_intake_anonymous_policy WHERE tenant_id=$1", [tenantId]);
  return on(row.rows[0]?.allowed);
}
async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_intake_form_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}
async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const stored = { ...result, replayed: false as const };
  await tx.query("INSERT INTO hs_intake_form_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}
async function audit(tx: Sql, actor: Actor, action: string, operationId: string, formId: string, after: Record<string, unknown>) {
  const body = { source: intakeSource, operationId, atIst: formatIst(new Date()), ...flags(after) };
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,page_id,subject_id,after_value,correlation_id) VALUES($1,$2,$3,NULL,$4,$5,$6)",
    [randomUUID(), actor.id, action, formId, JSON.stringify(body), operationId],
  );
}
async function track(tx: Sql, tenantId: string, formId: string, actor: Actor, action: string, operationId: string, cacheGeneration: number, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_intake_form_events(id,tenant_id,form_id,action,actor_id,operation_id,source,cache_generation,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [randomUUID(), tenantId, formId, action, actor.id, operationId, intakeSource, cacheGeneration, JSON.stringify(flags(detail))],
  );
}
async function saveDraft(tx: Sql, tenantId: string, actorId: string, formKey: string, kind: string, baseVersion: number, payload: Record<string, unknown>, operationId: string) {
  await tx.query(
    `INSERT INTO hs_intake_form_drafts(tenant_id,actor_id,form_key,kind,base_version,payload,operation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, actor_id, form_key, kind)
     DO UPDATE SET base_version=$5, payload=$6, operation_id=$7, updated_at=clock_timestamp()`,
    [tenantId, actorId, formKey, kind, baseVersion, JSON.stringify(payload), operationId],
  );
}
function definitionOf(value: unknown) {
  return compileIntakeForm(asJson(value));
}
function present(row: FormRow, definition: IntakeDefinition, replayed = false) {
  return {
    ...flags(),
    id: row.id,
    name: row.name,
    status: row.status,
    version: num(row.version),
    cacheGeneration: num(row.cache_generation),
    definition,
    audience: definition.audience,
    anonymous: definition.anonymous,
    queue: definition.queue,
    validation: definition.validation,
    fields: definition.fields,
    consent: definition.consent,
    expiry: definition.expiry,
    replayed,
  };
}
async function loadForm(tx: Sql, tenantId: string, formId: string) {
  if (!uuidPattern.test(formId)) throw unavailable();
  const row = await tx.query<FormRow>("SELECT id, name, status, sharing, activated, version, cache_generation, definition, created_by, expires_at FROM hs_intake_forms WHERE id=$1 AND tenant_id=$2", [formId, tenantId]);
  if (!row.rows[0] || row.rows[0].sharing !== "off" || on(row.rows[0].activated)) throw unavailable();
  return row.rows[0];
}
async function revise(tx: Sql, row: FormRow, actor: Actor, operationId: string, action: string) {
  await tx.query(
    "INSERT INTO hs_intake_form_revisions(form_id,version,status,name,definition,cache_generation,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [row.id, num(row.version), row.status, row.name, JSON.stringify(asJson(row.definition)), num(row.cache_generation), action, actor.id, operationId],
  );
}
function kindAllows(type: "text" | "email", kind: string) {
  if (type === "email") return kind === "email";
  return kind === "text" || kind === "long-text";
}
async function assertBound(tx: Sql, tenantId: string, definition: IntakeDefinition) {
  const collection = await tx.query("SELECT 1 FROM hs_data_collections WHERE tenant_id=$1 AND id=$2 AND deprecated=false", [tenantId, definition.collection]);
  if (!collection.rows.length) throw unavailable();
  const core = new Map(standardRecordFields(definition.collection).map(field => [field.key, field]));
  for (const field of definition.fields) {
    if (field.key.startsWith("core:")) {
      const found = core.get(field.key);
      if (!found || !kindAllows(field.type, found.kind)) throw new DocumentError("Check the form.", "intake_validation", 422);
      continue;
    }
    const row = await tx.query<{ kind: string; deprecated: boolean }>("SELECT kind, deprecated FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND field_key=$3", [tenantId, definition.collection, field.key]);
    if (!row.rows[0] || on(row.rows[0].deprecated) || !kindAllows(field.type, row.rows[0].kind)) throw new DocumentError("Check the form.", "intake_validation", 422);
  }
}
async function fieldDecision(tx: Sql, tenantId: string, collection: string, key: string, userId: string, mode: "view" | "write" | "history") {
  const core = standardRecordFields(collection).find(field => field.key === key);
  const policy = await tx.query<{ sensitive: boolean }>("SELECT sensitive FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND field_key=$3", [tenantId, collection, key]);
  const sensitive = on(policy.rows[0]?.sensitive) || core?.sensitive === true;
  if (!policy.rows[0] && !sensitive) return true;
  const explicit = await tx.query("SELECT 1 FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 LIMIT 1", [tenantId, collection, key]);
  if (!sensitive && !explicit.rows.length) return true;
  const access = await tx.query<{ can_view: boolean; can_write: boolean; can_history: boolean }>(
    "SELECT can_view, can_write, can_history FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND user_id=$4",
    [tenantId, collection, key, userId],
  );
  const row = access.rows[0];
  if (!row) return false;
  if (mode === "write") return on(row.can_write);
  if (mode === "history") return on(row.can_history);
  return on(row.can_view);
}
async function can(tx: Sql, tenantId: string, userId: string, collection: string, recordId: string | null, capability: string) {
  const row = await tx.query<{ ok: boolean }>(
    `SELECT (
      EXISTS (SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=$1 AND g.user_id=$2 AND g.collection=$3 AND $4=ANY(g.capabilities))
      OR ($5::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=$1 AND rg.record_id=$5 AND rg.user_id=$2 AND $4=ANY(rg.capabilities)))
    ) AS ok`,
    [tenantId, userId, collection, capability, recordId],
  );
  return on(row.rows[0]?.ok);
}
async function fenceOlder(tx: Sql, formId: string, version: number) {
  await tx.query("UPDATE hs_intake_submissions SET state='fenced' WHERE form_id=$1 AND state IN ('quarantine','reviewed') AND form_version < $2", [formId, version]);
}
async function fenceOpen(tx: Sql, formId: string) {
  await tx.query("UPDATE hs_intake_submissions SET state='fenced' WHERE form_id=$1 AND state IN ('quarantine','reviewed')", [formId]);
}
function expired(row: FormRow) {
  return new Date(row.expires_at).getTime() <= Date.now();
}
async function writeForm(tx: Sql, here: Scope, actor: Actor, operationId: string, action: string, formId: string, expectedVersion: number, patch: { status?: IntakeStatus; name?: string; definition?: IntakeDefinition; expiresAt?: string }) {
  const current = await loadForm(tx, here.tenantId, formId);
  const definition = patch.definition ?? definitionOf(current.definition);
  if (num(current.version) !== expectedVersion) {
    await saveDraft(tx, here.tenantId, actor.id, formId, "configure", expectedVersion, { name: patch.name ?? current.name, definition }, operationId);
    return { conflict: true as const, version: num(current.version) };
  }
  if (current.status === "revoked" && action !== "configure") {
    await saveDraft(tx, here.tenantId, actor.id, formId, "configure", expectedVersion, { name: current.name, definition, rejected: action }, operationId);
    return fail("intake_revoked", "This form is revoked. The draft is kept.");
  }
  const status = patch.status ?? current.status;
  const name = patch.name ?? current.name;
  const expiresAt = patch.expiresAt ?? new Date(current.expires_at).toISOString();
  const updated = await tx.query<FormRow>(
    `UPDATE hs_intake_forms SET status=$2, name=$3, definition=$4::jsonb, expires_at=$5, version=version+1, cache_generation=cache_generation+1, updated_at=clock_timestamp()
     WHERE id=$1 AND tenant_id=$6 AND version=$7
     RETURNING id, name, status, sharing, activated, version, cache_generation, definition, created_by, expires_at`,
    [formId, status, name, JSON.stringify(definition), expiresAt, here.tenantId, expectedVersion],
  );
  const row = updated.rows[0];
  if (!row) return { conflict: true as const, version: num(current.version) };
  if (row.status === "draft") await fenceOlder(tx, row.id, num(row.version));
  else await fenceOpen(tx, row.id);
  await revise(tx, row, actor, operationId, action);
  await audit(tx, actor, `intake-form.${action}`, operationId, row.id, { status: row.status, cacheGeneration: num(row.cache_generation), version: num(row.version), consentVersion: definition.consent?.version ?? null });
  await track(tx, here.tenantId, row.id, actor, action, operationId, num(row.cache_generation), { status: row.status, version: num(row.version), consentVersion: definition.consent?.version ?? null });
  return present(row, definitionOf(row.definition));
}
async function expireIfNeeded(tx: Sql, here: Scope, actor: Actor, row: FormRow, operationId: string) {
  if (row.status !== "draft" || !expired(row)) return row;
  const saved = await writeForm(tx, here, actor, operationId, "expire", row.id, num(row.version), { status: "expired" });
  if ("conflict" in saved || "failed" in saved) return row;
  return loadForm(tx, here.tenantId, row.id);
}

export async function intakeFormCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manage = await isManager(tx, here, actor);
    const forms = [];
    if (manage) {
      const rows = await tx.query<FormRow>("SELECT id, name, status, sharing, activated, version, cache_generation, definition, created_by, expires_at FROM hs_intake_forms WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
      for (const row of rows.rows) {
        const definition = definitionOf(row.definition);
        forms.push({ id: row.id, name: row.name, status: row.status, version: num(row.version), cacheGeneration: num(row.cache_generation), sharing: intakeSharing, accessGranted: false as const, activated: false as const, audience: definition.audience, queue: definition.queue.name, anonymous: definition.anonymous });
      }
    }
    const drafts = await tx.query<{ form_key: string; kind: string; base_version: number | string; payload: unknown }>("SELECT form_key, kind, base_version, payload FROM hs_intake_form_drafts WHERE tenant_id=$1 AND actor_id=$2 ORDER BY form_key, kind", [here.tenantId, actor.id]);
    return {
      ...copy(),
      actorId: actor.id,
      manage,
      anonymousAllowed: await policyAllows(tx, here.tenantId),
      forms,
      drafts: drafts.rows.map(draft => ({ formKey: draft.form_key, kind: draft.kind, baseVersion: num(draft.base_version), payload: asJson(draft.payload) })),
    };
  });
}

export async function readIntakeForm(r: Repository, actor: Actor, workspaceId: string, formId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const row = await loadForm(tx, here.tenantId, formId);
    return { ...present(row, definitionOf(row.definition)), admitted: false as const };
  });
}

export async function searchIntakeForms(r: Repository, actor: Actor, workspaceId: string, query: string) {
  const needle = intakeQuery(query);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "search", true)) throw forbidden();
    if (!await isManager(tx, here, actor)) return { results: [], ...flags({ assignment: intakeAssignment }) };
    const rows = await tx.query<FormRow>("SELECT id, name, status, sharing, activated, version, cache_generation, definition, created_by, expires_at FROM hs_intake_forms WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
    const results = [];
    for (const row of rows.rows) {
      const definition = definitionOf(row.definition);
      const submissions = await tx.query<{ record_name: string; values: unknown }>("SELECT record_name, values FROM hs_intake_submissions WHERE tenant_id=$1 AND form_id=$2", [here.tenantId, row.id]);
      const visible: string[] = [row.name, row.status, definition.queue.name];
      for (const submission of submissions.rows) {
        visible.push(submission.record_name);
        const values = asJson<Record<string, string>>(submission.values);
        for (const [key, value] of Object.entries(values)) {
          if (await fieldDecision(tx, here.tenantId, definition.collection, key, actor.id, "view")) visible.push(value);
        }
      }
      if (!visible.join("\n").toLocaleLowerCase().includes(needle)) continue;
      const shown = visible.filter(value => value.toLocaleLowerCase().includes(needle) && value !== row.name);
      results.push({ id: row.id, name: row.name, status: row.status, sharing: intakeSharing, accessGranted: false as const, activated: false as const, queue: definition.queue.name, values: shown });
    }
    return { results, ...flags({ assignment: intakeAssignment }) };
  });
}

export async function intakeFormHistory(r: Repository, actor: Actor, workspaceId: string, formId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadForm(tx, here.tenantId, formId);
    const definition = definitionOf(row.definition);
    if (!await isManager(tx, here, actor)) throw unavailable();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "history", true)) throw forbidden();
    for (const field of definition.fields) {
      if (!await fieldDecision(tx, here.tenantId, definition.collection, field.key, actor.id, "history")) throw forbidden();
    }
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; cache_generation: number | string; created_at: string | Date; detail: unknown }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.cache_generation, e.created_at, e.detail
       FROM hs_intake_form_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.form_id=$2 ORDER BY e.created_at, e.id`,
      [here.tenantId, formId],
    );
    return {
      ...flags(),
      events: events.rows.map(event => {
        const detail = asJson<{ consentVersion?: number | null }>(event.detail);
        return { action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id, source: event.source, cacheGeneration: num(event.cache_generation), atIst: formatIst(event.created_at), consentVersion: detail.consentVersion ?? null };
      }),
      form: { id: row.id, name: row.name, status: row.status, sharing: intakeSharing, activated: false as const },
    };
  });
}

export async function saveIntakeForm(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId?: string; expectedVersion: number; name: string; definition: unknown }) {
  const name = intakeName(input.name);
  const definition = compileIntakeForm(input.definition);
  const requestHash = recordHash({ kind: "configure", workspaceId, formId: input.formId ?? null, expectedVersion: input.expectedVersion, name, definition });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "configure", true)) throw forbidden();
    const replay = await prior<Outcome & { id?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await assertBound(tx, here.tenantId, definition);
    if (definition.anonymous && !await policyAllows(tx, here.tenantId)) {
      await saveDraft(tx, here.tenantId, actor.id, input.formId ?? "new", "configure", input.expectedVersion, { name, definition, rejected: "anonymous" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_anonymous", intakeAnonymousCopy));
    }
    const expiresAt = new Date(Date.now() + definition.expiry.hours * 3_600_000).toISOString();
    if (!input.formId) {
      if (input.expectedVersion !== 0) {
        await saveDraft(tx, here.tenantId, actor.id, "new", "configure", input.expectedVersion, { name, definition }, input.operationId);
        return { conflict: true as const, version: 0 };
      }
      const id = randomUUID();
      const inserted = await tx.query<FormRow>(
        `INSERT INTO hs_intake_forms(id,tenant_id,name,status,sharing,activated,version,cache_generation,definition,expires_at,created_by)
         VALUES($1,$2,$3,'draft','off',false,1,1,$4::jsonb,$5,$6)
         RETURNING id, name, status, sharing, activated, version, cache_generation, definition, created_by, expires_at`,
        [id, here.tenantId, name, JSON.stringify(definition), expiresAt, actor.id],
      );
      const row = inserted.rows[0];
      await revise(tx, row, actor, input.operationId, "configure");
      await audit(tx, actor, "intake-form.configure", input.operationId, row.id, { status: "draft", cacheGeneration: 1, version: 1, consentVersion: definition.consent?.version ?? null });
      await track(tx, here.tenantId, row.id, actor, "configure", input.operationId, 1, { status: "draft", version: 1, consentVersion: definition.consent?.version ?? null });
      return remember(tx, actor.id, input.operationId, requestHash, present(row, definitionOf(row.definition)));
    }
    const current = await loadForm(tx, here.tenantId, input.formId);
    assertConsentAdvance(definitionOf(current.definition).consent, definition.consent);
    const saved = await writeForm(tx, here, actor, input.operationId, "configure", input.formId, input.expectedVersion, { name, definition, expiresAt });
    return remember(tx, actor.id, input.operationId, requestHash, saved);
  });
  return settle(outcome);
}

export async function stashIntakeForm(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; expectedVersion: number; name: string; definition: unknown }) {
  const name = intakeName(input.name);
  const definition = compileIntakeForm(input.definition);
  const requestHash = recordHash({ kind: "stash", workspaceId, formId: input.formId, expectedVersion: input.expectedVersion, name, definition });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await loadForm(tx, here.tenantId, input.formId);
    await saveDraft(tx, here.tenantId, actor.id, input.formId, "configure", input.expectedVersion, { name, definition }, input.operationId);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ version: input.expectedVersion, stashed: true as const }));
  });
  return settle(outcome);
}

export async function discardIntakeDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, formId: input.formId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_intake_form_drafts WHERE tenant_id=$1 AND actor_id=$2 AND form_key=$3", [here.tenantId, actor.id, input.formId]);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ discarded: true as const }));
  });
}

export async function previewIntakeForm(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "preview", workspaceId, formId: input.formId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "preview", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadForm(tx, here.tenantId, input.formId);
    const definition = definitionOf(row.definition);
    if (num(row.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.formId, "configure", input.expectedVersion, { rejected: "preview" }, input.operationId);
      return { conflict: true as const, version: num(row.version) };
    }
    await audit(tx, actor, "intake-form.preview", input.operationId, row.id, { status: row.status, cacheGeneration: num(row.cache_generation), version: num(row.version), consentVersion: definition.consent?.version ?? null });
    await track(tx, here.tenantId, row.id, actor, "preview", input.operationId, num(row.cache_generation), { status: row.status, version: num(row.version) });
    return remember(tx, actor.id, input.operationId, requestHash, { ...present(row, definition), admitted: false as const, preview: "admin" as const });
  });
  return settle(outcome);
}

async function markStatus(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; expectedVersion: number }, status: "disabled" | "revoked") {
  const event = status === "revoked" ? "revoke" : "disable";
  const requestHash = recordHash({ kind: event, workspaceId, formId: input.formId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "disable", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadForm(tx, here.tenantId, input.formId);
    if (current.status === status && num(current.version) === input.expectedVersion) return remember(tx, actor.id, input.operationId, requestHash, { ...present(current, definitionOf(current.definition)), unchanged: true as const });
    return remember(tx, actor.id, input.operationId, requestHash, await writeForm(tx, here, actor, input.operationId, event, input.formId, input.expectedVersion, { status }));
  });
  return settle(outcome);
}
export function disableIntakeForm(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; expectedVersion: number }) {
  return markStatus(r, actor, workspaceId, input, "disabled");
}
export function revokeIntakeForm(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; expectedVersion: number }) {
  return markStatus(r, actor, workspaceId, input, "revoked");
}

export async function activateIntakeForm(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "activate", workspaceId, formId: input.formId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadForm(tx, here.tenantId, input.formId);
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.formId, "configure", input.expectedVersion, { rejected: "activate" }, input.operationId);
      return { conflict: true as const, version: num(current.version) };
    }
    await audit(tx, actor, "intake-form.activate-refused", input.operationId, current.id, { status: current.status, cacheGeneration: num(current.cache_generation), version: num(current.version) });
    return remember(tx, actor.id, input.operationId, requestHash, fail("intake_activation", intakeActivation));
  });
  return settle(outcome);
}

export async function setIntakeAnonymousPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; allowed: boolean }) {
  if (typeof input.allowed !== "boolean") throw new DocumentError("Check the form.", "intake_validation", 422);
  const requestHash = recordHash({ kind: "policy", workspaceId, expectedVersion: input.expectedVersion, allowed: input.allowed });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw unavailable();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "policy", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await tx.query<{ version: number | string; allowed: boolean }>("SELECT version, allowed FROM hs_intake_anonymous_policy WHERE tenant_id=$1", [here.tenantId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, "policy", "policy", input.expectedVersion, { allowed: input.allowed }, input.operationId);
      return { conflict: true as const, version };
    }
    const next = version + 1;
    if (!current.rows[0]) await tx.query("INSERT INTO hs_intake_anonymous_policy(tenant_id,allowed,version,updated_by) VALUES($1,$2,$3,$4)", [here.tenantId, input.allowed, next, actor.id]);
    else await tx.query("UPDATE hs_intake_anonymous_policy SET allowed=$2, version=$3, updated_by=$4, updated_at=clock_timestamp() WHERE tenant_id=$1", [here.tenantId, input.allowed, next, actor.id]);
    await audit(tx, actor, "intake-form.policy", input.operationId, here.tenantId, { allowed: input.allowed, version: next });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ allowed: input.allowed, version: next, anonymousPolicy: intakeAnonymousCopy }));
  });
  return settle(outcome);
}

export async function setIntakeActions(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string; expectedVersion: number; actions: string[] }) {
  const actions: IntakeActorAction[] = [];
  for (const action of input.actions) {
    if (!intakeActorActions.includes(action as IntakeActorAction) || actions.includes(action as IntakeActorAction)) throw new DocumentError("Check the form.", "intake_validation", 422);
    actions.push(action as IntakeActorAction);
  }
  const requestHash = recordHash({ kind: "actions", workspaceId, userId: input.userId, expectedVersion: input.expectedVersion, actions });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (!await isMember(tx, here.workspaceId, input.userId)) throw unavailable();
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_intake_form_actor_sets WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.userId, "actions", input.expectedVersion, { actions }, input.operationId);
      return { conflict: true as const, version };
    }
    const next = version + 1;
    if (!current.rows[0]) await tx.query("INSERT INTO hs_intake_form_actor_sets(tenant_id,user_id,version) VALUES($1,$2,$3)", [here.tenantId, input.userId, next]);
    else await tx.query("UPDATE hs_intake_form_actor_sets SET version=$3 WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId, next]);
    await tx.query("DELETE FROM hs_intake_form_actor_actions WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    for (const action of actions) await tx.query("INSERT INTO hs_intake_form_actor_actions(tenant_id,user_id,action,granted_by) VALUES($1,$2,$3,$4)", [here.tenantId, input.userId, action, actor.id]);
    await audit(tx, actor, "intake-form.actions", input.operationId, input.userId, { version: next, actions });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ userId: input.userId, version: next, actions }));
  });
  return settle(outcome);
}

async function managerChange(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }, grant: boolean) {
  const requestHash = recordHash({ kind: grant ? "grant-manager" : "revoke-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (here.role !== "owner" && here.role !== "admin") throw unavailable();
    const replay = await prior<{ userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (!await isMember(tx, here.workspaceId, input.userId)) throw unavailable();
    if (grant) await tx.query("INSERT INTO hs_intake_form_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [here.workspaceId, input.userId, actor.id]);
    else await tx.query("DELETE FROM hs_intake_form_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, grant ? "intake-form.grant-manager" : "intake-form.revoke-manager", input.operationId, input.userId, { userId: input.userId });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ userId: input.userId, manager: grant }));
  });
}
export function grantIntakeManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  return managerChange(r, actor, workspaceId, input, true);
}
export function revokeIntakeManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  return managerChange(r, actor, workspaceId, input, false);
}

export async function issueIntakeChallenge(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string }) {
  const requestHash = recordHash({ kind: "challenge", workspaceId, formId: input.formId });
  const outcome = await r.db.transaction(async tx => {
    const located = await tenantOf(tx, workspaceId);
    const replay = await prior<{ token: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadForm(tx, located.tenantId, input.formId);
    const definition = definitionOf(row.definition);
    const member = await isMember(tx, workspaceId, actor.id);
    if (definition.audience === "guest" && !member) throw unavailable();
    if (row.status !== "draft" || expired(row)) throw unavailable();
    const token = randomUUID();
    await tx.query("INSERT INTO hs_intake_challenges(token,tenant_id,form_id,used) VALUES($1,$2,$3,false)", [token, located.tenantId, row.id]);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ token, formId: row.id }));
  });
  return settle(outcome);
}

async function loadSubmission(tx: Sql, tenantId: string, formId: string, submissionId: string) {
  if (!uuidPattern.test(submissionId)) throw unavailable();
  const row = await tx.query<SubmissionRow>(
    "SELECT id, form_id, form_version, actor_id, anonymous, state, record_name, values, consent_version, receipt_code, request_hash, committed_record_id FROM hs_intake_submissions WHERE id=$1 AND tenant_id=$2 AND form_id=$3",
    [submissionId, tenantId, formId],
  );
  if (!row.rows[0]) throw unavailable();
  return row.rows[0];
}
async function attachmentScans(tx: Sql, submissionId: string) {
  const rows = await tx.query<{ name: string; scan_state: string; quarantined: boolean; fetched: boolean }>("SELECT name, scan_state, quarantined, fetched FROM hs_intake_attachments WHERE submission_id=$1 ORDER BY name", [submissionId]);
  return rows.rows;
}

export async function submitIntake(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; expectedVersion: number; intentToken: string; botToken: string; anonymous?: boolean; recordName: string; values: Record<string, string>; consentVersion?: number | null; consentAccepted?: boolean; attachments?: AttachmentInput[] }) {
  const intentToken = intakeUuid(input.intentToken);
  const recordName = intakeRecordName(input.recordName);
  const requestedAnonymous = input.anonymous === true;
  const requestHash = recordHash({
    kind: "submit", workspaceId, formId: input.formId, expectedVersion: input.expectedVersion, intentToken, botToken: input.botToken,
    anonymous: requestedAnonymous, recordName, values: input.values, consentVersion: input.consentVersion ?? null, consentAccepted: input.consentAccepted === true, attachments: input.attachments ?? [],
  });
  const outcome = await r.db.transaction(async tx => {
    const located = await tenantOf(tx, workspaceId);
    await hold(tx, located.tenantId);
    const replay = await prior<Outcome & { code?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    let row = await loadForm(tx, located.tenantId, input.formId);
    const memberRow = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, actor.id]);
    const here: Scope = { ...located, role: memberRow.rows[0]?.role ?? "member" };
    const member = memberRow.rows.length > 0;
    row = await expireIfNeeded(tx, here, actor, row, input.operationId);
    const definition = definitionOf(row.definition);
    const anonymousDecision = decideAnonymous({ requested: requestedAnonymous, formAllows: definition.anonymous, policyAllows: await policyAllows(tx, located.tenantId) });
    if (!anonymousDecision.accepted) throw unavailable();
    if (definition.audience === "guest" && !member && !anonymousDecision.anonymous) throw unavailable();
    if (!member && definition.audience !== "public" && !anonymousDecision.anonymous) throw unavailable();
    const existing = await tx.query<{ id: string; request_hash: string; receipt_code: string }>("SELECT id, request_hash, receipt_code FROM hs_intake_submissions WHERE form_id=$1 AND intent_token=$2", [row.id, intentToken]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) return remember(tx, actor.id, input.operationId, requestHash, fail("intake_intent", "This intent token was already used. Nothing was overwritten."));
      const receipt = genericReceipt(existing.rows[0].receipt_code);
      const saved = await remember(tx, actor.id, input.operationId, requestHash, flags({ ...receipt, id: existing.rows[0].id, quarantined: true as const }));
      return { ...saved, replayed: true as const };
    }
    if (row.status !== "draft" || expired(row)) {
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "fence" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_fenced", "This form no longer accepts that submission. The draft is kept."));
    }
    if (num(row.version) !== input.expectedVersion) {
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "version" }, input.operationId);
      return { conflict: true as const, version: num(row.version) };
    }
    if (!uuidPattern.test(input.botToken)) {
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "bot" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_bot", "Bot protection rejected the submission. Nothing was saved."));
    }
    const consumed = await tx.query("UPDATE hs_intake_challenges SET used=true WHERE token=$1 AND form_id=$2 AND used=false RETURNING token", [input.botToken, row.id]);
    if (!consumed.rows.length) {
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "bot" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_bot", "Bot protection rejected the submission. Nothing was saved."));
    }
    const subject = anonymousDecision.anonymous ? `anon:${actor.id}` : actor.id;
    const rate = await tx.query<{ count: number | string }>(
      `INSERT INTO hs_intake_rates(form_id,subject_key,window_start,count)
       VALUES ($1,$2,date_trunc('minute', clock_timestamp()),1)
       ON CONFLICT (form_id, subject_key, window_start)
       DO UPDATE SET count = hs_intake_rates.count + 1
       RETURNING count`,
      [row.id, subject],
    );
    const rateDecision = decideAbuse({ bytes: 0, limitBytes: definition.limits.bytes, mediaType: null, allowedMedia: [], rateCount: num(rate.rows[0].count), rateLimit: intakeRateLimit, bot: "valid", intent: "new" });
    if (!rateDecision.allowed) return remember(tx, actor.id, input.operationId, requestHash, fail("intake_rate", "Too many submissions. Nothing was saved."));
    if (definition.consent) {
      if (input.consentAccepted !== true || input.consentVersion !== definition.consent.version) {
        await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "consent" }, input.operationId);
        return remember(tx, actor.id, input.operationId, requestHash, fail("intake_consent", "Consent does not match the current text. The draft is kept."));
      }
    } else if (input.consentVersion != null || input.consentAccepted === true) {
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "consent" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_consent", "Consent does not match the current text. The draft is kept."));
    }
    const accepted: Record<string, string> = {};
    try {
      for (const key of Object.keys(input.values)) {
        if (!definition.fields.some(field => field.key.toLowerCase() === key.toLowerCase())) throw new DocumentError("Check the form.", "intake_validation", 422);
      }
      for (const field of definition.fields) {
        const raw = input.values[field.key] ?? input.values[field.key.toLowerCase()];
        if (raw === undefined || raw === "") {
          if (field.required) throw new DocumentError("Check the form.", "intake_validation", 422);
          continue;
        }
        accepted[field.key] = field.type === "email" ? assertIntakeEmail(raw, field.maxLength) : assertIntakeText(raw, field.maxLength);
      }
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: error.code }, input.operationId);
      const code = error.code === "intake_link" ? "intake_link" : "intake_validation";
      return remember(tx, actor.id, input.operationId, requestHash, fail(code, kept(error.message)));
    }
    const textBytes = Array.from(Object.values(accepted).join("")).length + Array.from(recordName).length;
    const textDecision = decideAbuse({ bytes: textBytes, limitBytes: definition.limits.bytes, mediaType: null, allowedMedia: [], rateCount: 1, rateLimit: intakeRateLimit, bot: "valid", intent: "new" });
    if (!textDecision.allowed) {
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "size" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_limit", "That submission exceeds the form limits. The draft is kept."));
    }
    const scanned = [];
    try {
      for (const file of input.attachments ?? []) scanned.push(scanIntakeAttachment(file, definition.limits));
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "attachment" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail(error.code === "intake_link" ? "intake_link" : "intake_limit", kept(error.message)));
    }
    if (scanned.some(file => file.byteSize > intakeLimits.bytes)) {
      await saveDraft(tx, located.tenantId, actor.id, row.id, "submit", input.expectedVersion, { rejected: "size" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_limit", "That submission exceeds the form limits. The draft is kept."));
    }
    const rejectedScan = scanned.some(file => file.scan === "rejected");
    const state = rejectedScan ? "rejected" : "quarantine";
    const id = randomUUID();
    const code = `rc_${randomUUID().replace(/-/g, "")}`;
    await tx.query(
      `INSERT INTO hs_intake_submissions(id,tenant_id,form_id,form_version,queue_name,actor_id,anonymous,intent_token,state,record_name,values,consent_version,receipt_code,request_hash,operation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)`,
      [id, located.tenantId, row.id, num(row.version), definition.queue.name, anonymousDecision.anonymous ? null : actor.id, anonymousDecision.anonymous, intentToken, state, recordName, JSON.stringify(accepted), definition.consent?.version ?? null, code, requestHash, input.operationId],
    );
    for (const file of scanned) {
      await tx.query(
        "INSERT INTO hs_intake_attachments(id,tenant_id,submission_id,name,media_type,byte_size,scan_state,quarantined,fetched) VALUES($1,$2,$3,$4,$5,$6,$7,true,false)",
        [randomUUID(), located.tenantId, id, file.name, file.mediaType, file.byteSize, file.scan],
      );
    }
    await audit(tx, actor, "intake-form.submit", input.operationId, row.id, { fields: Object.keys(accepted), consentVersion: definition.consent?.version ?? null, anonymous: anonymousDecision.anonymous, state, quarantined: true });
    await track(tx, located.tenantId, row.id, actor, "submit", input.operationId, num(row.cache_generation), { fields: Object.keys(accepted), consentVersion: definition.consent?.version ?? null, anonymous: anonymousDecision.anonymous, state });
    const receipt = genericReceipt(code);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ ...receipt, id, state, quarantined: true as const, scans: scanned.map(file => ({ name: file.name, scan: file.scan, quarantined: true as const, fetched: false as const })), consentVersion: definition.consent?.version ?? null, anonymous: anonymousDecision.anonymous }));
  });
  return settle(outcome);
}

export async function reviewIntake(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; submissionId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "review", workspaceId, formId: input.formId, submissionId: input.submissionId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "review", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    let row = await loadForm(tx, here.tenantId, input.formId);
    row = await expireIfNeeded(tx, here, actor, row, input.operationId);
    const definition = definitionOf(row.definition);
    const submission = await loadSubmission(tx, here.tenantId, row.id, input.submissionId);
    const scans = await attachmentScans(tx, submission.id);
    const fence = decideFence({ status: row.status, expired: expired(row), formVersion: num(row.version), submissionVersion: num(submission.form_version), state: submission.state });
    if (fence.fenced || num(row.version) !== input.expectedVersion) {
      if (submission.state === "quarantine" || submission.state === "reviewed") await tx.query("UPDATE hs_intake_submissions SET state='fenced' WHERE id=$1 AND state IN ('quarantine','reviewed')", [submission.id]);
      await saveDraft(tx, here.tenantId, actor.id, row.id, "review", input.expectedVersion, { submissionId: submission.id, rejected: "fence" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_fenced", "This form no longer accepts that submission. The draft is kept."));
    }
    if (submission.state === "rejected" || scans.some(file => file.scan_state === "rejected" || !on(file.quarantined) || on(file.fetched))) {
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_scan", "The attachment is still quarantined. No record was written."));
    }
    if (submission.state !== "quarantine") return remember(tx, actor.id, input.operationId, requestHash, fail("intake_review", "Review the quarantined submission before creating a record."));
    const values = asJson<Record<string, string>>(submission.values);
    for (const key of Object.keys(values)) {
      if (!await fieldDecision(tx, here.tenantId, definition.collection, key, actor.id, "view")) throw forbidden();
    }
    await tx.query("UPDATE hs_intake_submissions SET state='reviewed' WHERE id=$1 AND state='quarantine'", [submission.id]);
    await audit(tx, actor, "intake-form.review", input.operationId, row.id, { submissionId: submission.id, consentVersion: submission.consent_version, recordCreated: false });
    await track(tx, here.tenantId, row.id, actor, "review", input.operationId, num(row.cache_generation), { submissionId: submission.id, consentVersion: submission.consent_version });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ id: submission.id, state: "reviewed" as const, quarantined: true as const }));
  });
  return settle(outcome);
}

export async function commitIntake(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; submissionId: string; expectedVersion: number; recordId?: string | null; expectedRecordVersion?: number | null }) {
  const explicitRecordId = input.recordId ? intakeUuid(input.recordId) : null;
  const requestHash = recordHash({ kind: "commit", workspaceId, formId: input.formId, submissionId: input.submissionId, expectedVersion: input.expectedVersion, recordId: explicitRecordId, expectedRecordVersion: input.expectedRecordVersion ?? null });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "commit", true)) throw forbidden();
    const replay = await prior<Outcome & { recordId?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    let row = await loadForm(tx, here.tenantId, input.formId);
    row = await expireIfNeeded(tx, here, actor, row, input.operationId);
    const definition = definitionOf(row.definition);
    const submission = await loadSubmission(tx, here.tenantId, row.id, input.submissionId);
    const scans = await attachmentScans(tx, submission.id);
    const fence = decideFence({ status: row.status, expired: expired(row), formVersion: num(row.version), submissionVersion: num(submission.form_version), state: submission.state });
    if (fence.fenced || num(row.version) !== input.expectedVersion) {
      if (submission.state === "quarantine" || submission.state === "reviewed") await tx.query("UPDATE hs_intake_submissions SET state='fenced' WHERE id=$1 AND state IN ('quarantine','reviewed')", [submission.id]);
      await saveDraft(tx, here.tenantId, actor.id, row.id, "commit", input.expectedVersion, { submissionId: submission.id, rejected: "fence" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, fail("intake_fenced", "This form no longer accepts that submission. The draft is kept."));
    }
    if (scans.some(file => file.scan_state !== "clean" || !on(file.quarantined))) return remember(tx, actor.id, input.operationId, requestHash, fail("intake_scan", "The attachment is still quarantined. No record was written."));
    if (submission.state !== "reviewed") return remember(tx, actor.id, input.operationId, requestHash, fail("intake_review", "Review the quarantined submission before creating a record."));
    const values = asJson<Record<string, string>>(submission.values);
    for (const key of Object.keys(values)) {
      if (!await fieldDecision(tx, here.tenantId, definition.collection, key, actor.id, "write")) throw forbidden();
    }
    const named = await tx.query<{ id: string }>("SELECT id FROM hs_data_records WHERE tenant_id=$1 AND collection=$2 AND lower(name)=lower($3) AND state='active' AND id<>COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000') ORDER BY id LIMIT 1", [here.tenantId, definition.collection, submission.record_name, explicitRecordId]);
    const target = commitTarget(explicitRecordId, named.rows[0]?.id ?? null);
    let recordId = "";
    if (target.mode === "insert") {
      if (target.namedRecordIdIgnored) {
        /* The same name may already exist. Insert a new id and leave that row untouched. */
      }
      if (!await can(tx, here.tenantId, actor.id, definition.collection, null, "create")) throw forbidden();
      recordId = randomUUID();
      await tx.query(
        "INSERT INTO hs_data_records(id,tenant_id,collection,name,field_values,created_by,updated_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6)",
        [recordId, here.tenantId, definition.collection, submission.record_name, JSON.stringify(values), actor.id],
      );
    } else {
      if (!await can(tx, here.tenantId, actor.id, definition.collection, target.recordId, "edit")) throw forbidden();
      const current = await tx.query<{ version: number | string; collection: string }>("SELECT version, collection FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state='active'", [target.recordId, here.tenantId]);
      if (!current.rows[0] || current.rows[0].collection !== definition.collection) throw unavailable();
      if (num(current.rows[0].version) !== input.expectedRecordVersion) {
        await saveDraft(tx, here.tenantId, actor.id, row.id, "commit", input.expectedVersion, { submissionId: submission.id, rejected: "record-version" }, input.operationId);
        return { conflict: true as const, version: num(row.version) };
      }
      const updated = await tx.query(
        "UPDATE hs_data_records SET field_values=field_values || $2::jsonb, version=version+1, updated_by=$3, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$4 AND version=$5 RETURNING id",
        [target.recordId, JSON.stringify(values), actor.id, here.tenantId, input.expectedRecordVersion],
      );
      if (!updated.rows[0]) return { conflict: true as const, version: num(row.version) };
      recordId = target.recordId;
    }
    await tx.query("UPDATE hs_intake_submissions SET state='committed', committed_record_id=$2 WHERE id=$1 AND state='reviewed'", [submission.id, recordId]);
    await audit(tx, actor, "intake-form.commit", input.operationId, row.id, { submissionId: submission.id, recordId, mode: target.mode, consentVersion: submission.consent_version });
    await track(tx, here.tenantId, row.id, actor, "commit", input.operationId, num(row.cache_generation), { submissionId: submission.id, mode: target.mode, consentVersion: submission.consent_version });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ id: submission.id, state: "committed" as const, recordId, mode: target.mode, recordCreated: true as const, quarantined: false as const }));
  });
  return settle(outcome);
}

export async function readIntakeReceipt(r: Repository, actor: Actor, workspaceId: string, code: string) {
  const receiptCode = code.trim();
  if (!receiptCode || receiptCode.length > 80) throw unavailable();
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await tx.query<{ actor_id: string | null; receipt_code: string }>("SELECT actor_id, receipt_code FROM hs_intake_submissions WHERE tenant_id=$1 AND receipt_code=$2", [here.tenantId, receiptCode]);
    if (!row.rows[0]) throw unavailable();
    const own = row.rows[0].actor_id === actor.id;
    const manage = await isManager(tx, here, actor);
    const allowed = own || (manage && (await actionAllowed(tx, here.tenantId, actor.id, "receipt", true) || await actionAllowed(tx, here.tenantId, actor.id, "history", true)));
    if (!allowed) throw unavailable();
    return { ...genericReceipt(row.rows[0].receipt_code), ...flags() };
  });
}

export async function downloadIntakeReport(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; formId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "download", workspaceId, formId: input.formId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ body: string; version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadForm(tx, here.tenantId, input.formId);
    const definition = definitionOf(row.definition);
    if (num(row.version) !== input.expectedVersion) throw new DocumentError("The form version changed. Nothing was overwritten.", "intake_conflict", 409);
    if (!await isManager(tx, here, actor)) throw unavailable();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "download", true)) throw forbidden();
    if (!await can(tx, here.tenantId, actor.id, definition.collection, null, "export")) throw forbidden();
    for (const field of definition.fields) {
      if (!await fieldDecision(tx, here.tenantId, definition.collection, field.key, actor.id, "view")) throw forbidden();
    }
    const submissions = await tx.query<{ state: string; receipt_code: string; record_name: string; values: unknown }>("SELECT state, receipt_code, record_name, values FROM hs_intake_submissions WHERE tenant_id=$1 AND form_id=$2 ORDER BY created_at, id", [here.tenantId, row.id]);
    const lines = [`Cache generation: ${num(row.cache_generation)}.`, "Cache: no-store."];
    for (const submission of submissions.rows) {
      const values = asJson<Record<string, string>>(submission.values);
      const visible: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        if (await fieldDecision(tx, here.tenantId, definition.collection, key, actor.id, "view")) visible.push(`${key}: ${value}`);
      }
      lines.push(`## ${submission.record_name}`, `State: ${submission.state}.`, `Receipt: ${submission.receipt_code}.`, ...visible);
    }
    const body = intakeReport(definition, row.name, lines);
    await audit(tx, actor, "intake-form.download", input.operationId, row.id, { cacheGeneration: num(row.cache_generation), version: num(row.version) });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ body, version: num(row.version), cacheGeneration: num(row.cache_generation) }));
  });
  return settle(outcome);
}
