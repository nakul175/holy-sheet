import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import {
  classifyIdentifierWrite,
  externalIdentifierAccess,
  externalIdentifierStates,
  identifierPayloadHasCredential,
  parseExternalIdentifier,
  planMergeIdentifierRedirect,
  type ExternalIdentifierSnapshot,
  type ExternalIdentifierState,
} from "./external-identifier-mapping";
import { formatIst } from "./ist-label";
import { SharedRecordRepository, type RecordContext, type Stored } from "./shared-records";
import { recordHash, type RecordCapability } from "./shared-record-types";

const uuid = z.string().uuid();
const review = z.object({
  decision: z.enum(["keep", "reassign"]),
  mappingId: uuid,
  version: z.number().int().positive(),
  confirm: z.enum(["keep-external-identifier", "reassign-external-identifier"]),
}).strict();
const previewInput = z.object({
  recordId: uuid,
  namespace: z.string().max(80),
  externalId: z.string().max(200),
  provenanceLabel: z.string().max(120).optional(),
}).strict();
const registerInput = z.object({
  operationId: uuid,
  previewId: uuid,
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  review: review.optional(),
}).strict();
const stateInput = z.object({
  mappingId: uuid,
  operationId: uuid,
  expectedVersion: z.number().int().positive(),
  state: z.enum(externalIdentifierStates),
  confirm: z.literal("set-external-identifier-state"),
}).strict();
const draftInput = z.object({
  draftId: uuid,
  mappingId: uuid,
  recordId: uuid,
  operationId: uuid,
  expectedVersion: z.number().int().nonnegative(),
  namespace: z.string().max(80),
  externalId: z.string().max(200),
  provenanceLabel: z.string().max(120).optional(),
}).strict();
const discardInput = z.object({
  mappingId: uuid,
  operationId: uuid,
  expectedVersion: z.number().int().positive(),
}).strict();
const grantInput = z.object({
  collection: z.string().min(1).max(100),
  namespace: z.string().max(80),
  userId: z.string().min(1).max(200),
  operationId: uuid,
  expectedVersion: z.number().int().nonnegative(),
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canExport: z.boolean(),
  canHistory: z.boolean(),
  confirm: z.literal("grant-integration-metadata-access"),
}).strict();

type MappingRow = {
  id: string;
  namespace: string;
  external_id: string;
  record_id: string;
  original_record_id: string;
  redirected_from_record_id: string | null;
  redirect_reason: "explicit-review" | "merge" | null;
  state: ExternalIdentifierState;
  version: number;
  provenance_label: string;
  created_at: string;
  updated_at: string;
};
type GrantRow = { can_read: boolean; can_write: boolean; can_export: boolean; can_history: boolean; version: number };
type IntegrationRow = { label: string; state: "active" | "archived"; version: number };
type PreviewRow = {
  id: string;
  record_id: string;
  namespace: string;
  external_id: string;
  provenance_label: string;
  conflict: { reviewable: boolean; mappingId?: string; recordId?: string; state?: ExternalIdentifierState; version?: number } | null;
  review_hash: string;
  authority_revision: string;
  expires_at: string;
};
type DraftRow = { id: string; mapping_id: string; record_id: string; namespace: string; external_id: string; provenance_label: string; version: number };
type Conflict = { reviewable: false } | { reviewable: true; mappingId: string; recordId: string; state: ExternalIdentifierState; version: number };

const fail = (message: string, code = "identifier_conflict", status = 409, details?: unknown) => new DocumentError(message, code, status, details);
const missing = () => fail("The external identifier is unavailable.", "identifier_unavailable", 404);
const forbidden = () => fail("External identifier management is not permitted.", "identifier_forbidden", 403);
const invalid = (message = "Review the external identifier.") => fail(message, "identifier_invalid", 400);

function snapshot(row: MappingRow): ExternalIdentifierSnapshot {
  return {
    id: row.id,
    namespace: row.namespace,
    externalId: row.external_id,
    recordId: row.record_id,
    originalRecordId: row.original_record_id,
    state: row.state,
    version: Number(row.version),
  };
}

function conflictOf(existing: ExternalIdentifierSnapshot | null, targetRecordId: string, reviewable: boolean): Conflict | null {
  if (!existing || (existing.recordId === targetRecordId && existing.state === "active")) return null;
  if (!reviewable || existing.recordId === targetRecordId) return { reviewable: false };
  return { reviewable: true, mappingId: existing.id, recordId: existing.recordId, state: existing.state, version: existing.version };
}

