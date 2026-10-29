import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DocumentError } from "./document";
import type { Sql } from "./database";
import { recordHash } from "./shared-record-types";
import { SharedRecordRepository, type RecordContext, type Stored } from "./shared-records";

const uuid = z.string().uuid();
const kinds = ["contact-account", "employee-account", "contract-legal-party", "contract-account"] as const;
export type RelationshipKind = (typeof kinds)[number];
const relationshipSchema = z
  .object({
    operationId: uuid,
    expectedVersion: z.number().int().positive(),
    kind: z.enum(kinds),
    targetId: uuid,
    action: z.enum(["upsert", "remove"]),
    role: z.string().trim().max(100).default(""),
    primary: z.boolean().default(false),
    status: z.enum(["active", "inactive"]).default("active"),
  })
  .strict();
const previewSchema = z.object({ newOrganisationId: uuid }).strict();
const reparentSchema = z
  .object({
    operationId: uuid,
    expectedVersion: z.number().int().positive(),
    newOrganisationId: uuid,
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();
const shape: Record<RelationshipKind, { source: string; target: string }> = {
  "contact-account": { source: "contacts", target: "accounts" },
  "employee-account": { source: "employees", target: "accounts" },
  "contract-legal-party": { source: "contracts", target: "organisations" },
  "contract-account": { source: "contracts", target: "accounts" },
};
const invalid = () => new DocumentError("Review the relationship type and records.", "record_relationship_validation");

export class SharedRecordRelationshipRepository extends SharedRecordRepository {
  private token(input: unknown) {
    return createHash("sha256").update(recordHash(input)).digest("hex");
  }

  async mutateRelationship(ctx: RecordContext, recordId: string, input: z.input<typeof relationshipSchema>) {
    const parsed = relationshipSchema.safeParse(input);
    if (!parsed.success) throw new DocumentError("Invalid relationship update.", "record_validation");
    const c = parsed.data,
      requestHash = recordHash({
        operationKind: "relationship-update",
        recordId,
        ...c,
      });
    return this.transaction(ctx, async (tx, t) => {
      const source = await this.raw(tx, ctx, recordId, "edit", true);
      await this.raw(tx, ctx, recordId, "link", true);
      const prior = await this.operation(tx, ctx, c.operationId, requestHash);
      if (prior) {
        if (prior.record_id !== recordId) throw new DocumentError("Operation record mismatch.", "operation_mismatch", 409);
        return {
          record: await this.view(tx, ctx, source, t),
          appliedVersion: prior.applied_version,
          replayed: true,
        };
      }
      if (source.version !== c.expectedVersion) throw new DocumentError("The record changed. Review the relationship.", "record_version_conflict", 409);
      const expected = shape[c.kind],
        target = await this.raw(tx, ctx, c.targetId, "link", true);
      if (source.collection !== expected.source || target.collection !== expected.target || source.id === target.id || (c.kind !== "contact-account" && c.primary)) throw invalid();
      const existing = await tx.query<{ id: string }>("SELECT id FROM hs_data_relationships WHERE tenant_id=$1 AND source_id=$2 AND target_id=$3 AND kind=$4", [ctx.tenantId, recordId, target.id, c.kind]);
      if (c.action === "remove") {
        if (c.kind === "contract-legal-party") {
          const count = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_data_relationships WHERE tenant_id=$1 AND source_id=$2 AND kind='contract-legal-party'", [ctx.tenantId, recordId]);
          if ((count.rows[0]?.n ?? 0) <= 1 && existing.rows.length) throw new DocumentError("A contract must retain at least one legal organisation.", "record_relationship_required", 409);
        }
        if (existing.rows.length) await tx.query("DELETE FROM hs_data_relationships WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, existing.rows[0].id]);
      } else if (existing.rows.length) await tx.query("UPDATE hs_data_relationships SET role=$3,is_primary=$4,status=$5,version=version+1 WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, existing.rows[0].id, c.role, c.primary, c.status]);
      else await tx.query("INSERT INTO hs_data_relationships(id,tenant_id,source_id,target_id,kind,role,is_primary,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), ctx.tenantId, recordId, target.id, c.kind, c.role, c.primary, c.status]);
      let next = source;
      if (existing.rows.length || c.action === "upsert") {
        await tx.query("UPDATE hs_data_records SET version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, recordId, ctx.actor.id]);
        next = await this.raw(tx, ctx, recordId);
        await this.emit(tx, ctx, next, c.operationId, "relationship-update", source, await this.fields(tx, ctx, source.collection));
      }
      await this.remember(tx, ctx, c.operationId, requestHash, next, "relationship-update");
      return {
        record: await this.view(tx, ctx, next, t),
        appliedVersion: next.version,
        replayed: false,
      };
    });
  }

  async previewReparent(ctx: RecordContext, recordId: string, input: z.input<typeof previewSchema>) {
    const parsed = previewSchema.safeParse(input);
    if (!parsed.success) throw new DocumentError("Invalid reparent preview.", "record_validation");
    return this.transaction(ctx, async (tx) => this.reparentPreview(tx, ctx, recordId, parsed.data.newOrganisationId));
  }

  private async reparentPreview(tx: Sql, ctx: RecordContext, recordId: string, newOrganisationId: string) {
    const account = await this.raw(tx, ctx, recordId, "edit", true);
    await this.raw(tx, ctx, recordId, "link", true);
    const organisation = await this.raw(tx, ctx, newOrganisationId, "link", true);
    if (account.collection !== "accounts" || organisation.collection !== "organisations" || account.parent_organisation_id === organisation.id) throw invalid();
    const contracts = await tx.query<{ id: string; name: string }>("SELECT r.id,r.name FROM hs_data_relationships e JOIN hs_data_records r ON r.tenant_id=e.tenant_id AND r.id=e.source_id WHERE e.tenant_id=$1 AND e.kind='contract-account' AND e.target_id=$2 AND r.state<>'trashed' ORDER BY r.id", [ctx.tenantId, account.id]);
    const references = await tx.query<{
      source_app: string;
      source_type: string;
      source_id: string;
    }>("SELECT source_app,source_type,source_id FROM hs_data_references WHERE tenant_id=$1 AND record_id=$2 ORDER BY source_app,source_type,source_id", [ctx.tenantId, account.id]);
    const basis = {
      tenantId: ctx.tenantId,
      recordId: account.id,
      expectedVersion: account.version,
      currentOrganisationId: account.parent_organisation_id,
      newOrganisationId: organisation.id,
      affectedContractIds: contracts.rows.map((row) => row.id),
      contextReferences: references.rows,
    };
    return {
      ...basis,
      currentOrganisation: account.parent_organisation_id ? { id: account.parent_organisation_id } : null,
      newOrganisation: { id: organisation.id, name: organisation.name },
      affectedContracts: contracts.rows,
      legalPartiesWillChange: false,
      previewToken: this.token(basis),
    };
  }

  async reparent(ctx: RecordContext, recordId: string, input: z.input<typeof reparentSchema>) {
    const parsed = reparentSchema.safeParse(input);
    if (!parsed.success) throw new DocumentError("Confirm the reviewed reparent preview.", "record_validation");
    const c = parsed.data,
      requestHash = recordHash({ kind: "account-reparent", recordId, ...c });
    return this.transaction(ctx, async (tx, t) => {
      const account = await this.raw(tx, ctx, recordId, "edit", true);
      await this.raw(tx, ctx, recordId, "link", true);
      const prior = await this.operation(tx, ctx, c.operationId, requestHash);
      if (prior) {
        if (prior.record_id !== recordId) throw new DocumentError("Operation record mismatch.", "operation_mismatch", 409);
        return {
          record: await this.view(tx, ctx, account, t),
          appliedVersion: prior.applied_version,
          replayed: true,
        };
      }
      if (account.version !== c.expectedVersion) throw new DocumentError("The account changed. Request a new preview.", "record_version_conflict", 409);
      const preview = await this.reparentPreview(tx, ctx, recordId, c.newOrganisationId);
      if (preview.previewToken !== c.previewToken) throw new DocumentError("The reparent impact changed. Request a new preview.", "record_reparent_preview_stale", 409);
      const legalBefore = await tx.query<{ id: string }>("SELECT id FROM hs_data_relationships WHERE tenant_id=$1 AND source_id IN(SELECT source_id FROM hs_data_relationships WHERE tenant_id=$1 AND kind='contract-account' AND target_id=$2) AND kind='contract-legal-party' ORDER BY id", [ctx.tenantId, recordId]);
      await tx.query("UPDATE hs_data_records SET parent_organisation_id=$3,version=version+1,updated_by=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, recordId, c.newOrganisationId, ctx.actor.id]);
      const next = await this.raw(tx, ctx, recordId);
      const legalAfter = await tx.query<{ id: string }>("SELECT id FROM hs_data_relationships WHERE tenant_id=$1 AND source_id IN(SELECT source_id FROM hs_data_relationships WHERE tenant_id=$1 AND kind='contract-account' AND target_id=$2) AND kind='contract-legal-party' ORDER BY id", [ctx.tenantId, recordId]);
      if (JSON.stringify(legalAfter.rows) !== JSON.stringify(legalBefore.rows)) throw new DocumentError("Legal parties changed unexpectedly.", "record_relationship_integrity", 500);
      await this.emit(tx, ctx, next, c.operationId, "account-reparent", account, await this.fields(tx, ctx, account.collection));
      await this.remember(tx, ctx, c.operationId, requestHash, next, "account-reparent");
      return {
        record: await this.view(tx, ctx, next, t),
        appliedVersion: next.version,
        replayed: false,
        affectedContracts: preview.affectedContracts,
        legalPartiesChanged: false,
      };
    });
  }
}
