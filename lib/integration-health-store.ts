import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { identifierPayloadHasCredential } from "./external-identifier-mapping";
import {
  classifyCanonicalReference,
  classifyExtraReference,
  classifyObservedRecord,
  classifyRepair,
  classifyVisibleEvent,
  failureTransition,
  integrationHealthAccess,
  integrationPageBound,
  integrationScanWindow,
  mismatchClasses,
  nextBackoffSeconds,
  parseConsumerIdentity,
  parseFailureReport,
  parseObservations,
  queueAgeSeconds,
  referenceKey,
  replayAllowed,
  retryAllowed,
  type DeliveryState,
  type MismatchClass,
  type ObservedReference,
  type ObservedRecord,
} from "./integration-health";
import { formatIst } from "./ist-label";
import { SharedRecordRepository, type RecordContext } from "./shared-records";
import { recordHash, type RecordCapability } from "./shared-record-types";

const uuid = z.string().uuid();
const collectionName = z.string().min(1).max(100);
const flags = { credentialsStored: false as const, accessGranted: false as const, liveActivation: false as const, schedule: "paused" as const };
const confirms = ["register-paused-consumer", "retry-delivery", "replay-delivery", "repair-keep-canonical", "repair-queue-replay", "repair-reference", "repair-keep-isolated", "record-consumer-acknowledgement", "record-delivery-failure", "isolate-consumer", "release-consumer-isolation", "rename-integration-consumer"] as const;

const previewInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("register"), collection: collectionName, clientId: z.string().max(80), label: z.string().max(120) }).strict(),
  z.object({ action: z.literal("retry"), collection: collectionName, consumerId: uuid, deliveryId: uuid }).strict(),
  z.object({ action: z.literal("replay"), collection: collectionName, consumerId: uuid, eventId: uuid, mismatchId: uuid.optional() }).strict(),
  z.object({ action: z.literal("repair"), collection: collectionName, consumerId: uuid, mismatchId: uuid, decision: z.string().max(80) }).strict(),
  z.object({ action: z.literal("acknowledge"), collection: collectionName, consumerId: uuid, eventId: uuid }).strict(),
  z.object({ action: z.literal("record-failure"), collection: collectionName, consumerId: uuid, eventId: uuid, failureCode: z.string().max(40), failureDetail: z.string().max(500) }).strict(),
  z.object({ action: z.literal("isolate"), collection: collectionName, consumerId: uuid }).strict(),
  z.object({ action: z.literal("release"), collection: collectionName, consumerId: uuid }).strict(),
  z.object({ action: z.literal("rename"), collection: collectionName, consumerId: uuid, label: z.string().max(120) }).strict(),
]);
const confirmInput = z.object({ operationId: uuid, previewId: uuid, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.enum(confirms) }).strict();
const reconcileInput = z.object({
  collection: collectionName,
  consumerId: uuid,
  operationId: uuid,
  runId: uuid.optional(),
  expectedVersion: z.number().int().positive().optional(),
  bound: z.number().int().min(1).max(50).optional(),
  observations: z.unknown().optional(),
}).strict();
const draftInput = z.object({
  draftId: uuid,
  consumerId: uuid,
  collection: collectionName,
  operationId: uuid,
  expectedVersion: z.number().int().nonnegative(),
  note: z.string().max(500),
  observations: z.unknown().optional(),
}).strict();
const discardInput = z.object({ consumerId: uuid, collection: collectionName, operationId: uuid, expectedVersion: z.number().int().positive() }).strict();
const grantInput = z.object({
  collection: collectionName,
  consumerId: uuid,
  userId: z.string().min(1).max(200),
  operationId: uuid,
  expectedVersion: z.number().int().nonnegative(),
  canRead: z.boolean(),
  canReconcile: z.boolean(),
  canRepair: z.boolean(),
  canExport: z.boolean(),
  canHistory: z.boolean(),
  confirm: z.literal("grant-integration-health-access"),
}).strict();

type ConsumerRow = { id: string; client_id: string; label: string; outage: "none" | "partial" | "isolated"; version: number; updated_at: string };
type GrantRow = { can_read: boolean; can_reconcile: boolean; can_repair: boolean; can_export: boolean; can_history: boolean; version: number };
type AckRow = { last_sequence: string | number; event_id: string | null; record_version: number | null; version: number; acknowledged_at: string };
type DeliveryRow = { id: string; event_id: string; event_sequence: string | number; record_id: string; record_version: number; state: DeliveryState; attempt_count: number; next_attempt_at: string | Date | null; failure_code: string | null; failure_redacted: string; version: number; updated_at: string };
type EventRow = { id: string; sequence: string; record_id: string; record_version: number; collection: string; created_at: string };
type MismatchRow = { id: string; class: MismatchClass; record_id: string | null; event_id: string | null; reference_key: string | null; canonical_version: number | null; observed_version: number | null; state: string };
type RunRow = { id: string; consumer_id: string; collection: string; phase: "events" | "records" | "references" | "extras" | "completed"; cursor_sequence: string | number; observation_offset: number; reference_cursor: string; bound: number; observations: unknown; state: "open" | "completed"; version: number };
type PreviewRow = { id: string; collection: string; consumer_id: string | null; action: string; confirm: (typeof confirms)[number]; payload: unknown; review_hash: string; authority_revision: string };
type DraftRow = { id: string; consumer_id: string; note: string; observations: unknown; version: number };
type HealthEffect = {
  appliedVersion?: number;
  replayed?: boolean;
  credentialsStored?: false;
  accessGranted?: false;
  liveActivation?: false;
  schedule?: "paused";
  consumerId?: string;
  deliveryId?: string;
  runId?: string;
  version?: number;
  resume?: boolean;
  mismatches?: Array<{ class?: string; id?: string }>;
  outage?: string;
  decision?: string;
  canonicalVersion?: number | null;
  action?: string;
  attemptCount?: number;
  state?: string;
  sequence?: number;
};

