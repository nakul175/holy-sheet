import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "./database";
import { DocumentError, stableStringify } from "./document";
import {
  covers,
  effectiveAccess,
  effectiveCalculation,
  isEligibleEffectiveKind,
  overlaps,
  parseAsOf,
  parseCorrectionReason,
  parseEffectiveWindow,
  rangeOf,
  resolveAsOf,
  type AsOfInterval,
  type BlockedCode,
  type EffectiveAssignment,
  type IntervalState,
} from "./effective-dates";
import { formatIst } from "./ist-label";
import { SharedRecordRepository, type CurrentSuiteTenantAuthority, type RecordContext, type RecordValueAuthority, type Stored } from "./shared-records";
import { recordHash, typedRecordValue, type RecordCapability, type RecordField } from "./shared-record-types";

const uuid = z.string().uuid();
const collectionName = z.string().min(1).max(100);
const fieldKey = z.string().regex(/^(core:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
const instantText = z.string().min(16).max(40);
const flags = { accessGranted: false as const, liveActivation: false as const, schedule: "paused" as const };
const confirms = ["configure-effective-field", "assign-effective-access", "propose-effective-value", "activate-effective-value", "cancel-effective-value"] as const;

const previewInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), collection: collectionName, fieldKey, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("assign"), collection: collectionName, userId: z.string().min(1).max(200), canPropose: z.boolean(), canCorrect: z.boolean(), canActivate: z.boolean(), canCancel: z.boolean() }).strict(),
  z.object({ action: z.literal("propose"), collection: collectionName, recordId: uuid, fieldKey, value: z.unknown(), start: instantText, end: instantText.nullable(), timezone: z.string().min(1).max(100), reason: z.string().max(500).optional(), expectedRecordVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("activate"), collection: collectionName, recordId: uuid, intervalId: uuid, expectedRecordVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("cancel"), collection: collectionName, recordId: uuid, intervalId: uuid, reason: z.string().max(500).optional(), expectedRecordVersion: z.number().int().positive() }).strict(),
]);
const confirmInput = z.object({ operationId: uuid, previewId: uuid, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.enum(confirms) }).strict();
const draftInput = z.object({
  draftId: uuid,
  collection: collectionName,
  recordId: uuid,
  fieldKey,
  value: z.unknown(),
  start: z.string().max(40),
  end: z.string().max(40).nullable(),
  timezone: z.string().max(100),
  reason: z.string().max(500).optional(),
  operationId: uuid,
  expectedVersion: z.number().int().nonnegative(),
}).strict();
const discardInput = z.object({ draftId: uuid, collection: collectionName, operationId: uuid, expectedVersion: z.number().int().positive() }).strict();

type PolicyRow = { field_key: string; enabled: boolean; version: number };
type AssignmentRow = { user_id: string; can_propose: boolean; can_correct: boolean; can_activate: boolean; can_cancel: boolean; version: number };
type IntervalRow = {
  id: string;
  record_id: string;
  collection: string;
  field_key: string;
  value: unknown;
  effective_start: string | Date;
  effective_end: string | Date | null;
  timezone: string;
  state: IntervalState;
  reason: string;
  blocked_code: BlockedCode | null;
  version: number;
  entered_at: string | Date;
  activated_at: string | Date | null;
  cancelled_at: string | Date | null;
};
type DraftRow = { id: string; record_id: string; field_key: string; value: unknown; effective_start: string; effective_end: string | null; timezone: string; reason: string; version: number; state: "open" | "discarded" };
type PreviewRow = { id: string; collection: string; action: string; confirm: (typeof confirms)[number]; payload: unknown; review_hash: string; authority_revision: string; expires_at: string | Date };
type Effect = Record<string, unknown> & { appliedVersion?: number; replayed?: boolean };

