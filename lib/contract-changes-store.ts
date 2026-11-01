import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  approvalAllowed,
  changeKinds,
  contractChangeAccess,
  createsCycle,
  effectuateAllowed,
  explicitRenewalDecision,
  noCommitmentNote,
  parseChangeInstant,
  parseProposedEnd,
  renewalDecisionView,
  renewalDecisions,
  statusStep,
  type ChangeKind,
  type ChangeStatus,
  type RenewalDecision,
} from "./contract-changes";
import type { Sql } from "./database";
import { DocumentError, stableStringify } from "./document";
import { formatIst } from "./ist-label";
import { SharedRecordRepository, type CurrentSuiteTenantAuthority, type RecordContext, type RecordValueAuthority, type Stored } from "./shared-records";
import { recordHash, type RecordField } from "./shared-record-types";

const uuid = z.string().uuid();
const instantText = z.string().min(16).max(40);
const userId = z.string().min(1).max(200);
const flags = { accessGranted: false as const, legalCommitment: false as const, commitsRenewal: false as const, schedule: "paused" as const };
const confirms = ["configure-contract-change", "assign-contract-change", "create-contract-change", "propose-contract-change", "approve-contract-change", "effectuate-contract-change", "decide-contract-change"] as const;
const changeColumns = "id, kind, parent_record_id, successor_record_id, effective_start, proposed_end, timezone, document_file_id, document_version_no, document_history, parent_terms, parent_version, successor_version, status, decision, responsible_user_id, version, entered_at, entered_by, proposed_by, proposed_at, approved_by, approved_at, effective_at, review_policy_version, legal_commitment";

const previewInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), reviewRequired: z.boolean() }).strict(),
  z.object({ action: z.literal("assign"), userId, canPropose: z.boolean(), canApprove: z.boolean(), canEffectuate: z.boolean(), canDecide: z.boolean() }).strict(),
  z.object({ action: z.literal("create"), kind: z.enum(changeKinds), parentRecordId: uuid, successorRecordId: uuid, start: instantText, timezone: z.string().min(1).max(100), documentFileId: uuid, documentVersionNo: z.number().int().positive(), proposedEnd: z.string().max(10).nullable().optional(), responsibleUserId: userId.nullable().optional(), decision: z.enum(renewalDecisions).optional() }).strict(),
  z.object({ action: z.literal("propose"), changeId: uuid, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("approve"), changeId: uuid, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("effectuate"), changeId: uuid, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("decide"), changeId: uuid, expectedVersion: z.number().int().positive(), decision: z.enum(renewalDecisions), responsibleUserId: userId.nullable() }).strict(),
]);
const confirmInput = z.object({ operationId: uuid, previewId: uuid, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.enum(confirms) }).strict();
const draftInput = z.object({
  draftId: uuid,
  kind: z.enum(changeKinds),
  parentRecordId: uuid,
  successorRecordId: uuid,
  start: z.string().max(40),
  proposedEnd: z.string().max(10).nullable(),
  timezone: z.string().max(100),
  documentFileId: uuid,
  documentVersionNo: z.number().int().positive(),
  responsibleUserId: z.string().max(200).nullable(),
  decision: z.enum(renewalDecisions),
  operationId: uuid,
  expectedVersion: z.number().int().nonnegative(),
}).strict();
const draftVersionInput = z.object({ draftId: uuid, operationId: uuid, expectedVersion: z.number().int().positive() }).strict();

type PolicyRow = { review_required: boolean; version: number };
type AssignmentRow = { user_id: string; can_propose: boolean; can_approve: boolean; can_effectuate: boolean; can_decide: boolean; version: number };
type ChangeRow = {
  id: string;
  kind: ChangeKind;
  parent_record_id: string;
  successor_record_id: string;
  effective_start: string | Date;
  proposed_end: string | null;
  timezone: string;
  document_file_id: string;
  document_version_no: number;
  document_history: unknown;
  parent_terms: unknown;
  parent_version: number;
  successor_version: number;
  status: ChangeStatus;
  decision: RenewalDecision;
  responsible_user_id: string | null;
  version: number;
  entered_at: string | Date;
  entered_by: string;
  proposed_by: string | null;
  proposed_at: string | Date | null;
  approved_by: string | null;
  approved_at: string | Date | null;
  effective_at: string | Date | null;
  review_policy_version: number | null;
  legal_commitment: boolean;
};
type DraftRow = {
  id: string;
  kind: ChangeKind;
  parent_record_id: string;
  successor_record_id: string;
  effective_start: string;
  proposed_end: string | null;
  timezone: string;
  document_file_id: string;
  document_version_no: number;
  responsible_user_id: string | null;
  decision: RenewalDecision;
  version: number;
  state: "open" | "discarded";
};
type PreviewRow = { id: string; action: string; confirm: (typeof confirms)[number]; payload: unknown; review_hash: string; authority_revision: string; expires_at: string | Date };
type EventRow = { event_version: number; kind: string; status: ChangeStatus; decision: RenewalDecision | null; responsible_user_id: string | null; actor_id: string; operation_id: string; source: string; created_at: string | Date };
type Effect = Record<string, unknown> & { appliedVersion?: number; replayed?: boolean };