export async function redirectExternalIdentifierMappings(tx: Sql, input: { tenantId: string; actorId: string; sourceId: string; survivorId: string; operationId: string }) {
  const rows = await tx.query<MappingRow>("SELECT id, namespace, external_id, record_id, original_record_id, redirected_from_record_id, redirect_reason, state, version, provenance_label, created_at, updated_at FROM hs_external_identifier_mappings WHERE tenant_id=$1 AND record_id=$2 FOR UPDATE", [input.tenantId, input.sourceId]);
  const plan = planMergeIdentifierRedirect(rows.rows.map(snapshot), input.sourceId, input.survivorId);
  if (!plan.ok) return { redirected: 0 };
  for (const current of rows.rows) {
    const next = plan.redirects.find((item) => item.id === current.id);
    if (!next) continue;
    await tx.query("UPDATE hs_external_identifier_mappings SET record_id=$3, redirected_from_record_id=$4, redirect_reason='merge', version=version+1, updated_by=$5, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [input.tenantId, current.id, input.survivorId, current.record_id, input.actorId]);
    const stored = { ...current, record_id: input.survivorId, redirected_from_record_id: current.record_id, redirect_reason: "merge" as const, version: Number(current.version) + 1 };
    await rememberVersion(tx, input.tenantId, input.actorId, input.operationId, stored);
    await audit(tx, input.actorId, input.operationId, "external-identifier.merge-redirect", publicAudit(input.tenantId, stored));
  }
  return { redirected: plan.redirects.length };
}

async function rememberVersion(tx: Sql, tenantId: string, actorId: string, operationId: string, row: MappingRow) {
  await tx.query("INSERT INTO hs_external_identifier_versions(tenant_id,mapping_id,version,namespace,external_id,record_id,original_record_id,redirected_from_record_id,redirect_reason,state,provenance_label,actor_id,operation_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'holy-sheet')", [tenantId, row.id, Number(row.version), row.namespace, row.external_id, row.record_id, row.original_record_id, row.redirected_from_record_id, row.redirect_reason, row.state, row.provenance_label, actorId, operationId]);
}

function publicAudit(tenantId: string, row: Pick<MappingRow, "id" | "namespace" | "external_id" | "record_id" | "original_record_id" | "state" | "version">, extra: Record<string, unknown> = {}) {
  return { tenantId, mappingId: row.id, namespace: row.namespace, externalId: row.external_id, recordId: row.record_id, originalRecordId: row.original_record_id, state: row.state, version: Number(row.version), ...extra, source: "holy-sheet", atIst: formatIst(new Date()) };
}

async function audit(tx: Sql, actorId: string, operationId: string, action: string, after: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)", [randomUUID(), actorId, action, JSON.stringify(after), operationId]);
}

export class ExternalIdentifierRepository extends SharedRecordRepository {
  private async visibleRecord(tx: Sql, ctx: RecordContext, recordId: string) {
    if (!uuid.safeParse(recordId).success) throw missing();
    const record = (await tx.query<Stored>("SELECT * FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state<>'trashed' FOR UPDATE", [recordId, ctx.tenantId])).rows[0];
    if (!record) throw missing();
    const capabilities = await this.caps(tx, ctx, record);
    if (!capabilities.includes("view")) throw missing();
    return { record, capabilities };
  }

  private async connectable(tx: Sql, ctx: RecordContext, recordId: string) {
    const found = await this.visibleRecord(tx, ctx, recordId);
    if (found.record.merged_into_id) throw fail("This record was merged. Connect the identifier to the surviving record.", "identifier_merged", 409);
    if (found.record.state !== "active") throw fail("Restore the record before connecting an identifier.", "identifier_record_inactive", 409);
    if (!found.capabilities.includes("edit") || !found.capabilities.includes("manage-external-ids")) throw forbidden();
    return found;
  }

  private async integration(tx: Sql, ctx: RecordContext, namespace: string) {
    const row = (await tx.query<IntegrationRow>("SELECT label, state, version FROM hs_external_integrations WHERE tenant_id=$1 AND namespace=$2", [ctx.tenantId, namespace])).rows[0] ?? null;
    const grant = row ? (await tx.query<GrantRow>("SELECT can_read, can_write, can_export, can_history, version FROM hs_external_integration_grants WHERE tenant_id=$1 AND namespace=$2 AND user_id=$3", [ctx.tenantId, namespace, ctx.actor.id])).rows[0] ?? null : null;
    return { row, grant };
  }

  private access(capabilities: RecordCapability[], grant: GrantRow | null) {
    return externalIdentifierAccess({
      recordCapabilities: capabilities,
      integration: grant ? { canRead: grant.can_read, canWrite: grant.can_write, canExport: grant.can_export, canHistory: grant.can_history } : null,
    });
  }

