import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { recordHash, type RecordCapability } from "./shared-record-types";
import { SharedRecordRelationshipRepository } from "./shared-record-relationships";
import type { RecordContext, Stored } from "./shared-records";

const uuid = z.string().uuid();
const bulkKinds = ["contact-account", "employee-account", "contract-legal-party", "contract-account", "parent-organisation"] as const;
const operations = ["add", "remove", "replace"] as const;
export type BulkRelationshipKind = (typeof bulkKinds)[number];
export type BulkRelationshipOperation = (typeof operations)[number];
const shape: Record<BulkRelationshipKind, { source: string; target: string }> = {
  "contact-account": { source: "contacts", target: "accounts" },
  "employee-account": { source: "employees", target: "accounts" },
  "contract-legal-party": { source: "contracts", target: "organisations" },
  "contract-account": { source: "contracts", target: "accounts" },
  "parent-organisation": { source: "accounts", target: "organisations" },
};
const selectionSchema = z
  .object({
    sourceIds: z.array(uuid).min(1).max(1000),
    kind: z.enum(bulkKinds),
    operation: z.enum(operations),
    targetId: uuid,
    role: z.string().trim().max(100).default(""),
    primary: z.boolean().default(false),
    status: z.enum(["active", "inactive"]).default("active"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.sourceIds).size !== value.sourceIds.length) ctx.addIssue({ code: "custom", message: "duplicate" });
    if (value.primary && value.kind !== "contact-account") ctx.addIssue({ code: "custom", message: "primary" });
  });
const executeObject = z
  .object({
    operationId: uuid,
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
    sourceIds: z.array(uuid).min(1).max(1000),
    kind: z.enum(bulkKinds),
    operation: z.enum(operations),
    targetId: uuid,
    role: z.string().trim().max(100).default(""),
    primary: z.boolean().default(false),
    status: z.enum(["active", "inactive"]).default("active"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.sourceIds).size !== value.sourceIds.length) ctx.addIssue({ code: "custom", message: "duplicate" });
    if (value.primary && value.kind !== "contact-account") ctx.addIssue({ code: "custom", message: "primary" });
  });
const draftCollections = ["accounts", "contacts", "employees", "contracts"] as const;
const draftPayloadSchema = z
  .object({
    collection: z.enum(draftCollections),
    sourceIds: z.array(uuid).max(1000).default([]),
    kind: z.enum(bulkKinds),
    operation: z.enum(operations),
    targetId: z.union([uuid, z.literal("")]).default(""),
    role: z.string().trim().max(100).default(""),
    primary: z.boolean().default(false),
    status: z.enum(["active", "inactive"]).default("active"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.sourceIds).size !== value.sourceIds.length) ctx.addIssue({ code: "custom", message: "duplicate" });
    if (shape[value.kind].source !== value.collection) ctx.addIssue({ code: "custom", message: "kind" });
    if (value.primary && value.kind !== "contact-account") ctx.addIssue({ code: "custom", message: "primary" });
  });
const draftSaveSchema = z
  .object({
    draftId: uuid,
    operationId: uuid,
    expectedVersion: z.number().int().nonnegative(),
    payload: draftPayloadSchema,
  })
  .strict();