const fail = (message: string, code = "effective_conflict", status = 409) => new DocumentError(message, code, status);
const missing = () => fail("Effective-dated information is unavailable.", "effective_unavailable", 404);
const forbidden = (message = "This effective-date action is not permitted.") => fail(message, "effective_forbidden", 403);
const invalid = (message = "Review the effective-date request.") => fail(message, "effective_invalid", 400);

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
function canonicalKey(value: string) {
  return value.toLowerCase();
}
function sameJson(left: unknown, right: unknown) {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

export class EffectiveDateRepository extends SharedRecordRepository {
  constructor(pages: ConstructorParameters<typeof SharedRecordRepository>[0], authority: CurrentSuiteTenantAuthority, valueAuthority?: RecordValueAuthority, private readonly clock: () => Date = () => new Date()) {
    super(pages, authority, valueAuthority);
  }

  private now() { return this.clock(); }

  async listEffective(ctx: RecordContext, input: { collection: string; query?: string; recordId?: string; fieldKey?: string; asOf?: string }) {
    const parsed = z.object({ collection: collectionName, query: z.string().max(100).optional(), recordId: uuid.optional(), fieldKey: fieldKey.optional(), asOf: instantText.optional() }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the effective-date search.");
    const asOf = parsed.data.asOf ? parseAsOf(parsed.data.asOf) : null;
    if (parsed.data.asOf && !asOf) throw invalid("Enter an as-of time with an explicit offset.");
    return this.transaction(ctx, async (tx) => {
      const capabilities = await this.collectionCaps(tx, ctx, parsed.data.collection);
      const query = parsed.data.query?.trim().toLowerCase() ?? "";
      const policies = capabilities.includes("view") || capabilities.includes("manage-effective-dates") ? await this.policyViews(tx, ctx, parsed.data.collection, query) : [];
      const assignments = capabilities.includes("manage-effective-dates") ? await this.assignmentViews(tx, ctx, parsed.data.collection) : [];
      const intervals = await this.visibleIntervals(tx, ctx, parsed.data.collection, capabilities, parsed.data.recordId, parsed.data.fieldKey ? canonicalKey(parsed.data.fieldKey) : undefined, query);
      const drafts = await this.visibleDrafts(tx, ctx, parsed.data.collection);
      const resolved = asOf && parsed.data.recordId && parsed.data.fieldKey ? await this.readAsOf(tx, ctx, parsed.data.collection, parsed.data.recordId, canonicalKey(parsed.data.fieldKey), asOf, true) : null;
      return { policies, assignments, intervals, drafts, asOf: resolved, ...flags };
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
      await tx.query("INSERT INTO hs_effective_previews(id,tenant_id,workspace_id,actor_id,collection,action,confirm,payload,review_hash,authority_revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.collection, command.action, described.confirm, JSON.stringify(described.payload), reviewHash, proof.revision, expiresAt]);
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
      const preview = (await tx.query<PreviewRow>("SELECT id, collection, action, confirm, payload, review_hash, authority_revision, expires_at FROM hs_effective_previews WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4", [command.previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
      if (!preview || new Date(preview.expires_at).getTime() <= this.now().getTime()) throw fail("Review the effective-date action again.", "review_expired");
      if (preview.review_hash !== command.reviewHash || preview.confirm !== command.confirm || preview.authority_revision !== proof.revision) throw fail("Confirm the reviewed effective-date action.", "review_unconfirmed");
      const payload = jsonValue(preview.payload);
      const result = await this.apply(tx, ctx, command.operationId, preview.confirm, payload);
      await this.finish(tx, ctx, command.operationId, requestHash, result.recordId ?? null, result.appliedVersion ?? 1, preview.action, result);
      return { ...result, replayed: false, ...flags };
    });
  }

  async saveDraft(ctx: RecordContext, input: z.input<typeof draftInput>) {
    const parsed = draftInput.safeParse(input);
    if (!parsed.success) throw invalid("Review the draft.");
    const command = parsed.data;
    const requestHash = recordHash({ kind: "draft", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const record = await this.raw(tx, ctx, command.recordId, "edit", true);
      if (record.collection !== command.collection) throw missing();
      const key = canonicalKey(command.fieldKey);
      const field = await this.fieldFor(tx, ctx, command.collection, key);
      const access = await this.accessFor(tx, ctx, command.collection, field);
      if (!access.canPropose && !access.canCorrect) throw forbidden();
      if (Buffer.byteLength(stableStringify(command.value ?? null)) > 20000) throw invalid("The draft value is too large.");
      const existing = (await tx.query<DraftRow>("SELECT id, record_id, field_key, value, effective_start, effective_end, timezone, reason, version, state FROM hs_effective_drafts WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 FOR UPDATE", [command.draftId, ctx.tenantId, ctx.actor.id])).rows[0];
      if (command.expectedVersion === 0) {
        if (existing) throw fail("This draft already exists.", "effective_conflict");
        await tx.query("INSERT INTO hs_effective_drafts(id,tenant_id,workspace_id,actor_id,record_id,collection,field_key,value,effective_start,effective_end,timezone,reason,version,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,'open')", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.recordId, command.collection, key, JSON.stringify(command.value ?? null), command.start, command.end, command.timezone, command.reason ?? ""]);
      } else {
        if (!existing || existing.state !== "open" || Number(existing.version) !== command.expectedVersion) throw fail("Refresh the draft and try again.", "effective_conflict");
        const updated = await tx.query("UPDATE hs_effective_drafts SET value=$4, effective_start=$5, effective_end=$6, timezone=$7, reason=$8, version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$3 RETURNING version", [command.draftId, ctx.tenantId, command.expectedVersion, JSON.stringify(command.value ?? null), command.start, command.end, command.timezone, command.reason ?? ""]);
        if (!updated.rows.length) throw fail("Refresh the draft and try again.", "effective_conflict");
      }
      const version = command.expectedVersion + 1;
      const result = { draftId: command.draftId, version, recordId: command.recordId, appliedVersion: version };
      await this.audit(tx, ctx, command.operationId, "effective.draft", { recordId: command.recordId, fieldKey: key, draftId: command.draftId, version });
      await this.finish(tx, ctx, command.operationId, requestHash, command.recordId, version, "draft", result);
      return { ...result, replayed: false, ...flags };
    });
  }

  async discardDraft(ctx: RecordContext, input: z.input<typeof discardInput>) {
    const parsed = discardInput.safeParse(input);
    if (!parsed.success) throw invalid("Review the draft.");
    const command = parsed.data;
    const requestHash = recordHash({ kind: "discard", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const existing = (await tx.query<DraftRow & { collection: string }>("SELECT id, record_id, collection, field_key, value, effective_start, effective_end, timezone, reason, version, state FROM hs_effective_drafts WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 FOR UPDATE", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
      if (!existing || existing.collection !== command.collection) throw missing();
      await this.raw(tx, ctx, existing.record_id, "edit", true);
      if (existing.state !== "open" || Number(existing.version) !== command.expectedVersion) throw fail("Refresh the draft and try again.", "effective_conflict");
      await tx.query("UPDATE hs_effective_drafts SET state='discarded', version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$3", [command.draftId, ctx.tenantId, command.expectedVersion]);
      const result = { draftId: command.draftId, state: "discarded" as const, version: command.expectedVersion + 1, recordId: existing.record_id, appliedVersion: command.expectedVersion + 1 };
      await this.audit(tx, ctx, command.operationId, "effective.discard", { recordId: existing.record_id, fieldKey: existing.field_key, draftId: command.draftId });
      await this.finish(tx, ctx, command.operationId, requestHash, existing.record_id, result.version, "discard", result);
      return { ...result, replayed: false, ...flags };
    });
  }

  async intervalHistory(ctx: RecordContext, input: { collection: string; recordId: string; fieldKey: string }) {
    const parsed = z.object({ collection: collectionName, recordId: uuid, fieldKey }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the effective-date history.");
    const key = canonicalKey(parsed.data.fieldKey);
    return this.transaction(ctx, async (tx) => {
      const record = await this.raw(tx, ctx, parsed.data.recordId, "history");
      if (record.collection !== parsed.data.collection) throw missing();
      const field = await this.fieldFor(tx, ctx, parsed.data.collection, key);
      const access = await this.accessFor(tx, ctx, parsed.data.collection, field);
      if (!access.canHistory) throw forbidden();
      const rows = await this.intervalRows(tx, ctx.tenantId, parsed.data.recordId, key);
      return { recordId: parsed.data.recordId, fieldKey: key, intervals: rows.map((row) => this.present(row, true)), ...flags };
    });
  }

  async download(ctx: RecordContext, input: { collection: string; recordId: string; fieldKey: string; asOf: string }) {
    const parsed = z.object({ collection: collectionName, recordId: uuid, fieldKey, asOf: instantText }).strict().safeParse(input);
    if (!parsed.success) throw invalid("Review the effective-date download.");
    const asOf = parseAsOf(parsed.data.asOf);
    if (!asOf) throw invalid("Enter an as-of time with an explicit offset.");
    const key = canonicalKey(parsed.data.fieldKey);
    return this.transaction(ctx, async (tx) => {
      const record = await this.raw(tx, ctx, parsed.data.recordId, "export");
      if (record.collection !== parsed.data.collection) throw missing();
      const field = await this.fieldFor(tx, ctx, parsed.data.collection, key);
      const access = await this.accessFor(tx, ctx, parsed.data.collection, field);
      if (!access.canView) throw missing();
      if (!access.canExport) throw forbidden();
      const resolved = await this.readAsOf(tx, ctx, parsed.data.collection, parsed.data.recordId, key, asOf, false);
      const body = { source: "holy-sheet", accessGranted: false, liveActivation: false, schedule: "paused", collection: parsed.data.collection, recordId: parsed.data.recordId, fieldKey: key, ...resolved };
      return { filename: "effective-dates-as-of.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from(JSON.stringify(body), "utf8") };
    });
  }

  private async describe(tx: Sql, ctx: RecordContext, command: z.infer<typeof previewInput>) {
    if (command.action === "configure") {
      const field = await this.fieldFor(tx, ctx, command.collection, canonicalKey(command.fieldKey));
      if (!isEligibleEffectiveKind(field.kind) || field.deprecated) throw invalid("Effective dates apply to selected scalar and reference fields that are still available.");
      const access = await this.accessFor(tx, ctx, command.collection, field);
      if (!access.canConfigure) throw forbidden();
      const current = await this.policy(tx, ctx, command.collection, field.key);
      return { confirm: "configure-effective-field" as const, impact: "This versions the effective-date setting for one field. It does not grant record access or change stored values.", payload: { action: "configure", collection: command.collection, fieldKey: field.key, enabled: command.enabled, expectedVersion: current?.version ?? 0 } };
    }
    if (command.action === "assign") {
      const capabilities = await this.collectionCaps(tx, ctx, command.collection);
      if (!capabilities.includes("manage-effective-dates")) throw forbidden();
      const member = await tx.query("SELECT user_id FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [ctx.workspaceId, command.userId]);
      if (!member.rows.length) throw invalid("Choose a workspace member. Assignment does not grant access.");
      const current = await this.assignment(tx, ctx, command.collection, command.userId);
      return { confirm: "assign-effective-access" as const, impact: "This assignment does not grant record, field, or collection access. The person still needs those permissions separately.", payload: { action: "assign", collection: command.collection, userId: command.userId, canPropose: command.canPropose, canCorrect: command.canCorrect, canActivate: command.canActivate, canCancel: command.canCancel, expectedVersion: current?.version ?? 0 } };
    }
    if (command.action === "propose") {
      const prepared = await this.prepareProposal(tx, ctx, command);
      const when = prepared.window.backdated ? "This start is before the transaction time, so it is a backdated correction." : "This start is not before the transaction time.";
      return { confirm: "propose-effective-value" as const, impact: `The interval is half-open in ${prepared.window.timezone}: it includes the start and excludes the end. ${when} Entered time and effective time stay separate. Nothing runs on a schedule.`, payload: { action: "propose", collection: command.collection, recordId: command.recordId, fieldKey: prepared.field.key, value: prepared.value, start: command.start, end: command.end, timezone: command.timezone, reason: prepared.reason, expectedRecordVersion: command.expectedRecordVersion } };
    }
    if (command.action === "activate") {
      const loaded = await this.prepareActivation(tx, ctx, command.collection, command.recordId, command.intervalId, command.expectedRecordVersion);
      return { confirm: "activate-effective-value" as const, impact: "Activation checks the field, target, and your rights again. An invalid target or schema is saved as blocked and does not change the current value. No schedule runs this.", payload: { action: "activate", collection: command.collection, recordId: command.recordId, intervalId: loaded.row.id, expectedIntervalVersion: Number(loaded.row.version), expectedRecordVersion: command.expectedRecordVersion } };
    }
    const loaded = await this.prepareCancel(tx, ctx, command);
    return { confirm: "cancel-effective-value" as const, impact: "Cancellation keeps the interval for history and leaves every other interval unchanged. Entered time stays the original transaction time.", payload: { action: "cancel", collection: command.collection, recordId: command.recordId, intervalId: loaded.row.id, reason: loaded.reason, expectedIntervalVersion: Number(loaded.row.version), expectedRecordVersion: command.expectedRecordVersion } };
  }

  private async apply(tx: Sql, ctx: RecordContext, operationId: string, confirm: (typeof confirms)[number], payload: unknown): Promise<Effect & { recordId?: string; appliedVersion?: number }> {
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (confirm === "configure-effective-field") return this.applyConfigure(tx, ctx, operationId, body);
    if (confirm === "assign-effective-access") return this.applyAssign(tx, ctx, operationId, body);
    if (confirm === "propose-effective-value") return this.applyPropose(tx, ctx, operationId, body);
    if (confirm === "activate-effective-value") return this.applyActivate(tx, ctx, operationId, body);
    return this.applyCancel(tx, ctx, operationId, body);
  }

  private async applyConfigure(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("configure"), collection: collectionName, fieldKey, enabled: z.boolean(), expectedVersion: z.number().int().nonnegative() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const key = canonicalKey(parsed.data.fieldKey);
    const field = await this.fieldFor(tx, ctx, parsed.data.collection, key);
    if (!isEligibleEffectiveKind(field.kind) || field.deprecated) throw invalid("Effective dates apply to selected scalar and reference fields that are still available.");
    const access = await this.accessFor(tx, ctx, parsed.data.collection, field);
    if (!access.canConfigure) throw forbidden();
    const current = await this.policy(tx, ctx, parsed.data.collection, key, true);
    if ((current?.version ?? 0) !== parsed.data.expectedVersion) throw fail("The effective-date setting changed. Review it again.", "effective_conflict");
    if (current && current.enabled === parsed.data.enabled) {
      await this.audit(tx, ctx, operationId, "effective.configure", { collection: parsed.data.collection, fieldKey: key, enabled: current.enabled, version: current.version, unchanged: true });
      return { collection: parsed.data.collection, fieldKey: key, enabled: current.enabled, version: current.version, unchanged: true, appliedVersion: current.version };
    }
    const version = parsed.data.expectedVersion + 1;
    if (!current) await tx.query("INSERT INTO hs_effective_field_policies(tenant_id,collection,field_key,enabled,version,updated_by) VALUES($1,$2,$3,$4,1,$5)", [ctx.tenantId, parsed.data.collection, key, parsed.data.enabled, ctx.actor.id]);
    else {
      const updated = await tx.query("UPDATE hs_effective_field_policies SET enabled=$4, version=version+1, updated_by=$5, updated_at=clock_timestamp() WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND version=$6 RETURNING version", [ctx.tenantId, parsed.data.collection, key, parsed.data.enabled, ctx.actor.id, parsed.data.expectedVersion]);
      if (!updated.rows.length) throw fail("The effective-date setting changed. Review it again.", "effective_conflict");
    }
    await tx.query("INSERT INTO hs_effective_field_policy_versions(tenant_id,collection,field_key,version,enabled,actor_id,operation_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,'holy-sheet')", [ctx.tenantId, parsed.data.collection, key, version, parsed.data.enabled, ctx.actor.id, operationId]);
    await this.audit(tx, ctx, operationId, "effective.configure", { collection: parsed.data.collection, fieldKey: key, enabled: parsed.data.enabled, version });
    return { collection: parsed.data.collection, fieldKey: key, enabled: parsed.data.enabled, version, unchanged: false, appliedVersion: version };
  }

  private async applyAssign(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("assign"), collection: collectionName, userId: z.string().min(1).max(200), canPropose: z.boolean(), canCorrect: z.boolean(), canActivate: z.boolean(), canCancel: z.boolean(), expectedVersion: z.number().int().nonnegative() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const capabilities = await this.collectionCaps(tx, ctx, parsed.data.collection);
    if (!capabilities.includes("manage-effective-dates")) throw forbidden();
    const member = await tx.query("SELECT user_id FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [ctx.workspaceId, parsed.data.userId]);
    if (!member.rows.length) throw invalid("Choose a workspace member. Assignment does not grant access.");
    const current = await this.assignment(tx, ctx, parsed.data.collection, parsed.data.userId, true);
    if ((current?.version ?? 0) !== parsed.data.expectedVersion) throw fail("The assignment changed. Review it again.", "effective_conflict");
    const version = parsed.data.expectedVersion + 1;
    if (!current) await tx.query("INSERT INTO hs_effective_assignments(tenant_id,collection,user_id,can_propose,can_correct,can_activate,can_cancel,version,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)", [ctx.tenantId, parsed.data.collection, parsed.data.userId, parsed.data.canPropose, parsed.data.canCorrect, parsed.data.canActivate, parsed.data.canCancel, ctx.actor.id]);
    else {
      const updated = await tx.query("UPDATE hs_effective_assignments SET can_propose=$4, can_correct=$5, can_activate=$6, can_cancel=$7, version=version+1, updated_by=$8, updated_at=clock_timestamp() WHERE tenant_id=$1 AND collection=$2 AND user_id=$3 AND version=$9 RETURNING version", [ctx.tenantId, parsed.data.collection, parsed.data.userId, parsed.data.canPropose, parsed.data.canCorrect, parsed.data.canActivate, parsed.data.canCancel, ctx.actor.id, parsed.data.expectedVersion]);
      if (!updated.rows.length) throw fail("The assignment changed. Review it again.", "effective_conflict");
    }
    await this.audit(tx, ctx, operationId, "effective.assign", { collection: parsed.data.collection, userId: parsed.data.userId, version, accessGranted: false });
    return { collection: parsed.data.collection, userId: parsed.data.userId, version, accessGranted: false as const, appliedVersion: version };
  }

  private async applyPropose(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("propose"), collection: collectionName, recordId: uuid, fieldKey, value: z.unknown(), start: instantText, end: instantText.nullable(), timezone: z.string().min(1).max(100), reason: z.string().max(500), expectedRecordVersion: z.number().int().positive() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const record = await this.raw(tx, ctx, parsed.data.recordId, "edit", true);
    if (record.collection !== parsed.data.collection || Number(record.version) !== parsed.data.expectedRecordVersion) throw fail("The record changed. Review the effective value again.", "record_version_conflict");
    const field = await this.fieldFor(tx, ctx, parsed.data.collection, canonicalKey(parsed.data.fieldKey));
    const window = parseEffectiveWindow({ start: parsed.data.start, end: parsed.data.end, timezone: parsed.data.timezone, now: this.now() });
    if (!window.ok) throw invalid(window.message);
    const reason = parseCorrectionReason(parsed.data.reason, window.window.backdated);
    if (!reason.ok) throw window.window.backdated ? invalid(reason.message) : invalid(reason.message);
    await this.assertProposalRights(tx, ctx, parsed.data.collection, field, window.window.backdated);
    const value = this.typed(field, parsed.data.value);
    if (!await this.targetsOk(tx, ctx, field, value, record.id)) throw invalid("The referenced record is unavailable.");
    await this.assertClear(tx, ctx.tenantId, record.id, field.key, rangeOf(window.window.start, window.window.end));
    const enteredAt = this.now().toISOString();
    const intervalId = randomUUID();
    await tx.query("INSERT INTO hs_effective_intervals(id,tenant_id,workspace_id,record_id,collection,field_key,value,effective_start,effective_end,timezone,state,reason,version,entered_at,entered_by,source,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,'holy-sheet',$15)", [intervalId, ctx.tenantId, ctx.workspaceId, record.id, parsed.data.collection, field.key, JSON.stringify(value), window.window.start.toISOString(), window.window.end?.toISOString() ?? null, window.window.timezone, window.window.state, reason.reason, enteredAt, ctx.actor.id, operationId]);
    let stored = record;
    if (window.window.state === "active") stored = await this.syncCurrent(tx, ctx, record, field, await this.fields(tx, ctx, parsed.data.collection), operationId);
    await this.audit(tx, ctx, operationId, "effective.propose", { recordId: record.id, fieldKey: field.key, intervalId, state: window.window.state, enteredAt, effectiveStart: window.window.start.toISOString(), effectiveEnd: window.window.end?.toISOString() ?? null, timezone: window.window.timezone, backdated: window.window.backdated });
    return { intervalId, state: window.window.state, enteredAt, effectiveStart: window.window.start.toISOString(), effectiveEnd: window.window.end?.toISOString() ?? null, timezone: window.window.timezone, recordId: record.id, recordVersion: Number(stored.version), appliedVersion: Number(stored.version) };
  }

  private async applyActivate(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("activate"), collection: collectionName, recordId: uuid, intervalId: uuid, expectedIntervalVersion: z.number().int().positive(), expectedRecordVersion: z.number().int().positive() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const record = await this.raw(tx, ctx, parsed.data.recordId, "edit", true);
    if (record.collection !== parsed.data.collection || Number(record.version) !== parsed.data.expectedRecordVersion) throw fail("The record changed. Review activation again.", "record_version_conflict");
    const row = await this.intervalFor(tx, ctx.tenantId, parsed.data.recordId, parsed.data.intervalId, true);
    if (Number(row.version) !== parsed.data.expectedIntervalVersion) throw fail("The effective interval changed. Review activation again.", "effective_conflict");
    if (row.state !== "scheduled") throw fail("Only a scheduled value can be activated.", "effective_state");
    const start = new Date(row.effective_start).getTime();
    const end = row.effective_end ? new Date(row.effective_end).getTime() : Number.POSITIVE_INFINITY;
    if (start > this.now().getTime()) throw fail("This value is not due yet.", "effective_not_due");
    const field = await this.fieldFor(tx, ctx, parsed.data.collection, row.field_key);
    const access = await this.accessFor(tx, ctx, parsed.data.collection, field);
    if (!access.canActivate) throw forbidden();
    const fields = await this.fields(tx, ctx, parsed.data.collection);
    const block = await this.blockReason(tx, ctx, record, field, fields, jsonValue(row.value));
    const checkedAt = this.now().toISOString();
    if (block) {
      await tx.query("UPDATE hs_effective_intervals SET state='blocked', blocked_code=$3, version=version+1 WHERE id=$1 AND tenant_id=$2 AND version=$4", [row.id, ctx.tenantId, block, row.version]);
      await this.audit(tx, ctx, operationId, "effective.block", { recordId: record.id, fieldKey: row.field_key, intervalId: row.id, state: "blocked", blockedCode: block, enteredAt: iso(row.entered_at), effectiveStart: iso(row.effective_start), effectiveEnd: iso(row.effective_end), checkedAt });
      return { intervalId: row.id, state: "blocked" as const, blockedCode: block, enteredAt: iso(row.entered_at), effectiveStart: iso(row.effective_start), effectiveEnd: iso(row.effective_end), recordId: record.id, recordVersion: Number(record.version), appliedVersion: Number(record.version) };
    }
    const state: IntervalState = this.now().getTime() < end ? "active" : "ended";
    await tx.query("UPDATE hs_effective_intervals SET state=$3, version=version+1, activated_at=$4 WHERE id=$1 AND tenant_id=$2 AND version=$5", [row.id, ctx.tenantId, state, checkedAt, row.version]);
    const stored = state === "active" ? await this.syncCurrent(tx, ctx, record, field, fields, operationId) : record;
    await this.audit(tx, ctx, operationId, "effective.activate", { recordId: record.id, fieldKey: row.field_key, intervalId: row.id, state, enteredAt: iso(row.entered_at), effectiveStart: iso(row.effective_start), effectiveEnd: iso(row.effective_end), activatedAt: checkedAt });
    return { intervalId: row.id, state, enteredAt: iso(row.entered_at), effectiveStart: iso(row.effective_start), effectiveEnd: iso(row.effective_end), activatedAt: checkedAt, recordId: record.id, recordVersion: Number(stored.version), appliedVersion: Number(stored.version) };
  }

  private async applyCancel(tx: Sql, ctx: RecordContext, operationId: string, body: Record<string, unknown>) {
    const parsed = z.object({ action: z.literal("cancel"), collection: collectionName, recordId: uuid, intervalId: uuid, reason: z.string().max(500), expectedIntervalVersion: z.number().int().positive(), expectedRecordVersion: z.number().int().positive() }).strict().safeParse(body);
    if (!parsed.success) throw invalid();
    const record = await this.raw(tx, ctx, parsed.data.recordId, "edit", true);
    if (record.collection !== parsed.data.collection || Number(record.version) !== parsed.data.expectedRecordVersion) throw fail("The record changed. Review cancellation again.", "record_version_conflict");
    const row = await this.intervalFor(tx, ctx.tenantId, parsed.data.recordId, parsed.data.intervalId, true);
    if (Number(row.version) !== parsed.data.expectedIntervalVersion) throw fail("The effective interval changed. Review cancellation again.", "effective_conflict");
    if (row.state === "cancelled") throw fail("This effective value is already cancelled.", "effective_state");
    const field = await this.fieldFor(tx, ctx, parsed.data.collection, row.field_key);
    const access = await this.accessFor(tx, ctx, parsed.data.collection, field);
    if (!access.canCancel) throw forbidden();
    const started = new Date(row.effective_start).getTime() < this.now().getTime();
    if (started && !access.canCorrect) throw forbidden("Cancelling an effective value that has already started needs the separate correction permission.");
    const reason = parseCorrectionReason(parsed.data.reason, started);
    if (!reason.ok) throw invalid(reason.message);
    const cancelledAt = this.now().toISOString();
    await tx.query("UPDATE hs_effective_intervals SET state='cancelled', reason=CASE WHEN $3='' THEN reason ELSE $3 END, version=version+1, cancelled_at=$4 WHERE id=$1 AND tenant_id=$2 AND version=$5", [row.id, ctx.tenantId, reason.reason, cancelledAt, row.version]);
    const fields = await this.fields(tx, ctx, parsed.data.collection);
    const stored = await this.syncCurrent(tx, ctx, record, field, fields, operationId);
    await this.audit(tx, ctx, operationId, "effective.cancel", { recordId: record.id, fieldKey: row.field_key, intervalId: row.id, state: "cancelled", enteredAt: iso(row.entered_at), effectiveStart: iso(row.effective_start), effectiveEnd: iso(row.effective_end), cancelledAt });
    return { intervalId: row.id, state: "cancelled" as const, enteredAt: iso(row.entered_at), effectiveStart: iso(row.effective_start), effectiveEnd: iso(row.effective_end), cancelledAt, recordId: record.id, recordVersion: Number(stored.version), appliedVersion: Number(stored.version) };
  }

  private async prepareProposal(tx: Sql, ctx: RecordContext, command: Extract<z.infer<typeof previewInput>, { action: "propose" }>) {
    const record = await this.raw(tx, ctx, command.recordId, "edit", true);
    if (record.collection !== command.collection || Number(record.version) !== command.expectedRecordVersion) throw fail("The record changed. Review the effective value again.", "record_version_conflict");
    const field = await this.fieldFor(tx, ctx, command.collection, canonicalKey(command.fieldKey));
    const window = parseEffectiveWindow({ start: command.start, end: command.end, timezone: command.timezone, now: this.now() });
    if (!window.ok) throw invalid(window.message);
    const reason = parseCorrectionReason(command.reason, window.window.backdated);
    if (!reason.ok) throw invalid(reason.message);
    await this.assertProposalRights(tx, ctx, command.collection, field, window.window.backdated);
    const enabled = await this.policy(tx, ctx, command.collection, field.key);
    if (!enabled?.enabled) throw fail("This field is not effective-dated.", "effective_not_configured");
    const value = this.typed(field, command.value);
    if (!await this.targetsOk(tx, ctx, field, value, record.id)) throw invalid("The referenced record is unavailable.");
    await this.assertClear(tx, ctx.tenantId, record.id, field.key, rangeOf(window.window.start, window.window.end));
    return { field, window: window.window, reason: reason.reason, value };
  }

  private async prepareActivation(tx: Sql, ctx: RecordContext, collection: string, recordId: string, intervalId: string, expectedRecordVersion: number) {
    const record = await this.raw(tx, ctx, recordId, "edit", true);
    if (record.collection !== collection || Number(record.version) !== expectedRecordVersion) throw fail("The record changed. Review activation again.", "record_version_conflict");
    const row = await this.intervalFor(tx, ctx.tenantId, recordId, intervalId, false);
    if (row.state !== "scheduled") throw fail("Only a scheduled value can be activated.", "effective_state");
    if (new Date(row.effective_start).getTime() > this.now().getTime()) throw fail("This value is not due yet.", "effective_not_due");
    const field = await this.fieldFor(tx, ctx, collection, row.field_key);
    const access = await this.accessFor(tx, ctx, collection, field);
    if (!access.canActivate) throw forbidden();
    return { row, field };
  }

  private async prepareCancel(tx: Sql, ctx: RecordContext, command: Extract<z.infer<typeof previewInput>, { action: "cancel" }>) {
    const record = await this.raw(tx, ctx, command.recordId, "edit", true);
    if (record.collection !== command.collection || Number(record.version) !== command.expectedRecordVersion) throw fail("The record changed. Review cancellation again.", "record_version_conflict");
    const row = await this.intervalFor(tx, ctx.tenantId, command.recordId, command.intervalId, false);
    if (row.state === "cancelled") throw fail("This effective value is already cancelled.", "effective_state");
    const field = await this.fieldFor(tx, ctx, command.collection, row.field_key);
    const access = await this.accessFor(tx, ctx, command.collection, field);
    if (!access.canCancel) throw forbidden();
    const started = new Date(row.effective_start).getTime() < this.now().getTime();
    if (started && !access.canCorrect) throw forbidden("Cancelling an effective value that has already started needs the separate correction permission.");
    const reason = parseCorrectionReason(command.reason, started);
    if (!reason.ok) throw invalid(reason.message);
    return { row, reason: reason.reason };
  }

  private async assertProposalRights(tx: Sql, ctx: RecordContext, collection: string, field: RecordField, backdated: boolean) {
    const enabled = await this.policy(tx, ctx, collection, field.key);
    if (!enabled?.enabled) throw fail("This field is not effective-dated.", "effective_not_configured");
    if (!isEligibleEffectiveKind(field.kind) || field.deprecated) throw invalid("Effective dates apply to selected scalar and reference fields that are still available.");
    const access = await this.accessFor(tx, ctx, collection, field);
    if (backdated) {
      if (!access.canCorrect) throw forbidden("Backdated correction needs the separate correction permission and a reason.");
      return;
    }
    if (!access.canPropose) throw forbidden();
  }

  private typed(field: RecordField, value: unknown) {
    try { return typedRecordValue(field, value); }
    catch (error) { if (error instanceof DocumentError) throw invalid(error.message); throw error; }
  }

  private async blockReason(tx: Sql, ctx: RecordContext, record: Stored, field: RecordField, fields: RecordField[], value: unknown): Promise<BlockedCode | null> {
    const policy = await this.policy(tx, ctx, record.collection, field.key);
    if (!policy?.enabled) return "config_disabled";
    const current = fields.find((item) => item.key === field.key);
    if (!current || current.deprecated || !isEligibleEffectiveKind(current.kind)) return "field_unavailable";
    const access = await this.accessFor(tx, ctx, record.collection, current);
    if (!access.canView || !current || !await this.fieldAllowed(tx, ctx, record.collection, current, "write")) return "rights_revoked";
    let typed: unknown;
    try { typed = typedRecordValue(current, value, { historical: true, previous: jsonObject(record.field_values)[current.key] }); }
    catch { return "schema_invalid"; }
    if (!await this.targetsOk(tx, ctx, current, typed, record.id)) return "target_invalid";
    const next = { ...jsonObject(record.field_values), [current.key]: typed };
    try { await this.validateUniqueCandidate(tx, ctx, record.collection, next, fields, record.id); }
    catch (error) { if (error instanceof DocumentError && error.code === "record_unique_conflict") return "schema_invalid"; throw error; }
    return null;
  }

  private async targetsOk(tx: Sql, ctx: RecordContext, field: RecordField, value: unknown, recordId: string) {
    if (field.kind !== "record") return true;
    if (!Array.isArray(value)) return false;
    for (const target of value) {
      if (typeof target !== "string" || target === recordId) return false;
      const row = (await tx.query<{ state: string }>("SELECT state FROM hs_data_records WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, target])).rows[0];
      if (!row || row.state !== "active") return false;
      try { await this.raw(tx, ctx, target, "view"); }
      catch (error) { if (error instanceof DocumentError && [403, 404].includes(error.status)) return false; throw error; }
    }
    return true;
  }

  private async assertClear(tx: Sql, tenantId: string, recordId: string, key: string, next: { start: number; end: number }) {
    const rows = await tx.query<IntervalRow>("SELECT id, effective_start, effective_end, state FROM hs_effective_intervals WHERE tenant_id=$1 AND record_id=$2 AND field_key=$3 AND state = ANY($4::text[])", [tenantId, recordId, key, ["scheduled", "active", "ended"]]);
    for (const row of rows.rows) {
      if (overlaps(next, rangeOf(row.effective_start, row.effective_end))) throw fail("That effective interval overlaps an existing value. Intervals are half-open and cannot conflict.", "effective_overlap");
    }
  }

  private async syncCurrent(tx: Sql, ctx: RecordContext, record: Stored, field: RecordField, fields: RecordField[], operationId: string) {
    const rows = await this.intervalRows(tx, ctx.tenantId, record.id, field.key);
    const now = this.now().getTime();
    const covering = rows.find((row) => row.state === "active" && covers(rangeOf(row.effective_start, row.effective_end), now));
    const current = jsonObject(record.field_values);
    const next = { ...current };
    if (covering) next[field.key] = jsonValue(covering.value);
    else delete next[field.key];
    const had = Object.hasOwn(current, field.key);
    const has = Object.hasOwn(next, field.key);
    if (had === has && sameJson(current[field.key], next[field.key])) return record;
    await this.validateUniqueCandidate(tx, ctx, record.collection, next, fields, record.id);
    const updatedAt = this.now().toISOString();
    const written = await tx.query<{ version: number }>("UPDATE hs_data_records SET field_values=$3::jsonb, version=version+1, updated_by=$4, updated_at=$5 WHERE tenant_id=$1 AND id=$2 AND version=$6 RETURNING version", [ctx.tenantId, record.id, JSON.stringify(next), ctx.actor.id, updatedAt, record.version]);
    if (!written.rows.length) throw fail("The record changed. Review the effective value again.", "record_version_conflict");
    const stored: Stored = { ...record, field_values: next, version: Number(written.rows[0].version), updated_by: ctx.actor.id, updated_at: updatedAt };
    await this.uniqueValues(tx, ctx, stored, fields);
    await this.emit(tx, ctx, stored, operationId, "effective-apply", record, fields);
    return stored;
  }

  private async readAsOf(tx: Sql, ctx: RecordContext, collection: string, recordId: string, key: string, asOf: Date, enforceView: boolean) {
    const record = await this.raw(tx, ctx, recordId, "view");
    if (record.collection !== collection) throw missing();
    const field = await this.fieldFor(tx, ctx, collection, key);
    const access = await this.accessFor(tx, ctx, collection, field);
    if (!access.canView) throw missing();
    if (enforceView && !access.canSearch) throw missing();
    const rows = (await this.intervalRows(tx, ctx.tenantId, recordId, key)).map((row) => this.asOfInterval(row));
    const resolved = resolveAsOf(rows, asOf.getTime());
    const value = resolved.state === "effective" ? resolved.value : null;
    return {
      asOf: asOf.toISOString(),
      state: resolved.state,
      value,
      enteredAt: resolved.interval?.enteredAt ?? null,
      effectiveStart: resolved.interval?.effectiveStart ?? null,
      effectiveEnd: resolved.interval?.effectiveEnd ?? null,
      timezone: resolved.interval?.timezone ?? null,
      calculation: effectiveCalculation(asOf.toISOString(), value, field.kind),
    };
  }

  private asOfInterval(row: IntervalRow): AsOfInterval {
    const range = rangeOf(row.effective_start, row.effective_end);
    return { id: row.id, start: range.start, end: range.end, state: row.state, value: jsonValue(row.value), enteredAt: iso(row.entered_at) ?? "", effectiveStart: iso(row.effective_start) ?? "", effectiveEnd: iso(row.effective_end), timezone: row.timezone };
  }

  private present(row: IntervalRow, includeValue: boolean) {
    return {
      id: row.id,
      recordId: row.record_id,
      fieldKey: row.field_key,
      state: row.state,
      ...(includeValue ? { value: jsonValue(row.value) } : {}),
      effectiveStart: iso(row.effective_start),
      effectiveEnd: iso(row.effective_end),
      timezone: row.timezone,
      enteredAt: iso(row.entered_at),
      activatedAt: iso(row.activated_at),
      cancelledAt: iso(row.cancelled_at),
      blockedCode: row.blocked_code,
      version: Number(row.version),
      halfOpen: true as const,
    };
  }

  private async visibleIntervals(tx: Sql, ctx: RecordContext, collection: string, capabilities: RecordCapability[], recordId: string | undefined, key: string | undefined, query: string) {
    if (recordId) {
      const record = await this.raw(tx, ctx, recordId, "view");
      if (record.collection !== collection) throw missing();
      if (query && !record.name.toLowerCase().includes(query)) return [];
      const rows = await tx.query<IntervalRow>("SELECT id, record_id, collection, field_key, value, effective_start, effective_end, timezone, state, reason, blocked_code, version, entered_at, activated_at, cancelled_at FROM hs_effective_intervals WHERE tenant_id=$1 AND record_id=$2 AND ($3::text IS NULL OR field_key=$3) ORDER BY effective_start, id LIMIT 50", [ctx.tenantId, recordId, key ?? null]);
      const shown = [];
      for (const row of rows.rows) {
        const field = (await this.fields(tx, ctx, collection)).find((item) => item.key === row.field_key);
        if (!field || !await this.fieldAllowed(tx, ctx, collection, field, "view")) continue;
        shown.push({ ...this.present(row, true), recordName: record.name });
      }
      return shown;
    }
    if (!capabilities.includes("view")) return [];
    const rows = await tx.query<IntervalRow>("SELECT id, record_id, collection, field_key, value, effective_start, effective_end, timezone, state, reason, blocked_code, version, entered_at, activated_at, cancelled_at FROM hs_effective_intervals WHERE tenant_id=$1 AND collection=$2 AND ($3::text IS NULL OR field_key=$3) ORDER BY entered_at DESC, id LIMIT 50", [ctx.tenantId, collection, key ?? null]);
    const shown = [];
    for (const row of rows.rows) {
      let record: Stored;
      try { record = await this.raw(tx, ctx, row.record_id, "view"); }
      catch (error) { if (error instanceof DocumentError && [403, 404].includes(error.status)) continue; throw error; }
      if (query && !record.name.toLowerCase().includes(query)) continue;
      const field = (await this.fields(tx, ctx, collection)).find((item) => item.key === row.field_key);
      if (!field || !await this.fieldAllowed(tx, ctx, collection, field, "view")) continue;
      shown.push({ ...this.present(row, true), recordName: record.name });
      if (shown.length >= 25) break;
    }
    return shown;
  }

  private async policyViews(tx: Sql, ctx: RecordContext, collection: string, query: string) {
    const fields = await this.fields(tx, ctx, collection);
    const policies = await tx.query<PolicyRow>("SELECT field_key, enabled, version FROM hs_effective_field_policies WHERE tenant_id=$1 AND collection=$2", [ctx.tenantId, collection]);
    const byKey = new Map(policies.rows.map((row) => [row.field_key, row]));
    return fields.filter((field) => isEligibleEffectiveKind(field.kind) && !field.deprecated && (!query || field.label.toLowerCase().includes(query) || field.key.includes(query))).map((field) => {
      const policy = byKey.get(field.key);
      return { fieldKey: field.key, label: field.label, kind: field.kind, enabled: policy?.enabled ?? false, version: policy ? Number(policy.version) : 0 };
    });
  }

  private async assignmentViews(tx: Sql, ctx: RecordContext, collection: string) {
    const rows = await tx.query<AssignmentRow>("SELECT user_id, can_propose, can_correct, can_activate, can_cancel, version FROM hs_effective_assignments WHERE tenant_id=$1 AND collection=$2 ORDER BY user_id", [ctx.tenantId, collection]);
    return rows.rows.map((row) => ({ userId: row.user_id, canPropose: row.can_propose, canCorrect: row.can_correct, canActivate: row.can_activate, canCancel: row.can_cancel, version: Number(row.version), accessGranted: false as const }));
  }

  private async visibleDrafts(tx: Sql, ctx: RecordContext, collection: string) {
    const rows = await tx.query<DraftRow>("SELECT id, record_id, field_key, value, effective_start, effective_end, timezone, reason, version, state FROM hs_effective_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND collection=$4 AND state='open' ORDER BY updated_at DESC, id LIMIT 25", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, collection]);
    const shown = [];
    for (const row of rows.rows) {
      try { await this.raw(tx, ctx, row.record_id, "view"); }
      catch (error) { if (error instanceof DocumentError && [403, 404].includes(error.status)) continue; throw error; }
      const field = (await this.fields(tx, ctx, collection)).find((item) => item.key === row.field_key);
      if (!field || !await this.fieldAllowed(tx, ctx, collection, field, "view")) continue;
      shown.push({ id: row.id, recordId: row.record_id, fieldKey: row.field_key, value: jsonValue(row.value), start: row.effective_start, end: row.effective_end, timezone: row.timezone, reason: row.reason, version: Number(row.version), state: row.state });
    }
    return shown;
  }

  private async accessFor(tx: Sql, ctx: RecordContext, collection: string, field: RecordField) {
    const capabilities = await this.collectionCaps(tx, ctx, collection);
    const assignment = await this.assignment(tx, ctx, collection, ctx.actor.id);
    const gate = { canView: await this.fieldAllowed(tx, ctx, collection, field, "view"), canWrite: await this.fieldAllowed(tx, ctx, collection, field, "write"), canHistory: await this.fieldAllowed(tx, ctx, collection, field, "history") };
    return effectiveAccess({ recordCapabilities: capabilities, field: gate, assignment: assignment ? { canPropose: assignment.can_propose, canCorrect: assignment.can_correct, canActivate: assignment.can_activate, canCancel: assignment.can_cancel } : null });
  }

  private async fieldFor(tx: Sql, ctx: RecordContext, collection: string, key: string) {
    await this.collectionCaps(tx, ctx, collection);
    const field = (await this.fields(tx, ctx, collection)).find((item) => item.key === key);
    if (!field) throw invalid("Choose a field on this collection.");
    return field;
  }

  private async policy(tx: Sql, ctx: RecordContext, collection: string, key: string, lock = false) {
    const rows = await tx.query<PolicyRow>(`SELECT field_key, enabled, version FROM hs_effective_field_policies WHERE tenant_id=$1 AND collection=$2 AND field_key=$3${lock ? " FOR UPDATE" : ""}`, [ctx.tenantId, collection, key]);
    return rows.rows[0] ?? null;
  }

  private async assignment(tx: Sql, ctx: RecordContext, collection: string, userId: string, lock = false) {
    const rows = await tx.query<AssignmentRow>(`SELECT user_id, can_propose, can_correct, can_activate, can_cancel, version FROM hs_effective_assignments WHERE tenant_id=$1 AND collection=$2 AND user_id=$3${lock ? " FOR UPDATE" : ""}`, [ctx.tenantId, collection, userId]);
    return rows.rows[0] ?? null;
  }

  private async intervalRows(tx: Sql, tenantId: string, recordId: string, key: string) {
    const rows = await tx.query<IntervalRow>("SELECT id, record_id, collection, field_key, value, effective_start, effective_end, timezone, state, reason, blocked_code, version, entered_at, activated_at, cancelled_at FROM hs_effective_intervals WHERE tenant_id=$1 AND record_id=$2 AND field_key=$3 ORDER BY effective_start, id", [tenantId, recordId, key]);
    return rows.rows;
  }

  private async intervalFor(tx: Sql, tenantId: string, recordId: string, intervalId: string, lock: boolean) {
    const rows = await tx.query<IntervalRow>(`SELECT id, record_id, collection, field_key, value, effective_start, effective_end, timezone, state, reason, blocked_code, version, entered_at, activated_at, cancelled_at FROM hs_effective_intervals WHERE id=$1 AND tenant_id=$2 AND record_id=$3${lock ? " FOR UPDATE" : ""}`, [intervalId, tenantId, recordId]);
    const row = rows.rows[0];
    if (!row) throw missing();
    return row;
  }

  private async seen(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string): Promise<Effect | null> {
    const prior = (await tx.query<{ request_hash: string; result: unknown; applied_version: number }>("SELECT request_hash, result, applied_version FROM hs_effective_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, operationId])).rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash) throw fail("Operation identity was reused.", "operation_mismatch");
    return { ...jsonObject(prior.result), appliedVersion: Number(prior.applied_version), replayed: true, ...flags };
  }

  private async finish(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string, recordId: string | null, version: number, kind: string, result: Record<string, unknown>) {
    await tx.query("INSERT INTO hs_effective_operations(tenant_id,actor_id,operation_id,request_hash,kind,record_id,applied_version,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [ctx.tenantId, ctx.actor.id, operationId, requestHash, kind, recordId, version, JSON.stringify(result)]);
  }

  private async audit(tx: Sql, ctx: RecordContext, operationId: string, action: string, extra: Record<string, unknown>) {
    await tx.query("INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ctx.actor.id, action, JSON.stringify({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, actorId: ctx.actor.id, source: "holy-sheet", operation: action, atIst: formatIst(this.now()), accessGranted: false, liveActivation: false, ...extra }), operationId]);
  }
}

export type { EffectiveAssignment };
