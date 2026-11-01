import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "./database";
import { DocumentError, stableStringify } from "./document";
import { formatIst } from "./ist-label";
import { SharedRecordRepository, type CurrentSuiteTenantAuthority, type RecordContext, type Stored } from "./shared-records";
import { recordHash, type RecordField } from "./shared-record-types";
import {
  claimAccessRevoked,
  completeHandoverAllowed,
  directoryNote,
  externalSource,
  handoverLink,
  lifecycleStates,
  normaliseAccountIds,
  normaliseChecklist,
  openingDates,
  presentLifecycleHistory,
  sameOperation,
  staffLifecycleAccess,
  stateStep,
  transitionDates,
  type ChecklistItem,
  type LifecycleDates,
  type LifecycleState,
} from "./staff-lifecycle";

const uuid = z.string().uuid();
const userId = z.string().min(1).max(200);
const dayText = z.string().min(10).max(10);
const flags = { accessTransferred: false as const, credentialsTransferred: false as const, provisionsAccount: false as const, payroll: false as const, employmentDecision: false as const };
const confirms = ["configure-staff-lifecycle", "assign-staff-lifecycle", "create-staff-lifecycle", "transition-staff-lifecycle", "checklist-staff-lifecycle", "link-accounts-staff-lifecycle", "name-recipient-staff-lifecycle", "complete-handover-staff-lifecycle", "identity-evidence-staff-lifecycle"] as const;
const checklistInput = z.array(z.object({
  id: uuid,
  phase: z.enum(["onboarding", "offboarding"]),
  title: z.string().min(1).max(200),
  dueOn: dayText,
  ownerUserId: userId,
  done: z.boolean(),
}).strict()).max(50);
const columns = "id, employee_record_id, directory_user_id, state, planned_on, start_on, leaving_on, left_on, checklist, recipient_user_id, handover_state, exceptions_acknowledged, exception_note, outstanding_snapshot, version, entered_at, entered_by, access_revoked";

const previewInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), acknowledgementRequired: z.boolean() }).strict(),
  z.object({ action: z.literal("assign"), userId, canMaintain: z.boolean(), canHandover: z.boolean(), canRecordEvidence: z.boolean() }).strict(),
  z.object({ action: z.literal("create"), employeeRecordId: uuid, plannedOn: dayText, directoryUserId: userId.nullable().optional(), checklist: checklistInput.optional() }).strict(),
  z.object({ action: z.literal("transition"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), to: z.enum(lifecycleStates), date: dayText.nullable() }).strict(),
  z.object({ action: z.literal("checklist"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), items: checklistInput }).strict(),
  z.object({ action: z.literal("link-accounts"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), accountIds: z.array(uuid).max(50) }).strict(),
  z.object({ action: z.literal("name-recipient"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), recipientUserId: userId.nullable() }).strict(),
  z.object({ action: z.literal("complete-handover"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), exceptionsAcknowledged: z.boolean(), exceptionNote: z.string().max(500).nullable() }).strict(),
  z.object({ action: z.literal("identity-evidence"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), evidenceReference: z.string().min(1).max(200), sourceSystem: z.string().min(1).max(80), observedAccessRevoked: z.boolean() }).strict(),
]);
const confirmInput = z.object({ operationId: uuid, previewId: uuid, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.enum(confirms) }).strict();
const draftInput = z.object({
  draftId: uuid,
  employeeRecordId: uuid,
  directoryUserId: z.string().max(200).nullable(),
  plannedOn: z.string().max(10).nullable(),
  startOn: z.string().max(10).nullable(),
  leavingOn: z.string().max(10).nullable(),
  leftOn: z.string().max(10).nullable(),
  checklist: checklistInput,
  accountIds: z.array(uuid).max(50),
  recipientUserId: z.string().max(200).nullable(),
  exceptionsAcknowledged: z.boolean(),
  exceptionNote: z.string().max(500).nullable(),
  operationId: uuid,
  expectedVersion: z.number().int().nonnegative(),
}).strict();
const draftVersionInput = z.object({ draftId: uuid, operationId: uuid, expectedVersion: z.number().int().positive() }).strict();

type PolicyRow = { acknowledgement_required: boolean; version: number };
type AssignmentRow = { user_id: string; can_maintain: boolean; can_handover: boolean; can_record_evidence: boolean; version: number };
type LifecycleRow = {
  id: string;
  employee_record_id: string;
  directory_user_id: string | null;
  state: LifecycleState;
  planned_on: string | null;
  start_on: string | null;
  leaving_on: string | null;
  left_on: string | null;
  checklist: unknown;
  recipient_user_id: string | null;
  handover_state: "open" | "complete";
  exceptions_acknowledged: boolean;
  exception_note: string | null;
  outstanding_snapshot: unknown;
  version: number;
  entered_at: string | Date;
  entered_by: string;
  access_revoked: boolean;
};
type DraftRow = {
  id: string;
  employee_record_id: string;
  directory_user_id: string | null;
  planned_on: string | null;
  start_on: string | null;
  leaving_on: string | null;
  left_on: string | null;
  checklist: unknown;
  account_ids: unknown;
  recipient_user_id: string | null;
  exceptions_acknowledged: boolean;
  exception_note: string | null;
  version: number;
  state: "open" | "discarded";
};
type PreviewRow = { id: string; action: string; confirm: (typeof confirms)[number]; payload: unknown; review_hash: string; authority_revision: string; expires_at: string | Date };
type EventRow = { event_version: number; kind: string; state: LifecycleState; evidence_class: "hr-record" | "identity-evidence"; access_revoked: boolean; evidence_reference: string | null; actor_id: string; operation_id: string; source: string; created_at: string | Date };
type Outstanding = { id: string; kind: "owned-record" | "approval"; label: string; hidden: boolean };
type Effect = Record<string, unknown> & { appliedVersion?: number; replayed?: boolean };