const draftDiscardSchema = z
  .object({
    draftId: uuid,
    operationId: uuid,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

type Selection = z.infer<typeof selectionSchema>;
type LinkMeta = { role: string; primary: boolean; status: "active" | "inactive" };
type Change = {
  action: "insert" | "update" | "delete" | "reparent";
  kind: string;
  targetId: string;
  relationshipId: string | null;
  before: LinkMeta | null;
  after: LinkMeta | null;
};
type Edge = LinkMeta & { id: string; kind: string; targetId: string };
type Reference = { recordId: string; sourceApp: string; sourceType: string; sourceId: string };
type Constraint = { code: string; recordId: string; message: string };
type Plan = {
  sourceId: string;
  ordinal: number;
  outcome: "success" | "skipped" | "error";
  code: string;
  message: string;
  version: number | null;
  parentOrganisationId: string | null;
  edges: Edge[];
  changes: Change[];
  contextReferences: Reference[];
  deletionConstraints: Constraint[];
  affectedContractIds: string[];
  hiddenAffectedContracts: boolean;
  legalPartiesWillChange: false;
};
type Access = { record: Stored | null; caps: RecordCapability[]; problem: null | "absent" | "forbidden" | "archived" | "merged" };
type Review = {
  previewToken: string;
  kind: BulkRelationshipKind;
  operation: BulkRelationshipOperation;
  plans: Plan[];
  names: Record<string, string>;
  contractNames: Record<string, string>;
  target: { id: string; name: string; collection: string };
};
type BatchRow = {
  id: string;
  actor_id: string;
  operation_id: string;
  request_hash: string;
  kind: BulkRelationshipKind;
  operation: BulkRelationshipOperation;
  target_id: string;
  preview_token: string;
  snapshot: Plan[] | string;
  state: "running" | "completed";
};
type OutcomeRow = {
  source_id: string;
  ordinal: number;
  outcome: Plan["outcome"];
  code: string;
  message: string;
  before_value: unknown;
  after_value: unknown;
  applied_version: number | null;
};

const missing = () => new DocumentError("Record is restricted or unavailable.", "record_not_found", 404);
const forbidden = () => new DocumentError("This record action is not permitted.", "record_forbidden", 403);
const invalid = () => new DocumentError("Review the relationship type and records.", "record_relationship_validation", 422);
const mismatch = () => new DocumentError("Operation identity was reused with changed fields.", "operation_mismatch", 409);
const stale = () => new DocumentError("The relationship impact changed. Request a new preview.", "record_relationship_preview_stale", 409);
const draftConflict = () => new DocumentError("The draft changed. Review it before saving.", "record_relationship_draft_conflict", 409);
const limit = () => new DocumentError("Select at most 1000 source records.", "record_relationship_selection_limit", 422);

function assertSelection(input: unknown) {
  if (input && typeof input === "object" && Array.isArray((input as { sourceIds?: unknown }).sourceIds) && (input as { sourceIds: unknown[] }).sourceIds.length > 1000) throw limit();
}
function json<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
function counts(rows: { outcome: Plan["outcome"] }[]) {
  return {
    success: rows.filter((row) => row.outcome === "success").length,
    skipped: rows.filter((row) => row.outcome === "skipped").length,
    error: rows.filter((row) => row.outcome === "error").length,
  };
}
function meta(role: string, primary: boolean, status: "active" | "inactive"): LinkMeta {
  return { role, primary, status };
}
function rowBasis(plan: Plan) {
  return recordHash({
    affectedContractIds: plan.affectedContractIds,
    changes: plan.changes,
    code: plan.code,
    contextReferences: plan.contextReferences,
    deletionConstraints: plan.deletionConstraints,
    edges: plan.edges,
    hiddenAffectedContracts: plan.hiddenAffectedContracts,
    legalPartiesWillChange: plan.legalPartiesWillChange,
    message: plan.message,
    outcome: plan.outcome,
    parentOrganisationId: plan.parentOrganisationId,
    sourceId: plan.sourceId,
    version: plan.version,
  });
}
function mutationBasis(plan: Plan) {
  return recordHash({
    changes: plan.changes,
    code: plan.code,
    edges: plan.edges,
    outcome: plan.outcome,
    parentOrganisationId: plan.parentOrganisationId,
    sourceId: plan.sourceId,
    version: plan.version,
  });
}
function csvCell(value: string) {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export class BulkRelationshipRepository extends SharedRecordRelationshipRepository {
  async preview(ctx: RecordContext, input: unknown) {
    assertSelection(input);
    const parsed = selectionSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    return this.transaction(ctx, async (tx) => this.previewBody(await this.review(tx, ctx, parsed.data, false)));
  }

  async execute(ctx: RecordContext, input: unknown) {
    assertSelection(input);
    const parsed = executeObject.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ requestKind: "relationship-batch", ...command });
    let batch = await this.transaction(ctx, async (tx) => this.batchByOperation(tx, ctx, command.operationId));
    if (batch && batch.request_hash !== requestHash) throw mismatch();
    if (batch?.state === "completed") return this.present(ctx, batch.id, true);
    if (!batch) {
      const selection = { sourceIds: command.sourceIds, kind: command.kind, operation: command.operation, targetId: command.targetId, role: command.role, primary: command.primary, status: command.status };
      const review = await this.transaction(ctx, async (tx) => this.review(tx, ctx, selection, false));
      if (review.previewToken !== command.previewToken) throw stale();
      await this.transaction(ctx, async (tx) => {
        await tx.query(
          `INSERT INTO hs_data_relationship_batches(id,tenant_id,workspace_id,actor_id,operation_id,request_hash,kind,operation,target_id,role,is_primary,status,preview_token,snapshot,state)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'running')
           ON CONFLICT(tenant_id,actor_id,operation_id) DO NOTHING`,
          [randomUUID(), ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.operationId, requestHash, command.kind, command.operation, command.targetId, command.role, command.primary, command.status, review.previewToken, JSON.stringify(review.plans)],
        );
      });
      batch = await this.transaction(ctx, async (tx) => this.batchByOperation(tx, ctx, command.operationId));
      if (!batch || batch.request_hash !== requestHash) throw mismatch();
      if (batch.state === "completed") return this.present(ctx, batch.id, true);
    }
    const plans = json<Plan[]>(batch.snapshot);
    for (const plan of plans) await this.transaction(ctx, (tx) => this.applyRow(tx, ctx, batch!, command, plan));
    await this.transaction(ctx, (tx) => this.complete(tx, ctx, batch!.id));
    return this.present(ctx, batch.id, false);
  }

  async searchTargets(ctx: RecordContext, input: unknown) {
    const parsed = z.object({ kind: z.enum(bulkKinds), query: z.string().max(200).default("") }).strict().safeParse(input);
    if (!parsed.success) throw invalid();
    const collection = shape[parsed.data.kind].target;
    const pattern = `${parsed.data.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
    return this.transaction(ctx, async (tx) => {
      const caps = await this.collectionCaps(tx, ctx, collection);
      const rows = await tx.query<Stored>(
        `SELECT r.* FROM hs_data_records r WHERE r.tenant_id=$1 AND r.collection=$2 AND r.merged_into_id IS NULL AND r.state='active' AND r.name_search COLLATE "C" LIKE lower($3) COLLATE "C" ESCAPE '\\' AND ($4::boolean OR r.id IN (SELECT g.record_id FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$5 AND 'view'=ANY(g.capabilities))) ORDER BY r.name_search COLLATE "C", r.id LIMIT 50`,
        [ctx.tenantId, collection, pattern, caps.includes("view"), ctx.actor.id],
      );
      const results: { id: string; name: string; collection: string; version: number }[] = [];
      for (const record of rows.rows) {
        const access = await this.probe(tx, ctx, record.id, ["view", "link"], false);
        if (access.problem || !access.record) continue;
        results.push({ id: access.record.id, name: access.record.name, collection: access.record.collection, version: access.record.version });
      }
      return { results };
    });
  }

  async saveDraft(ctx: RecordContext, input: unknown) {
    const parsed = draftSaveSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "relationship-draft-save", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.draftOperation(tx, ctx, command.operationId, requestHash, "save");
      if (prior) return { draftId: prior.draft_id, version: prior.applied_version, replayed: true, payload: command.payload };
      await this.assertDraftAccess(tx, ctx, command.payload.collection, command.payload.sourceIds);
      const current = await this.draftRow(tx, ctx, command.draftId, true);
      if (current?.discarded_at) throw missing();
      if (current && current.version !== command.expectedVersion) throw draftConflict();
      if (!current && command.expectedVersion !== 0) throw missing();
      const version = current
        ? (await tx.query<{ version: number }>(
            "UPDATE hs_data_relationship_drafts SET payload=$5,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND version=$6 AND discarded_at IS NULL RETURNING version",
            [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, JSON.stringify(command.payload), command.expectedVersion],
          )).rows[0]?.version
        : (await tx.query<{ version: number }>(
            "INSERT INTO hs_data_relationship_drafts(id,tenant_id,workspace_id,actor_id,version,payload) VALUES($1,$2,$3,$4,1,$5) RETURNING version",
            [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, JSON.stringify(command.payload)],
          )).rows[0]?.version;
      if (!version) throw draftConflict();
      await tx.query(
        "INSERT INTO hs_data_relationship_draft_operations(tenant_id,workspace_id,actor_id,operation_id,request_hash,draft_id,kind,applied_version) VALUES($1,$2,$3,$4,$5,$6,'save',$7)",
        [ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.operationId, requestHash, command.draftId, version],
      );
      return { draftId: command.draftId, version, replayed: false, payload: command.payload };
    });
  }

  async readDraft(ctx: RecordContext, draftId: string) {
    if (!uuid.safeParse(draftId).success) throw missing();
    return this.transaction(ctx, async (tx) => {
      const row = await this.draftRow(tx, ctx, draftId, false);
      if (!row || row.discarded_at) throw missing();
      const payload = json<z.infer<typeof draftPayloadSchema>>(row.payload);
      await this.assertDraftAccess(tx, ctx, payload.collection, payload.sourceIds);
      return { draftId: row.id, version: row.version, updatedAt: new Date(row.updated_at).toISOString(), payload };
    });
  }

  async listDrafts(ctx: RecordContext) {
    return this.transaction(ctx, async (tx) => {
      const rows = await tx.query<{ id: string; version: number; payload: unknown; updated_at: string }>(
        "SELECT id,version,payload,updated_at FROM hs_data_relationship_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND discarded_at IS NULL ORDER BY updated_at DESC LIMIT 20",
        [ctx.tenantId, ctx.workspaceId, ctx.actor.id],
      );
      const drafts = [];
      for (const row of rows.rows) {
        const payload = json<z.infer<typeof draftPayloadSchema>>(row.payload);
        try {
          await this.assertDraftAccess(tx, ctx, payload.collection, payload.sourceIds);
        } catch (error) {
          if (error instanceof DocumentError && (error.status === 403 || error.status === 404)) continue;
          throw error;
        }
        drafts.push({ draftId: row.id, version: row.version, updatedAt: new Date(row.updated_at).toISOString(), payload });
      }
      return { drafts };
    });
  }

  async discardDraft(ctx: RecordContext, input: unknown) {
    const parsed = draftDiscardSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "relationship-draft-discard", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = await this.draftOperation(tx, ctx, command.operationId, requestHash, "discard");
      if (prior) return { draftId: command.draftId, version: prior.applied_version, discarded: true, replayed: true };
      const current = await this.draftRow(tx, ctx, command.draftId, true);
      if (!current || current.discarded_at) throw missing();
      const payload = json<z.infer<typeof draftPayloadSchema>>(current.payload);
      await this.assertDraftAccess(tx, ctx, payload.collection, payload.sourceIds);
      if (current.version !== command.expectedVersion) throw draftConflict();
      const updated = await tx.query<{ version: number }>(
        "UPDATE hs_data_relationship_drafts SET discarded_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND version=$5 AND discarded_at IS NULL RETURNING version",
        [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.expectedVersion],
      );
      if (!updated.rows[0]) throw draftConflict();
      await tx.query(
        "INSERT INTO hs_data_relationship_draft_operations(tenant_id,workspace_id,actor_id,operation_id,request_hash,draft_id,kind,applied_version) VALUES($1,$2,$3,$4,$5,$6,'discard',$7)",
        [ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.operationId, requestHash, command.draftId, updated.rows[0].version],
      );
      return { draftId: command.draftId, version: updated.rows[0].version, discarded: true, replayed: false };
    });
  }

  async batchHistory(ctx: RecordContext, batchId: string) {
    if (!uuid.safeParse(batchId).success) throw missing();
    return this.transaction(ctx, (tx) => this.readBatch(tx, ctx, batchId));
  }

  async download(ctx: RecordContext, batchId: string) {
    const result = await this.batchHistory(ctx, batchId);
    const lines = ["batchId,sourceId,outcome,code,message", ...result.rows.map((row) => [result.batchId, row.sourceId, row.outcome, row.code, row.message].map(csvCell).join(","))];
    return { filename: "relationship-batch.csv", body: `${lines.join("\n")}\n` };
  }

  private previewBody(review: Review) {
    return {
      previewToken: review.previewToken,
      kind: review.kind,
      operation: review.operation,
      target: review.target,
      legalPartiesWillChange: false as const,
      counts: counts(review.plans),
      rows: review.plans.map((plan) => this.display(plan, review.names, review.contractNames)),
    };
  }

  private display(plan: Plan, names: Record<string, string>, contractNames: Record<string, string>) {
    return {
      sourceId: plan.sourceId,
      sourceName: names[plan.sourceId] ?? null,
      ordinal: plan.ordinal,
      outcome: plan.outcome,
      code: plan.code,
      message: plan.message,
      version: plan.version,
      currentParent: plan.parentOrganisationId && names[plan.parentOrganisationId] ? { id: plan.parentOrganisationId, name: names[plan.parentOrganisationId] } : null,
      changes: plan.changes,
      contextReferences: plan.contextReferences,
      deletionConstraints: plan.deletionConstraints,
      affectedContracts: plan.affectedContractIds.map((id) => ({ id, name: contractNames[id] })).filter((row) => row.name),
      hiddenAffectedContracts: plan.hiddenAffectedContracts,
      legalPartiesWillChange: false as const,
    };
  }

  private async review(tx: Sql, ctx: RecordContext, input: Selection, lock: boolean): Promise<Review> {
    const expected = shape[input.kind];
    const target = await this.probe(tx, ctx, input.targetId, ["view", "link"], lock);
    if (target.problem === "forbidden") throw forbidden();
    if (target.problem === "archived") throw new DocumentError("Record archived.", "record_archived", 409);
    if (target.problem === "merged") throw new DocumentError("This record was merged. Open the current record.", "record_merged", 409);
    if (target.problem || !target.record) throw missing();
    if (target.record.collection !== expected.target) throw invalid();
    const names: Record<string, string> = { [target.record.id]: target.record.name };
    const contractNames: Record<string, string> = {};
    const plans: Plan[] = [];
    for (const [index, sourceId] of input.sourceIds.entries()) {
      const access = await this.probe(tx, ctx, sourceId, ["view", "edit", "link", "bulk"], lock);
      if (access.record && access.problem !== "absent") names[access.record.id] = access.record.name;
      plans.push(await this.planSource(tx, ctx, input, access, index + 1, target.record, names, contractNames));
    }
    const previewToken = recordHash({
      actorId: ctx.actor.id,
      kind: input.kind,
      operation: input.operation,
      primary: input.primary,
      role: input.role,
      rows: plans.map(rowBasis),
      sourceIds: input.sourceIds,
      status: input.status,
      targetId: input.targetId,
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
    });
    return { previewToken, kind: input.kind, operation: input.operation, plans, names, contractNames, target: { id: target.record.id, name: target.record.name, collection: target.record.collection } };
  }

  private async planSource(tx: Sql, ctx: RecordContext, input: Selection, access: Access, ordinal: number, target: Stored, names: Record<string, string>, contractNames: Record<string, string>): Promise<Plan> {
    const base = (patch: Partial<Plan> & Pick<Plan, "outcome" | "code" | "message">, edges: Edge[] = [], parentOrganisationId: string | null = null, version: number | null = null): Plan => ({
      sourceId: input.sourceIds[ordinal - 1],
      ordinal,
      version,
      parentOrganisationId,
      edges,
      changes: [],
      contextReferences: [],
      deletionConstraints: [],
      affectedContractIds: [],
      hiddenAffectedContracts: false,
      legalPartiesWillChange: false,
      ...patch,
    });
    if (!access.record || access.problem === "absent") return base({ outcome: "error", code: "record_not_found", message: "Record is restricted or unavailable." });
    const edges = await this.edges(tx, ctx, access.record.id);
    const parentOrganisationId = access.record.parent_organisation_id;
    if (parentOrganisationId) {
      const parent = await this.probe(tx, ctx, parentOrganisationId, ["view"], false);
      if (parent.record && parent.problem !== "absent" && parent.problem !== "forbidden") names[parent.record.id] = parent.record.name;
    }
    const version = access.record.version;
    const problem = access.problem === "archived"
      ? { outcome: "error" as const, code: "record_archived", message: "Record archived." }
      : access.problem === "merged"
        ? { outcome: "error" as const, code: "record_merged", message: "This record was merged. Open the current record." }
        : access.problem === "forbidden"
          ? { outcome: "error" as const, code: "record_forbidden", message: "This record action is not permitted." }
          : access.record.collection !== shape[input.kind].source || access.record.id === target.id
            ? { outcome: "error" as const, code: "record_relationship_validation", message: "Review the relationship type and records." }
            : null;
    const decided: Pick<Plan, "outcome" | "code" | "message"> & { changes?: Change[] } = problem ?? await this.decide(tx, ctx, input, access.record, edges, target.id);
    const plan = base(decided, edges, parentOrganisationId, version);
    plan.changes = decided.changes ?? [];
    if (input.kind === "parent-organisation" && access.problem !== "forbidden" && access.problem !== "archived" && access.problem !== "merged") {
      const contracts = await tx.query<{ id: string; name: string }>(
        "SELECT r.id,r.name FROM hs_data_relationships e JOIN hs_data_records r ON r.tenant_id=e.tenant_id AND r.id=e.source_id WHERE e.tenant_id=$1 AND e.kind='contract-account' AND e.target_id=$2 AND r.state<>'trashed' ORDER BY r.id",
        [ctx.tenantId, access.record.id],
      );
      for (const contract of contracts.rows) {
        const visible = await this.probe(tx, ctx, contract.id, ["view"], false);
        if (!visible.record || visible.problem === "absent") plan.hiddenAffectedContracts = true;
        else {
          plan.affectedContractIds.push(visible.record.id);
          contractNames[visible.record.id] = visible.record.name;
          names[visible.record.id] = visible.record.name;
        }
      }
    }
    const impact = new Set<string>([target.id, access.record.id]);
    for (const id of plan.affectedContractIds) impact.add(id);
    for (const change of plan.changes) impact.add(change.targetId);
    const references: Reference[] = [];
    const constraints: Constraint[] = [];
    if (plan.code === "account_one_parent" || plan.code === "contract_legal_party" || plan.code === "record_relationship_cardinality") {
      constraints.push({ code: plan.code, recordId: access.record.id, message: plan.message });
    }
    for (const recordId of [...impact].sort()) {
      const visible = recordId === access.record.id ? access : await this.probe(tx, ctx, recordId, ["view"], false);
      if (!visible.record || visible.problem === "absent") continue;
      const refs = await tx.query<{ source_app: string; source_type: string; source_id: string }>(
        "SELECT source_app,source_type,source_id FROM hs_data_references WHERE tenant_id=$1 AND record_id=$2 ORDER BY source_app,source_type,source_id",
        [ctx.tenantId, recordId],
      );
      for (const ref of refs.rows) references.push({ recordId, sourceApp: ref.source_app, sourceType: ref.source_type, sourceId: ref.source_id });
      if (await this.deletionBlocked(tx, ctx, recordId)) constraints.push({ code: "deletion_blocked", recordId, message: "Existing associations must be resolved before this record can be deleted." });
    }
    plan.contextReferences = references;
    plan.deletionConstraints = constraints.sort((a, b) => `${a.code}:${a.recordId}`.localeCompare(`${b.code}:${b.recordId}`));
    plan.affectedContractIds.sort();
    return plan;
  }

  private async decide(tx: Sql, ctx: RecordContext, input: Selection, source: Stored, edges: Edge[], targetId: string): Promise<Pick<Plan, "outcome" | "code" | "message"> & { changes?: Change[] }> {
    if (input.kind === "parent-organisation") return this.decideParent(input, source, targetId);
    const kindEdges = edges.filter((edge) => edge.kind === input.kind);
    const existing = kindEdges.find((edge) => edge.targetId === targetId);
    const desired = meta(input.role, input.primary, input.status);
    const otherPrimary = input.kind === "contact-account" && input.primary && kindEdges.some((edge) => edge.primary && edge.targetId !== targetId);
    if (input.operation === "add") {
      if (existing && existing.role === desired.role && existing.primary === desired.primary && existing.status === desired.status) return { outcome: "skipped", code: "unchanged", message: "The link is already in this state." };
      if (otherPrimary) return { outcome: "error", code: "record_relationship_cardinality", message: "A contact can have one primary account relationship." };
      return existing
        ? { outcome: "success", code: "applied", message: "Link updated.", changes: [this.change("update", input.kind, existing, desired)] }
        : { outcome: "success", code: "applied", message: "Link added.", changes: [this.change("insert", input.kind, null, desired, targetId)] };
    }
    if (input.operation === "remove") {
      if (!existing) return { outcome: "skipped", code: "unchanged", message: "The link is already in this state." };
      if (input.kind === "contract-legal-party" && kindEdges.length <= 1) return { outcome: "error", code: "contract_legal_party", message: "A contract must retain at least one legal organisation." };
      return { outcome: "success", code: "applied", message: "Link removed.", changes: [this.change("delete", input.kind, existing, null)] };
    }
    const others = kindEdges.filter((edge) => edge.targetId !== targetId);
    for (const edge of others) {
      const linked = await this.probe(tx, ctx, edge.targetId, ["view", "link"], false);
      if (linked.problem === "forbidden") return { outcome: "error", code: "record_forbidden", message: "This record action is not permitted." };
      if (linked.problem || !linked.record) return { outcome: "error", code: "record_not_found", message: "Record is restricted or unavailable." };
    }
    const same = !!existing && existing.role === desired.role && existing.primary === desired.primary && existing.status === desired.status && others.length === 0;
    if (same) return { outcome: "skipped", code: "unchanged", message: "The link is already in this state." };
    if (input.kind === "contract-legal-party" && !existing && others.length === 0) {
      return { outcome: "success", code: "applied", message: "Links replaced.", changes: [this.change("insert", input.kind, null, desired, targetId)] };
    }
    const changes = [
      ...(existing ? (existing.role === desired.role && existing.primary === desired.primary && existing.status === desired.status ? [] : [this.change("update", input.kind, existing, desired)]) : [this.change("insert", input.kind, null, desired, targetId)]),
      ...others.map((edge) => this.change("delete", input.kind, edge, null)),
    ];
    return { outcome: "success", code: "applied", message: "Links replaced.", changes };
  }

  private decideParent(input: Selection, source: Stored, targetId: string): Pick<Plan, "outcome" | "code" | "message"> & { changes?: Change[] } {
    const current = source.parent_organisation_id;
    if (input.operation === "add") {
      if (current === targetId) return { outcome: "skipped", code: "unchanged", message: "The link is already in this state." };
      return { outcome: "error", code: "account_one_parent", message: "An account keeps one parent organisation. Use replace to change it." };
    }
    if (input.operation === "remove") {
      if (current !== targetId) return { outcome: "skipped", code: "unchanged", message: "The link is already in this state." };
      return { outcome: "error", code: "account_one_parent", message: "An account must keep one parent organisation." };
    }
    if (current === targetId) return { outcome: "skipped", code: "unchanged", message: "The link is already in this state." };
    return {
      outcome: "success",
      code: "applied",
      message: "Parent organisation replaced.",
      changes: [{ action: "reparent", kind: "parent-organisation", targetId, relationshipId: null, before: current ? meta("", false, "active") : null, after: meta("", false, "active") }],
    };
  }

  private change(action: "insert" | "update" | "delete", kind: string, edge: Edge | null, after: LinkMeta | null, targetId = edge?.targetId ?? ""): Change {
    return {
      action,
      kind,
      targetId,
      relationshipId: action === "insert" ? null : edge?.id ?? null,
      before: edge ? meta(edge.role, edge.primary, edge.status) : null,
      after,
    };
  }

  private async edges(tx: Sql, ctx: RecordContext, sourceId: string): Promise<Edge[]> {
    const rows = await tx.query<{ id: string; kind: string; target_id: string; role: string; is_primary: boolean; status: "active" | "inactive" }>(
      "SELECT id,kind,target_id,role,is_primary,status FROM hs_data_relationships WHERE tenant_id=$1 AND source_id=$2 ORDER BY id",
      [ctx.tenantId, sourceId],
    );
    return rows.rows.map((row) => ({ id: row.id, kind: row.kind, targetId: row.target_id, role: row.role, primary: row.is_primary, status: row.status }));
  }

  private async probe(tx: Sql, ctx: RecordContext, recordId: string, actions: RecordCapability[], lock: boolean): Promise<Access> {
    if (!uuid.safeParse(recordId).success) return { record: null, caps: [], problem: "absent" };
    const rows = await tx.query<Stored>(`SELECT * FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state<>'trashed'${lock ? " FOR UPDATE" : ""}`, [recordId, ctx.tenantId]);
    const record = rows.rows[0];
    if (!record) return { record: null, caps: [], problem: "absent" };
    const caps = await this.caps(tx, ctx, record);
    if (!caps.includes("view")) return { record: null, caps: [], problem: "absent" };
    if (record.merged_into_id) return { record, caps, problem: "merged" };
    if (record.state !== "active") return { record, caps, problem: "archived" };
    if (actions.some((action) => action !== "view" && !caps.includes(action))) return { record, caps, problem: "forbidden" };
    return { record, caps, problem: null };
  }

  private async deletionBlocked(tx: Sql, ctx: RecordContext, recordId: string) {
    const result = await tx.query<{ blocked: boolean }>(
      `WITH RECURSIVE aliases(id) AS (SELECT $2::uuid UNION SELECT r.id FROM hs_data_records r JOIN aliases a ON r.merged_into_id=a.id WHERE r.tenant_id=$1) SELECT (
        EXISTS(SELECT 1 FROM hs_data_records WHERE tenant_id=$1 AND parent_organisation_id IN(SELECT id FROM aliases))
        OR EXISTS(SELECT 1 FROM hs_data_relationships WHERE tenant_id=$1 AND target_id IN(SELECT id FROM aliases))
        OR EXISTS(SELECT 1 FROM hs_data_documents WHERE tenant_id=$1 AND record_id IN(SELECT id FROM aliases))
        OR EXISTS(SELECT 1 FROM hs_data_references WHERE tenant_id=$1 AND record_id IN(SELECT id FROM aliases))
        OR EXISTS(SELECT 1 FROM hs_data_records r JOIN hs_data_fields f ON f.tenant_id=r.tenant_id AND f.collection=r.collection AND f.kind='record' WHERE r.tenant_id=$1 AND EXISTS(SELECT 1 FROM aliases a WHERE (r.field_values->f.field_key) @> to_jsonb(ARRAY[a.id::text])))
      ) AS blocked`,
      [ctx.tenantId, recordId],
    );
    return result.rows[0]?.blocked === true;
  }

  private async applyRow(tx: Sql, ctx: RecordContext, batch: BatchRow, command: Selection, stored: Plan) {
    await tx.query("SELECT id FROM hs_data_relationship_batches WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [batch.id, ctx.tenantId]);
    const existing = await tx.query("SELECT source_id FROM hs_data_relationship_batch_rows WHERE batch_id=$1 AND source_id=$2", [batch.id, stored.sourceId]);
    if (existing.rows.length) return;
    let live: Plan;
    try {
      const review = await this.review(tx, ctx, { ...command, sourceIds: [stored.sourceId] }, true);
      live = review.plans[0];
    } catch (error) {
      if (error instanceof DocumentError && error.status < 500) {
        await this.writeOutcome(tx, ctx, batch, stored, { outcome: "error", code: "record_relationship_preview_stale", message: "This record changed after the preview. Review it again." }, null);
        return;
      }
      throw error;
    }
    if (mutationBasis(live) !== mutationBasis(stored)) {
      await this.writeOutcome(tx, ctx, batch, stored, { outcome: "error", code: "record_relationship_preview_stale", message: "This record changed after the preview. Review it again." }, null);
      return;
    }
    if (stored.outcome !== "success") {
      await this.writeOutcome(tx, ctx, batch, stored, stored, null);
      return;
    }
    await tx.query("SAVEPOINT bulk_row");
    try {
      const appliedVersion = await this.mutate(tx, ctx, batch, command, stored);
      await this.writeOutcome(tx, ctx, batch, stored, stored, appliedVersion);
      await tx.query("RELEASE SAVEPOINT bulk_row");
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT bulk_row");
      const text = error instanceof Error ? error.message : "";
      if (text.includes("Contract requires a legal organisation")) {
        await this.writeOutcome(tx, ctx, batch, stored, { outcome: "error", code: "contract_legal_party", message: "A contract must retain at least one legal organisation." }, null);
        return;
      }
      if (error instanceof DocumentError && error.status < 500) {
        const code = error.code === "record_version_conflict" ? "record_relationship_preview_stale" : error.code;
        await this.writeOutcome(tx, ctx, batch, stored, { outcome: "error", code, message: error.message.slice(0, 300) }, null);
        return;
      }
      throw error;
    }
  }

  private async mutate(tx: Sql, ctx: RecordContext, batch: BatchRow, command: Selection, plan: Plan) {
    const before = await this.raw(tx, ctx, plan.sourceId, "edit", true);
    await this.raw(tx, ctx, plan.sourceId, "link", true);
    await this.raw(tx, ctx, plan.sourceId, "bulk", true);
    await this.raw(tx, ctx, command.targetId, "link", true);
    if (before.version !== plan.version) throw new DocumentError("This record changed after the preview. Review it again.", "record_relationship_preview_stale", 409);
    const legalBefore = plan.changes.some((change) => change.action === "reparent") ? await this.legalPartyIds(tx, ctx, plan.sourceId) : null;
    const ordered = [...plan.changes.filter((change) => change.action === "insert"), ...plan.changes.filter((change) => change.action === "update"), ...plan.changes.filter((change) => change.action === "reparent"), ...plan.changes.filter((change) => change.action === "delete")];
    for (const change of ordered) {
      if (change.action === "insert") {
        await tx.query(
          "INSERT INTO hs_data_relationships(id,tenant_id,source_id,target_id,kind,role,is_primary,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [randomUUID(), ctx.tenantId, plan.sourceId, change.targetId, change.kind, change.after?.role ?? "", change.after?.primary ?? false, change.after?.status ?? "active"],
        );
      } else if (change.action === "update") {
        const updated = await tx.query("UPDATE hs_data_relationships SET role=$3,is_primary=$4,status=$5,version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING id", [ctx.tenantId, change.relationshipId, change.after?.role ?? "", change.after?.primary ?? false, change.after?.status ?? "active"]);
        if (!updated.rows.length) throw new DocumentError("This record changed after the preview. Review it again.", "record_relationship_preview_stale", 409);
      } else if (change.action === "delete") {
        const deleted = await tx.query("DELETE FROM hs_data_relationships WHERE tenant_id=$1 AND id=$2 RETURNING id", [ctx.tenantId, change.relationshipId]);
        if (!deleted.rows.length) throw new DocumentError("This record changed after the preview. Review it again.", "record_relationship_preview_stale", 409);
      } else {
        const moved = await tx.query("UPDATE hs_data_records SET parent_organisation_id=$3,version=version+1,updated_by=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING id", [ctx.tenantId, plan.sourceId, change.targetId, ctx.actor.id, plan.version]);
        if (!moved.rows.length) throw new DocumentError("This record changed after the preview. Review it again.", "record_relationship_preview_stale", 409);
      }
    }
    if (!plan.changes.some((change) => change.action === "reparent")) {
      const bumped = await tx.query("UPDATE hs_data_records SET version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND version=$4 RETURNING id", [ctx.tenantId, plan.sourceId, ctx.actor.id, plan.version]);
      if (!bumped.rows.length) throw new DocumentError("This record changed after the preview. Review it again.", "record_relationship_preview_stale", 409);
    }
    const next = await this.raw(tx, ctx, plan.sourceId, "edit", true);
    if (legalBefore) {
      const legalAfter = await this.legalPartyIds(tx, ctx, plan.sourceId);
      if (JSON.stringify(legalAfter) !== JSON.stringify(legalBefore)) throw new DocumentError("Legal parties changed unexpectedly.", "record_relationship_integrity", 500);
    }
    await this.emit(tx, ctx, next, batch.operation_id, "relationship-batch-change", before, await this.fields(tx, ctx, next.collection), { batchId: batch.id, rowNumber: plan.ordinal });
    return next.version;
  }

  private async legalPartyIds(tx: Sql, ctx: RecordContext, accountId: string) {
    const rows = await tx.query<{ id: string }>(
      "SELECT id FROM hs_data_relationships WHERE tenant_id=$1 AND source_id IN(SELECT source_id FROM hs_data_relationships WHERE tenant_id=$1 AND kind='contract-account' AND target_id=$2) AND kind='contract-legal-party' ORDER BY id",
      [ctx.tenantId, accountId],
    );
    return rows.rows.map((row) => row.id);
  }

  private async writeOutcome(tx: Sql, ctx: RecordContext, batch: BatchRow, plan: Plan, outcome: Pick<Plan, "outcome" | "code" | "message">, appliedVersion: number | null) {
    const nextParent = outcome.outcome === "success" && plan.changes.some((change) => change.action === "reparent") ? plan.changes.find((change) => change.action === "reparent")!.targetId : plan.parentOrganisationId;
    const before = { parentOrganisationId: plan.parentOrganisationId, changes: plan.changes };
    const after = { parentOrganisationId: nextParent, changes: outcome.outcome === "success" ? plan.changes : [] };
    await tx.query(
      "INSERT INTO hs_data_relationship_batch_rows(batch_id,source_id,ordinal,outcome,code,message,before_value,after_value,applied_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [batch.id, plan.sourceId, plan.ordinal, outcome.outcome, outcome.code, outcome.message, JSON.stringify(before), JSON.stringify(after), appliedVersion],
    );
    await tx.query(
      "INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,'shared-record.relationship-batch-row',$3,$4)",
      [randomUUID(), ctx.actor.id, JSON.stringify({ batchId: batch.id, sourceId: plan.sourceId, ordinal: plan.ordinal, outcome: outcome.outcome, code: outcome.code, before, after, source: "holy-sheet" }), batch.operation_id],
    );
  }

  private async complete(tx: Sql, ctx: RecordContext, batchId: string) {
    const batch = (await tx.query<BatchRow>("SELECT * FROM hs_data_relationship_batches WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE", [batchId, ctx.tenantId, ctx.workspaceId])).rows[0];
    if (!batch || batch.state === "completed") return;
    const plans = json<Plan[]>(batch.snapshot);
    const written = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_data_relationship_batch_rows WHERE batch_id=$1", [batchId]);
    if ((written.rows[0]?.n ?? 0) !== plans.length) return;
    const rows = await tx.query<{ outcome: Plan["outcome"] }>("SELECT outcome FROM hs_data_relationship_batch_rows WHERE batch_id=$1", [batchId]);
    await tx.query("UPDATE hs_data_relationship_batches SET state='completed',completed_at=clock_timestamp(),version=version+1 WHERE id=$1 AND state='running'", [batchId]);
    await tx.query(
      "INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,'shared-record.relationship-batch',$3,$4)",
      [randomUUID(), ctx.actor.id, JSON.stringify({ batchId, kind: batch.kind, operation: batch.operation, targetId: batch.target_id, counts: counts(rows.rows), actorId: ctx.actor.id, source: "holy-sheet", at: new Date().toISOString() }), batch.operation_id],
    );
  }

  private async present(ctx: RecordContext, batchId: string, replayed: boolean) {
    return this.transaction(ctx, async (tx) => ({ ...(await this.readBatch(tx, ctx, batchId)), replayed }));
  }

  private async readBatch(tx: Sql, ctx: RecordContext, batchId: string) {
    const batch = (await tx.query<BatchRow>("SELECT * FROM hs_data_relationship_batches WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3", [batchId, ctx.tenantId, ctx.workspaceId])).rows[0];
    if (!batch) throw missing();
    const owner = batch.actor_id === ctx.actor.id;
    const targetAccess = await this.probe(tx, ctx, batch.target_id, ["view"], false);
    const targetVisible = !targetAccess.problem && !!targetAccess.record;
    const stored = json<Plan[]>(batch.snapshot);
    const outcomes = await tx.query<OutcomeRow>("SELECT * FROM hs_data_relationship_batch_rows WHERE batch_id=$1 ORDER BY ordinal", [batchId]);
    const rows = [];
    let hiddenRows = false;
    for (const outcome of outcomes.rows) {
      const plan = stored.find((item) => item.sourceId === outcome.source_id);
      const access = await this.probe(tx, ctx, outcome.source_id, owner ? ["view"] : ["view", "history"], false);
      if (!owner && (access.problem || !access.record)) {
        hiddenRows = true;
        continue;
      }
      const visible = !access.problem && !!access.record;
      const changes = [];
      if (visible && plan) {
        for (const change of plan.changes) {
          const target = await this.probe(tx, ctx, change.targetId, ["view"], false);
          if (!target.problem && target.record) changes.push(change);
        }
      }
      rows.push({
        sourceId: outcome.source_id,
        sourceName: visible ? access.record!.name : null,
        ordinal: outcome.ordinal,
        outcome: outcome.outcome,
        code: outcome.code,
        message: visible || owner ? outcome.message : "Record is restricted or unavailable.",
        version: outcome.applied_version,
        changes,
        contextReferences: visible ? plan?.contextReferences ?? [] : [],
        deletionConstraints: visible ? plan?.deletionConstraints ?? [] : [],
        affectedContracts: [],
        hiddenAffectedContracts: visible ? plan?.hiddenAffectedContracts ?? false : false,
        legalPartiesWillChange: false as const,
      });
    }
    if (!owner && !rows.length) throw missing();
    return {
      batchId: batch.id,
      operationId: batch.operation_id,
      previewToken: batch.preview_token,
      kind: batch.kind,
      operation: batch.operation,
      targetId: targetVisible ? batch.target_id : null,
      legalPartiesWillChange: false as const,
      counts: owner ? counts(outcomes.rows) : counts(rows),
      hiddenRows: owner ? false : hiddenRows,
      rows,
    };
  }

  private async batchByOperation(tx: Sql, ctx: RecordContext, operationId: string) {
    return (await tx.query<BatchRow>("SELECT * FROM hs_data_relationship_batches WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, operationId])).rows[0] ?? null;
  }

  private async draftOperation(tx: Sql, ctx: RecordContext, operationId: string, requestHash: string, kind: "save" | "discard") {
    const prior = (await tx.query<{ request_hash: string; draft_id: string; kind: string; applied_version: number }>("SELECT request_hash,draft_id,kind,applied_version FROM hs_data_relationship_draft_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, operationId])).rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash || prior.kind !== kind) throw mismatch();
    return prior;
  }

  private async draftRow(tx: Sql, ctx: RecordContext, draftId: string, lock: boolean) {
    return (await tx.query<{ id: string; version: number; payload: unknown; discarded_at: string | null; updated_at: string }>(
      `SELECT id,version,payload,discarded_at,updated_at FROM hs_data_relationship_drafts WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4${lock ? " FOR UPDATE" : ""}`,
      [draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id],
    )).rows[0] ?? null;
  }

  private async assertDraftAccess(tx: Sql, ctx: RecordContext, collection: string, sourceIds: string[]) {
    const caps = await this.collectionCaps(tx, ctx, collection);
    if (["view", "edit", "link", "bulk"].every((capability) => caps.includes(capability as RecordCapability))) return;
    if (!sourceIds.length) throw forbidden();
    for (const sourceId of sourceIds) {
      const access = await this.probe(tx, ctx, sourceId, ["view", "edit", "link", "bulk"], false);
      if (access.problem === "forbidden") throw forbidden();
      if (access.problem || !access.record) throw missing();
    }
  }
}