const fail = (message: string, code = "integration_conflict", status = 409) => new DocumentError(message, code, status);
const missing = () => fail("Integration health is unavailable.", "integration_unavailable", 404);
const forbidden = () => fail("Integration health is not permitted.", "integration_forbidden", 403);
const invalid = (message = "Review the integration health request.") => fail(message, "integration_invalid", 400);

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value) as unknown; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function numberValue(value: string | number | null | undefined) { return value === null || value === undefined ? 0 : Number(value); }
function iso(value: string | Date | null) { if (!value) return null; const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function retryMessage(code: string) {
  if (code === "integration_backoff") return "This delivery is still inside its backoff limit.";
  if (code === "integration_poison") return "Poison deliveries stay isolated.";
  if (code === "integration_isolated") return "This consumer is isolated.";
  return "This delivery cannot be retried.";
}

export class IntegrationHealthRepository extends SharedRecordRepository {
  private async canView(tx: Sql, ctx: RecordContext, recordId: string) {
    try { return await this.raw(tx, ctx, recordId, "view"); }
    catch (error) { if (error instanceof DocumentError && [403, 404].includes(error.status)) return null; throw error; }
  }

  private async rights(tx: Sql, ctx: RecordContext, collection: string, consumerId: string) {
    const capabilities = await this.collectionCaps(tx, ctx, collection);
    const grant = (await tx.query<GrantRow>("SELECT can_read, can_reconcile, can_repair, can_export, can_history, version FROM hs_integration_consumer_grants WHERE tenant_id=$1 AND consumer_id=$2 AND user_id=$3", [ctx.tenantId, consumerId, ctx.actor.id])).rows[0] ?? null;
    return { capabilities, grant, access: integrationHealthAccess({ recordCapabilities: capabilities, grant: grant ? { canRead: grant.can_read, canReconcile: grant.can_reconcile, canRepair: grant.can_repair, canExport: grant.can_export, canHistory: grant.can_history } : null }) };
  }

  private async consumer(tx: Sql, ctx: RecordContext, consumerId: string) {
    if (!uuid.safeParse(consumerId).success) throw missing();
    const row = (await tx.query<ConsumerRow>("SELECT id, client_id, label, outage, version, updated_at FROM hs_integration_consumers WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE", [consumerId, ctx.tenantId, ctx.workspaceId])).rows[0];
    if (!row) throw missing();
    return row;
  }

  private async seen(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string): Promise<HealthEffect | null> {
    const prior = (await tx.query<{ request_hash: string; result: unknown; applied_version: number }>("SELECT request_hash, result, applied_version FROM hs_integration_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, operationId])).rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash) throw fail("Operation identity was reused.", "operation_mismatch");
    return { ...asObject(prior.result), appliedVersion: Number(prior.applied_version), replayed: true, ...flags };
  }

  private async finish(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string, consumerId: string | null, version: number, kind: string, result: Record<string, unknown>) {
    await tx.query("INSERT INTO hs_integration_operations(tenant_id,actor_id,operation_id,request_hash,consumer_id,applied_version,kind,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [ctx.tenantId, ctx.actor.id, operationId, requestHash, consumerId, version, kind, JSON.stringify(result)]);
  }

  private async audit(tx: Sql, ctx: RecordContext, operationId: string, action: string, extra: Record<string, unknown>) {
    await tx.query("INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ctx.actor.id, action, JSON.stringify({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, source: "holy-sheet", atIst: formatIst(new Date()), accessGranted: false, liveActivation: false, operation: action, ...extra }), operationId]);
  }

  private async rememberConsumer(tx: Sql, ctx: RecordContext, row: ConsumerRow, operationId: string) {
    await tx.query("INSERT INTO hs_integration_consumer_versions(tenant_id,consumer_id,version,client_id,label,outage,actor_id,operation_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'holy-sheet')", [ctx.tenantId, row.id, Number(row.version), row.client_id, row.label, row.outage, ctx.actor.id, operationId]);
  }

  private async bumpConsumer(tx: Sql, ctx: RecordContext, row: ConsumerRow, operationId: string, patch: { label?: string; outage?: ConsumerRow["outage"] }) {
    const label = patch.label ?? row.label;
    const outage = patch.outage ?? row.outage;
    if (label === row.label && outage === row.outage) return row;
    await tx.query("UPDATE hs_integration_consumers SET label=$3, outage=$4, version=version+1, updated_by=$5, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND version=$6", [ctx.tenantId, row.id, label, outage, ctx.actor.id, Number(row.version)]);
    const next = { ...row, label, outage, version: Number(row.version) + 1 };
    await this.rememberConsumer(tx, ctx, next, operationId);
    return next;
  }

  private async event(tx: Sql, ctx: RecordContext, collection: string, eventId: string) {
    const found = (await tx.query<EventRow>("SELECT id, sequence::text AS sequence, record_id, record_version, collection, created_at FROM hs_data_change_events WHERE id=$1 AND tenant_id=$2", [eventId, ctx.tenantId])).rows[0];
    if (!found || found.collection !== collection) throw missing();
    const record = await this.canView(tx, ctx, found.record_id);
    if (!record || record.collection !== collection) throw missing();
    return { event: found, record };
  }

  private async delivery(tx: Sql, ctx: RecordContext, consumerId: string, deliveryId: string) {
    const row = (await tx.query<DeliveryRow>("SELECT id, event_id, event_sequence, record_id, record_version, state, attempt_count, next_attempt_at, failure_code, failure_redacted, version, updated_at FROM hs_integration_deliveries WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND consumer_id=$4 FOR UPDATE", [deliveryId, ctx.tenantId, ctx.workspaceId, consumerId])).rows[0];
    if (!row) throw missing();
    return row;
  }

  private async addMismatch(tx: Sql, ctx: RecordContext, runId: string, consumerId: string, input: { class: MismatchClass; recordId?: string | null; eventId?: string | null; referenceKey?: string | null; canonicalVersion?: number | null; observedVersion?: number | null }) {
    const id = randomUUID();
    const inserted = await tx.query<{ id: string }>(`INSERT INTO hs_integration_mismatches(id,tenant_id,run_id,consumer_id,class,record_id,event_id,reference_key,canonical_version,observed_version)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      WHERE NOT EXISTS (SELECT 1 FROM hs_integration_mismatches WHERE run_id=$3 AND class=$5 AND record_id IS NOT DISTINCT FROM $6 AND event_id IS NOT DISTINCT FROM $7 AND reference_key IS NOT DISTINCT FROM $8)
      RETURNING id`, [id, ctx.tenantId, runId, consumerId, input.class, input.recordId ?? null, input.eventId ?? null, input.referenceKey ?? null, input.canonicalVersion ?? null, input.observedVersion ?? null]);
    const mismatchId = inserted.rows[0]?.id ?? (await tx.query<{ id: string }>("SELECT id FROM hs_integration_mismatches WHERE run_id=$1 AND class=$2 AND record_id IS NOT DISTINCT FROM $3 AND event_id IS NOT DISTINCT FROM $4 AND reference_key IS NOT DISTINCT FROM $5", [runId, input.class, input.recordId ?? null, input.eventId ?? null, input.referenceKey ?? null])).rows[0]?.id;
    if (!mismatchId) throw fail("The reconciliation mismatch could not be recorded.");
    return { id: mismatchId, class: input.class, recordId: input.recordId ?? null, eventId: input.eventId ?? null, referenceKey: input.referenceKey ?? null, canonicalVersion: input.canonicalVersion ?? null, observedVersion: input.observedVersion ?? null };
  }

  async listHealth(ctx: RecordContext, input: { collection: string; query?: string; recordId?: string }) {
    const parsed = z.object({ collection: collectionName, query: z.string().max(100).optional(), recordId: uuid.optional() }).strict().safeParse(input);
    if (!parsed.success || (parsed.data.query && /[\p{Cc}]/u.test(parsed.data.query)) || identifierPayloadHasCredential(input)) throw invalid("Review the integration health search.");
    const term = parsed.data.query?.trim() ?? "";
    return this.transaction(ctx, async (tx) => {
      if (parsed.data.recordId) {
        const record = await this.canView(tx, ctx, parsed.data.recordId);
        if (!record || record.collection !== parsed.data.collection) throw missing();
      }
      const capabilities = await this.collectionCaps(tx, ctx, parsed.data.collection);
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      const consumers = await tx.query<ConsumerRow>(`SELECT id, client_id, label, outage, version, updated_at FROM hs_integration_consumers
        WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text='' OR lower(client_id) LIKE lower($4) ESCAPE '\\' OR lower(label) LIKE lower($4) ESCAPE '\\')
        ORDER BY client_id LIMIT 51`, [ctx.tenantId, ctx.workspaceId, term, pattern]);
      if (consumers.rows.length > 50) throw invalid("Use a narrower integration health search.");
      const listed: Array<{ id: string; failures: Array<{ deliveryId: string; recordId: string }>; [key: string]: unknown }> = [];
      for (const row of consumers.rows) {
        const access = integrationHealthAccess({ recordCapabilities: capabilities, grant: await this.grantOf(tx, ctx, row.id) });
        if (!access.canRead) continue;
        const ack = (await tx.query<AckRow>("SELECT last_sequence, event_id, record_version, version, acknowledged_at FROM hs_integration_acknowledgements WHERE tenant_id=$1 AND consumer_id=$2", [ctx.tenantId, row.id])).rows[0] ?? null;
        const queue = await this.queue(tx, ctx, parsed.data.collection, numberValue(ack?.last_sequence));
        const failures = await this.failures(tx, ctx, parsed.data.collection, row.id, parsed.data.recordId);
        if (parsed.data.recordId && !failures.some((failure) => failure.recordId === parsed.data.recordId) && !queue.recordIds.includes(parsed.data.recordId)) continue;
        listed.push({
          id: row.id,
          clientId: row.client_id,
          label: row.label,
          outage: row.outage,
          version: Number(row.version),
          deliveryMode: "paused" as const,
          liveActivation: false as const,
          schedule: "paused" as const,
          lastAcknowledgement: ack ? { sequence: numberValue(ack.last_sequence), eventId: ack.event_id, recordVersion: ack.record_version, version: Number(ack.version), atIst: formatIst(ack.acknowledged_at) } : null,
          queueAgeSeconds: queue.ageSeconds,
          oldestUnacknowledgedAtIst: queue.oldestAtIst,
          failures,
          ...access,
        });
      }
      const drafts = capabilities.includes("view") ? await tx.query<DraftRow>("SELECT id, consumer_id, note, observations, version FROM hs_integration_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND collection=$4 ORDER BY consumer_id", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, parsed.data.collection]) : { rows: [] as DraftRow[] };
      const visibleDrafts = drafts.rows.filter((draft) => listed.some((consumer) => consumer.id === draft.consumer_id));
      return { consumers: listed, drafts: visibleDrafts.map((draft) => ({ id: draft.id, consumerId: draft.consumer_id, note: draft.note, observations: asObject(draft.observations), version: Number(draft.version) })), ...flags };
    });
  }

  private async grantOf(tx: Sql, ctx: RecordContext, consumerId: string) {
    const grant = (await tx.query<GrantRow>("SELECT can_read, can_reconcile, can_repair, can_export, can_history, version FROM hs_integration_consumer_grants WHERE tenant_id=$1 AND consumer_id=$2 AND user_id=$3", [ctx.tenantId, consumerId, ctx.actor.id])).rows[0];
    return grant ? { canRead: grant.can_read, canReconcile: grant.can_reconcile, canRepair: grant.can_repair, canExport: grant.can_export, canHistory: grant.can_history } : null;
  }

  private async queue(tx: Sql, ctx: RecordContext, collection: string, acknowledgedSequence: number) {
    const rows = await tx.query<EventRow>("SELECT id, sequence::text AS sequence, record_id, record_version, collection, created_at FROM hs_data_change_events WHERE tenant_id=$1 AND collection=$2 AND sequence > $3 ORDER BY sequence LIMIT 200", [ctx.tenantId, collection, acknowledgedSequence]);
    let oldest: string | null = null;
    const recordIds: string[] = [];
    for (const event of rows.rows) {
      const record = await this.canView(tx, ctx, event.record_id);
      if (!record) continue;
      recordIds.push(event.record_id);
      oldest ??= event.created_at;
    }
    return { ageSeconds: queueAgeSeconds(oldest, new Date()), oldestAtIst: oldest ? formatIst(oldest) : null, recordIds };
  }

  private async failures(tx: Sql, ctx: RecordContext, collection: string, consumerId: string, recordId?: string) {
    const rows = await tx.query<DeliveryRow>("SELECT d.id, d.event_id, d.event_sequence, d.record_id, d.record_version, d.state, d.attempt_count, d.next_attempt_at, d.failure_code, d.failure_redacted, d.version, d.updated_at FROM hs_integration_deliveries d JOIN hs_data_change_events e ON e.id=d.event_id WHERE d.tenant_id=$1 AND d.consumer_id=$2 AND d.state IN ('failed','poison') AND e.collection=$3 AND ($4::uuid IS NULL OR d.record_id=$4) ORDER BY d.updated_at DESC LIMIT 40", [ctx.tenantId, consumerId, collection, recordId ?? null]);
    const visible = [];
    for (const row of rows.rows) {
      const record = await this.canView(tx, ctx, row.record_id);
      if (!record || record.collection !== collection) continue;
      visible.push({ deliveryId: row.id, eventId: row.event_id, recordId: row.record_id, recordVersion: Number(row.record_version), state: row.state, attemptCount: Number(row.attempt_count), failureCode: row.failure_code, failureRedacted: row.failure_redacted, atIst: formatIst(row.updated_at), nextAttemptAt: iso(row.next_attempt_at) });
      if (visible.length === 20) break;
    }
    return visible;
  }

  async preview(ctx: RecordContext, input: z.input<typeof previewInput>) {
    const parsed = previewInput.safeParse(input);
    if (!parsed.success) throw invalid();
    const credentialProbe = parsed.data.action === "record-failure" ? { ...parsed.data, failureDetail: "" } : input;
    if (identifierPayloadHasCredential(credentialProbe)) throw invalid();
    const command = parsed.data;
    return this.transaction(ctx, async (tx, _tenant, proof) => {
      const described = await this.describePreview(tx, ctx, command);
      const previewId = randomUUID();
      const reviewHash = recordHash({ previewId, action: command.action, confirm: described.confirm, payload: described.payload, authorityRevision: proof.revision });
      await tx.query("INSERT INTO hs_integration_previews(id,tenant_id,workspace_id,actor_id,collection,consumer_id,action,confirm,payload,review_hash,authority_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.collection, described.consumerId, command.action, described.confirm, JSON.stringify(described.payload), reviewHash, proof.revision]);
      return { previewId, reviewHash, action: command.action, confirm: described.confirm, impact: described.impact, consumerId: described.consumerId, payload: described.payload, ...flags };
    });
  }

  private async describePreview(tx: Sql, ctx: RecordContext, command: z.output<typeof previewInput>) {
    if (command.action === "register") {
      const identity = parseConsumerIdentity(command);
      if (!identity.ok) throw invalid(identity.message);
      const capabilities = await this.collectionCaps(tx, ctx, command.collection);
      if (!capabilities.includes("view") || !capabilities.includes("manage-integration-health")) throw forbidden();
      const existing = (await tx.query("SELECT 1 FROM hs_integration_consumers WHERE tenant_id=$1 AND workspace_id=$2 AND client_id=$3", [ctx.tenantId, ctx.workspaceId, identity.clientId])).rows[0];
      if (existing) throw fail("This consumer is already registered.");
      return { consumerId: null, confirm: "register-paused-consumer" as const, impact: "This registers a paused consumer for health checks. It does not activate a live connection, rotate credentials, or grant record access.", payload: { clientId: identity.clientId, label: identity.label } };
    }
    const current = await this.consumer(tx, ctx, command.consumerId);
    const rights = await this.rights(tx, ctx, command.collection, current.id);
    if (command.action === "rename") {
      if (!rights.access.canRepair) throw forbidden();
      const identity = parseConsumerIdentity({ clientId: current.client_id, label: command.label });
      if (!identity.ok) throw invalid(identity.message);
      return { consumerId: current.id, confirm: "rename-integration-consumer" as const, impact: "This renames the consumer configuration. It does not grant access or activate delivery.", payload: { label: identity.label, expectedVersion: Number(current.version) } };
    }
    if (command.action === "isolate" || command.action === "release") {
      if (!rights.access.canRepair) throw forbidden();
      if (command.action === "isolate" && current.outage === "isolated") throw fail("This consumer is already isolated.");
      if (command.action === "release" && current.outage !== "isolated") throw fail("This consumer is not isolated.");
      return { consumerId: current.id, confirm: command.action === "isolate" ? "isolate-consumer" as const : "release-consumer-isolation" as const, impact: command.action === "isolate" ? "This isolates the consumer until you release it. Canonical records stay unchanged." : "This clears consumer isolation. Poison events stay isolated.", payload: { expectedVersion: Number(current.version) } };
    }
    if (!rights.access.canRepair && command.action !== "retry") throw forbidden();
    if (command.action === "retry") {
      if (!rights.access.canRepair) throw forbidden();
      const row = await this.visibleDelivery(tx, ctx, command.collection, current, command.deliveryId);
      const allowed = retryAllowed({ state: row.state, attemptCount: Number(row.attempt_count), nextAttemptAt: iso(row.next_attempt_at), outage: current.outage, now: new Date() });
      if (!allowed.ok) throw fail(retryMessage(allowed.code), allowed.code);
      return { consumerId: current.id, confirm: "retry-delivery" as const, impact: "This queues one idempotent retry of a failed delivery. It does not send data to another app.", payload: { deliveryId: row.id, expectedVersion: Number(row.version), eventId: row.event_id, recordId: row.record_id } };
    }
    if (command.action === "replay") {
      const found = await this.event(tx, ctx, command.collection, command.eventId);
      const row = (await tx.query<DeliveryRow>("SELECT id, event_id, event_sequence, record_id, record_version, state, attempt_count, next_attempt_at, failure_code, failure_redacted, version, updated_at FROM hs_integration_deliveries WHERE tenant_id=$1 AND consumer_id=$2 AND event_id=$3 FOR UPDATE", [ctx.tenantId, current.id, command.eventId])).rows[0] ?? null;
      const allowed = replayAllowed({ state: row?.state ?? null, outage: current.outage });
      if (!allowed.ok) throw fail(allowed.code === "integration_poison" ? "Poison deliveries stay isolated." : "This consumer is isolated.", allowed.code);
      return { consumerId: current.id, confirm: "replay-delivery" as const, impact: "This queues a replay of the canonical change. Canonical records stay unchanged.", payload: { eventId: found.event.id, deliveryId: row?.id ?? null, expectedVersion: row ? Number(row.version) : 0, recordId: found.event.record_id, recordVersion: Number(found.event.record_version), sequence: numberValue(found.event.sequence), mismatchId: command.mismatchId ?? null } };
    }
    if (command.action === "repair") {
      const mismatch = await this.mismatch(tx, ctx, command.collection, current.id, command.mismatchId);
      const repair = classifyRepair(mismatch.class, command.decision);
      if (!repair.ok) throw fail(repair.code === "repair_destructive" ? "Destructive conflict resolution is not available." : "This repair does not apply to the mismatch.", repair.code);
      return { consumerId: current.id, confirm: repair.confirm, impact: repair.effect === "hold" || repair.effect === "isolate" ? "This keeps canonical data unchanged." : "This queues a non-destructive repair. Canonical records and references stay unchanged.", payload: { mismatchId: mismatch.id, decision: repair.decision, effect: repair.effect, class: mismatch.class, recordId: mismatch.record_id, eventId: mismatch.event_id, referenceKey: mismatch.reference_key } };
    }
    if (command.action === "acknowledge") {
      const found = await this.event(tx, ctx, command.collection, command.eventId);
      const ack = (await tx.query<AckRow>("SELECT last_sequence, event_id, record_version, version, acknowledged_at FROM hs_integration_acknowledgements WHERE tenant_id=$1 AND consumer_id=$2 FOR UPDATE", [ctx.tenantId, current.id])).rows[0] ?? null;
      if (ack && numberValue(found.event.sequence) < numberValue(ack.last_sequence)) throw fail("An acknowledgement cannot move backwards.", "integration_ack_rewind");
      return { consumerId: current.id, confirm: "record-consumer-acknowledgement" as const, impact: "This records the consumer acknowledgement you reviewed. It does not grant access or hide later changes.", payload: { eventId: found.event.id, sequence: numberValue(found.event.sequence), recordVersion: Number(found.event.record_version), expectedVersion: ack ? Number(ack.version) : 0 } };
    }
    const found = await this.event(tx, ctx, command.collection, command.eventId);
    const failure = parseFailureReport(command);
    if (!failure.ok) throw invalid(failure.message);
    const row = (await tx.query<DeliveryRow>("SELECT id, event_id, event_sequence, record_id, record_version, state, attempt_count, next_attempt_at, failure_code, failure_redacted, version, updated_at FROM hs_integration_deliveries WHERE tenant_id=$1 AND consumer_id=$2 AND event_id=$3 FOR UPDATE", [ctx.tenantId, current.id, command.eventId])).rows[0] ?? null;
    if (row?.state === "poison") throw fail("Poison deliveries stay isolated.", "integration_poison");
    return { consumerId: current.id, confirm: "record-delivery-failure" as const, impact: "This records a redacted delivery failure. Repeated failures isolate the event. Nothing is sent to another app.", payload: { eventId: found.event.id, sequence: numberValue(found.event.sequence), recordId: found.event.record_id, recordVersion: Number(found.event.record_version), failureCode: failure.failureCode, failureRedacted: failure.failureRedacted, expectedVersion: row ? Number(row.version) : 0, deliveryId: row?.id ?? null } };
  }

  private async visibleDelivery(tx: Sql, ctx: RecordContext, collection: string, consumer: ConsumerRow, deliveryId: string) {
    const row = await this.delivery(tx, ctx, consumer.id, deliveryId);
    const record = await this.canView(tx, ctx, row.record_id);
    if (!record || record.collection !== collection) throw missing();
    return row;
  }

  private async mismatch(tx: Sql, ctx: RecordContext, collection: string, consumerId: string, mismatchId: string) {
    const row = (await tx.query<MismatchRow & { collection: string }>(`SELECT m.id, m.class, m.record_id, m.event_id, m.reference_key, m.canonical_version, m.observed_version, m.state, r.collection
      FROM hs_integration_mismatches m JOIN hs_integration_runs r ON r.id=m.run_id
      WHERE m.id=$1 AND m.tenant_id=$2 AND m.consumer_id=$3 AND r.workspace_id=$4 FOR UPDATE OF m`, [mismatchId, ctx.tenantId, consumerId, ctx.workspaceId])).rows[0];
    if (!row || row.collection !== collection || !mismatchClasses.includes(row.class)) throw missing();
    if (row.record_id) {
      const record = await this.canView(tx, ctx, row.record_id);
      if (!record && row.class !== "unknown-record") throw missing();
    }
    return row;
  }

  async confirm(ctx: RecordContext, input: z.input<typeof confirmInput>): Promise<HealthEffect> {
    const parsed = confirmInput.safeParse(input);
    if (!parsed.success || identifierPayloadHasCredential(input)) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "confirm", ...command });
    return this.transaction(ctx, async (tx, _tenant, proof) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const preview = (await tx.query<PreviewRow>("SELECT id, collection, consumer_id, action, confirm, payload, review_hash, authority_revision FROM hs_integration_previews WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND expires_at>clock_timestamp()", [command.previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
      if (!preview) throw fail("Review the integration action again.", "integration_preview_expired");
      if (preview.review_hash !== command.reviewHash || preview.confirm !== command.confirm || preview.authority_revision !== proof.revision) throw fail("Confirm the reviewed integration action.", "review_unconfirmed");
      const payload = asObject(preview.payload);
      const result = await this.apply(tx, ctx, command.operationId, preview, payload);
      const body = { ...result, replayed: false, ...flags };
      await this.finish(tx, ctx, command.operationId, requestHash, preview.consumer_id, Number(result.appliedVersion), preview.action, body);
      return body;
    });
  }

  private async apply(tx: Sql, ctx: RecordContext, operationId: string, preview: PreviewRow, payload: Record<string, unknown>) {
    if (preview.action === "register") {
      const capabilities = await this.collectionCaps(tx, ctx, preview.collection);
      if (!capabilities.includes("view") || !capabilities.includes("manage-integration-health")) throw forbidden();
      const identity = parseConsumerIdentity({ clientId: payload.clientId, label: payload.label });
      if (!identity.ok) throw invalid(identity.message);
      const id = randomUUID();
      await tx.query("INSERT INTO hs_integration_consumers(id,tenant_id,workspace_id,client_id,label,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)", [id, ctx.tenantId, ctx.workspaceId, identity.clientId, identity.label, ctx.actor.id]);
      const row: ConsumerRow = { id, client_id: identity.clientId, label: identity.label, outage: "none", version: 1, updated_at: new Date().toISOString() };
      await this.rememberConsumer(tx, ctx, row, operationId);
      await tx.query("INSERT INTO hs_integration_consumer_grants(tenant_id,consumer_id,user_id,can_read,can_reconcile,can_repair,can_export,can_history) VALUES($1,$2,$3,true,true,true,true,true)", [ctx.tenantId, id, ctx.actor.id]);
      await this.audit(tx, ctx, operationId, "integration.register", { consumerId: id, clientId: identity.clientId, version: 1 });
      return { consumerId: id, appliedVersion: 1, action: "register" };
    }
    if (!preview.consumer_id) throw missing();
    const current = await this.consumer(tx, ctx, preview.consumer_id);
    const rights = await this.rights(tx, ctx, preview.collection, current.id);
    if (preview.action === "rename" || preview.action === "isolate" || preview.action === "release" || preview.action === "retry" || preview.action === "replay" || preview.action === "repair" || preview.action === "acknowledge" || preview.action === "record-failure") {
      if (!rights.access.canRepair) throw forbidden();
    }
    if (preview.action === "rename") {
      if (Number(payload.expectedVersion) !== Number(current.version)) throw fail("The consumer changed. Review it again.");
      const identity = parseConsumerIdentity({ clientId: current.client_id, label: payload.label });
      if (!identity.ok) throw invalid(identity.message);
      const next = await this.bumpConsumer(tx, ctx, current, operationId, { label: identity.label });
      await this.audit(tx, ctx, operationId, "integration.rename", { consumerId: current.id, version: next.version });
      return { consumerId: current.id, appliedVersion: next.version, action: "rename" };
    }
    if (preview.action === "isolate" || preview.action === "release") {
      if (Number(payload.expectedVersion) !== Number(current.version)) throw fail("The consumer changed. Review it again.");
      const poison = (await tx.query("SELECT 1 FROM hs_integration_deliveries WHERE tenant_id=$1 AND consumer_id=$2 AND state='poison' LIMIT 1", [ctx.tenantId, current.id])).rows.length > 0;
      const outage = preview.action === "isolate" ? "isolated" : poison ? "partial" : "none";
      const next = await this.bumpConsumer(tx, ctx, current, operationId, { outage });
      await this.audit(tx, ctx, operationId, preview.action === "isolate" ? "integration.isolate" : "integration.release", { consumerId: current.id, outage, version: next.version });
      return { consumerId: current.id, appliedVersion: next.version, action: preview.action, outage };
    }
    if (preview.action === "retry") return this.applyRetry(tx, ctx, operationId, current, preview.collection, payload);
    if (preview.action === "replay") return this.applyReplay(tx, ctx, operationId, current, preview.collection, payload);
    if (preview.action === "repair") return this.applyRepair(tx, ctx, operationId, current, preview.collection, payload);
    if (preview.action === "acknowledge") return this.applyAck(tx, ctx, operationId, current, preview.collection, payload);
    if (preview.action === "record-failure") return this.applyFailure(tx, ctx, operationId, current, preview.collection, payload);
    throw invalid();
  }

  private async applyRetry(tx: Sql, ctx: RecordContext, operationId: string, consumer: ConsumerRow, collection: string, payload: Record<string, unknown>) {
    const row = await this.visibleDelivery(tx, ctx, collection, consumer, String(payload.deliveryId));
    if (Number(row.version) !== Number(payload.expectedVersion)) throw fail("The delivery changed. Review it again.");
    const allowed = retryAllowed({ state: row.state, attemptCount: Number(row.attempt_count), nextAttemptAt: iso(row.next_attempt_at), outage: consumer.outage, now: new Date() });
    if (!allowed.ok) throw fail("The delivery cannot be retried.", allowed.code);
    const backoff = nextBackoffSeconds(Number(row.attempt_count) + 1);
    await tx.query("UPDATE hs_integration_deliveries SET state='pending', attempt_count=attempt_count+1, next_attempt_at=clock_timestamp() + ($4 || ' seconds')::interval, version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND version=$3", [ctx.tenantId, row.id, Number(row.version), String(backoff)]);
    await tx.query("INSERT INTO hs_integration_repairs(id,tenant_id,consumer_id,delivery_id,action,decision,applied_version,actor_id,operation_id) VALUES($1,$2,$3,$4,'retry','retry-delivery',$5,$6,$7)", [randomUUID(), ctx.tenantId, consumer.id, row.id, Number(row.version) + 1, ctx.actor.id, operationId]);
    await this.audit(tx, ctx, operationId, "integration.retry", { consumerId: consumer.id, deliveryId: row.id, eventId: row.event_id, version: Number(row.version) + 1 });
    return { consumerId: consumer.id, deliveryId: row.id, appliedVersion: Number(row.version) + 1, action: "retry", attemptCount: Number(row.attempt_count) + 1 };
  }

  private async applyReplay(tx: Sql, ctx: RecordContext, operationId: string, consumer: ConsumerRow, collection: string, payload: Record<string, unknown>) {
    const found = await this.event(tx, ctx, collection, String(payload.eventId));
    const existing = payload.deliveryId ? await this.delivery(tx, ctx, consumer.id, String(payload.deliveryId)) : (await tx.query<DeliveryRow>("SELECT id, event_id, event_sequence, record_id, record_version, state, attempt_count, next_attempt_at, failure_code, failure_redacted, version, updated_at FROM hs_integration_deliveries WHERE tenant_id=$1 AND consumer_id=$2 AND event_id=$3 FOR UPDATE", [ctx.tenantId, consumer.id, found.event.id])).rows[0] ?? null;
    const allowed = replayAllowed({ state: existing?.state ?? null, outage: consumer.outage });
    if (!allowed.ok) throw fail("The delivery cannot be replayed.", allowed.code);
    let deliveryId = existing?.id ?? randomUUID();
    let version = 1;
    if (existing) {
      if (Number(existing.version) !== Number(payload.expectedVersion)) throw fail("The delivery changed. Review it again.");
      version = Number(existing.version) + 1;
      await tx.query("UPDATE hs_integration_deliveries SET state='replay-queued', version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND version=$3", [ctx.tenantId, existing.id, Number(existing.version)]);
    } else {
      await tx.query("INSERT INTO hs_integration_deliveries(id,tenant_id,workspace_id,consumer_id,event_id,event_sequence,record_id,record_version,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'replay-queued')", [deliveryId, ctx.tenantId, ctx.workspaceId, consumer.id, found.event.id, numberValue(found.event.sequence), found.event.record_id, Number(found.event.record_version)]);
    }
    if (typeof payload.mismatchId === "string") await tx.query("UPDATE hs_integration_mismatches SET state='queued' WHERE tenant_id=$1 AND id=$2 AND state='open'", [ctx.tenantId, payload.mismatchId]);
    await tx.query("INSERT INTO hs_integration_repairs(id,tenant_id,consumer_id,mismatch_id,delivery_id,action,decision,applied_version,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,'replay','queue-replay',$6,$7,$8)", [randomUUID(), ctx.tenantId, consumer.id, typeof payload.mismatchId === "string" ? payload.mismatchId : null, deliveryId, version, ctx.actor.id, operationId]);
    await this.audit(tx, ctx, operationId, "integration.replay", { consumerId: consumer.id, deliveryId, eventId: found.event.id, version });
    return { consumerId: consumer.id, deliveryId, appliedVersion: version, action: "replay" };
  }

  private async applyRepair(tx: Sql, ctx: RecordContext, operationId: string, consumer: ConsumerRow, collection: string, payload: Record<string, unknown>) {
    const mismatch = await this.mismatch(tx, ctx, collection, consumer.id, String(payload.mismatchId));
    const repair = classifyRepair(mismatch.class, String(payload.decision));
    if (!repair.ok || repair.effect !== payload.effect) throw fail("Destructive conflict resolution is not available.", "repair_destructive");
    if (mismatch.state !== "open") throw fail("The mismatch changed. Review it again.");
    const canonicalVersion = await this.canonicalVersion(tx, mismatch.record_id);
    if (repair.effect === "replay") {
      const eventId = mismatch.event_id ?? (mismatch.record_id ? (await tx.query<{ id: string }>("SELECT id FROM hs_data_change_events WHERE tenant_id=$1 AND record_id=$2 ORDER BY sequence DESC LIMIT 1", [ctx.tenantId, mismatch.record_id])).rows[0]?.id : undefined);
      if (!eventId) throw fail("This mismatch has no canonical change to replay.", "repair_not_applicable");
      const existing = (await tx.query<DeliveryRow>("SELECT id, event_id, event_sequence, record_id, record_version, state, attempt_count, next_attempt_at, failure_code, failure_redacted, version, updated_at FROM hs_integration_deliveries WHERE tenant_id=$1 AND consumer_id=$2 AND event_id=$3", [ctx.tenantId, consumer.id, eventId])).rows[0] ?? null;
      const replay = await this.applyReplay(tx, ctx, operationId, consumer, collection, { eventId, deliveryId: existing?.id ?? null, expectedVersion: existing ? Number(existing.version) : 0, mismatchId: mismatch.id });
      return { ...replay, action: "repair", decision: repair.decision, canonicalVersion };
    }
    const state = repair.effect === "isolate" ? "isolated" : repair.effect === "reference-repair" ? "queued" : "held";
    await tx.query("UPDATE hs_integration_mismatches SET state=$3 WHERE tenant_id=$1 AND id=$2 AND state='open'", [ctx.tenantId, mismatch.id, state]);
    await tx.query("INSERT INTO hs_integration_repairs(id,tenant_id,consumer_id,mismatch_id,action,decision,applied_version,actor_id,operation_id) VALUES($1,$2,$3,$4,'repair',$5,1,$6,$7)", [randomUUID(), ctx.tenantId, consumer.id, mismatch.id, repair.decision, ctx.actor.id, operationId]);
    await this.audit(tx, ctx, operationId, "integration.repair", { consumerId: consumer.id, mismatchId: mismatch.id, decision: repair.decision, class: mismatch.class });
    return { consumerId: consumer.id, mismatchId: mismatch.id, appliedVersion: 1, action: "repair", decision: repair.decision, canonicalVersion };
  }

  private async canonicalVersion(tx: Sql, recordId: string | null) {
    if (!recordId) return null;
    const row = (await tx.query<{ version: number }>("SELECT version FROM hs_data_records WHERE id=$1", [recordId])).rows[0];
    return row ? Number(row.version) : null;
  }

  private async applyAck(tx: Sql, ctx: RecordContext, operationId: string, consumer: ConsumerRow, collection: string, payload: Record<string, unknown>) {
    const found = await this.event(tx, ctx, collection, String(payload.eventId));
    const ack = (await tx.query<AckRow>("SELECT last_sequence, event_id, record_version, version, acknowledged_at FROM hs_integration_acknowledgements WHERE tenant_id=$1 AND consumer_id=$2 FOR UPDATE", [ctx.tenantId, consumer.id])).rows[0] ?? null;
    const expected = Number(payload.expectedVersion);
    if ((ack ? Number(ack.version) : 0) !== expected) throw fail("The acknowledgement changed. Review it again.");
    if (ack && numberValue(found.event.sequence) < numberValue(ack.last_sequence)) throw fail("An acknowledgement cannot move backwards.", "integration_ack_rewind");
    const version = expected + 1;
    if (ack) await tx.query("UPDATE hs_integration_acknowledgements SET last_sequence=$3, event_id=$4, record_version=$5, version=version+1, actor_id=$6, acknowledged_at=clock_timestamp() WHERE tenant_id=$1 AND consumer_id=$2 AND version=$7", [ctx.tenantId, consumer.id, numberValue(found.event.sequence), found.event.id, Number(found.event.record_version), ctx.actor.id, expected]);
    else await tx.query("INSERT INTO hs_integration_acknowledgements(tenant_id,consumer_id,last_sequence,event_id,record_version,version,actor_id) VALUES($1,$2,$3,$4,$5,1,$6)", [ctx.tenantId, consumer.id, numberValue(found.event.sequence), found.event.id, Number(found.event.record_version), ctx.actor.id]);
    await this.audit(tx, ctx, operationId, "integration.acknowledge", { consumerId: consumer.id, eventId: found.event.id, sequence: numberValue(found.event.sequence), version });
    return { consumerId: consumer.id, appliedVersion: version, action: "acknowledge", sequence: numberValue(found.event.sequence) };
  }

  private async applyFailure(tx: Sql, ctx: RecordContext, operationId: string, consumer: ConsumerRow, collection: string, payload: Record<string, unknown>) {
    const found = await this.event(tx, ctx, collection, String(payload.eventId));
    const failureCode = typeof payload.failureCode === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(payload.failureCode) ? payload.failureCode : "";
    const failureRedacted = typeof payload.failureRedacted === "string" ? payload.failureRedacted.slice(0, 200) : "";
    if (!failureCode) throw invalid();
    const existing = payload.deliveryId ? await this.delivery(tx, ctx, consumer.id, String(payload.deliveryId)) : null;
    if (existing?.state === "poison") throw fail("Poison deliveries stay isolated.", "integration_poison");
    if (existing && Number(existing.version) !== Number(payload.expectedVersion)) throw fail("The delivery changed. Review it again.");
    const transition = failureTransition(existing ? Number(existing.attempt_count) : 0);
    const deliveryId = existing?.id ?? randomUUID();
    const version = existing ? Number(existing.version) + 1 : 1;
    if (existing) await tx.query("UPDATE hs_integration_deliveries SET state=$3, attempt_count=$4, next_attempt_at=clock_timestamp() + ($5 || ' seconds')::interval, failure_code=$6, failure_redacted=$7, version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND version=$8", [ctx.tenantId, existing.id, transition.state, transition.attemptCount, String(transition.backoffSeconds), failureCode, failureRedacted, Number(existing.version)]);
    else await tx.query("INSERT INTO hs_integration_deliveries(id,tenant_id,workspace_id,consumer_id,event_id,event_sequence,record_id,record_version,state,attempt_count,next_attempt_at,failure_code,failure_redacted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp() + ($11 || ' seconds')::interval,$12,$13)", [deliveryId, ctx.tenantId, ctx.workspaceId, consumer.id, found.event.id, numberValue(found.event.sequence), found.event.record_id, Number(found.event.record_version), transition.state, transition.attemptCount, String(transition.backoffSeconds), failureCode, failureRedacted]);
    let outage = consumer.outage;
    if (transition.state === "poison" && consumer.outage === "none") outage = (await this.bumpConsumer(tx, ctx, consumer, operationId, { outage: "partial" })).outage;
    await this.audit(tx, ctx, operationId, "integration.failure", { consumerId: consumer.id, deliveryId, eventId: found.event.id, state: transition.state, attemptCount: transition.attemptCount, outage, version });
    return { consumerId: consumer.id, deliveryId, appliedVersion: version, action: "record-failure", state: transition.state, attemptCount: transition.attemptCount, outage };
  }

  async reconcile(ctx: RecordContext, input: z.input<typeof reconcileInput>): Promise<HealthEffect> {
    const parsed = reconcileInput.safeParse(input);
    const observations = parsed.success && !parsed.data.runId ? parseObservations(parsed.data.observations) : { ok: true as const, records: null, references: null };
    if (!parsed.success || !observations.ok || identifierPayloadHasCredential(input)) throw invalid(!observations.ok ? observations.message : undefined);
    const command = parsed.data;
    if (command.runId && command.observations !== undefined) throw invalid("Resume uses the saved reconciliation scope.");
    if (!command.runId && command.expectedVersion) throw invalid();
    if (command.runId && !command.expectedVersion) throw invalid("Review the reconciliation before continuing it.");
    const requestHash = recordHash({ kind: "reconcile", collection: command.collection, consumerId: command.consumerId, operationId: command.operationId, runId: command.runId ?? null, expectedVersion: command.expectedVersion ?? null, bound: command.bound ?? integrationPageBound, observations: command.runId ? null : observations });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const current = await this.consumer(tx, ctx, command.consumerId);
      const rights = await this.rights(tx, ctx, command.collection, current.id);
      if (!rights.access.canReconcile) throw forbidden();
      const run = command.runId ? await this.run(tx, ctx, command.runId, current.id, command.collection) : null;
      if (run && Number(run.version) !== command.expectedVersion) throw fail("The reconciliation changed. Review it again.");
      if (run?.phase === "completed") {
        const result = { runId: run.id, version: Number(run.version), phase: "completed", resume: false, mismatches: [], appliedVersion: Number(run.version), action: "reconcile", ...flags, replayed: false };
        await this.finish(tx, ctx, command.operationId, requestHash, current.id, Number(run.version), "reconcile", result);
        await this.audit(tx, ctx, command.operationId, "integration.reconcile", { consumerId: current.id, runId: run.id, phase: "completed", version: Number(run.version), mismatchCount: 0 });
        return result;
      }
      const runId = run?.id ?? randomUUID();
      const bound = run ? Number(run.bound) : command.bound ?? integrationPageBound;
      const storedObservations = run ? this.readObservations(run.observations) : observations;
      if (!run) await tx.query("INSERT INTO hs_integration_runs(id,tenant_id,workspace_id,actor_id,collection,consumer_id,phase,bound,observations,state) VALUES($1,$2,$3,$4,$5,$6,'events',$7,$8,'open')", [runId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.collection, current.id, bound, JSON.stringify({ records: storedObservations.records, references: storedObservations.references })]);
      const ack = (await tx.query<AckRow>("SELECT last_sequence, event_id, record_version, version, acknowledged_at FROM hs_integration_acknowledgements WHERE tenant_id=$1 AND consumer_id=$2", [ctx.tenantId, current.id])).rows[0] ?? null;
      let phase: "events" | "records" | "references" | "extras" | "completed" = run?.phase ?? "events";
      let cursor = numberValue(run?.cursor_sequence);
      let offset = Number(run?.observation_offset ?? 0);
      let referenceCursor = run?.reference_cursor ?? "";
      let budget = bound;
      const mismatches: Array<Record<string, unknown>> = [];
      if (phase === "events") {
        const step = await this.scanEvents(tx, ctx, command.collection, current, numberValue(ack?.last_sequence), runId, cursor, budget);
        budget -= step.produced;
        cursor = step.cursor;
        mismatches.push(...step.mismatches);
        if (step.done) phase = storedObservations.records ? "records" : storedObservations.references ? "references" : "completed";
      }
      if (phase === "records" && storedObservations.records && budget > 0) {
        const step = await this.scanRecords(tx, ctx, command.collection, current.id, runId, storedObservations.records, offset, budget);
        budget -= step.produced;
        offset = step.offset;
        mismatches.push(...step.mismatches);
        if (step.done) { phase = storedObservations.references ? "references" : "completed"; offset = 0; }
      }
      if (phase === "references" && storedObservations.references && budget > 0) {
        const step = await this.scanReferences(tx, ctx, command.collection, current, runId, storedObservations.references, referenceCursor, budget);
        budget -= step.produced;
        referenceCursor = step.cursor;
        mismatches.push(...step.mismatches);
        if (step.done) phase = "extras";
      }
      if (phase === "extras" && storedObservations.references && budget > 0) {
        const step = await this.scanExtras(tx, ctx, command.collection, current, runId, storedObservations.references, offset, budget);
        offset = step.offset;
        mismatches.push(...step.mismatches);
        if (step.done) phase = "completed";
      }
      const version = (run ? Number(run.version) : 1) + 1;
      const state = phase === "completed" ? "completed" : "open";
      await tx.query("UPDATE hs_integration_runs SET phase=$3, cursor_sequence=$4, observation_offset=$5, reference_cursor=$6, state=$7, version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND version=$2", [runId, run ? Number(run.version) : 1, phase, cursor, offset, referenceCursor, state]);
      const result = { runId, version, phase, resume: phase !== "completed", mismatches, appliedVersion: version, action: "reconcile", ...flags, replayed: false };
      await this.finish(tx, ctx, command.operationId, requestHash, current.id, version, "reconcile", result);
      await this.audit(tx, ctx, command.operationId, "integration.reconcile", { consumerId: current.id, runId, phase, version, mismatchCount: mismatches.length });
      return result;
    });
  }

  private readObservations(value: unknown) {
    const body = asObject(value);
    const parsed = parseObservations({ ...(Array.isArray(body.records) ? { records: body.records } : {}), ...(Array.isArray(body.references) ? { references: body.references } : {}) });
    if (!parsed.ok) return { records: null, references: null };
    return { records: body.records === null ? null : parsed.records, references: body.references === null ? null : parsed.references };
  }

  private async run(tx: Sql, ctx: RecordContext, runId: string, consumerId: string, collection: string) {
    const row = (await tx.query<RunRow>("SELECT id, consumer_id, collection, phase, cursor_sequence, observation_offset, reference_cursor, bound, observations, state, version FROM hs_integration_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 FOR UPDATE", [runId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
    if (!row || row.consumer_id !== consumerId || row.collection !== collection) throw missing();
    return row;
  }

  private async scanEvents(tx: Sql, ctx: RecordContext, collection: string, consumer: ConsumerRow, acknowledgedSequence: number, runId: string, cursor: number, budget: number) {
    const rows = await tx.query<EventRow>("SELECT id, sequence::text AS sequence, record_id, record_version, collection, created_at FROM hs_data_change_events WHERE tenant_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3", [ctx.tenantId, cursor, integrationScanWindow]);
    let produced = 0;
    let scanned = cursor;
    const mismatches = [];
    for (const event of rows.rows) {
      if (produced >= budget) break;
      scanned = numberValue(event.sequence);
      if (event.collection !== collection) continue;
      const record = await this.canView(tx, ctx, event.record_id);
      if (!record) continue;
      produced += 1;
      const delivery = (await tx.query<{ state: DeliveryState }>("SELECT state FROM hs_integration_deliveries WHERE tenant_id=$1 AND consumer_id=$2 AND event_id=$3", [ctx.tenantId, consumer.id, event.id])).rows[0] ?? null;
      const mismatch = classifyVisibleEvent({ sequence: scanned, acknowledgedSequence, deliveryState: delivery?.state ?? null });
      if (!mismatch) continue;
      mismatches.push(await this.addMismatch(tx, ctx, runId, consumer.id, { class: mismatch, recordId: event.record_id, eventId: event.id, canonicalVersion: Number(event.record_version) }));
    }
    const pendingWindow = rows.rows.some((event) => numberValue(event.sequence) > scanned && event.collection === collection);
    const more = (await tx.query("SELECT 1 FROM hs_data_change_events WHERE tenant_id=$1 AND collection=$2 AND sequence>$3 LIMIT 1", [ctx.tenantId, collection, scanned])).rows.length > 0;
    return { produced, cursor: scanned, done: !pendingWindow && !more, mismatches };
  }

  private async scanRecords(tx: Sql, ctx: RecordContext, collection: string, consumerId: string, runId: string, records: ObservedRecord[], offset: number, budget: number) {
    const page = records.slice(offset, offset + budget);
    const mismatches = [];
    for (const item of page) {
      const canonical = (await tx.query<{ id: string; version: number; collection: string }>("SELECT id, version, collection FROM hs_data_records WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, item.recordId])).rows[0] ?? null;
      if (!canonical) {
        mismatches.push(await this.addMismatch(tx, ctx, runId, consumerId, { class: "unknown-record", recordId: item.recordId, observedVersion: item.version }));
        continue;
      }
      if (canonical.collection !== collection) continue;
      const visible = await this.canView(tx, ctx, canonical.id);
      if (!visible) continue;
      const mismatch = classifyObservedRecord({ found: true, canonicalVersion: Number(canonical.version), observedVersion: item.version });
      if (mismatch) mismatches.push(await this.addMismatch(tx, ctx, runId, consumerId, { class: mismatch, recordId: canonical.id, canonicalVersion: Number(canonical.version), observedVersion: item.version }));
    }
    const next = offset + page.length;
    return { produced: page.length, offset: next, done: next >= records.length, mismatches };
  }

  private async scanReferences(tx: Sql, ctx: RecordContext, collection: string, consumer: ConsumerRow, runId: string, observed: ObservedReference[], cursor: string, budget: number) {
    const rows = await tx.query<{ id: string; record_id: string; source_type: string; source_id: string; version: number }>("SELECT r.id, r.record_id, r.source_type, r.source_id, r.version FROM hs_data_references r JOIN hs_data_records rec ON rec.tenant_id=r.tenant_id AND rec.id=r.record_id WHERE r.tenant_id=$1 AND r.source_app=$2 AND rec.collection=$3 AND ($4::uuid IS NULL OR r.id > $4::uuid) ORDER BY r.id LIMIT $5", [ctx.tenantId, consumer.client_id, collection, cursor || null, budget]);
    const mismatches = [];
    let scanned = cursor;
    let produced = 0;
    for (const row of rows.rows) {
      scanned = row.id;
      produced += 1;
      const visible = await this.canView(tx, ctx, row.record_id);
      if (!visible) continue;
      const canonical = { recordId: row.record_id, sourceType: row.source_type, sourceId: row.source_id, version: Number(row.version) };
      const match = observed.find((item) => referenceKey(item) === referenceKey(canonical));
      const mismatch = classifyCanonicalReference(canonical, match);
      if (!mismatch) continue;
      mismatches.push(await this.addMismatch(tx, ctx, runId, consumer.id, { class: mismatch, recordId: row.record_id, referenceKey: referenceKey(canonical), canonicalVersion: canonical.version, observedVersion: match?.version ?? null }));
    }
    return { produced, cursor: scanned, done: rows.rows.length < budget, mismatches };
  }

  private async scanExtras(tx: Sql, ctx: RecordContext, collection: string, consumer: ConsumerRow, runId: string, observed: ObservedReference[], offset: number, budget: number) {
    const page = observed.slice(offset, offset + budget);
    const mismatches = [];
    for (const item of page) {
      const canonicalRecord = (await tx.query<{ collection: string }>("SELECT collection FROM hs_data_records WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, item.recordId])).rows[0] ?? null;
      if (!canonicalRecord || canonicalRecord.collection !== collection) continue;
      const visible = await this.canView(tx, ctx, item.recordId);
      if (!visible) continue;
      const canonical = (await tx.query("SELECT 1 FROM hs_data_references WHERE tenant_id=$1 AND record_id=$2 AND source_app=$3 AND source_type=$4 AND source_id=$5", [ctx.tenantId, item.recordId, consumer.client_id, item.sourceType, item.sourceId])).rows[0];
      if (classifyExtraReference(canonical ? item : undefined)) mismatches.push(await this.addMismatch(tx, ctx, runId, consumer.id, { class: "extra-reference", recordId: item.recordId, referenceKey: referenceKey(item), observedVersion: item.version }));
    }
    const next = offset + page.length;
    return { produced: page.length, offset: next, done: next >= observed.length, mismatches };
  }

  async saveDraft(ctx: RecordContext, input: z.input<typeof draftInput>) {
    const parsed = draftInput.safeParse(input);
    const observations = parsed.success ? parseObservations(parsed.data.observations) : { ok: false as const, message: "Review the draft." };
    if (!parsed.success || !observations.ok || identifierPayloadHasCredential(input) || (parsed.data.note && identifierPayloadHasCredential({ note: parsed.data.note }))) throw invalid(!observations.ok ? observations.message : undefined);
    const command = parsed.data;
    const requestHash = recordHash({ kind: "draft", ...command, observations });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const current = await this.consumer(tx, ctx, command.consumerId);
      const rights = await this.rights(tx, ctx, command.collection, current.id);
      if (!rights.access.canRead) throw missing();
      const draft = (await tx.query<DraftRow>("SELECT id, consumer_id, note, observations, version FROM hs_integration_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND consumer_id=$4 FOR UPDATE", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, current.id])).rows[0] ?? null;
      if ((draft ? Number(draft.version) : 0) !== command.expectedVersion) throw fail("The draft changed. Review it again.");
      const version = command.expectedVersion + 1;
      const body = JSON.stringify({ records: observations.records, references: observations.references });
      if (draft) await tx.query("UPDATE hs_integration_drafts SET note=$4, observations=$5, version=$6, updated_at=clock_timestamp() WHERE tenant_id=$1 AND actor_id=$2 AND consumer_id=$3", [ctx.tenantId, ctx.actor.id, current.id, command.note, body, version]);
      else await tx.query("INSERT INTO hs_integration_drafts(id,tenant_id,workspace_id,actor_id,collection,consumer_id,note,observations,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.collection, current.id, command.note, body]);
      const result = { draftId: draft?.id ?? command.draftId, version, appliedVersion: version, action: "draft", replayed: false, ...flags };
      await this.finish(tx, ctx, command.operationId, requestHash, current.id, version, "draft", result);
      await this.audit(tx, ctx, command.operationId, "integration.draft", { consumerId: current.id, version });
      return result;
    });
  }

  async discardDraft(ctx: RecordContext, input: z.input<typeof discardInput>) {
    const parsed = discardInput.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "discard", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const draft = (await tx.query<DraftRow>("SELECT id, consumer_id, note, observations, version FROM hs_integration_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND consumer_id=$4 FOR UPDATE", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.consumerId])).rows[0];
      if (!draft || Number(draft.version) !== command.expectedVersion) throw fail("The draft changed. Review it again.");
      const rights = await this.rights(tx, ctx, command.collection, command.consumerId);
      if (!rights.access.canRead) throw missing();
      await tx.query("DELETE FROM hs_integration_drafts WHERE tenant_id=$1 AND actor_id=$2 AND consumer_id=$3", [ctx.tenantId, ctx.actor.id, command.consumerId]);
      const result = { discarded: true, appliedVersion: command.expectedVersion, action: "discard", replayed: false, ...flags };
      await this.finish(tx, ctx, command.operationId, requestHash, command.consumerId, command.expectedVersion, "discard", result);
      await this.audit(tx, ctx, command.operationId, "integration.discard", { consumerId: command.consumerId, version: command.expectedVersion });
      return result;
    });
  }

  async grantHealth(ctx: RecordContext, input: z.input<typeof grantInput>) {
    const parsed = grantInput.safeParse(input);
    if (!parsed.success || identifierPayloadHasCredential(input)) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "grant", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      if (prior) return prior;
      const capabilities = await this.collectionCaps(tx, ctx, command.collection);
      if (!capabilities.includes("view") || !capabilities.includes("manage-integration-health")) throw forbidden();
      const current = await this.consumer(tx, ctx, command.consumerId);
      const rights = await this.rights(tx, ctx, command.collection, current.id);
      if (!rights.access.canRepair) throw forbidden();
      const existing = (await tx.query<GrantRow>("SELECT can_read, can_reconcile, can_repair, can_export, can_history, version FROM hs_integration_consumer_grants WHERE tenant_id=$1 AND consumer_id=$2 AND user_id=$3 FOR UPDATE", [ctx.tenantId, current.id, command.userId])).rows[0] ?? null;
      if ((existing ? Number(existing.version) : 0) !== command.expectedVersion) throw fail("The integration grant changed. Review it again.");
      const version = command.expectedVersion + 1;
      if (existing) await tx.query("UPDATE hs_integration_consumer_grants SET can_read=$4, can_reconcile=$5, can_repair=$6, can_export=$7, can_history=$8, version=$9 WHERE tenant_id=$1 AND consumer_id=$2 AND user_id=$3", [ctx.tenantId, current.id, command.userId, command.canRead, command.canReconcile, command.canRepair, command.canExport, command.canHistory, version]);
      else await tx.query("INSERT INTO hs_integration_consumer_grants(tenant_id,consumer_id,user_id,can_read,can_reconcile,can_repair,can_export,can_history,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [ctx.tenantId, current.id, command.userId, command.canRead, command.canReconcile, command.canRepair, command.canExport, command.canHistory, version]);
      const result = { version, appliedVersion: version, action: "grant", replayed: false, ...flags };
      await this.finish(tx, ctx, command.operationId, requestHash, current.id, version, "grant", result);
      await this.audit(tx, ctx, command.operationId, "integration.grant", { consumerId: current.id, granteeId: command.userId, version });
      return result;
    });
  }

  async consumerHistory(ctx: RecordContext, consumerId: string, collection: string) {
    if (!uuid.safeParse(consumerId).success || !collectionName.safeParse(collection).success) throw invalid();
    return this.transaction(ctx, async (tx) => {
      const current = await this.consumer(tx, ctx, consumerId);
      const rights = await this.rights(tx, ctx, collection, current.id);
      if (!rights.access.canHistory) throw forbidden();
      const versions = await tx.query<{ version: number; label: string; outage: string; actor_id: string; source: string; operation_id: string; created_at: string }>("SELECT version, label, outage, actor_id, source, operation_id, created_at FROM hs_integration_consumer_versions WHERE tenant_id=$1 AND consumer_id=$2 ORDER BY version DESC LIMIT 50", [ctx.tenantId, current.id]);
      const repairs = await tx.query<{ action: string; decision: string; actor_id: string; source: string; operation_id: string; created_at: string; applied_version: number }>("SELECT action, decision, actor_id, source, operation_id, created_at, applied_version FROM hs_integration_repairs WHERE tenant_id=$1 AND consumer_id=$2 ORDER BY created_at DESC LIMIT 50", [ctx.tenantId, current.id]);
      return {
        consumerId: current.id,
        versions: versions.rows.map((version) => ({ version: Number(version.version), label: version.label, outage: version.outage, actorId: version.actor_id, source: version.source, operationId: version.operation_id, atIst: formatIst(version.created_at) })),
        repairs: repairs.rows.map((repair) => ({ action: repair.action, decision: repair.decision, actorId: repair.actor_id, source: repair.source, operationId: repair.operation_id, version: Number(repair.applied_version), atIst: formatIst(repair.created_at) })),
        ...flags,
      };
    });
  }

  async downloadEvidence(ctx: RecordContext, input: { collection: string; consumerId?: string }) {
    const parsed = z.object({ collection: collectionName, consumerId: uuid.optional() }).strict().safeParse(input);
    if (!parsed.success) throw invalid();
    return this.transaction(ctx, async (tx) => {
      const capabilities = await this.collectionCaps(tx, ctx, parsed.data.collection);
      if (parsed.data.consumerId) {
        const rights = await this.rights(tx, ctx, parsed.data.collection, parsed.data.consumerId);
        if (!rights.access.canExport) throw forbidden();
      } else if (!capabilities.includes("view") || !capabilities.includes("export")) throw forbidden();
      const consumers = await tx.query<ConsumerRow>("SELECT id, client_id, label, outage, version, updated_at FROM hs_integration_consumers WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY client_id LIMIT 51", [ctx.tenantId, ctx.workspaceId, parsed.data.consumerId ?? null]);
      const exported = [];
      for (const row of consumers.rows) {
        const access = integrationHealthAccess({ recordCapabilities: capabilities, grant: await this.grantOf(tx, ctx, row.id) });
        if (!access.canExport) continue;
        const failures = await this.failures(tx, ctx, parsed.data.collection, row.id);
        const mismatches = await tx.query<MismatchRow>("SELECT id, class, record_id, event_id, reference_key, canonical_version, observed_version, state FROM hs_integration_mismatches WHERE tenant_id=$1 AND consumer_id=$2 ORDER BY created_at LIMIT 200", [ctx.tenantId, row.id]);
        const visibleMismatches = [];
        for (const mismatch of mismatches.rows) {
          if (mismatch.record_id && mismatch.class !== "unknown-record") {
            const record = await this.canView(tx, ctx, mismatch.record_id);
            if (!record || record.collection !== parsed.data.collection) continue;
          }
          visibleMismatches.push({ id: mismatch.id, class: mismatch.class, recordId: mismatch.record_id, eventId: mismatch.event_id, referenceKey: mismatch.reference_key, canonicalVersion: mismatch.canonical_version, observedVersion: mismatch.observed_version, state: mismatch.state });
        }
        exported.push({ id: row.id, clientId: row.client_id, label: row.label, outage: row.outage, version: Number(row.version), deliveryMode: "paused", liveActivation: false, failures, mismatches: visibleMismatches });
      }
      if (!exported.length) throw missing();
      const operationId = randomUUID();
      await this.audit(tx, ctx, operationId, "integration.export", { count: exported.length, collection: parsed.data.collection });
      return { filename: "integration-health-evidence.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from(JSON.stringify({ source: "holy-sheet", ...flags, consumers: exported }), "utf8") };
    });
  }
}