  private present(row: MappingRow, capabilities: RecordCapability[], grant: GrantRow | null) {
    const access = this.access(capabilities, grant);
    return {
      id: row.id,
      namespace: row.namespace,
      externalId: row.external_id,
      recordId: row.record_id,
      originalRecordId: row.original_record_id,
      redirectedFromRecordId: row.redirected_from_record_id,
      redirectReason: row.redirect_reason,
      state: row.state,
      version: Number(row.version),
      provenanceLabel: row.provenance_label,
      atIst: formatIst(row.updated_at),
      canRead: access.canRead,
      canWrite: access.canWrite,
      canExport: access.canExport,
      canHistory: access.canHistory,
      credentialsStored: false,
      accessGranted: false,
    };
  }

  private async mapping(tx: Sql, ctx: RecordContext, namespace: string, externalId: string) {
    return (await tx.query<MappingRow>("SELECT id, namespace, external_id, record_id, original_record_id, redirected_from_record_id, redirect_reason, state, version, provenance_label, created_at, updated_at FROM hs_external_identifier_mappings WHERE tenant_id=$1 AND workspace_id=$2 AND namespace=$3 AND external_id=$4 FOR UPDATE", [ctx.tenantId, ctx.workspaceId, namespace, externalId])).rows[0] ?? null;
  }

  private async byId(tx: Sql, ctx: RecordContext, mappingId: string) {
    if (!uuid.safeParse(mappingId).success) throw missing();
    const row = (await tx.query<MappingRow>("SELECT id, namespace, external_id, record_id, original_record_id, redirected_from_record_id, redirect_reason, state, version, provenance_label, created_at, updated_at FROM hs_external_identifier_mappings WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE", [mappingId, ctx.tenantId, ctx.workspaceId])).rows[0];
    if (!row) throw missing();
    return row;
  }

  private async seen(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string) {
    const prior = (await tx.query<{ request_hash: string; mapping_id: string; applied_version: number }>("SELECT request_hash, mapping_id, applied_version FROM hs_external_identifier_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, operationId])).rows[0];
    if (prior && prior.request_hash !== requestHash) throw fail("Operation identity was reused.", "operation_mismatch");
    return prior ?? null;
  }

  private async finish(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string, row: MappingRow, kind: string) {
    await tx.query("INSERT INTO hs_external_identifier_operations(tenant_id,actor_id,operation_id,request_hash,mapping_id,applied_version,kind) VALUES($1,$2,$3,$4,$5,$6,$7)", [ctx.tenantId, ctx.actor.id, operationId, requestHash, row.id, Number(row.version), kind]);
  }

  private async readable(tx: Sql, ctx: RecordContext, row: MappingRow) {
    let found: { record: Stored; capabilities: RecordCapability[] };
    try {
      found = await this.visibleRecord(tx, ctx, row.record_id);
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) throw missing();
      throw error;
    }
    const integration = await this.integration(tx, ctx, row.namespace);
    const access = this.access(found.capabilities, integration.grant);
    if (!access.canRead) throw missing();
    return { ...found, integration, access };
  }

  async listMappings(ctx: RecordContext, input: { collection: string; recordId?: string; query?: string; namespace?: string }) {
    const parsed = z.object({
      collection: z.string().min(1).max(100),
      recordId: uuid.optional(),
      query: z.string().max(100).optional(),
      namespace: z.string().max(80).optional(),
    }).strict().safeParse(input);
    if (!parsed.success || (parsed.data.query && /[\p{Cc}]/u.test(parsed.data.query)) || (parsed.data.namespace && !parseExternalIdentifier({ namespace: parsed.data.namespace, externalId: "placeholder" }).ok)) throw invalid("Review the identifier search.");
    const term = parsed.data.query?.trim() ?? "";
    const namespace = parsed.data.namespace ?? "";
    return this.transaction(ctx, async (tx) => {
      const capabilities = await this.collectionCaps(tx, ctx, parsed.data.collection);
      if (parsed.data.recordId) await this.visibleRecord(tx, ctx, parsed.data.recordId);
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = await tx.query<MappingRow>(`SELECT m.id, m.namespace, m.external_id, m.record_id, m.original_record_id, m.redirected_from_record_id, m.redirect_reason, m.state, m.version, m.provenance_label, m.created_at, m.updated_at
        FROM hs_external_identifier_mappings m
        JOIN hs_data_records r ON r.tenant_id=m.tenant_id AND r.id=m.record_id
        WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND r.collection=$3 AND r.state<>'trashed'
        AND ($4::uuid IS NULL OR m.record_id=$4)
        AND ($5::text='' OR m.namespace=$5)
        AND ($6::text='' OR lower(m.namespace) LIKE lower($7) ESCAPE '\\' OR lower(m.external_id) LIKE lower($7) ESCAPE '\\')
        ORDER BY m.namespace, m.external_id, m.id LIMIT 201`, [ctx.tenantId, ctx.workspaceId, parsed.data.collection, parsed.data.recordId ?? null, namespace, term, pattern]);
      if (rows.rows.length > 200) throw invalid("Use a narrower identifier search.");
      const grants = rows.rows.length ? await tx.query<GrantRow & { namespace: string }>("SELECT namespace, can_read, can_write, can_export, can_history, version FROM hs_external_integration_grants WHERE tenant_id=$1 AND user_id=$2 AND namespace=ANY($3::text[])", [ctx.tenantId, ctx.actor.id, [...new Set(rows.rows.map((row) => row.namespace))]]) : { rows: [] as Array<GrantRow & { namespace: string }> };
      const recordGrants = rows.rows.length ? await tx.query<{ record_id: string; capabilities: RecordCapability[] }>("SELECT record_id, capabilities FROM hs_data_record_grants WHERE tenant_id=$1 AND user_id=$2 AND record_id=ANY($3::uuid[])", [ctx.tenantId, ctx.actor.id, rows.rows.map((row) => row.record_id)]) : { rows: [] as Array<{ record_id: string; capabilities: RecordCapability[] }> };
      const mappings = [];
      for (const row of rows.rows) {
        const recordCapabilities = [...new Set([...capabilities, ...(recordGrants.rows.find((grant) => grant.record_id === row.record_id)?.capabilities ?? [])])];
        const grant = grants.rows.find((item) => item.namespace === row.namespace) ?? null;
        if (!this.access(recordCapabilities, grant).canRead) continue;
        mappings.push(this.present(row, recordCapabilities, grant));
      }
      const drafts = await tx.query<DraftRow>("SELECT id, mapping_id, record_id, namespace, external_id, provenance_label, version FROM hs_external_identifier_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND collection=$4 AND ($5::uuid IS NULL OR record_id=$5) ORDER BY mapping_id", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, parsed.data.collection, parsed.data.recordId ?? null]);
      return {
        mappings,
        drafts: drafts.rows.map((row) => ({ id: row.id, mappingId: row.mapping_id, recordId: row.record_id, namespace: row.namespace, externalId: row.external_id, provenanceLabel: row.provenance_label, version: Number(row.version) })),
        credentialsStored: false,
        accessGranted: false,
      };
    });
  }