const fail = (message: string, code = "lifecycle_conflict", status = 409) => new DocumentError(message, code, status);
const missing = () => fail("That staff lifecycle is unavailable.", "lifecycle_unavailable", 404);
const forbidden = (message = "This staff lifecycle action is not permitted.") => fail(message, "lifecycle_forbidden", 403);
const invalid = (message = "Review the staff lifecycle.") => fail(message, "lifecycle_invalid", 400);

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\"")) return value;
  try { return JSON.parse(trimmed) as unknown; } catch { return value; }
}
function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
function iso(value: string | Date | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function hiddenError(error: unknown) {
  return error instanceof DocumentError && [403, 404].includes(error.status);
}
function isUnique(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}
function datesOf(row: LifecycleRow): LifecycleDates {
  return { plannedOn: row.planned_on, startOn: row.start_on, leavingOn: row.leaving_on, leftOn: row.left_on };
}

export class StaffLifecycleRepository extends SharedRecordRepository {
  constructor(pages: ConstructorParameters<typeof SharedRecordRepository>[0], authority: CurrentSuiteTenantAuthority, valueAuthority?: ConstructorParameters<typeof SharedRecordRepository>[2], private readonly clock: () => Date = () => new Date()) {
    super(pages, authority, valueAuthority);
  }

  private now() { return this.clock(); }

  async listLifecycles(ctx: RecordContext, input: { query?: string; lifecycleId?: string }) {
    const parsed = z.object({ query: z.string().max(100).optional(), lifecycleId: uuid.optional() }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the staff lifecycle search.");
    const query = parsed.data.query?.trim().toLowerCase() ?? "";
    return this.transaction(ctx, async (tx) => {
      const capabilities = await this.collectionCaps(tx, ctx, "employees");
      const assignment = await this.assignment(tx, ctx, ctx.actor.id);
      const actions = staffLifecycleAccess({
        recordCapabilities: capabilities,
        assignment: assignment ? this.assignmentFlags(assignment) : null,
        canViewRecords: capabilities.includes("view"),
      });
      const policy = capabilities.includes("view") || capabilities.includes("manage-staff-lifecycle") ? await this.policyView(tx, ctx) : null;
      const assignments = capabilities.includes("manage-staff-lifecycle") ? await this.assignmentViews(tx, ctx) : [];
      const rows = parsed.data.lifecycleId
        ? (await tx.query<LifecycleRow>(`SELECT ${columns} FROM hs_staff_lifecycles WHERE tenant_id=$1 AND id=$2`, [ctx.tenantId, parsed.data.lifecycleId])).rows
        : (await tx.query<LifecycleRow>(`SELECT ${columns} FROM hs_staff_lifecycles WHERE tenant_id=$1 ORDER BY entered_at DESC, id LIMIT 50`, [ctx.tenantId])).rows;
      const lifecycles = [];
      for (const row of rows) {
        let employee: Stored;
        try { employee = await this.raw(tx, ctx, row.employee_record_id, "view"); }
        catch (error) {
          if (hiddenError(error)) continue;
          throw error;
        }
        if (employee.collection !== "employees") continue;
        const lifecycle = await this.present(tx, ctx, row, employee);
        if (query && !this.matches(query, lifecycle)) continue;
        lifecycles.push(lifecycle);
        if (lifecycles.length >= 25) break;
      }
      if (parsed.data.lifecycleId && !lifecycles.length) throw missing();
      return { lifecycles, drafts: await this.visibleDrafts(tx, ctx), policy, assignments, actions, note: directoryNote, ...flags };
    });
  }

  async preview(ctx: RecordContext, input: z.input<typeof previewInput>) {
    const parsed = previewInput.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    return this.transaction(ctx, async (tx, _tenant, proof) => {
      const described = await this.describe(tx, ctx, command);
      const previewId = randomUUID();
      const reviewHash = recordHash({ previewId, action: command.action, confirm: described.confirm, payload: described.payload, authorityRevision: proof.revision });
      const expiresAt = new Date(this.now().getTime() + 10 * 60 * 1000).toISOString();
      await tx.query("INSERT INTO hs_staff_lifecycle_previews(id,tenant_id,workspace_id,actor_id,action,confirm,payload,review_hash,authority_revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.action, described.confirm, JSON.stringify(described.payload), reviewHash, proof.revision, expiresAt]);
      return { previewId, reviewHash, action: command.action, confirm: described.confirm, impact: described.impact, outstanding: described.outstanding ?? null, ...flags };
    });
  }

  async confirm(ctx: RecordContext, input: z.input<typeof confirmInput>): Promise<Effect> {
    const parsed = confirmInput.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash(command);
    return this.transaction(ctx, async (tx, _tenant, proof) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const preview = (await tx.query<PreviewRow>("SELECT id, action, confirm, payload, review_hash, authority_revision, expires_at FROM hs_staff_lifecycle_previews WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4", [command.previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
      if (!preview || new Date(preview.expires_at).getTime() <= this.now().getTime()) throw fail("Review the staff lifecycle again.", "review_expired");
      if (preview.review_hash !== command.reviewHash || preview.confirm !== command.confirm || preview.authority_revision !== proof.revision) throw fail("Confirm the reviewed staff lifecycle.", "review_unconfirmed");
      const result = await this.apply(tx, ctx, command.operationId, preview.confirm, jsonValue(preview.payload));
      await this.finish(tx, ctx, command.operationId, requestHash, typeof result.lifecycleId === "string" ? result.lifecycleId : null, result.appliedVersion ?? 1, preview.action, result);
      return { ...result, replayed: false, ...flags };
    });
  }

  async saveDraft(ctx: RecordContext, input: z.input<typeof draftInput>) {
    const parsed = draftInput.safeParse(input);
    if (!parsed.success) throw invalid("Review the draft.");
    const command = parsed.data;
    const requestHash = recordHash({ ...command, ledgerKind: "draft" });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const employee = await this.employeeRecord(tx, ctx, command.employeeRecordId, true);
      await this.raw(tx, ctx, employee.id, "edit", true);
      const access = await this.accessFor(tx, ctx, employee);
      if (!access.canMaintain) throw forbidden();
      const checklist = normaliseChecklist(command.checklist);
      if (!checklist.ok) throw invalid(checklist.message);
      const accounts = normaliseAccountIds(command.accountIds);
      if (!accounts.ok) throw invalid(accounts.message);
      const existing = (await tx.query<DraftRow>("SELECT id, employee_record_id, directory_user_id, planned_on, start_on, leaving_on, left_on, checklist, account_ids, recipient_user_id, exceptions_acknowledged, exception_note, version, state FROM hs_staff_lifecycle_drafts WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 FOR UPDATE", [command.draftId, ctx.tenantId, ctx.actor.id])).rows[0];
      const note = command.exceptionNote?.trim() || null;
      if (command.expectedVersion === 0) {
        if (existing) throw fail("This draft already exists.", "lifecycle_conflict");
        await tx.query("INSERT INTO hs_staff_lifecycle_drafts(id,tenant_id,workspace_id,actor_id,employee_record_id,directory_user_id,planned_on,start_on,leaving_on,left_on,checklist,account_ids,recipient_user_id,exceptions_acknowledged,exception_note,version,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,1,'open')", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, employee.id, command.directoryUserId, command.plannedOn, command.startOn, command.leavingOn, command.leftOn, JSON.stringify(checklist.items), JSON.stringify(accounts.accountIds), command.recipientUserId, command.exceptionsAcknowledged, note]);
      } else {
        if (!existing || existing.state !== "open" || Number(existing.version) !== command.expectedVersion) throw fail("Refresh the draft and try again.", "lifecycle_conflict");
        const updated = await tx.query("UPDATE hs_staff_lifecycle_drafts SET employee_record_id=$4, directory_user_id=$5, planned_on=$6, start_on=$7, leaving_on=$8, left_on=$9, checklist=$10::jsonb, account_ids=$11::jsonb, recipient_user_id=$12, exceptions_acknowledged=$13, exception_note=$14, version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$3 RETURNING version", [command.draftId, ctx.tenantId, command.expectedVersion, employee.id, command.directoryUserId, command.plannedOn, command.startOn, command.leavingOn, command.leftOn, JSON.stringify(checklist.items), JSON.stringify(accounts.accountIds), command.recipientUserId, command.exceptionsAcknowledged, note]);
        if (!updated.rows.length) throw fail("Refresh the draft and try again.", "lifecycle_conflict");
      }
      const version = command.expectedVersion + 1;
      const result = { draftId: command.draftId, version, state: "open" as const, appliedVersion: version };
      await this.audit(tx, ctx, command.operationId, "staff-lifecycle.draft", "hr-record", false, { draftId: command.draftId, employeeId: employee.id, version });
      await this.finish(tx, ctx, command.operationId, requestHash, null, version, "draft", result);
      return { ...result, replayed: false, ...flags };
    });
  }

  async discardDraft(ctx: RecordContext, input: z.input<typeof draftVersionInput>) {
    return this.shiftDraft(ctx, input, "discarded", "open");
  }

  async restoreDraft(ctx: RecordContext, input: z.input<typeof draftVersionInput>) {
    return this.shiftDraft(ctx, input, "open", "discarded");
  }

  async lifecycleHistory(ctx: RecordContext, input: { lifecycleId: string }) {
    const parsed = z.object({ lifecycleId: uuid }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the staff lifecycle history.");
    return this.transaction(ctx, async (tx) => {
      const loaded = await this.visibleLifecycle(tx, ctx, parsed.data.lifecycleId, false);
      if (!loaded.access.canHistory) throw forbidden();
      const events = await tx.query<EventRow>("SELECT event_version, kind, state, evidence_class, access_revoked, evidence_reference, actor_id, operation_id, source, created_at FROM hs_staff_lifecycle_events WHERE tenant_id=$1 AND lifecycle_id=$2 ORDER BY event_version", [ctx.tenantId, parsed.data.lifecycleId]);
      const lifecycle = await this.present(tx, ctx, loaded.row, loaded.employee);
      return {
        lifecycleId: parsed.data.lifecycleId,
        lifecycle,
        events: presentLifecycleHistory(events.rows.map((event) => ({
          version: Number(event.event_version),
          kind: event.kind,
          state: event.state,
          evidenceClass: event.evidence_class,
          evidenceReference: event.evidence_reference,
          observedAccessRevoked: event.access_revoked === true,
          source: event.source,
          actorId: event.actor_id,
          operationId: event.operation_id,
          at: iso(event.created_at),
        }))),
        ...flags,
      };
    });
  }

  async download(ctx: RecordContext, input: { lifecycleId: string }) {
    const parsed = z.object({ lifecycleId: uuid }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the staff lifecycle download.");
    return this.transaction(ctx, async (tx) => {
      const loaded = await this.visibleLifecycle(tx, ctx, parsed.data.lifecycleId, false);
      if (!loaded.access.canExport) throw forbidden();
      const lifecycle = await this.present(tx, ctx, loaded.row, loaded.employee);
      const body = { source: "holy-sheet", note: directoryNote, ...flags, lifecycle };
      return { filename: "staff-lifecycle.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from(JSON.stringify(body), "utf8") };
    });
  }

  private async shiftDraft(ctx: RecordContext, input: z.input<typeof draftVersionInput>, next: "open" | "discarded", from: "open" | "discarded") {
    const parsed = draftVersionInput.safeParse(input);
    if (!parsed.success) throw invalid("Review the draft.");
    const command = parsed.data;
    const requestHash = recordHash({ kind: next === "open" ? "restore" : "discard", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const existing = (await tx.query<DraftRow>("SELECT id, employee_record_id, directory_user_id, planned_on, start_on, leaving_on, left_on, checklist, account_ids, recipient_user_id, exceptions_acknowledged, exception_note, version, state FROM hs_staff_lifecycle_drafts WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 FOR UPDATE", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
      if (!existing) throw missing();
      await this.raw(tx, ctx, existing.employee_record_id, "view");
      if (existing.state !== from || Number(existing.version) !== command.expectedVersion) throw fail("Refresh the draft and try again.", "lifecycle_conflict");
      await tx.query("UPDATE hs_staff_lifecycle_drafts SET state=$4, version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$3", [command.draftId, ctx.tenantId, command.expectedVersion, next]);
      const version = command.expectedVersion + 1;
      const result = { draftId: command.draftId, state: next, version, appliedVersion: version };
      await this.audit(tx, ctx, command.operationId, next === "open" ? "staff-lifecycle.restore" : "staff-lifecycle.discard", "hr-record", false, { draftId: command.draftId, version });
      await this.finish(tx, ctx, command.operationId, requestHash, null, version, next === "open" ? "restore" : "discard", result);
      return { ...result, replayed: false, ...flags };
    });
  }

  private async describe(tx: Sql, ctx: RecordContext, command: z.infer<typeof previewInput>) {
    if (command.action === "configure") {
      if (!(await this.collectionCaps(tx, ctx, "employees")).includes("manage-staff-lifecycle")) throw forbidden();
      const current = await this.policy(tx, ctx);
      return { confirm: "configure-staff-lifecycle" as const, impact: "This versions the handover acknowledgement rule. It does not grant record access or transfer login credentials.", payload: { action: "configure", acknowledgementRequired: command.acknowledgementRequired, expectedVersion: current.version }, outstanding: null };
    }
    if (command.action === "assign") {
      if (!(await this.collectionCaps(tx, ctx, "employees")).includes("manage-staff-lifecycle")) throw forbidden();
      await this.member(tx, ctx, command.userId);
      const current = await this.assignment(tx, ctx, command.userId);
      return { confirm: "assign-staff-lifecycle" as const, impact: "This assignment does not grant record, field, or collection access. The person still needs those permissions separately.", payload: { action: "assign", userId: command.userId, canMaintain: command.canMaintain, canHandover: command.canHandover, canRecordEvidence: command.canRecordEvidence, expectedVersion: current?.version ?? 0 }, outstanding: null };
    }
    if (command.action === "create") {
      const prepared = await this.prepareCreate(tx, ctx, command);
      return { confirm: "create-staff-lifecycle" as const, impact: `This opens a planned staff lifecycle. ${directoryNote}`, payload: { action: "create", employeeRecordId: prepared.employee.id, plannedOn: prepared.dates.plannedOn, directoryUserId: prepared.directoryUserId, checklist: prepared.checklist }, outstanding: null };
    }
    if (command.action === "transition") {
      const loaded = await this.prepareTransition(tx, ctx, command.lifecycleId, command.expectedVersion, command.to, command.date);
      return { confirm: "transition-staff-lifecycle" as const, impact: `This records the HR state ${command.to}. It does not provision an account or revoke access.`, payload: { action: "transition", lifecycleId: loaded.row.id, expectedVersion: Number(loaded.row.version), to: command.to, date: command.date }, outstanding: null };
    }
    if (command.action === "checklist") {
      const loaded = await this.prepareChecklist(tx, ctx, command.lifecycleId, command.expectedVersion, command.items);
      return { confirm: "checklist-staff-lifecycle" as const, impact: "This saves checklist items with their dates and responsible owners. It does not grant those owners access.", payload: { action: "checklist", lifecycleId: loaded.row.id, expectedVersion: Number(loaded.row.version), items: loaded.checklist }, outstanding: null };
    }
    if (command.action === "link-accounts") {
      const loaded = await this.prepareAccounts(tx, ctx, command.lifecycleId, command.expectedVersion, command.accountIds);
      const link = handoverLink({ accountIds: loaded.accountIds, recipientUserId: loaded.row.recipient_user_id });
      return { confirm: "link-accounts-staff-lifecycle" as const, impact: "These account links record responsibility. They do not transfer access or login credentials.", payload: { action: "link-accounts", lifecycleId: loaded.row.id, expectedVersion: Number(loaded.row.version), accountIds: link.accountIds }, outstanding: null };
    }
    if (command.action === "name-recipient") {
      const loaded = await this.prepareRecipient(tx, ctx, command.lifecycleId, command.expectedVersion, command.recipientUserId);
      return { confirm: "name-recipient-staff-lifecycle" as const, impact: "Naming a handover recipient does not transfer access or login credentials.", payload: { action: "name-recipient", lifecycleId: loaded.row.id, expectedVersion: Number(loaded.row.version), recipientUserId: command.recipientUserId }, outstanding: null };
    }
    if (command.action === "complete-handover") {
      const loaded = await this.prepareComplete(tx, ctx, command.lifecycleId, command.expectedVersion, command.exceptionsAcknowledged, command.exceptionNote);
      const visible = loaded.outstanding.filter((item) => !item.hidden).map((item) => item.label);
      const impact = loaded.decision.cleanHandover
        ? "Nothing owned is still outstanding. Recording the handover does not transfer access or login credentials, and it does not claim access was revoked."
        : `Outstanding items stay visible: ${visible.join("; ") || `${loaded.outstanding.length} restricted item(s)`}. Acknowledging them does not transfer access or login credentials.`;
      return { confirm: "complete-handover-staff-lifecycle" as const, impact, payload: { action: "complete-handover", lifecycleId: loaded.row.id, expectedVersion: Number(loaded.row.version), exceptionsAcknowledged: command.exceptionsAcknowledged, exceptionNote: loaded.decision.exceptionNote, outstandingHash: loaded.outstandingHash }, outstanding: this.publicOutstanding(loaded.outstanding) };
    }
    const loaded = await this.prepareEvidence(tx, ctx, command.lifecycleId, command.expectedVersion, command.evidenceReference, command.sourceSystem, command.observedAccessRevoked);
    return { confirm: "identity-evidence-staff-lifecycle" as const, impact: loaded.claim.accessRevoked ? "This records identity-service evidence that access was revoked. An HR state change still does not revoke access." : "This records identity-service evidence. Access revoked is not claimed.", payload: { action: "identity-evidence", lifecycleId: loaded.row.id, expectedVersion: Number(loaded.row.version), evidenceReference: loaded.claim.evidenceReference, sourceSystem: loaded.source, observedAccessRevoked: command.observedAccessRevoked }, outstanding: null };
  }

  private async apply(tx: Sql, ctx: RecordContext, operationId: string, confirm: (typeof confirms)[number], payload: unknown): Promise<Effect & { lifecycleId?: string; appliedVersion?: number }> {
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (confirm === "configure-staff-lifecycle") return this.applyConfigure(tx, ctx, operationId, body);
    if (confirm === "assign-staff-lifecycle") return this.applyAssign(tx, ctx, operationId, body);
    if (confirm === "create-staff-lifecycle") return this.applyCreate(tx, ctx, operationId, body);
    if (confirm === "transition-staff-lifecycle") return this.applyTransition(tx, ctx, operationId, body);
    if (confirm === "checklist-staff-lifecycle") return this.applyChecklist(tx, ctx, operationId, body);
    if (confirm === "link-accounts-staff-lifecycle") return this.applyAccounts(tx, ctx, operationId, body);
    if (confirm === "name-recipient-staff-lifecycle") return this.applyRecipient(tx, ctx, operationId, body);
    if (confirm === "complete-handover-staff-lifecycle") return this.applyComplete(tx, ctx, operationId, body);
    return this.applyEvidence(tx, ctx, operationId, body);
  }

  private async applyConfigure(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("configure"), acknowledgementRequired: z.boolean(), expectedVersion: z.number().int().nonnegative() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    if (!(await this.collectionCaps(tx, ctx, "employees")).includes("manage-staff-lifecycle")) throw forbidden();
    const current = await this.policy(tx, ctx, true);
    if (current.version !== parsed.data.expectedVersion) throw fail("The acknowledgement rule changed. Review it again.", "lifecycle_conflict");
    if (current.stored && current.acknowledgement_required === parsed.data.acknowledgementRequired) {
      await this.audit(tx, ctx, operationId, "staff-lifecycle.configure", "hr-record", false, { acknowledgementRequired: current.acknowledgement_required, version: current.version, unchanged: true });
      return { acknowledgementRequired: current.acknowledgement_required, version: current.version, unchanged: true, appliedVersion: current.version, accessGranted: false as const };
    }
    const version = parsed.data.expectedVersion + 1;
    if (!current.stored) await tx.query("INSERT INTO hs_staff_lifecycle_policies(tenant_id,acknowledgement_required,version,updated_by) VALUES($1,$2,1,$3)", [ctx.tenantId, parsed.data.acknowledgementRequired, ctx.actor.id]);
    else {
      const updated = await tx.query("UPDATE hs_staff_lifecycle_policies SET acknowledgement_required=$2, version=version+1, updated_by=$3, updated_at=clock_timestamp() WHERE tenant_id=$1 AND version=$4 RETURNING version", [ctx.tenantId, parsed.data.acknowledgementRequired, ctx.actor.id, parsed.data.expectedVersion]);
      if (!updated.rows.length) throw fail("The acknowledgement rule changed. Review it again.", "lifecycle_conflict");
    }
    await tx.query("INSERT INTO hs_staff_lifecycle_policy_versions(tenant_id,version,acknowledgement_required,actor_id,operation_id,source) VALUES($1,$2,$3,$4,$5,'holy-sheet')", [ctx.tenantId, version, parsed.data.acknowledgementRequired, ctx.actor.id, operationId]);
    await this.audit(tx, ctx, operationId, "staff-lifecycle.configure", "hr-record", false, { acknowledgementRequired: parsed.data.acknowledgementRequired, version });
    return { acknowledgementRequired: parsed.data.acknowledgementRequired, version, unchanged: false, appliedVersion: version, accessGranted: false as const };
  }

  private async applyAssign(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("assign"), userId, canMaintain: z.boolean(), canHandover: z.boolean(), canRecordEvidence: z.boolean(), expectedVersion: z.number().int().nonnegative() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    if (!(await this.collectionCaps(tx, ctx, "employees")).includes("manage-staff-lifecycle")) throw forbidden();
    await this.member(tx, ctx, parsed.data.userId);
    const current = await this.assignment(tx, ctx, parsed.data.userId, true);
    if ((current?.version ?? 0) !== parsed.data.expectedVersion) throw fail("The assignment changed. Review it again.", "lifecycle_conflict");
    const version = parsed.data.expectedVersion + 1;
    if (!current) await tx.query("INSERT INTO hs_staff_lifecycle_assignments(tenant_id,user_id,can_maintain,can_handover,can_record_evidence,version,updated_by) VALUES($1,$2,$3,$4,$5,1,$6)", [ctx.tenantId, parsed.data.userId, parsed.data.canMaintain, parsed.data.canHandover, parsed.data.canRecordEvidence, ctx.actor.id]);
    else {
      const updated = await tx.query("UPDATE hs_staff_lifecycle_assignments SET can_maintain=$3, can_handover=$4, can_record_evidence=$5, version=version+1, updated_by=$6, updated_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND version=$7 RETURNING version", [ctx.tenantId, parsed.data.userId, parsed.data.canMaintain, parsed.data.canHandover, parsed.data.canRecordEvidence, ctx.actor.id, parsed.data.expectedVersion]);
      if (!updated.rows.length) throw fail("The assignment changed. Review it again.", "lifecycle_conflict");
    }
    await this.audit(tx, ctx, operationId, "staff-lifecycle.assign", "hr-record", false, { userId: parsed.data.userId, version, accessGranted: false });
    return { userId: parsed.data.userId, version, accessGranted: false as const, appliedVersion: version };
  }

  private async applyCreate(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("create"), employeeRecordId: uuid, plannedOn: z.string(), directoryUserId: z.string().nullable(), checklist: checklistInput }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const prepared = await this.prepareCreate(tx, ctx, parsed.data);
    const lifecycleId = randomUUID();
    const enteredAt = this.now().toISOString();
    try {
      await tx.query("INSERT INTO hs_staff_lifecycles(id,tenant_id,workspace_id,employee_record_id,directory_user_id,state,planned_on,checklist,version,entered_at,entered_by,source,operation_id,access_transferred,credentials_transferred,access_revoked) VALUES($1,$2,$3,$4,$5,'planned',$6,$7::jsonb,1,$8,$9,'holy-sheet',$10,false,false,false)", [lifecycleId, ctx.tenantId, ctx.workspaceId, prepared.employee.id, prepared.directoryUserId, prepared.dates.plannedOn, JSON.stringify(prepared.checklist), enteredAt, ctx.actor.id, operationId]);
    } catch (error) {
      if (isUnique(error)) throw fail("This employee already has a lifecycle record.", "lifecycle_conflict");
      throw error;
    }
    await this.event(tx, ctx, lifecycleId, 1, "create", "planned", operationId, { plannedOn: prepared.dates.plannedOn });
    await this.audit(tx, ctx, operationId, "staff-lifecycle.create", "hr-record", false, { lifecycleId, employeeId: prepared.employee.id, state: "planned", enteredAt });
    return { lifecycleId, state: "planned" as const, plannedOn: prepared.dates.plannedOn, enteredAt, accessRevoked: false as const, appliedVersion: 1, ...handoverLink({ accountIds: [], recipientUserId: null }) };
  }

  private async applyTransition(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("transition"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), to: z.enum(lifecycleStates), date: z.string().nullable() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareTransition(tx, ctx, parsed.data.lifecycleId, parsed.data.expectedVersion, parsed.data.to, parsed.data.date);
    const version = await this.bump(tx, ctx, loaded.row, "state=$1, planned_on=$2, start_on=$3, leaving_on=$4, left_on=$5", [parsed.data.to, loaded.dates.plannedOn, loaded.dates.startOn, loaded.dates.leavingOn, loaded.dates.leftOn]);
    await this.event(tx, ctx, loaded.row.id, version, "transition", parsed.data.to, operationId, { date: parsed.data.date });
    await this.audit(tx, ctx, operationId, "staff-lifecycle.transition", "hr-record", false, { lifecycleId: loaded.row.id, state: parsed.data.to, at: this.now().toISOString() });
    return { lifecycleId: loaded.row.id, state: parsed.data.to, accessRevoked: false as const, appliedVersion: version, ...handoverLink({ accountIds: [], recipientUserId: loaded.row.recipient_user_id }) };
  }

  private async applyChecklist(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("checklist"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), items: checklistInput }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareChecklist(tx, ctx, parsed.data.lifecycleId, parsed.data.expectedVersion, parsed.data.items);
    const version = await this.bump(tx, ctx, loaded.row, "checklist=$1::jsonb", [JSON.stringify(loaded.checklist)]);
    await this.event(tx, ctx, loaded.row.id, version, "checklist", loaded.row.state, operationId, { items: loaded.checklist.length });
    await this.audit(tx, ctx, operationId, "staff-lifecycle.checklist", "hr-record", false, { lifecycleId: loaded.row.id, items: loaded.checklist.length });
    return { lifecycleId: loaded.row.id, items: loaded.checklist.length, accessRevoked: false as const, appliedVersion: version };
  }

  private async applyAccounts(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("link-accounts"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), accountIds: z.array(uuid).max(50) }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareAccounts(tx, ctx, parsed.data.lifecycleId, parsed.data.expectedVersion, parsed.data.accountIds);
    await tx.query("DELETE FROM hs_staff_lifecycle_accounts WHERE tenant_id=$1 AND lifecycle_id=$2", [ctx.tenantId, loaded.row.id]);
    for (const accountId of loaded.accountIds) await tx.query("INSERT INTO hs_staff_lifecycle_accounts(tenant_id,lifecycle_id,account_record_id) VALUES($1,$2,$3)", [ctx.tenantId, loaded.row.id, accountId]);
    const version = await this.bump(tx, ctx, loaded.row, "", []);
    await this.event(tx, ctx, loaded.row.id, version, "link-accounts", loaded.row.state, operationId, { accounts: loaded.accountIds.length });
    await this.audit(tx, ctx, operationId, "staff-lifecycle.link-accounts", "hr-record", false, { lifecycleId: loaded.row.id, accounts: loaded.accountIds.length });
    return { lifecycleId: loaded.row.id, appliedVersion: version, ...handoverLink({ accountIds: loaded.accountIds, recipientUserId: loaded.row.recipient_user_id }) };
  }

  private async applyRecipient(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("name-recipient"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), recipientUserId: z.string().nullable() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareRecipient(tx, ctx, parsed.data.lifecycleId, parsed.data.expectedVersion, parsed.data.recipientUserId);
    const version = await this.bump(tx, ctx, loaded.row, "recipient_user_id=$1", [parsed.data.recipientUserId]);
    await this.event(tx, ctx, loaded.row.id, version, "name-recipient", loaded.row.state, operationId, { named: parsed.data.recipientUserId !== null });
    await this.audit(tx, ctx, operationId, "staff-lifecycle.name-recipient", "hr-record", false, { lifecycleId: loaded.row.id, named: parsed.data.recipientUserId !== null });
    return { lifecycleId: loaded.row.id, appliedVersion: version, ...handoverLink({ accountIds: [], recipientUserId: parsed.data.recipientUserId }) };
  }

  private async applyComplete(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("complete-handover"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), exceptionsAcknowledged: z.boolean(), exceptionNote: z.string().nullable(), outstandingHash: z.string() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareComplete(tx, ctx, parsed.data.lifecycleId, parsed.data.expectedVersion, parsed.data.exceptionsAcknowledged, parsed.data.exceptionNote);
    if (loaded.outstandingHash !== parsed.data.outstandingHash) throw fail("Outstanding records changed. Review the handover again.", "lifecycle_conflict");
    const snapshot = loaded.outstanding.map((item) => ({ id: item.id, kind: item.kind, hidden: item.hidden }));
    const version = await this.bump(tx, ctx, loaded.row, "handover_state='complete', exceptions_acknowledged=$1, exception_note=$2, outstanding_snapshot=$3::jsonb", [parsed.data.exceptionsAcknowledged, loaded.decision.exceptionNote, JSON.stringify(snapshot)]);
    await this.event(tx, ctx, loaded.row.id, version, "complete-handover", loaded.row.state, operationId, { outstanding: loaded.outstanding.length, cleanHandover: loaded.decision.cleanHandover });
    await this.audit(tx, ctx, operationId, "staff-lifecycle.complete-handover", "hr-record", false, { lifecycleId: loaded.row.id, outstanding: loaded.outstanding.length, cleanHandover: loaded.decision.cleanHandover });
    return { lifecycleId: loaded.row.id, handoverState: "complete" as const, cleanHandover: loaded.decision.cleanHandover, outstanding: loaded.outstanding.length, accessRevoked: false as const, appliedVersion: version, ...handoverLink({ accountIds: [], recipientUserId: loaded.row.recipient_user_id }) };
  }

  private async applyEvidence(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("identity-evidence"), lifecycleId: uuid, expectedVersion: z.number().int().positive(), evidenceReference: z.string(), sourceSystem: z.string(), observedAccessRevoked: z.boolean() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareEvidence(tx, ctx, parsed.data.lifecycleId, parsed.data.expectedVersion, parsed.data.evidenceReference, parsed.data.sourceSystem, parsed.data.observedAccessRevoked);
    const nextRevoked = loaded.row.access_revoked === true || loaded.claim.accessRevoked;
    if (loaded.claim.accessRevoked) {
      await this.event(tx, ctx, loaded.row.id, Number(loaded.row.version) + 1, "identity-evidence", loaded.row.state, operationId, { evidenceReference: loaded.claim.evidenceReference }, "identity-evidence", true, loaded.claim.evidenceReference, loaded.source);
      const version = await this.bump(tx, ctx, loaded.row, "access_revoked=true", []);
      await this.audit(tx, ctx, operationId, "staff-lifecycle.identity-evidence", "identity-evidence", true, { lifecycleId: loaded.row.id, source: loaded.source, evidenceReference: loaded.claim.evidenceReference });
      return { lifecycleId: loaded.row.id, accessRevoked: true as const, evidenceClass: "identity-evidence" as const, appliedVersion: version, ...handoverLink({ accountIds: [], recipientUserId: loaded.row.recipient_user_id }) };
    }
    const version = await this.bump(tx, ctx, loaded.row, "", []);
    await this.event(tx, ctx, loaded.row.id, version, "identity-evidence", loaded.row.state, operationId, { evidenceReference: loaded.claim.evidenceReference }, "identity-evidence", false, loaded.claim.evidenceReference, loaded.source);
    await this.audit(tx, ctx, operationId, "staff-lifecycle.identity-evidence", "identity-evidence", false, { lifecycleId: loaded.row.id, source: loaded.source, evidenceReference: loaded.claim.evidenceReference });
    return { lifecycleId: loaded.row.id, accessRevoked: nextRevoked, evidenceClass: "identity-evidence" as const, appliedVersion: version, ...handoverLink({ accountIds: [], recipientUserId: loaded.row.recipient_user_id }) };
  }

  private async prepareCreate(tx: Sql, ctx: RecordContext, command: { employeeRecordId: string; plannedOn: string; directoryUserId?: string | null; checklist?: ChecklistItem[] }) {
    const employee = await this.employeeRecord(tx, ctx, command.employeeRecordId, true);
    await this.raw(tx, ctx, employee.id, "edit", true);
    const access = await this.accessFor(tx, ctx, employee);
    if (!access.canMaintain) throw forbidden();
    const dates = openingDates(command.plannedOn);
    if (!dates.ok) throw invalid(dates.message);
    const checklist = normaliseChecklist(command.checklist ?? []);
    if (!checklist.ok) throw invalid(checklist.message);
    const directoryUserId = command.directoryUserId ?? null;
    if (directoryUserId) await this.member(tx, ctx, directoryUserId);
    for (const item of checklist.items) await this.member(tx, ctx, item.ownerUserId);
    const existing = await tx.query("SELECT id FROM hs_staff_lifecycles WHERE tenant_id=$1 AND employee_record_id=$2", [ctx.tenantId, employee.id]);
    if (existing.rows.length) throw fail("This employee already has a lifecycle record.", "lifecycle_conflict");
    return { employee, dates: dates.dates, checklist: checklist.items, directoryUserId };
  }

  private async prepareTransition(tx: Sql, ctx: RecordContext, lifecycleId: string, expectedVersion: number, to: LifecycleState, date: string | null) {
    const loaded = await this.visibleLifecycle(tx, ctx, lifecycleId, true);
    if (Number(loaded.row.version) !== expectedVersion) throw fail("The staff lifecycle changed. Review it again.", "lifecycle_conflict");
    if (!stateStep(loaded.row.state, to)) throw fail("That lifecycle step is not available.", "lifecycle_status");
    if (!loaded.access.canMaintain) throw forbidden();
    const dates = transitionDates(to, datesOf(loaded.row), date);
    if (!dates.ok) throw invalid(dates.message);
    return { ...loaded, dates: dates.dates };
  }

  private async prepareChecklist(tx: Sql, ctx: RecordContext, lifecycleId: string, expectedVersion: number, items: unknown) {
    const loaded = await this.versioned(tx, ctx, lifecycleId, expectedVersion);
    if (!loaded.access.canMaintain) throw forbidden();
    const checklist = normaliseChecklist(items);
    if (!checklist.ok) throw invalid(checklist.message);
    for (const item of checklist.items) await this.member(tx, ctx, item.ownerUserId);
    return { ...loaded, checklist: checklist.items };
  }

  private async prepareAccounts(tx: Sql, ctx: RecordContext, lifecycleId: string, expectedVersion: number, accountIds: string[]) {
    const loaded = await this.versioned(tx, ctx, lifecycleId, expectedVersion);
    if (!loaded.access.canLink) throw forbidden();
    const accounts = normaliseAccountIds(accountIds);
    if (!accounts.ok) throw invalid(accounts.message);
    for (const accountId of accounts.accountIds) {
      const account = await this.accountRecord(tx, ctx, accountId);
      await this.raw(tx, ctx, account.id, "view");
    }
    return { ...loaded, accountIds: accounts.accountIds };
  }

  private async prepareRecipient(tx: Sql, ctx: RecordContext, lifecycleId: string, expectedVersion: number, recipientUserId: string | null) {
    const loaded = await this.versioned(tx, ctx, lifecycleId, expectedVersion);
    if (!loaded.access.canLink) throw forbidden();
    if (loaded.row.handover_state === "complete") throw fail("The handover is already recorded.", "lifecycle_conflict");
    if (recipientUserId) {
      if (recipientUserId === loaded.row.directory_user_id) throw invalid("Choose a different handover recipient. This link does not transfer their access or login.");
      await this.member(tx, ctx, recipientUserId);
      if (!(await this.personCanView(tx, ctx, loaded.employee, recipientUserId))) throw fail("That person is unavailable or cannot view this employee. Naming them would not grant access.", "handover_target_unavailable", 422);
    }
    return loaded;
  }

  private async prepareComplete(tx: Sql, ctx: RecordContext, lifecycleId: string, expectedVersion: number, exceptionsAcknowledged: boolean, exceptionNote: string | null) {
    const loaded = await this.versioned(tx, ctx, lifecycleId, expectedVersion);
    if (!loaded.access.canComplete) throw forbidden();
    if (loaded.row.handover_state === "complete") throw fail("The handover is already recorded.", "lifecycle_conflict");
    const policy = await this.policy(tx, ctx);
    const outstanding = await this.outstanding(tx, ctx, loaded.row.directory_user_id);
    const decision = completeHandoverAllowed({
      recipientUserId: loaded.row.recipient_user_id,
      outstandingCount: outstanding.length,
      exceptionsAcknowledged,
      exceptionNote,
      acknowledgementRequired: policy.acknowledgement_required,
      state: loaded.row.state,
    });
    if (!decision.ok) throw fail(decision.message, decision.code);
    return { ...loaded, outstanding, outstandingHash: this.outstandingHash(outstanding), decision };
  }

  private async prepareEvidence(tx: Sql, ctx: RecordContext, lifecycleId: string, expectedVersion: number, evidenceReference: string, sourceSystem: string, observedAccessRevoked: boolean) {
    const loaded = await this.versioned(tx, ctx, lifecycleId, expectedVersion);
    if (!loaded.access.canRecordEvidence) throw forbidden();
    const source = externalSource(sourceSystem);
    if (!source.ok) throw invalid(source.message);
    const claim = claimAccessRevoked({ evidenceClass: "identity-evidence", evidenceReference, observedAccessRevoked });
    if (!claim.ok || !claim.evidenceReference) throw fail(claim.ok ? "Access revoked is not claimed without identity-service evidence." : claim.message, "access_revoked_without_evidence", 422);
    return { ...loaded, claim, source: source.source };
  }

  private async versioned(tx: Sql, ctx: RecordContext, lifecycleId: string, expectedVersion: number) {
    const loaded = await this.visibleLifecycle(tx, ctx, lifecycleId, true);
    if (Number(loaded.row.version) !== expectedVersion) throw fail("The staff lifecycle changed. Review it again.", "lifecycle_conflict");
    return loaded;
  }

  private async bump(tx: Sql, ctx: RecordContext, row: LifecycleRow, assignments: string, values: unknown[]) {
    const shifted = assignments.replace(/\$(\d+)/g, (_match, index: string) => `$${Number(index) + 3}`);
    const set = shifted ? `${shifted}, version=version+1` : "version=version+1";
    const updated = await tx.query<{ version: number }>(`UPDATE hs_staff_lifecycles SET ${set} WHERE id=$1 AND tenant_id=$2 AND version=$3 RETURNING version`, [row.id, ctx.tenantId, row.version, ...values]);
    if (!updated.rows.length) throw fail("The staff lifecycle changed. Review it again.", "lifecycle_conflict");
    return Number(updated.rows[0].version);
  }

  private async present(tx: Sql, ctx: RecordContext, row: LifecycleRow, employee: Stored) {
    const fields = await this.fields(tx, ctx, "employees");
    const values = await this.visibleValues(tx, ctx, jsonObject(employee.field_values), fields);
    const checklist = normaliseChecklist(jsonValue(row.checklist));
    const items = checklist.ok ? checklist.items : [];
    const accounts = await this.accountViews(tx, ctx, row.id);
    const outstanding = await this.outstanding(tx, ctx, row.directory_user_id);
    const accessRevoked = row.access_revoked === true;
    return {
      id: row.id,
      employeeId: employee.id,
      employeeName: employee.name,
      state: row.state,
      dates: datesOf(row),
      checklist: items,
      accounts: accounts.visible,
      hiddenAccountCount: accounts.hidden,
      directoryUserId: row.directory_user_id,
      handoverState: row.handover_state,
      exceptionsAcknowledged: row.exceptions_acknowledged === true,
      exceptionNote: row.exception_note,
      outstanding: this.publicOutstanding(outstanding),
      cleanHandover: row.handover_state === "complete" && outstanding.length === 0,
      version: Number(row.version),
      enteredAt: iso(row.entered_at),
      enteredBy: row.entered_by,
      values: values.values,
      redacted: values.redacted,
      accessRevoked,
      revocationClaim: accessRevoked ? "identity-evidence" as const : "not-recorded" as const,
      ...handoverLink({ accountIds: accounts.visible.map((account) => account.id), recipientUserId: row.recipient_user_id }),
    };
  }

  private matches(query: string, lifecycle: { employeeName: string; state: string; checklist: ChecklistItem[]; values: Record<string, unknown> }) {
    const titles = lifecycle.checklist.map((item) => `${item.title} ${item.dueOn} ${item.ownerUserId}`).join(" ");
    const haystack = `${lifecycle.employeeName} ${lifecycle.state} ${titles} ${stableStringify(lifecycle.values)}`.toLowerCase();
    return haystack.includes(query);
  }

  private async visibleValues(tx: Sql, ctx: RecordContext, values: Record<string, unknown>, fields: RecordField[]) {
    const shown = await this.filtered(tx, ctx, "employees", values, fields);
    return { values: shown, redacted: Object.keys(values).some((key) => !Object.hasOwn(shown, key)) };
  }

  private publicOutstanding(outstanding: Outstanding[]) {
    return {
      items: outstanding.filter((item) => !item.hidden).map((item) => ({ id: item.id, kind: item.kind, label: item.label })),
      hiddenCount: outstanding.filter((item) => item.hidden).length,
      total: outstanding.length,
    };
  }

  private outstandingHash(outstanding: Outstanding[]) {
    return recordHash(outstanding.map((item) => ({ id: item.id, kind: item.kind, hidden: item.hidden })).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)));
  }

  private async outstanding(tx: Sql, ctx: RecordContext, directoryUserId: string | null): Promise<Outstanding[]> {
    if (!directoryUserId) return [];
    const owned = await tx.query<{ id: string; name: string }>("SELECT r.id, r.name FROM hs_data_record_responsibility resp JOIN hs_data_records r ON r.tenant_id = resp.tenant_id AND r.id = resp.record_id WHERE resp.tenant_id=$1 AND resp.user_id=$2 AND r.merged_into_id IS NULL AND r.state <> 'trashed' ORDER BY r.id", [ctx.tenantId, directoryUserId]);
    const approvals = await tx.query<{ id: string; record_id: string; name: string }>("SELECT rev.id, r.id AS record_id, r.name FROM hs_data_reviews rev JOIN hs_data_records r ON r.tenant_id = rev.tenant_id AND r.id = rev.record_id WHERE rev.tenant_id=$1 AND rev.status IN ('pending','changes_requested') AND (rev.submitted_by=$2 OR rev.record_id IN (SELECT record_id FROM hs_data_record_responsibility WHERE tenant_id=$1 AND user_id=$2)) ORDER BY rev.id", [ctx.tenantId, directoryUserId]);
    const items: Outstanding[] = [];
    for (const row of owned.rows) items.push(await this.visibleOutstanding(tx, ctx, row.id, "owned-record", row.name));
    for (const row of approvals.rows) items.push(await this.visibleOutstanding(tx, ctx, row.record_id, "approval", `Approval still open on ${row.name}`, row.id));
    return items;
  }

  private async visibleOutstanding(tx: Sql, ctx: RecordContext, recordId: string, kind: Outstanding["kind"], label: string, id = recordId): Promise<Outstanding> {
    try {
      await this.raw(tx, ctx, recordId, "view");
      return { id, kind, label, hidden: false };
    } catch (error) {
      if (hiddenError(error)) return { id, kind, label: "Restricted record", hidden: true };
      throw error;
    }
  }

  private async accountViews(tx: Sql, ctx: RecordContext, lifecycleId: string) {
    const rows = await tx.query<{ account_record_id: string }>("SELECT account_record_id FROM hs_staff_lifecycle_accounts WHERE tenant_id=$1 AND lifecycle_id=$2 ORDER BY account_record_id", [ctx.tenantId, lifecycleId]);
    const visible: { id: string; name: string }[] = [];
    let hidden = 0;
    for (const row of rows.rows) {
      try {
        const account = await this.raw(tx, ctx, row.account_record_id, "view");
        if (account.collection === "accounts") visible.push({ id: account.id, name: account.name });
        else hidden += 1;
      } catch (error) {
        if (hiddenError(error)) { hidden += 1; continue; }
        throw error;
      }
    }
    return { visible, hidden };
  }

  private async visibleLifecycle(tx: Sql, ctx: RecordContext, lifecycleId: string, lock: boolean) {
    const row = await this.lifecycleFor(tx, ctx.tenantId, lifecycleId, lock);
    let employee: Stored;
    try { employee = await this.raw(tx, ctx, row.employee_record_id, "view"); }
    catch (error) {
      if (hiddenError(error)) throw missing();
      throw error;
    }
    if (employee.collection !== "employees") throw missing();
    return { row, employee, access: await this.accessFor(tx, ctx, employee) };
  }

  private async accessFor(tx: Sql, ctx: RecordContext, employee: Stored) {
    const caps = await this.caps(tx, ctx, employee);
    const assignment = await this.assignment(tx, ctx, ctx.actor.id);
    return staffLifecycleAccess({ recordCapabilities: caps, assignment: assignment ? this.assignmentFlags(assignment) : null, canViewRecords: true });
  }

  private assignmentFlags(row: AssignmentRow) {
    return { canMaintain: row.can_maintain === true, canHandover: row.can_handover === true, canRecordEvidence: row.can_record_evidence === true };
  }

  private async employeeRecord(tx: Sql, ctx: RecordContext, recordId: string, active: boolean) {
    return this.locatedRecord(tx, ctx, recordId, "employees", active, "Choose an employee record.");
  }

  private async accountRecord(tx: Sql, ctx: RecordContext, recordId: string) {
    return this.locatedRecord(tx, ctx, recordId, "accounts", true, "Choose an account record.");
  }

  private async locatedRecord(tx: Sql, ctx: RecordContext, recordId: string, collection: string, active: boolean, wrong: string) {
    if (!uuid.safeParse(recordId).success) throw missing();
    const located = (await tx.query<{ tenant_id: string; collection: string }>("SELECT tenant_id, collection FROM hs_data_records WHERE id=$1", [recordId])).rows[0];
    if (located && located.tenant_id !== ctx.tenantId) throw fail("That record is not available in this tenant.", "lifecycle_cross_tenant", 404);
    if (located && located.collection !== collection) throw invalid(wrong);
    const record = await this.raw(tx, ctx, recordId, "view", active);
    if (record.collection !== collection) throw invalid(wrong);
    return record;
  }

  private async personCanView(tx: Sql, ctx: RecordContext, employee: Stored, personId: string) {
    const rows = await tx.query("SELECT 1 FROM hs_users u JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$2 AND m.active=true WHERE u.id=$1 AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=$3 AND g.user_id=u.id AND g.collection=$4 AND 'view'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=$3 AND g.record_id=$5 AND g.user_id=u.id AND 'view'=ANY(g.capabilities)))", [personId, ctx.workspaceId, ctx.tenantId, employee.collection, employee.id]);
    return rows.rows.length > 0;
  }

  private async member(tx: Sql, ctx: RecordContext, memberId: string) {
    const member = await tx.query("SELECT user_id FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [ctx.workspaceId, memberId]);
    if (!member.rows.length) throw invalid("Choose a workspace member. Linking a person does not provision an account or grant access.");
  }

  private async policy(tx: Sql, ctx: RecordContext, lock = false): Promise<PolicyRow & { stored: boolean }> {
    const rows = await tx.query<PolicyRow>(`SELECT acknowledgement_required, version FROM hs_staff_lifecycle_policies WHERE tenant_id=$1${lock ? " FOR UPDATE" : ""}`, [ctx.tenantId]);
    return rows.rows[0] ? { ...rows.rows[0], acknowledgement_required: rows.rows[0].acknowledgement_required === true, version: Number(rows.rows[0].version), stored: true } : { acknowledgement_required: true, version: 0, stored: false };
  }

  private async policyView(tx: Sql, ctx: RecordContext) {
    const policy = await this.policy(tx, ctx);
    return { acknowledgementRequired: policy.acknowledgement_required, version: policy.version, accessGranted: false as const };
  }

  private async assignment(tx: Sql, ctx: RecordContext, memberId: string, lock = false) {
    const rows = await tx.query<AssignmentRow>(`SELECT user_id, can_maintain, can_handover, can_record_evidence, version FROM hs_staff_lifecycle_assignments WHERE tenant_id=$1 AND user_id=$2${lock ? " FOR UPDATE" : ""}`, [ctx.tenantId, memberId]);
    const row = rows.rows[0];
    return row ? { ...row, version: Number(row.version) } : null;
  }

  private async assignmentViews(tx: Sql, ctx: RecordContext) {
    const rows = await tx.query<AssignmentRow>("SELECT user_id, can_maintain, can_handover, can_record_evidence, version FROM hs_staff_lifecycle_assignments WHERE tenant_id=$1 ORDER BY user_id", [ctx.tenantId]);
    return rows.rows.map((row) => ({ userId: row.user_id, canMaintain: row.can_maintain === true, canHandover: row.can_handover === true, canRecordEvidence: row.can_record_evidence === true, version: Number(row.version), accessGranted: false as const }));
  }

  private async visibleDrafts(tx: Sql, ctx: RecordContext) {
    const rows = await tx.query<DraftRow>("SELECT id, employee_record_id, directory_user_id, planned_on, start_on, leaving_on, left_on, checklist, account_ids, recipient_user_id, exceptions_acknowledged, exception_note, version, state FROM hs_staff_lifecycle_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND state='open' ORDER BY updated_at DESC, id LIMIT 25", [ctx.tenantId, ctx.workspaceId, ctx.actor.id]);
    const shown = [];
    for (const row of rows.rows) {
      try { await this.raw(tx, ctx, row.employee_record_id, "view"); }
      catch (error) {
        if (hiddenError(error)) continue;
        throw error;
      }
      const checklist = normaliseChecklist(jsonValue(row.checklist));
      const accounts = jsonValue(row.account_ids);
      shown.push({ id: row.id, employeeRecordId: row.employee_record_id, directoryUserId: row.directory_user_id, plannedOn: row.planned_on, startOn: row.start_on, leavingOn: row.leaving_on, leftOn: row.left_on, checklist: checklist.ok ? checklist.items : [], accountIds: Array.isArray(accounts) ? accounts.filter((item): item is string => typeof item === "string") : [], recipientUserId: row.recipient_user_id, exceptionsAcknowledged: row.exceptions_acknowledged === true, exceptionNote: row.exception_note, version: Number(row.version), state: row.state });
    }
    return shown;
  }

  private async lifecycleFor(tx: Sql, tenantId: string, lifecycleId: string, lock: boolean) {
    const rows = await tx.query<LifecycleRow>(`SELECT ${columns} FROM hs_staff_lifecycles WHERE id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [lifecycleId, tenantId]);
    const row = rows.rows[0];
    if (!row) throw missing();
    return row;
  }

  private async event(tx: Sql, ctx: RecordContext, lifecycleId: string, version: number, kind: string, state: LifecycleState, operationId: string, detail: Record<string, unknown>, evidenceClass: "hr-record" | "identity-evidence" = "hr-record", accessRevoked = false, evidenceReference: string | null = null, source = "holy-sheet") {
    await tx.query("INSERT INTO hs_staff_lifecycle_events(tenant_id,lifecycle_id,event_version,kind,state,evidence_class,access_revoked,evidence_reference,actor_id,operation_id,source,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)", [ctx.tenantId, lifecycleId, version, kind, state, evidenceClass, accessRevoked, evidenceReference, ctx.actor.id, operationId, source, JSON.stringify(detail)]);
  }

  private async seen(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string): Promise<Effect | null> {
    const prior = (await tx.query<{ request_hash: string; result: unknown; applied_version: number }>("SELECT request_hash, result, applied_version FROM hs_staff_lifecycle_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, operationId])).rows[0];
    const outcome = sameOperation(prior ? { requestHash: prior.request_hash, result: jsonValue(prior.result) } : null, requestHash);
    if (outcome.status === "mismatch") throw fail("Operation identity was reused.", "operation_mismatch");
    if (outcome.status === "replay") return { ...jsonObject(outcome.result), appliedVersion: Number(prior?.applied_version), replayed: true, ...flags };
    return null;
  }

  private async finish(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string, lifecycleId: string | null, version: number, kind: string, result: Record<string, unknown>) {
    await tx.query("INSERT INTO hs_staff_lifecycle_operations(tenant_id,actor_id,operation_id,request_hash,kind,lifecycle_id,applied_version,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [ctx.tenantId, ctx.actor.id, operationId, requestHash, kind, lifecycleId, version, JSON.stringify(result)]);
  }

  private async audit(tx: Sql, ctx: RecordContext, operationId: string, action: string, evidenceClass: "hr-record" | "identity-evidence", accessRevoked: boolean, extra: Record<string, unknown>) {
    const source = evidenceClass === "identity-evidence" && typeof extra.source === "string" ? extra.source : "holy-sheet";
    await tx.query("INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ctx.actor.id, action, JSON.stringify({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, actorId: ctx.actor.id, source, evidenceClass, operation: action, at: this.now().toISOString(), atIst: formatIst(this.now()), accessTransferred: false, credentialsTransferred: false, accessRevoked, ...extra }), operationId]);
  }
}