const fail = (message: string, code = "change_conflict", status = 409) => new DocumentError(message, code, status);
const missing = () => fail("That contract change is unavailable.", "change_unavailable", 404);
const forbidden = (message = "This contract change action is not permitted.") => fail(message, "change_forbidden", 403);
const invalid = (message = "Review the contract change.") => fail(message, "change_invalid", 400);

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
function numberList(value: unknown) {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is number => typeof item === "number" || (typeof item === "string" && /^\d+$/.test(item))).map(Number);
}
function day(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
function hiddenError(error: unknown) {
  return error instanceof DocumentError && [403, 404].includes(error.status);
}

export class ContractChangeRepository extends SharedRecordRepository {
  constructor(pages: ConstructorParameters<typeof SharedRecordRepository>[0], authority: CurrentSuiteTenantAuthority, valueAuthority?: RecordValueAuthority, private readonly clock: () => Date = () => new Date()) {
    super(pages, authority, valueAuthority);
  }

  private now() { return this.clock(); }

  async listChanges(ctx: RecordContext, input: { query?: string; changeId?: string; parentId?: string }) {
    const parsed = z.object({ query: z.string().max(100).optional(), changeId: uuid.optional(), parentId: uuid.optional() }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the contract change search.");
    const query = parsed.data.query?.trim().toLowerCase() ?? "";
    return this.transaction(ctx, async (tx) => {
      const capabilities = await this.collectionCaps(tx, ctx, "contracts");
      const assignment = await this.assignment(tx, ctx, ctx.actor.id);
      const actions = contractChangeAccess({
        recordCapabilities: capabilities,
        assignment: assignment ? this.assignmentFlags(assignment) : null,
        canViewRecords: capabilities.includes("view"),
      });
      const policy = capabilities.includes("view") || capabilities.includes("manage-contract-changes") ? await this.policyView(tx, ctx) : null;
      const assignments = capabilities.includes("manage-contract-changes") ? await this.assignmentViews(tx, ctx) : [];
      if (parsed.data.changeId) {
        const loaded = await this.visibleChange(tx, ctx, parsed.data.changeId, false);
        const change = await this.present(tx, ctx, loaded.row, loaded.parent, loaded.successor, false);
        if (query && !this.matches(query, change)) return { changes: [], endDates: [], drafts: [], policy, assignments, actions, note: noCommitmentNote, ...flags };
        return { changes: [change], endDates: change.endDate ? [change.endDate] : [], drafts: await this.visibleDrafts(tx, ctx), policy, assignments, actions, note: noCommitmentNote, ...flags };
      }
      if (parsed.data.parentId) {
        const parent = await this.contractRecord(tx, ctx, parsed.data.parentId, false);
        await this.raw(tx, ctx, parent.id, "view");
      }
      const rows = await tx.query<ChangeRow>(`SELECT ${changeColumns} FROM hs_contract_changes WHERE tenant_id=$1 AND ($2::uuid IS NULL OR parent_record_id=$2 OR successor_record_id=$2) ORDER BY entered_at DESC, id LIMIT 50`, [ctx.tenantId, parsed.data.parentId ?? null]);
      const changes = [];
      for (const row of rows.rows) {
        let parent: Stored;
        let successor: Stored;
        try {
          parent = await this.raw(tx, ctx, row.parent_record_id, "view");
          successor = await this.raw(tx, ctx, row.successor_record_id, "view");
        } catch (error) {
          if (hiddenError(error)) continue;
          throw error;
        }
        if (parent.collection !== "contracts" || successor.collection !== "contracts") continue;
        const change = await this.present(tx, ctx, row, parent, successor, false);
        if (query && !this.matches(query, change)) continue;
        changes.push(change);
        if (changes.length >= 25) break;
      }
      return { changes, endDates: changes.flatMap((change) => change.endDate ? [change.endDate] : []), drafts: await this.visibleDrafts(tx, ctx), policy, assignments, actions, note: noCommitmentNote, ...flags };
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
      await tx.query("INSERT INTO hs_contract_change_previews(id,tenant_id,workspace_id,actor_id,action,confirm,payload,review_hash,authority_revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.action, described.confirm, JSON.stringify(described.payload), reviewHash, proof.revision, expiresAt]);
      return { previewId, reviewHash, action: command.action, confirm: described.confirm, impact: described.impact, ...flags };
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
      const preview = (await tx.query<PreviewRow>("SELECT id, action, confirm, payload, review_hash, authority_revision, expires_at FROM hs_contract_change_previews WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4", [command.previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
      if (!preview || new Date(preview.expires_at).getTime() <= this.now().getTime()) throw fail("Review the contract change again.", "review_expired");
      if (preview.review_hash !== command.reviewHash || preview.confirm !== command.confirm || preview.authority_revision !== proof.revision) throw fail("Confirm the reviewed contract change.", "review_unconfirmed");
      const result = await this.apply(tx, ctx, command.operationId, preview.confirm, jsonValue(preview.payload));
      await this.finish(tx, ctx, command.operationId, requestHash, typeof result.changeId === "string" ? result.changeId : null, result.appliedVersion ?? 1, preview.action, result);
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
      const parent = await this.contractRecord(tx, ctx, command.parentRecordId, true);
      const successor = await this.contractRecord(tx, ctx, command.successorRecordId, true);
      await this.raw(tx, ctx, parent.id, "edit", true);
      await this.raw(tx, ctx, successor.id, "link", true);
      const access = await this.accessFor(tx, ctx, parent, successor);
      if (!access.canPropose) throw forbidden();
      const existing = (await tx.query<DraftRow>("SELECT id, kind, parent_record_id, successor_record_id, effective_start, proposed_end, timezone, document_file_id, document_version_no, responsible_user_id, decision, version, state FROM hs_contract_change_drafts WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 FOR UPDATE", [command.draftId, ctx.tenantId, ctx.actor.id])).rows[0];
      if (command.expectedVersion === 0) {
        if (existing) throw fail("This draft already exists.", "change_conflict");
        await tx.query("INSERT INTO hs_contract_change_drafts(id,tenant_id,workspace_id,actor_id,kind,parent_record_id,successor_record_id,effective_start,proposed_end,timezone,document_file_id,document_version_no,responsible_user_id,decision,version,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,'open')", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.kind, parent.id, successor.id, command.start, command.proposedEnd, command.timezone, command.documentFileId, command.documentVersionNo, command.responsibleUserId, command.decision]);
      } else {
        if (!existing || existing.state !== "open" || Number(existing.version) !== command.expectedVersion) throw fail("Refresh the draft and try again.", "change_conflict");
        const updated = await tx.query("UPDATE hs_contract_change_drafts SET kind=$4, parent_record_id=$5, successor_record_id=$6, effective_start=$7, proposed_end=$8, timezone=$9, document_file_id=$10, document_version_no=$11, responsible_user_id=$12, decision=$13, version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$3 RETURNING version", [command.draftId, ctx.tenantId, command.expectedVersion, command.kind, parent.id, successor.id, command.start, command.proposedEnd, command.timezone, command.documentFileId, command.documentVersionNo, command.responsibleUserId, command.decision]);
        if (!updated.rows.length) throw fail("Refresh the draft and try again.", "change_conflict");
      }
      const version = command.expectedVersion + 1;
      const result = { draftId: command.draftId, version, state: "open" as const, appliedVersion: version };
      await this.audit(tx, ctx, command.operationId, "contract-change.draft", { draftId: command.draftId, parentId: parent.id, successorId: successor.id, version });
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

  async changeHistory(ctx: RecordContext, input: { changeId: string }) {
    const parsed = z.object({ changeId: uuid }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the contract change history.");
    return this.transaction(ctx, async (tx) => {
      const loaded = await this.visibleChange(tx, ctx, parsed.data.changeId, false);
      if (!loaded.access.canHistory) throw forbidden();
      const events = await tx.query<EventRow>("SELECT event_version, kind, status, decision, responsible_user_id, actor_id, operation_id, source, created_at FROM hs_contract_change_events WHERE tenant_id=$1 AND change_id=$2 ORDER BY event_version", [ctx.tenantId, parsed.data.changeId]);
      const change = await this.present(tx, ctx, loaded.row, loaded.parent, loaded.successor, true);
      return {
        changeId: parsed.data.changeId,
        change,
        events: events.rows.map((event) => ({ version: Number(event.event_version), kind: event.kind, status: event.status, decision: event.decision, responsibleUserId: event.responsible_user_id, actorId: event.actor_id, operationId: event.operation_id, source: event.source, at: iso(event.created_at) })),
        ...flags,
      };
    });
  }

  async download(ctx: RecordContext, input: { changeId: string }) {
    const parsed = z.object({ changeId: uuid }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the contract change download.");
    return this.transaction(ctx, async (tx) => {
      const loaded = await this.visibleChange(tx, ctx, parsed.data.changeId, false);
      if (!loaded.access.canExport) throw forbidden();
      const change = await this.present(tx, ctx, loaded.row, loaded.parent, loaded.successor, false);
      const body = { source: "holy-sheet", note: noCommitmentNote, ...flags, change };
      return { filename: "contract-change.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from(JSON.stringify(body), "utf8") };
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
      const existing = (await tx.query<DraftRow>("SELECT id, kind, parent_record_id, successor_record_id, effective_start, proposed_end, timezone, document_file_id, document_version_no, responsible_user_id, decision, version, state FROM hs_contract_change_drafts WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 FOR UPDATE", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
      if (!existing) throw missing();
      await this.raw(tx, ctx, existing.parent_record_id, "view");
      await this.raw(tx, ctx, existing.successor_record_id, "view");
      if (existing.state !== from || Number(existing.version) !== command.expectedVersion) throw fail("Refresh the draft and try again.", "change_conflict");
      await tx.query("UPDATE hs_contract_change_drafts SET state=$4, version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$3", [command.draftId, ctx.tenantId, command.expectedVersion, next]);
      const version = command.expectedVersion + 1;
      const result = { draftId: command.draftId, state: next, version, appliedVersion: version };
      await this.audit(tx, ctx, command.operationId, next === "open" ? "contract-change.restore" : "contract-change.discard", { draftId: command.draftId, version });
      await this.finish(tx, ctx, command.operationId, requestHash, null, version, next === "open" ? "restore" : "discard", result);
      return { ...result, replayed: false, ...flags };
    });
  }

  private async describe(tx: Sql, ctx: RecordContext, command: z.infer<typeof previewInput>) {
    if (command.action === "configure") {
      if (!(await this.collectionCaps(tx, ctx, "contracts")).includes("manage-contract-changes")) throw forbidden();
      const current = await this.policy(tx, ctx);
      return { confirm: "configure-contract-change" as const, impact: "This versions the review rule for contract changes. It does not grant record access or commit a renewal.", payload: { action: "configure", reviewRequired: command.reviewRequired, expectedVersion: current.version } };
    }
    if (command.action === "assign") {
      if (!(await this.collectionCaps(tx, ctx, "contracts")).includes("manage-contract-changes")) throw forbidden();
      await this.member(tx, ctx, command.userId);
      const current = await this.assignment(tx, ctx, command.userId);
      return { confirm: "assign-contract-change" as const, impact: "This assignment does not grant record, field, or collection access. The person still needs those permissions separately.", payload: { action: "assign", userId: command.userId, canPropose: command.canPropose, canApprove: command.canApprove, canEffectuate: command.canEffectuate, canDecide: command.canDecide, expectedVersion: current?.version ?? 0 } };
    }
    if (command.action === "create") {
      const prepared = await this.prepareCreate(tx, ctx, command);
      return { confirm: "create-contract-change" as const, impact: `This saves a ${prepared.kind} in draft. Original terms and the pinned document version stay as they are. ${noCommitmentNote}`, payload: { action: "create", kind: prepared.kind, parentRecordId: prepared.parent.id, successorRecordId: prepared.successor.id, start: command.start, timezone: command.timezone, documentFileId: command.documentFileId, documentVersionNo: command.documentVersionNo, proposedEnd: prepared.proposedEnd, responsibleUserId: prepared.responsibleUserId, decision: prepared.decision } };
    }
    if (command.action === "propose") {
      const loaded = await this.prepareTransition(tx, ctx, command.changeId, command.expectedVersion, "proposed");
      return { confirm: "propose-contract-change" as const, impact: "Proposal asks for the configured review. It does not approve the change or commit a renewal.", payload: { action: "propose", changeId: loaded.row.id, expectedVersion: Number(loaded.row.version) } };
    }
    if (command.action === "approve") {
      const loaded = await this.prepareApproval(tx, ctx, command.changeId, command.expectedVersion);
      return { confirm: "approve-contract-change" as const, impact: loaded.policy.review_required ? "Configured review requires a different reviewer. Approval does not make the change effective and does not commit a renewal." : "Review is not required to be a different person. Approval still does not make the change effective or commit a renewal.", payload: { action: "approve", changeId: loaded.row.id, expectedVersion: Number(loaded.row.version), expectedPolicyVersion: loaded.policy.version } };
    }
    if (command.action === "effectuate") {
      const loaded = await this.prepareEffectuate(tx, ctx, command.changeId, command.expectedVersion);
      return { confirm: "effectuate-contract-change" as const, impact: "Making a change effective follows the effective date and leaves the original terms and document history in place. It does not sign or commit a renewal.", payload: { action: "effectuate", changeId: loaded.row.id, expectedVersion: Number(loaded.row.version) } };
    }
    const loaded = await this.prepareDecision(tx, ctx, command.changeId, command.expectedVersion, command.decision, command.responsibleUserId);
    return { confirm: "decide-contract-change" as const, impact: "This records who is responsible and what they decided. The date and the decision do not commit a renewal.", payload: { action: "decide", changeId: loaded.row.id, expectedVersion: Number(loaded.row.version), decision: command.decision, responsibleUserId: command.responsibleUserId } };
  }

  private async apply(tx: Sql, ctx: RecordContext, operationId: string, confirm: (typeof confirms)[number], payload: unknown): Promise<Effect & { changeId?: string; appliedVersion?: number }> {
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (confirm === "configure-contract-change") return this.applyConfigure(tx, ctx, operationId, body);
    if (confirm === "assign-contract-change") return this.applyAssign(tx, ctx, operationId, body);
    if (confirm === "create-contract-change") return this.applyCreate(tx, ctx, operationId, body);
    if (confirm === "propose-contract-change") return this.applyPropose(tx, ctx, operationId, body);
    if (confirm === "approve-contract-change") return this.applyApprove(tx, ctx, operationId, body);
    if (confirm === "effectuate-contract-change") return this.applyEffectuate(tx, ctx, operationId, body);
    return this.applyDecide(tx, ctx, operationId, body);
  }

  private async applyConfigure(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("configure"), reviewRequired: z.boolean(), expectedVersion: z.number().int().nonnegative() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    if (!(await this.collectionCaps(tx, ctx, "contracts")).includes("manage-contract-changes")) throw forbidden();
    const current = await this.policy(tx, ctx, true);
    if (current.version !== parsed.data.expectedVersion) throw fail("The review rule changed. Review it again.", "change_conflict");
    if (current.stored && current.review_required === parsed.data.reviewRequired) {
      await this.audit(tx, ctx, operationId, "contract-change.configure", { reviewRequired: current.review_required, version: current.version, unchanged: true });
      return { reviewRequired: current.review_required, version: current.version, unchanged: true, appliedVersion: current.version };
    }
    const version = parsed.data.expectedVersion + 1;
    if (!current.stored) await tx.query("INSERT INTO hs_contract_change_policies(tenant_id,review_required,version,updated_by) VALUES($1,$2,1,$3)", [ctx.tenantId, parsed.data.reviewRequired, ctx.actor.id]);
    else {
      const updated = await tx.query("UPDATE hs_contract_change_policies SET review_required=$2, version=version+1, updated_by=$3, updated_at=clock_timestamp() WHERE tenant_id=$1 AND version=$4 RETURNING version", [ctx.tenantId, parsed.data.reviewRequired, ctx.actor.id, parsed.data.expectedVersion]);
      if (!updated.rows.length) throw fail("The review rule changed. Review it again.", "change_conflict");
    }
    await tx.query("INSERT INTO hs_contract_change_policy_versions(tenant_id,version,review_required,actor_id,operation_id,source) VALUES($1,$2,$3,$4,$5,'holy-sheet')", [ctx.tenantId, version, parsed.data.reviewRequired, ctx.actor.id, operationId]);
    await this.audit(tx, ctx, operationId, "contract-change.configure", { reviewRequired: parsed.data.reviewRequired, version });
    return { reviewRequired: parsed.data.reviewRequired, version, unchanged: false, appliedVersion: version };
  }

  private async applyAssign(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("assign"), userId, canPropose: z.boolean(), canApprove: z.boolean(), canEffectuate: z.boolean(), canDecide: z.boolean(), expectedVersion: z.number().int().nonnegative() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    if (!(await this.collectionCaps(tx, ctx, "contracts")).includes("manage-contract-changes")) throw forbidden();
    await this.member(tx, ctx, parsed.data.userId);
    const current = await this.assignment(tx, ctx, parsed.data.userId, true);
    if ((current?.version ?? 0) !== parsed.data.expectedVersion) throw fail("The assignment changed. Review it again.", "change_conflict");
    const version = parsed.data.expectedVersion + 1;
    if (!current) await tx.query("INSERT INTO hs_contract_change_assignments(tenant_id,user_id,can_propose,can_approve,can_effectuate,can_decide,version,updated_by) VALUES($1,$2,$3,$4,$5,$6,1,$7)", [ctx.tenantId, parsed.data.userId, parsed.data.canPropose, parsed.data.canApprove, parsed.data.canEffectuate, parsed.data.canDecide, ctx.actor.id]);
    else {
      const updated = await tx.query("UPDATE hs_contract_change_assignments SET can_propose=$3, can_approve=$4, can_effectuate=$5, can_decide=$6, version=version+1, updated_by=$7, updated_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND version=$8 RETURNING version", [ctx.tenantId, parsed.data.userId, parsed.data.canPropose, parsed.data.canApprove, parsed.data.canEffectuate, parsed.data.canDecide, ctx.actor.id, parsed.data.expectedVersion]);
      if (!updated.rows.length) throw fail("The assignment changed. Review it again.", "change_conflict");
    }
    await this.audit(tx, ctx, operationId, "contract-change.assign", { userId: parsed.data.userId, version, accessGranted: false });
    return { userId: parsed.data.userId, version, accessGranted: false as const, appliedVersion: version };
  }

  private async applyCreate(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("create"), kind: z.enum(changeKinds), parentRecordId: uuid, successorRecordId: uuid, start: instantText, timezone: z.string().min(1).max(100), documentFileId: uuid, documentVersionNo: z.number().int().positive(), proposedEnd: z.string().nullable(), responsibleUserId: z.string().nullable(), decision: z.enum(renewalDecisions) }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const prepared = await this.prepareCreate(tx, ctx, { ...parsed.data, proposedEnd: parsed.data.proposedEnd, responsibleUserId: parsed.data.responsibleUserId, decision: parsed.data.decision });
    const history = await this.supportingDocument(tx, ctx, parsed.data.documentFileId, parsed.data.documentVersionNo, prepared.parent.id, prepared.successor.id);
    const enteredAt = this.now().toISOString();
    const changeId = randomUUID();
    const terms = { name: prepared.parent.name, values: jsonObject(prepared.parent.field_values) };
    await tx.query(`INSERT INTO hs_contract_changes(id,tenant_id,workspace_id,kind,parent_record_id,successor_record_id,effective_start,proposed_end,timezone,document_file_id,document_version_no,document_history,parent_terms,parent_version,successor_version,status,decision,responsible_user_id,version,entered_at,entered_by,source,operation_id,legal_commitment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,'draft',$16,$17,1,$18,$19,'holy-sheet',$20,false)`, [changeId, ctx.tenantId, ctx.workspaceId, prepared.kind, prepared.parent.id, prepared.successor.id, prepared.instant.toISOString(), prepared.proposedEnd, parsed.data.timezone, parsed.data.documentFileId, parsed.data.documentVersionNo, JSON.stringify(history), JSON.stringify(terms), Number(prepared.parent.version), Number(prepared.successor.version), prepared.decision, prepared.responsibleUserId, enteredAt, ctx.actor.id, operationId]);
    await this.event(tx, ctx, changeId, 1, "create", "draft", prepared.decision, prepared.responsibleUserId, operationId);
    await this.audit(tx, ctx, operationId, "contract-change.create", { changeId, kind: prepared.kind, status: "draft", parentId: prepared.parent.id, successorId: prepared.successor.id, documentFileId: parsed.data.documentFileId, documentVersionNo: parsed.data.documentVersionNo, enteredAt, effectiveStart: prepared.instant.toISOString() });
    return { changeId, kind: prepared.kind, status: "draft" as const, documentVersionNo: parsed.data.documentVersionNo, enteredAt, effectiveStart: prepared.instant.toISOString(), legalCommitment: false as const, appliedVersion: 1 };
  }

  private async applyPropose(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("propose"), changeId: uuid, expectedVersion: z.number().int().positive() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareTransition(tx, ctx, parsed.data.changeId, parsed.data.expectedVersion, "proposed");
    const at = this.now().toISOString();
    const version = await this.transition(tx, ctx, loaded.row, "proposed", "proposed_by=$1, proposed_at=$2", [ctx.actor.id, at]);
    await this.event(tx, ctx, loaded.row.id, version, "propose", "proposed", null, null, operationId);
    await this.audit(tx, ctx, operationId, "contract-change.propose", { changeId: loaded.row.id, status: "proposed", at, effectiveStart: iso(loaded.row.effective_start) });
    return { changeId: loaded.row.id, status: "proposed" as const, at, legalCommitment: false as const, appliedVersion: version };
  }

  private async applyApprove(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("approve"), changeId: uuid, expectedVersion: z.number().int().positive(), expectedPolicyVersion: z.number().int().nonnegative() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareApproval(tx, ctx, parsed.data.changeId, parsed.data.expectedVersion);
    if (loaded.policy.version !== parsed.data.expectedPolicyVersion) throw fail("The review rule changed. Review the approval again.", "change_conflict");
    const at = this.now().toISOString();
    const version = await this.transition(tx, ctx, loaded.row, "approved", "approved_by=$1, approved_at=$2, review_policy_version=$3", [ctx.actor.id, at, loaded.policy.version]);
    await this.event(tx, ctx, loaded.row.id, version, "approve", "approved", null, null, operationId);
    await this.audit(tx, ctx, operationId, "contract-change.approve", { changeId: loaded.row.id, status: "approved", at, reviewPolicyVersion: loaded.policy.version, effectiveStart: iso(loaded.row.effective_start) });
    return { changeId: loaded.row.id, status: "approved" as const, at, reviewPolicyVersion: loaded.policy.version, legalCommitment: false as const, appliedVersion: version };
  }

  private async applyEffectuate(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("effectuate"), changeId: uuid, expectedVersion: z.number().int().positive() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareEffectuate(tx, ctx, parsed.data.changeId, parsed.data.expectedVersion);
    const at = this.now().toISOString();
    const version = await this.transition(tx, ctx, loaded.row, "effective", "effective_at=$1", [at]);
    await this.event(tx, ctx, loaded.row.id, version, "effectuate", "effective", null, null, operationId);
    await this.audit(tx, ctx, operationId, "contract-change.effectuate", { changeId: loaded.row.id, status: "effective", at, enteredAt: iso(loaded.row.entered_at), effectiveStart: iso(loaded.row.effective_start), legalCommitment: false });
    return { changeId: loaded.row.id, status: "effective" as const, at, effectiveStart: iso(loaded.row.effective_start), legalCommitment: false as const, commitsRenewal: false as const, appliedVersion: version };
  }

  private async applyDecide(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("decide"), changeId: uuid, expectedVersion: z.number().int().positive(), decision: z.enum(renewalDecisions), responsibleUserId: z.string().nullable() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const loaded = await this.prepareDecision(tx, ctx, parsed.data.changeId, parsed.data.expectedVersion, parsed.data.decision, parsed.data.responsibleUserId);
    const updated = await tx.query<{ version: number }>("UPDATE hs_contract_changes SET decision=$3, responsible_user_id=$4, version=version+1 WHERE id=$1 AND tenant_id=$2 AND version=$5 RETURNING version", [loaded.row.id, ctx.tenantId, parsed.data.decision, parsed.data.responsibleUserId, loaded.row.version]);
    if (!updated.rows.length) throw fail("The contract change changed. Review the decision again.", "change_conflict");
    const version = Number(updated.rows[0].version);
    await this.event(tx, ctx, loaded.row.id, version, "decide", loaded.row.status, parsed.data.decision, parsed.data.responsibleUserId, operationId);
    await this.audit(tx, ctx, operationId, "contract-change.decide", { changeId: loaded.row.id, status: loaded.row.status, decision: parsed.data.decision, responsibleUserId: parsed.data.responsibleUserId, legalCommitment: false });
    return { changeId: loaded.row.id, status: loaded.row.status, decision: parsed.data.decision, responsibleUserId: parsed.data.responsibleUserId, legalCommitment: false as const, commitsRenewal: false as const, appliedVersion: version };
  }

  private async prepareCreate(tx: Sql, ctx: RecordContext, command: { kind: ChangeKind; parentRecordId: string; successorRecordId: string; start: string; timezone: string; documentFileId: string; documentVersionNo: number; proposedEnd?: string | null; responsibleUserId?: string | null; decision?: RenewalDecision }) {
    const parent = await this.contractRecord(tx, ctx, command.parentRecordId, true);
    const successor = await this.contractRecord(tx, ctx, command.successorRecordId, true);
    await this.raw(tx, ctx, parent.id, "edit", true);
    await this.raw(tx, ctx, parent.id, "link", true);
    await this.raw(tx, ctx, successor.id, "edit", true);
    await this.raw(tx, ctx, successor.id, "link", true);
    const access = await this.accessFor(tx, ctx, parent, successor);
    if (!access.canPropose) throw forbidden();
    const proposed = parseProposedEnd(command.proposedEnd);
    if (!proposed.ok) throw invalid(proposed.message);
    const decision = command.decision ?? "undecided";
    const responsibleUserId = command.responsibleUserId ?? null;
    const named = explicitRenewalDecision(decision, responsibleUserId);
    if (!named.ok) throw invalid(named.message);
    if (responsibleUserId) await this.member(tx, ctx, responsibleUserId);
    const instant = parseChangeInstant(command.start, command.timezone);
    if (!instant.ok) throw invalid(instant.message);
    await this.supportingDocument(tx, ctx, command.documentFileId, command.documentVersionNo, parent.id, successor.id);
    const edges = await tx.query<{ parent_record_id: string; successor_record_id: string }>("SELECT parent_record_id, successor_record_id FROM hs_contract_changes WHERE tenant_id=$1", [ctx.tenantId]);
    if (createsCycle(edges.rows.map((row) => ({ parentId: row.parent_record_id, successorId: row.successor_record_id })), parent.id, successor.id)) throw fail("That link would create a circular contract chain.", "change_cycle");
    return { kind: command.kind, parent, successor, instant: instant.instant, proposedEnd: proposed.end, decision, responsibleUserId };
  }

  private async prepareTransition(tx: Sql, ctx: RecordContext, changeId: string, expectedVersion: number, to: ChangeStatus) {
    const loaded = await this.visibleChange(tx, ctx, changeId, true);
    if (Number(loaded.row.version) !== expectedVersion) throw fail("The contract change changed. Review it again.", "change_conflict");
    if (!statusStep(loaded.row.status, to)) throw fail("That status step is not available.", "change_status");
    if (to === "proposed" && !loaded.access.canPropose) throw forbidden();
    return loaded;
  }

  private async prepareApproval(tx: Sql, ctx: RecordContext, changeId: string, expectedVersion: number) {
    const loaded = await this.prepareTransition(tx, ctx, changeId, expectedVersion, "approved");
    if (!loaded.access.canApprove) throw forbidden();
    const policy = await this.policy(tx, ctx);
    const proposerId = loaded.row.proposed_by ?? loaded.row.entered_by;
    const review = approvalAllowed({ reviewRequired: policy.review_required, proposerId, approverId: ctx.actor.id });
    if (!review.ok) throw fail(review.message, "change_review", 403);
    return { ...loaded, policy };
  }

  private async prepareEffectuate(tx: Sql, ctx: RecordContext, changeId: string, expectedVersion: number) {
    const loaded = await this.prepareTransition(tx, ctx, changeId, expectedVersion, "effective");
    if (!loaded.access.canEffectuate) throw forbidden();
    const due = effectuateAllowed(loaded.row.status, new Date(loaded.row.effective_start), this.now());
    if (!due.ok) throw fail(due.message, due.code);
    return loaded;
  }

  private async prepareDecision(tx: Sql, ctx: RecordContext, changeId: string, expectedVersion: number, decision: RenewalDecision, responsibleUserId: string | null) {
    const loaded = await this.visibleChange(tx, ctx, changeId, true);
    if (Number(loaded.row.version) !== expectedVersion) throw fail("The contract change changed. Review the decision again.", "change_conflict");
    if (!loaded.access.canDecide) throw forbidden();
    const named = explicitRenewalDecision(decision, responsibleUserId);
    if (!named.ok) throw invalid(named.message);
    if (responsibleUserId) await this.member(tx, ctx, responsibleUserId);
    return loaded;
  }

  private async transition(tx: Sql, ctx: RecordContext, row: ChangeRow, status: ChangeStatus, assignments: string, values: unknown[]) {
    const shifted = assignments.replace(/\$(\d+)/g, (_match, index: string) => `$${Number(index) + 5}`);
    const updated = await tx.query<{ version: number }>(`UPDATE hs_contract_changes SET status=$3, ${shifted}, version=version+1 WHERE id=$1 AND tenant_id=$2 AND status=$4 AND version=$5 RETURNING version`, [row.id, ctx.tenantId, status, row.status, row.version, ...values]);
    if (!updated.rows.length) throw fail("The contract change changed. Review it again.", "change_conflict");
    return Number(updated.rows[0].version);
  }

  private async present(tx: Sql, ctx: RecordContext, row: ChangeRow, parent: Stored, successor: Stored, forHistory: boolean) {
    const fields = await this.fields(tx, ctx, "contracts");
    const snapshot = jsonObject(row.parent_terms);
    const original = await this.visibleTerms(tx, ctx, jsonObject(snapshot.values), fields, forHistory);
    const current = await this.visibleTerms(tx, ctx, jsonObject(parent.field_values), fields, forHistory);
    const originalEnd = day(original.values["core:end-date"]);
    const currentEnd = day(current.values["core:end-date"]);
    const effectiveStart = iso(row.effective_start);
    const endDate = row.kind === "renewal" || row.kind === "extension" ? { id: row.id, parentId: parent.id, parentName: parent.name, successorId: successor.id, successorName: successor.name, ...renewalDecisionView({ kind: row.kind, status: row.status, decision: row.decision, responsibleUserId: row.responsible_user_id, originalEnd, currentEnd, proposedEnd: row.proposed_end, effectiveStart }) } : null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      parentId: parent.id,
      parentName: parent.name,
      successorId: successor.id,
      successorName: successor.name,
      effectiveStart,
      enteredAt: iso(row.entered_at),
      proposedAt: iso(row.proposed_at),
      approvedAt: iso(row.approved_at),
      effectiveAt: iso(row.effective_at),
      version: Number(row.version),
      decision: row.decision,
      responsibleUserId: row.responsible_user_id,
      legalCommitment: false as const,
      commitsRenewal: false as const,
      originalTerms: { name: typeof snapshot.name === "string" ? snapshot.name : parent.name, values: original.values, redacted: original.redacted, preserved: true as const },
      document: { fileId: row.document_file_id, versionNo: Number(row.document_version_no), history: numberList(row.document_history), pinned: true as const },
      endDate,
    };
  }

  private matches(query: string, change: { parentName: string; successorName: string; originalTerms: { name: string; values: Record<string, unknown> } }) {
    const haystack = `${change.parentName} ${change.successorName} ${change.originalTerms.name} ${stableStringify(change.originalTerms.values)}`.toLowerCase();
    return haystack.includes(query);
  }

  private async visibleTerms(tx: Sql, ctx: RecordContext, values: Record<string, unknown>, fields: RecordField[], forHistory: boolean) {
    const shown = await this.filtered(tx, ctx, "contracts", values, fields, forHistory ? {} : undefined);
    return { values: shown, redacted: Object.keys(values).some((key) => !Object.hasOwn(shown, key)) };
  }

  private async visibleChange(tx: Sql, ctx: RecordContext, changeId: string, lock: boolean) {
    const row = await this.changeFor(tx, ctx.tenantId, changeId, lock);
    let parent: Stored;
    let successor: Stored;
    try {
      parent = await this.raw(tx, ctx, row.parent_record_id, "view");
      successor = await this.raw(tx, ctx, row.successor_record_id, "view");
    } catch (error) {
      if (hiddenError(error)) throw missing();
      throw error;
    }
    if (parent.collection !== "contracts" || successor.collection !== "contracts") throw missing();
    return { row, parent, successor, access: await this.accessFor(tx, ctx, parent, successor) };
  }

  private async accessFor(tx: Sql, ctx: RecordContext, parent: Stored, successor: Stored) {
    const parentCaps = await this.caps(tx, ctx, parent);
    const successorCaps = await this.caps(tx, ctx, successor);
    const shared = parentCaps.filter((capability) => successorCaps.includes(capability));
    const assignment = await this.assignment(tx, ctx, ctx.actor.id);
    return contractChangeAccess({ recordCapabilities: shared, assignment: assignment ? this.assignmentFlags(assignment) : null, canViewRecords: true });
  }

  private assignmentFlags(row: AssignmentRow) {
    return { canPropose: row.can_propose, canApprove: row.can_approve, canEffectuate: row.can_effectuate, canDecide: row.can_decide };
  }

  private async contractRecord(tx: Sql, ctx: RecordContext, recordId: string, active: boolean) {
    if (!uuid.safeParse(recordId).success) throw missing();
    const located = (await tx.query<{ tenant_id: string; collection: string }>("SELECT tenant_id, collection FROM hs_data_records WHERE id=$1", [recordId])).rows[0];
    if (located && located.tenant_id !== ctx.tenantId) throw fail("That contract is not available in this tenant.", "change_cross_tenant", 404);
    if (located && located.collection !== "contracts") throw invalid("Choose a contract record.");
    const record = await this.raw(tx, ctx, recordId, "view", active);
    if (record.collection !== "contracts") throw invalid("Choose a contract record.");
    return record;
  }

  private async supportingDocument(tx: Sql, ctx: RecordContext, fileId: string, versionNo: number, parentId: string, successorId: string) {
    const file = (await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM hs_linked_files WHERE id=$1", [fileId])).rows[0];
    if (file && file.tenant_id !== ctx.tenantId) throw fail("That document is not available in this tenant.", "change_cross_tenant", 404);
    if (!file) throw missing();
    const versions = await tx.query<{ version_no: number }>("SELECT version_no FROM hs_attachment_versions WHERE tenant_id=$1 AND file_id=$2 AND deleted_at IS NULL ORDER BY version_no", [ctx.tenantId, fileId]);
    const history = versions.rows.map((row) => Number(row.version_no));
    if (!history.includes(versionNo)) throw invalid("Choose a retained document version.");
    const linked = await tx.query("SELECT id FROM hs_document_record_links WHERE tenant_id=$1 AND workspace_id=$2 AND doc_type='file' AND doc_id=$3 AND record_id = ANY($4::uuid[])", [ctx.tenantId, ctx.workspaceId, fileId, [parentId, successorId]]);
    if (!linked.rows.length) throw invalid("Link the supporting document to the original or the successor contract first.");
    return history;
  }

  private async member(tx: Sql, ctx: RecordContext, memberId: string) {
    const member = await tx.query("SELECT user_id FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [ctx.workspaceId, memberId]);
    if (!member.rows.length) throw invalid("Choose a workspace member. Assignment does not grant access.");
  }

  private async policy(tx: Sql, ctx: RecordContext, lock = false): Promise<PolicyRow & { stored: boolean }> {
    const rows = await tx.query<PolicyRow>(`SELECT review_required, version FROM hs_contract_change_policies WHERE tenant_id=$1${lock ? " FOR UPDATE" : ""}`, [ctx.tenantId]);
    return rows.rows[0] ? { ...rows.rows[0], review_required: Boolean(rows.rows[0].review_required), version: Number(rows.rows[0].version), stored: true } : { review_required: true, version: 0, stored: false };
  }

  private async policyView(tx: Sql, ctx: RecordContext) {
    const policy = await this.policy(tx, ctx);
    return { reviewRequired: policy.review_required, version: policy.version, accessGranted: false as const };
  }

  private async assignment(tx: Sql, ctx: RecordContext, memberId: string, lock = false) {
    const rows = await tx.query<AssignmentRow>(`SELECT user_id, can_propose, can_approve, can_effectuate, can_decide, version FROM hs_contract_change_assignments WHERE tenant_id=$1 AND user_id=$2${lock ? " FOR UPDATE" : ""}`, [ctx.tenantId, memberId]);
    const row = rows.rows[0];
    return row ? { ...row, version: Number(row.version) } : null;
  }

  private async assignmentViews(tx: Sql, ctx: RecordContext) {
    const rows = await tx.query<AssignmentRow>("SELECT user_id, can_propose, can_approve, can_effectuate, can_decide, version FROM hs_contract_change_assignments WHERE tenant_id=$1 ORDER BY user_id", [ctx.tenantId]);
    return rows.rows.map((row) => ({ userId: row.user_id, canPropose: row.can_propose, canApprove: row.can_approve, canEffectuate: row.can_effectuate, canDecide: row.can_decide, version: Number(row.version), accessGranted: false as const }));
  }

  private async visibleDrafts(tx: Sql, ctx: RecordContext) {
    const rows = await tx.query<DraftRow>("SELECT id, kind, parent_record_id, successor_record_id, effective_start, proposed_end, timezone, document_file_id, document_version_no, responsible_user_id, decision, version, state FROM hs_contract_change_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND state='open' ORDER BY updated_at DESC, id LIMIT 25", [ctx.tenantId, ctx.workspaceId, ctx.actor.id]);
    const shown = [];
    for (const row of rows.rows) {
      try {
        await this.raw(tx, ctx, row.parent_record_id, "view");
        await this.raw(tx, ctx, row.successor_record_id, "view");
      } catch (error) {
        if (hiddenError(error)) continue;
        throw error;
      }
      shown.push({ id: row.id, kind: row.kind, parentRecordId: row.parent_record_id, successorRecordId: row.successor_record_id, start: row.effective_start, proposedEnd: row.proposed_end, timezone: row.timezone, documentFileId: row.document_file_id, documentVersionNo: Number(row.document_version_no), responsibleUserId: row.responsible_user_id, decision: row.decision, version: Number(row.version), state: row.state });
    }
    return shown;
  }

  private async changeFor(tx: Sql, tenantId: string, changeId: string, lock: boolean) {
    const rows = await tx.query<ChangeRow>(`SELECT ${changeColumns} FROM hs_contract_changes WHERE id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [changeId, tenantId]);
    const row = rows.rows[0];
    if (!row) throw missing();
    return row;
  }

  private async event(tx: Sql, ctx: RecordContext, changeId: string, version: number, kind: string, status: ChangeStatus, decision: RenewalDecision | null, responsibleUserId: string | null, operationId: string) {
    await tx.query("INSERT INTO hs_contract_change_events(tenant_id,change_id,event_version,kind,status,decision,responsible_user_id,actor_id,operation_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'holy-sheet')", [ctx.tenantId, changeId, version, kind, status, decision, responsibleUserId, ctx.actor.id, operationId]);
  }

  private async seen(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string): Promise<Effect | null> {
    const prior = (await tx.query<{ request_hash: string; result: unknown; applied_version: number }>("SELECT request_hash, result, applied_version FROM hs_contract_change_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, operationId])).rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash) throw fail("Operation identity was reused.", "operation_mismatch");
    return { ...jsonObject(prior.result), appliedVersion: Number(prior.applied_version), replayed: true, ...flags };
  }

  private async finish(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string, changeId: string | null, version: number, kind: string, result: Record<string, unknown>) {
    await tx.query("INSERT INTO hs_contract_change_operations(tenant_id,actor_id,operation_id,request_hash,kind,change_id,applied_version,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [ctx.tenantId, ctx.actor.id, operationId, requestHash, kind, changeId, version, JSON.stringify(result)]);
  }

  private async audit(tx: Sql, ctx: RecordContext, operationId: string, action: string, extra: Record<string, unknown>) {
    await tx.query("INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ctx.actor.id, action, JSON.stringify({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, actorId: ctx.actor.id, source: "holy-sheet", operation: action, at: this.now().toISOString(), atIst: formatIst(this.now()), accessGranted: false, legalCommitment: false, ...extra }), operationId]);
  }
}