  private async described(tx: Sql, ctx: RecordContext, recordId: string, namespace: string, externalId: string) {
    const target = await this.connectable(tx, ctx, recordId);
    const integration = await this.integration(tx, ctx, namespace);
    if (integration.row?.state === "archived") throw fail("This integration namespace is archived.", "identifier_integration_archived", 409);
    if (integration.row && !integration.grant?.can_write) throw forbidden();
    if (!integration.row && (!target.capabilities.includes("view") || !target.capabilities.includes("edit") || !target.capabilities.includes("manage-external-ids"))) throw forbidden();
    const existing = await this.mapping(tx, ctx, namespace, externalId);
    let reviewable = false;
    if (existing && existing.record_id !== recordId) {
      try {
        const current = await this.visibleRecord(tx, ctx, existing.record_id);
        reviewable = current.capabilities.includes("edit") && current.capabilities.includes("manage-external-ids") && !current.record.merged_into_id;
      } catch (error) {
        if (!(error instanceof DocumentError && [403, 404].includes(error.status))) throw error;
        reviewable = false;
      }
    }
    return { target, integration, existing, conflict: conflictOf(existing ? snapshot(existing) : null, recordId, reviewable) };
  }

  async previewMapping(ctx: RecordContext, input: z.input<typeof previewInput>) {
    const parsed = previewInput.safeParse(input);
    const identifier = parsed.success ? parseExternalIdentifier(parsed.data) : { ok: false as const };
    if (!parsed.success || !identifier.ok || identifierPayloadHasCredential(input)) throw invalid();
    return this.transaction(ctx, async (tx, _tenant, proof) => {
      const described = await this.described(tx, ctx, parsed.data.recordId, identifier.namespace, identifier.externalId);
      const previewId = randomUUID();
      const reviewHash = recordHash({ previewId, recordId: parsed.data.recordId, namespace: identifier.namespace, externalId: identifier.externalId, provenanceLabel: identifier.provenanceLabel, conflict: described.conflict, authorityRevision: proof.revision });
      await tx.query("INSERT INTO hs_external_identifier_previews(id,tenant_id,workspace_id,actor_id,record_id,namespace,external_id,provenance_label,conflict,review_hash,authority_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, parsed.data.recordId, identifier.namespace, identifier.externalId, identifier.provenanceLabel, described.conflict ? JSON.stringify(described.conflict) : null, reviewHash, proof.revision]);
      const expiry = (await tx.query<{ expires_at: string }>("SELECT expires_at FROM hs_external_identifier_previews WHERE id=$1", [previewId])).rows[0];
      return {
        previewId,
        reviewHash,
        expiresAt: new Date(expiry.expires_at).toISOString(),
        namespace: identifier.namespace,
        externalId: identifier.externalId,
        recordId: parsed.data.recordId,
        provenanceLabel: identifier.provenanceLabel,
        conflict: described.conflict,
        impact: "This connects an external identifier to the canonical record. It does not grant access or store a credential.",
        credentialsStored: false,
        accessGranted: false,
      };
    });
  }

  async registerMapping(ctx: RecordContext, input: z.input<typeof registerInput>) {
    const parsed = registerInput.safeParse(input);
    if (!parsed.success || identifierPayloadHasCredential(input)) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "register", ...command });
    return this.transaction(ctx, async (tx, _tenant, proof) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      const preview = (await tx.query<PreviewRow>("SELECT id, record_id, namespace, external_id, provenance_label, conflict, review_hash, authority_revision, expires_at FROM hs_external_identifier_previews WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4", [command.previewId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
      if (!preview) throw fail("The identifier review is unavailable.", "identifier_preview_unavailable", 404);
      if (prior) {
        const row = await this.byId(tx, ctx, prior.mapping_id);
        const readable = await this.readable(tx, ctx, row);
        return { mapping: this.present(row, readable.capabilities, readable.integration.grant), appliedVersion: prior.applied_version, replayed: true, action: "unchanged" as const, credentialsStored: false, accessGranted: false };
      }
      if (new Date(preview.expires_at).getTime() <= Date.now() || preview.review_hash !== command.reviewHash || preview.authority_revision !== proof.revision) throw fail("The identifier review expired or changed. Review it again.", "identifier_preview_stale", 409);
      const described = await this.described(tx, ctx, preview.record_id, preview.namespace, preview.external_id);
      const currentHash = recordHash({ previewId: preview.id, recordId: preview.record_id, namespace: preview.namespace, externalId: preview.external_id, provenanceLabel: preview.provenance_label, conflict: described.conflict, authorityRevision: proof.revision });
      if (currentHash !== preview.review_hash) throw fail("The identifier changed. Review it again.", "identifier_preview_stale", 409);
      const classification = classifyIdentifierWrite(described.existing ? snapshot(described.existing) : null, { namespace: preview.namespace, externalId: preview.external_id, recordId: preview.record_id, provenanceLabel: preview.provenance_label, ...(command.review ? { review: command.review } : {}) });
      if (classification.action === "reject") throw invalid("The identifier review does not match the current mapping.");
      if (classification.action === "conflict") throw fail("This external identifier is already connected. Review it before any reassignment.", "identifier_conflict", 409, described.conflict ?? { reviewable: false });
      let row = described.existing;
      let action: "create" | "unchanged" | "reassign" | "update-provenance" = "unchanged";
      if (classification.action === "create") {
        const integration = described.integration.row ?? await this.createIntegration(tx, ctx, preview.namespace);
        if (integration.state !== "active") throw fail("This integration namespace is archived.", "identifier_integration_archived", 409);
        const created: MappingRow = { id: randomUUID(), namespace: preview.namespace, external_id: preview.external_id, record_id: preview.record_id, original_record_id: preview.record_id, redirected_from_record_id: null, redirect_reason: null, state: "active", version: 1, provenance_label: preview.provenance_label, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        await tx.query("INSERT INTO hs_external_identifier_mappings(id,tenant_id,workspace_id,namespace,external_id,record_id,original_record_id,state,version,provenance_label,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6,'active',1,$7,$8,$8)", [created.id, ctx.tenantId, ctx.workspaceId, created.namespace, created.external_id, created.record_id, created.provenance_label, ctx.actor.id]);
        await rememberVersion(tx, ctx.tenantId, ctx.actor.id, command.operationId, created);
        await audit(tx, ctx.actor.id, command.operationId, "external-identifier.register", publicAudit(ctx.tenantId, created, { operation: "register", workspaceId: ctx.workspaceId }));
        row = created;
        action = "create";
      } else if (classification.action === "reassign" && row) {
        if (described.conflict?.reviewable !== true) throw fail("Review needs permission on both records.", "identifier_conflict", 409, { reviewable: false });
        await tx.query("UPDATE hs_external_identifier_mappings SET record_id=$3, redirected_from_record_id=$4, redirect_reason='explicit-review', provenance_label=$5, version=version+1, updated_by=$6, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, row.id, classification.toRecordId, row.record_id, preview.provenance_label, ctx.actor.id]);
        row = { ...row, record_id: classification.toRecordId, redirected_from_record_id: row.record_id, redirect_reason: "explicit-review", provenance_label: preview.provenance_label, version: Number(row.version) + 1 };
        await rememberVersion(tx, ctx.tenantId, ctx.actor.id, command.operationId, row);
        await audit(tx, ctx.actor.id, command.operationId, "external-identifier.reassign", publicAudit(ctx.tenantId, row, { operation: "reassign", workspaceId: ctx.workspaceId }));
        action = "reassign";
      } else if (row && row.provenance_label !== preview.provenance_label && row.record_id === preview.record_id && row.state === "active") {
        await tx.query("UPDATE hs_external_identifier_mappings SET provenance_label=$3, version=version+1, updated_by=$4, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, row.id, preview.provenance_label, ctx.actor.id]);
        row = { ...row, provenance_label: preview.provenance_label, version: Number(row.version) + 1 };
        await rememberVersion(tx, ctx.tenantId, ctx.actor.id, command.operationId, row);
        await audit(tx, ctx.actor.id, command.operationId, "external-identifier.provenance", publicAudit(ctx.tenantId, row, { operation: "provenance", workspaceId: ctx.workspaceId }));
        action = "update-provenance";
      }
      if (!row) throw missing();
      await this.finish(tx, ctx, command.operationId, requestHash, row, action);
      const readable = await this.readable(tx, ctx, row);
      return { mapping: this.present(row, readable.capabilities, readable.integration.grant), appliedVersion: Number(row.version), replayed: false, action, credentialsStored: false, accessGranted: false };
    });
  }

  private async createIntegration(tx: Sql, ctx: RecordContext, namespace: string) {
    await tx.query("INSERT INTO hs_external_integrations(tenant_id,workspace_id,namespace,label,created_by) VALUES($1,$2,$3,$3,$4)", [ctx.tenantId, ctx.workspaceId, namespace, ctx.actor.id]);
    await tx.query("INSERT INTO hs_external_integration_grants(tenant_id,namespace,user_id,can_read,can_write,can_export,can_history) VALUES($1,$2,$3,true,true,true,true)", [ctx.tenantId, namespace, ctx.actor.id]);
    await audit(tx, ctx.actor.id, randomUUID(), "external-identifier.integration", { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, namespace, operation: "register-namespace", source: "holy-sheet", atIst: formatIst(new Date()), accessGranted: false });
    return { label: namespace, state: "active" as const, version: 1 };
  }

  async setMappingState(ctx: RecordContext, input: z.input<typeof stateInput>) {
    const parsed = stateInput.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "state", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      const row = await this.byId(tx, ctx, prior?.mapping_id ?? command.mappingId);
      const readable = await this.readable(tx, ctx, row);
      if (!readable.access.canWrite) throw forbidden();
      if (prior) return { mapping: this.present(row, readable.capabilities, readable.integration.grant), appliedVersion: prior.applied_version, replayed: true, credentialsStored: false, accessGranted: false };
      if (Number(row.version) !== command.expectedVersion) throw fail("The identifier changed. Review it again.");
      if (readable.integration.row?.state === "archived" && command.state === "active") throw fail("This integration namespace is archived.", "identifier_integration_archived", 409);
      if (row.state === command.state) {
        await this.finish(tx, ctx, command.operationId, requestHash, row, "state");
        return { mapping: this.present(row, readable.capabilities, readable.integration.grant), appliedVersion: Number(row.version), replayed: false, credentialsStored: false, accessGranted: false };
      }
      await tx.query("UPDATE hs_external_identifier_mappings SET state=$3, version=version+1, updated_by=$4, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, row.id, command.state, ctx.actor.id]);
      const next = { ...row, state: command.state, version: Number(row.version) + 1 };
      await rememberVersion(tx, ctx.tenantId, ctx.actor.id, command.operationId, next);
      await audit(tx, ctx.actor.id, command.operationId, "external-identifier.state", publicAudit(ctx.tenantId, next, { operation: "state", workspaceId: ctx.workspaceId }));
      await this.finish(tx, ctx, command.operationId, requestHash, next, "state");
      return { mapping: this.present(next, readable.capabilities, readable.integration.grant), appliedVersion: next.version, replayed: false, credentialsStored: false, accessGranted: false };
    });
  }

  async saveDraft(ctx: RecordContext, input: z.input<typeof draftInput>) {
    const parsed = draftInput.safeParse(input);
    const identifier = parsed.success ? parseExternalIdentifier(parsed.data) : { ok: false as const };
    if (!parsed.success || !identifier.ok || identifierPayloadHasCredential(input)) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "draft", ...command, ...identifier });
    return this.transaction(ctx, async (tx) => {
      await this.visibleRecord(tx, ctx, command.recordId);
      const collection = (await tx.query<{ collection: string }>("SELECT collection FROM hs_data_records WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, command.recordId])).rows[0]?.collection;
      if (!collection) throw missing();
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      const current = (await tx.query<DraftRow>("SELECT id, mapping_id, record_id, namespace, external_id, provenance_label, version FROM hs_external_identifier_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND mapping_id=$4 FOR UPDATE", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.mappingId])).rows[0];
      if (prior) return { draftId: current?.id ?? command.draftId, version: prior.applied_version, replayed: true, credentialsStored: false, accessGranted: false };
      if (current && Number(current.version) !== command.expectedVersion) throw fail("The draft changed. Review it again.");
      if (!current && command.expectedVersion !== 0) throw fail("The draft changed. Review it again.");
      const version = current ? Number(current.version) + 1 : 1;
      if (current) await tx.query("UPDATE hs_external_identifier_drafts SET namespace=$4, external_id=$5, provenance_label=$6, version=$7, updated_at=clock_timestamp() WHERE tenant_id=$1 AND actor_id=$2 AND mapping_id=$3", [ctx.tenantId, ctx.actor.id, command.mappingId, identifier.namespace, identifier.externalId, identifier.provenanceLabel, version]);
      else await tx.query("INSERT INTO hs_external_identifier_drafts(id,tenant_id,workspace_id,actor_id,collection,record_id,mapping_id,namespace,external_id,provenance_label,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, collection, command.recordId, command.mappingId, identifier.namespace, identifier.externalId, identifier.provenanceLabel]);
      await tx.query("INSERT INTO hs_external_identifier_operations(tenant_id,actor_id,operation_id,request_hash,mapping_id,applied_version,kind) VALUES($1,$2,$3,$4,$5,$6,'draft')", [ctx.tenantId, ctx.actor.id, command.operationId, requestHash, command.mappingId, version]);
      await audit(tx, ctx.actor.id, command.operationId, "external-identifier.draft", { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, mappingId: command.mappingId, recordId: command.recordId, version, operation: "draft", source: "holy-sheet", atIst: formatIst(new Date()), accessGranted: false });
      return { draftId: current?.id ?? command.draftId, version, replayed: false, credentialsStored: false, accessGranted: false };
    });
  }

  async discardDraft(ctx: RecordContext, input: z.input<typeof discardInput>) {
    const parsed = discardInput.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "discard", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      const current = (await tx.query<DraftRow>("SELECT id, mapping_id, record_id, namespace, external_id, provenance_label, version FROM hs_external_identifier_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND mapping_id=$4 FOR UPDATE", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.mappingId])).rows[0];
      if (prior) return { discarded: true, replayed: true, credentialsStored: false, accessGranted: false };
      if (!current || Number(current.version) !== command.expectedVersion) throw fail("The draft changed. Review it again.");
      await this.visibleRecord(tx, ctx, current.record_id);
      await tx.query("DELETE FROM hs_external_identifier_drafts WHERE tenant_id=$1 AND actor_id=$2 AND mapping_id=$3", [ctx.tenantId, ctx.actor.id, command.mappingId]);
      await tx.query("INSERT INTO hs_external_identifier_operations(tenant_id,actor_id,operation_id,request_hash,mapping_id,applied_version,kind) VALUES($1,$2,$3,$4,$5,$6,'discard')", [ctx.tenantId, ctx.actor.id, command.operationId, requestHash, command.mappingId, command.expectedVersion]);
      await audit(tx, ctx.actor.id, command.operationId, "external-identifier.discard", { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, mappingId: command.mappingId, version: command.expectedVersion, operation: "discard", source: "holy-sheet", atIst: formatIst(new Date()), accessGranted: false });
      return { discarded: true, replayed: false, credentialsStored: false, accessGranted: false };
    });
  }

  async grantIntegration(ctx: RecordContext, input: z.input<typeof grantInput>) {
    const parsed = grantInput.safeParse(input);
    const namespace = parsed.success ? parseExternalIdentifier({ namespace: parsed.data.namespace, externalId: "placeholder" }) : { ok: false as const };
    if (!parsed.success || !namespace.ok || identifierPayloadHasCredential(input)) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "grant", ...command, namespace: namespace.namespace });
    return this.transaction(ctx, async (tx) => {
      const capabilities = await this.collectionCaps(tx, ctx, command.collection);
      if (!capabilities.includes("view") || !capabilities.includes("manage-external-ids")) throw forbidden();
      const integration = await this.integration(tx, ctx, namespace.namespace);
      if (!integration.row || !integration.grant?.can_write) throw forbidden();
      const prior = await this.seen(tx, ctx, command.operationId, requestHash);
      const existing = (await tx.query<GrantRow>("SELECT can_read, can_write, can_export, can_history, version FROM hs_external_integration_grants WHERE tenant_id=$1 AND namespace=$2 AND user_id=$3 FOR UPDATE", [ctx.tenantId, namespace.namespace, command.userId])).rows[0];
      if (prior) return { version: prior.applied_version, replayed: true, credentialsStored: false, accessGranted: false };
      if ((existing ? Number(existing.version) : 0) !== command.expectedVersion) throw fail("The integration grant changed. Review it again.");
      const version = command.expectedVersion + 1;
      if (existing) await tx.query("UPDATE hs_external_integration_grants SET can_read=$4, can_write=$5, can_export=$6, can_history=$7, version=$8 WHERE tenant_id=$1 AND namespace=$2 AND user_id=$3", [ctx.tenantId, namespace.namespace, command.userId, command.canRead, command.canWrite, command.canExport, command.canHistory, version]);
      else await tx.query("INSERT INTO hs_external_integration_grants(tenant_id,namespace,user_id,can_read,can_write,can_export,can_history,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [ctx.tenantId, namespace.namespace, command.userId, command.canRead, command.canWrite, command.canExport, command.canHistory, version]);
      await tx.query("INSERT INTO hs_external_identifier_operations(tenant_id,actor_id,operation_id,request_hash,mapping_id,applied_version,kind) VALUES($1,$2,$3,$4,$5,$6,'grant')", [ctx.tenantId, ctx.actor.id, command.operationId, requestHash, randomUUID(), version]);
      await audit(tx, ctx.actor.id, command.operationId, "external-identifier.grant", { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, namespace: namespace.namespace, granteeId: command.userId, version, operation: "grant", source: "holy-sheet", atIst: formatIst(new Date()), accessGranted: false });
      return { version, replayed: false, credentialsStored: false, accessGranted: false };
    });
  }

  async mappingHistory(ctx: RecordContext, mappingId: string) {
    if (!uuid.safeParse(mappingId).success) throw missing();
    return this.transaction(ctx, async (tx) => {
      const row = await this.byId(tx, ctx, mappingId);
      const readable = await this.readable(tx, ctx, row);
      if (!readable.access.canHistory) throw forbidden();
      const versions = await tx.query<{ version: number; record_id: string; original_record_id: string; state: ExternalIdentifierState; actor_id: string; source: string; operation_id: string; created_at: string; redirect_reason: string | null }>("SELECT version, record_id, original_record_id, state, actor_id, source, operation_id, created_at, redirect_reason FROM hs_external_identifier_versions WHERE tenant_id=$1 AND mapping_id=$2 ORDER BY version DESC LIMIT 50", [ctx.tenantId, mappingId]);
      return {
        mappingId,
        versions: versions.rows.map((version) => ({ version: Number(version.version), recordId: version.record_id, originalRecordId: version.original_record_id, state: version.state, redirectReason: version.redirect_reason, actorId: version.actor_id, source: version.source, operationId: version.operation_id, atIst: formatIst(version.created_at) })),
        credentialsStored: false,
        accessGranted: false,
      };
    });
  }

  async downloadMappings(ctx: RecordContext, input: { recordId?: string; namespace?: string }) {
    const parsed = z.object({ recordId: uuid.optional(), namespace: z.string().max(80).optional() }).strict().safeParse(input);
    const namespace = parsed.success && parsed.data.namespace ? parseExternalIdentifier({ namespace: parsed.data.namespace, externalId: "placeholder" }) : { ok: true as const, namespace: "" };
    if (!parsed.success || (!parsed.data.recordId && !parsed.data.namespace) || !namespace.ok) throw invalid();
    return this.transaction(ctx, async (tx) => {
      if (parsed.data.recordId) await this.visibleRecord(tx, ctx, parsed.data.recordId);
      const rows = await tx.query<MappingRow>("SELECT m.id, m.namespace, m.external_id, m.record_id, m.original_record_id, m.redirected_from_record_id, m.redirect_reason, m.state, m.version, m.provenance_label, m.created_at, m.updated_at FROM hs_external_identifier_mappings m WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND ($3::uuid IS NULL OR m.record_id=$3) AND ($4::text='' OR m.namespace=$4) ORDER BY m.namespace, m.external_id LIMIT 201", [ctx.tenantId, ctx.workspaceId, parsed.data.recordId ?? null, namespace.namespace]);
      if (rows.rows.length > 200) throw invalid("Use a narrower identifier download.");
      const exported = [];
      for (const row of rows.rows) {
        const readable = await this.readable(tx, ctx, row).catch((error: unknown) => {
          if (error instanceof DocumentError && error.status === 404) return null;
          throw error;
        });
        if (!readable) continue;
        if (!readable.access.canExport) {
          if (parsed.data.recordId) throw forbidden();
          continue;
        }
        exported.push({ id: row.id, namespace: row.namespace, externalId: row.external_id, recordId: row.record_id, originalRecordId: row.original_record_id, state: row.state, version: Number(row.version), provenanceLabel: row.provenance_label });
      }
      if (!exported.length) throw missing();
      const operationId = randomUUID();
      await audit(tx, ctx.actor.id, operationId, "external-identifier.export", { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, count: exported.length, operation: "export", source: "holy-sheet", atIst: formatIst(new Date()), accessGranted: false });
      return { filename: "external-identifier-mappings.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from(JSON.stringify({ source: "holy-sheet", credentialsStored: false, accessGranted: false, mappings: exported }), "utf8") };
    });
  }
}
