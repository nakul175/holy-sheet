import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { formatIst } from "./ist-label";
import {
  acceptedProfileColumn,
  applyImportProfile,
  columnsFromPositionalMapping,
  headerKey,
  importProfileAccess,
  profileCompatibility,
  profilePayloadHasSecrets,
  snapshotBindings,
  type ImportProfileBinding,
  type ImportProfileColumn,
  type ImportProfileField,
  type ImportProfileMode,
  type ImportProfilePreview,
  type ImportProfileScope,
} from "./import-mapping-profile";
import { recordImportMapping } from "./shared-record-import-values";
import { SharedRecordRepository, type RecordContext } from "./shared-records";
import { recordHash, type RecordField } from "./shared-record-types";

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(100).refine((value) => !/[\p{Cc}]/u.test(value));
const mapping = recordImportMapping;
const save = z.object({
  id: uuid,
  operationId: uuid,
  jobId: uuid,
  collection: z.string().min(1).max(100),
  scope: z.enum(["personal", "shared"]),
  name,
  expectedVersion: z.number().int().nonnegative(),
  mapping,
}).strict();
const draft = save.extend({ draftId: uuid }).strict();
const versioned = z.object({ id: uuid, operationId: uuid, expectedVersion: z.number().int().positive() }).strict();
const apply = z.object({ id: uuid, operationId: uuid, jobId: uuid, draft: z.boolean().optional() }).strict();
type SaveInput = z.infer<typeof save>;
type Profile = {
  id: string;
  tenant_id: string;
  workspace_id: string;
  collection: string;
  owner_id: string;
  scope: ImportProfileScope;
  name: string;
  mode: ImportProfileMode;
  columns: unknown;
  bindings: unknown;
  schema_version: number;
  version: number;
  deleted: boolean;
  created_at: string;
  updated_at: string;
};
type DraftRow = { id: string; profile_id: string; collection: string; name: string; scope: ImportProfileScope; mode: ImportProfileMode; columns: unknown; version: number };
type Job = { id: string; collection: string; headers: unknown; expires_at: string };

const fail = (message: string, code = "import_profile_conflict", status = 409) => new DocumentError(message, code, status);
const missing = () => fail("The import profile is unavailable.", "import_profile_unavailable", 404);
const forbidden = () => fail("Import profile management is not permitted.", "import_profile_forbidden", 403);
const invalid = (message = "Review the import profile.") => fail(message, "import_profile_validation", 400);

export class SharedRecordImportProfileRepository extends SharedRecordRepository {
  private async profileCaps(tx: Sql, ctx: RecordContext, collection: string) {
    const capabilities = await this.collectionCaps(tx, ctx, collection);
    if (!capabilities.includes("view") || !capabilities.includes("import")) throw forbidden();
    return capabilities;
  }

  private async catalogue(tx: Sql, ctx: RecordContext, collection: string) {
    const fields = await this.fields(tx, ctx, collection);
    const catalogue: ImportProfileField[] = [];
    for (const field of fields) {
      const visible = await this.fieldAllowed(tx, ctx, collection, field, "view");
      const writable = visible && await this.fieldAllowed(tx, ctx, collection, field, "write");
      catalogue.push(this.profileField(field, visible, writable));
    }
    return catalogue;
  }

  private profileField(field: RecordField, visible: boolean, writable: boolean): ImportProfileField {
    return {
      fieldId: field.key,
      label: field.label,
      kind: field.kind,
      choices: [...(field.referenceList ? field.referenceList.items.map((item) => item.id) : field.choices)],
      required: field.required,
      unique: field.unique,
      deprecated: field.deprecated,
      referenceListId: field.referenceListId ?? null,
      referenceListVersion: field.referenceList?.version ?? null,
      sensitive: field.sensitive,
      visible,
      writable,
    };
  }

  private columnsOf(value: unknown) {
    if (!Array.isArray(value)) return null;
    const columns: ImportProfileColumn[] = [];
    for (const item of value) {
      const column = acceptedProfileColumn(item);
      if (!column) return null;
      columns.push(column);
    }
    return columns;
  }

  private bindingsOf(value: unknown): ImportProfileBinding[] | null {
    if (!Array.isArray(value) || profilePayloadHasSecrets(value)) return null;
    const bindings: ImportProfileBinding[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") return null;
      const binding = item as Partial<ImportProfileBinding>;
      if (typeof binding.fieldId !== "string" || typeof binding.kind !== "string" || !Array.isArray(binding.choices) || binding.choices.some((choice) => typeof choice !== "string")) return null;
      if (typeof binding.required !== "boolean" || typeof binding.unique !== "boolean" || typeof binding.deprecated !== "boolean") return null;
      bindings.push({
        fieldId: binding.fieldId,
        kind: binding.kind,
        choices: binding.choices,
        required: binding.required,
        unique: binding.unique,
        deprecated: binding.deprecated,
        referenceListId: typeof binding.referenceListId === "string" ? binding.referenceListId : null,
        referenceListVersion: typeof binding.referenceListVersion === "number" ? binding.referenceListVersion : null,
      });
    }
    return bindings;
  }

  private restricted(columns: ImportProfileColumn[], fields: ImportProfileField[]) {
    return columns.some((column) => {
      if (column.role !== "field" || !column.fieldId) return false;
      const field = fields.find((item) => item.fieldId === column.fieldId);
      return !field || !field.visible || !field.writable;
    });
  }

  private present(profile: Profile, fields: ImportProfileField[], capabilities: string[], actorId: string) {
    const access = importProfileAccess({ scope: profile.scope, ownerId: profile.owner_id, actorId, capabilities });
    const columns = this.columnsOf(profile.columns);
    const bindings = this.bindingsOf(profile.bindings);
    const hidden = !columns || !bindings || this.restricted(columns, fields);
    const compatibility = hidden || !bindings ? { compatibility: "incompatible" as const, reasons: [{ code: "field_forbidden" }] } : profileCompatibility(bindings, fields);
    return {
      id: profile.id,
      collection: profile.collection,
      scope: profile.scope,
      name: profile.name,
      mode: profile.mode,
      version: profile.version,
      schemaVersion: profile.schema_version,
      canManage: access.canManage && !profile.deleted,
      canUse: access.canUse && !profile.deleted && !hidden,
      compatibility: compatibility.compatibility,
      restricted: hidden,
      columns: hidden ? null : columns,
      reasons: hidden ? [{ code: "field_forbidden" }] : compatibility.reasons,
    };
  }

  private async ownedJob(tx: Sql, ctx: RecordContext, jobId: string, collection: string) {
    if (!uuid.safeParse(jobId).success) throw fail("The staged import is unavailable.", "import_profile_unavailable", 404);
    const job = (await tx.query<Job>("SELECT id, collection, headers, expires_at FROM hs_data_import_jobs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4", [jobId, ctx.tenantId, ctx.workspaceId, ctx.actor.id])).rows[0];
    if (!job || job.collection !== collection) throw fail("The staged import is unavailable.", "import_profile_unavailable", 404);
    if (new Date(job.expires_at).getTime() <= Date.now()) throw fail("The private import staging copy expired after 24 hours.", "record_import_expired", 410);
    if (!Array.isArray(job.headers) || job.headers.some((header) => typeof header !== "string")) throw invalid("The staged headers are unavailable.");
    return { ...job, headers: job.headers as string[] };
  }

  private async samples(tx: Sql, jobId: string) {
    const rows = await tx.query<{ raw_cells: unknown }>("SELECT raw_cells FROM hs_data_import_rows WHERE job_id=$1 ORDER BY ordinal LIMIT 3", [jobId]);
    return rows.rows.map((row) => Array.isArray(row.raw_cells) ? row.raw_cells.map((cell) => typeof cell === "string" ? cell : "") : []);
  }

  private async audit(tx: Sql, ctx: RecordContext, profile: { id: string; collection: string; version: number; scope?: string; mode?: string }, operationId: string, operation: string) {
    await tx.query("INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ctx.actor.id, `import-profile.${operation}`, JSON.stringify({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, profileId: profile.id, collection: profile.collection, version: profile.version, operation, source: "holy-sheet", atIst: formatIst(new Date()), ...(profile.scope ? { scope: profile.scope } : {}), ...(profile.mode ? { mode: profile.mode } : {}) }), operationId]);
  }

  private async profile(tx: Sql, ctx: RecordContext, profileId: string, capabilities: string[], lock = false) {
    if (!uuid.safeParse(profileId).success) throw missing();
    const row = (await tx.query<Profile>(`SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3${lock ? " FOR UPDATE" : ""}`, [profileId, ctx.tenantId, ctx.workspaceId])).rows[0];
    if (!row) throw missing();
    const access = importProfileAccess({ scope: row.scope, ownerId: row.owner_id, actorId: ctx.actor.id, capabilities });
    if (!access.visible) throw missing();
    return { row, access };
  }

  async listProfiles(ctx: RecordContext, collection: string, query = "") {
    const parsed = z.object({ collection: z.string().min(1).max(100), query: z.string().max(100) }).strict().safeParse({ collection, query });
    if (!parsed.success) throw invalid("Review the profile search.");
    const term = parsed.data.query.trim();
    return this.transaction(ctx, async (tx, tenant) => {
      const capabilities = await this.profileCaps(tx, ctx, parsed.data.collection);
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND collection=$3 AND deleted=false AND (scope='shared' OR owner_id=$4) AND ($5::text='' OR lower(name) LIKE lower($6) ESCAPE '\\') ORDER BY lower(name), id LIMIT 201", [ctx.tenantId, ctx.workspaceId, parsed.data.collection, ctx.actor.id, term, pattern]);
      if (rows.rows.length > 200) throw invalid("Use a narrower profile search.");
      const fields = await this.catalogue(tx, ctx, parsed.data.collection);
      const drafts = await tx.query<DraftRow>("SELECT id, profile_id, collection, name, scope, mode, columns, version FROM hs_data_import_profile_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND collection=$4 ORDER BY profile_id", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, parsed.data.collection]);
      return {
        schemaVersion: tenant.schema_version,
        canManageShared: capabilities.includes("manage-import-profiles"),
        profiles: rows.rows.map((row) => this.present(row, fields, capabilities, ctx.actor.id)),
        drafts: drafts.rows.map((row) => ({ id: row.id, profileId: row.profile_id, name: row.name, scope: row.scope, mode: row.mode, version: row.version })),
      };
    });
  }

  private async prepared(tx: Sql, ctx: RecordContext, input: SaveInput) {
    const capabilities = await this.profileCaps(tx, ctx, input.collection);
    const access = importProfileAccess({ scope: input.scope, ownerId: ctx.actor.id, actorId: ctx.actor.id, capabilities });
    if (!access.canManage) throw forbidden();
    const job = await this.ownedJob(tx, ctx, input.jobId, input.collection);
    const built = columnsFromPositionalMapping(job.headers, input.mapping, input.collection);
    if (!built.ok) throw invalid(built.message);
    for (const column of built.columns) {
      if (job.headers.filter((header) => headerKey(header) === headerKey(column.header)).length !== 1) throw invalid("That header is ambiguous in the staged file. Repair it before saving a profile.");
    }
    const fields = await this.catalogue(tx, ctx, input.collection);
    for (const column of built.columns) {
      if (column.role !== "field" || !column.fieldId) continue;
      const field = fields.find((item) => item.fieldId === column.fieldId);
      if (!field || !field.visible || !field.writable || field.deprecated) throw fail("A mapped field is not permitted.", "import_profile_field_unavailable", 403);
      if (column.currency && field.kind !== "currency") throw invalid("Currency options apply to currency fields only.");
      if (column.lookup && !field.referenceListId) throw invalid("Reference lookup applies to reference fields only.");
    }
    if (profilePayloadHasSecrets(built.columns)) throw invalid("A profile cannot store samples or secrets.");
    const bindings = snapshotBindings(built.columns, fields);
    const compatibility = profileCompatibility(bindings, fields);
    if (compatibility.compatibility === "incompatible") throw invalid("Map the current required fields before saving this profile.");
    return { capabilities, columns: built.columns, bindings, fields, schemaVersion: (await tx.query<{ schema_version: number }>("SELECT schema_version FROM hs_data_tenants WHERE id=$1", [ctx.tenantId])).rows[0].schema_version };
  }

  async saveProfile(ctx: RecordContext, input: SaveInput) {
    const parsed = save.safeParse(input);
    if (!parsed.success || profilePayloadHasSecrets(input)) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "save", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = (await tx.query<{ request_hash: string; profile_id: string; applied_version: number }>("SELECT request_hash, profile_id, applied_version FROM hs_data_import_profile_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, command.operationId])).rows[0];
      const existing = (await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE", [command.id, ctx.tenantId, ctx.workspaceId])).rows[0];
      if (existing && existing.collection !== command.collection) throw missing();
      if (existing && importProfileAccess({ scope: existing.scope, ownerId: existing.owner_id, actorId: ctx.actor.id, capabilities: await this.profileCaps(tx, ctx, existing.collection) }).visible === false) throw missing();
      if (prior) {
        if (prior.request_hash !== requestHash || prior.profile_id !== command.id) throw fail("Operation identity was reused.", "operation_mismatch");
        const live = existing ?? (await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3", [command.id, ctx.tenantId, ctx.workspaceId])).rows[0];
        if (!live) throw missing();
        return { id: live.id, appliedVersion: prior.applied_version, currentVersion: live.version, deleted: live.deleted, replayed: true };
      }
      if ((await tx.query("SELECT id FROM hs_data_import_profiles WHERE id=$1 AND (tenant_id<>$2 OR workspace_id<>$3)", [command.id, ctx.tenantId, ctx.workspaceId])).rows.length) throw missing();
      const prepared = await this.prepared(tx, ctx, command);
      if (existing?.deleted || (existing && (existing.version !== command.expectedVersion || existing.scope !== command.scope)) || (!existing && command.expectedVersion !== 0)) throw fail("The profile changed. Keep your draft and review the current version.");
      if (!existing) {
        const count = await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_data_import_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND collection=$3 AND deleted=false", [ctx.tenantId, ctx.workspaceId, command.collection]);
        if (Number(count.rows[0].n) >= 200) throw invalid("This collection already has 200 import profiles in this workspace.");
        await tx.query("INSERT INTO hs_data_import_profiles(id,tenant_id,workspace_id,collection,owner_id,scope,name,mode,columns,bindings,schema_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [command.id, ctx.tenantId, ctx.workspaceId, command.collection, ctx.actor.id, command.scope, command.name, command.mapping.mode, JSON.stringify(prepared.columns), JSON.stringify(prepared.bindings), prepared.schemaVersion]);
      } else {
        await tx.query("UPDATE hs_data_import_profiles SET name=$3, mode=$4, columns=$5, bindings=$6, schema_version=$7, version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, command.id, command.name, command.mapping.mode, JSON.stringify(prepared.columns), JSON.stringify(prepared.bindings), prepared.schemaVersion]);
      }
      const saved = (await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2", [command.id, ctx.tenantId])).rows[0];
      await tx.query("INSERT INTO hs_data_import_profile_versions(tenant_id,profile_id,version,name,mode,columns,bindings,schema_version,actor_id,operation_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'holy-sheet')", [ctx.tenantId, saved.id, saved.version, saved.name, saved.mode, JSON.stringify(prepared.columns), JSON.stringify(prepared.bindings), saved.schema_version, ctx.actor.id, command.operationId]);
      await tx.query("INSERT INTO hs_data_import_profile_operations(tenant_id,actor_id,operation_id,request_hash,profile_id,applied_version,kind) VALUES($1,$2,$3,$4,$5,$6,'save')", [ctx.tenantId, ctx.actor.id, command.operationId, requestHash, saved.id, saved.version]);
      await tx.query("DELETE FROM hs_data_import_profile_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND profile_id=$4", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, saved.id]);
      await this.audit(tx, ctx, saved, command.operationId, existing ? "update" : "save");
      return { id: saved.id, appliedVersion: saved.version, currentVersion: saved.version, deleted: false, replayed: false };
    });
  }

  async saveDraft(ctx: RecordContext, input: z.infer<typeof draft>) {
    const parsed = draft.safeParse(input);
    if (!parsed.success || profilePayloadHasSecrets(input)) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "draft", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = (await tx.query<{ request_hash: string; profile_id: string; applied_version: number }>("SELECT request_hash, profile_id, applied_version FROM hs_data_import_profile_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, command.operationId])).rows[0];
      const existing = (await tx.query<DraftRow>("SELECT id, profile_id, collection, name, scope, mode, columns, version FROM hs_data_import_profile_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND profile_id=$4 FOR UPDATE", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.id])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash || prior.profile_id !== command.id) throw fail("Operation identity was reused.", "operation_mismatch");
        return { id: command.id, draftId: existing?.id ?? command.draftId, appliedVersion: prior.applied_version, currentVersion: existing?.version ?? prior.applied_version, replayed: true };
      }
      const profile = (await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3", [command.id, ctx.tenantId, ctx.workspaceId])).rows[0];
      if (profile && (profile.deleted || profile.scope !== command.scope || profile.collection !== command.collection)) throw fail("The profile changed. Keep your draft and review the current version.");
      if (profile) {
        const capabilities = await this.profileCaps(tx, ctx, profile.collection);
        if (!importProfileAccess({ scope: profile.scope, ownerId: profile.owner_id, actorId: ctx.actor.id, capabilities }).canManage) throw missing();
      }
      const prepared = await this.prepared(tx, ctx, command);
      if (existing && existing.version !== command.expectedVersion || !existing && command.expectedVersion !== 0) throw fail("The draft changed. Keep this copy and review the saved draft.");
      if (!existing) await tx.query("INSERT INTO hs_data_import_profile_drafts(id,tenant_id,workspace_id,actor_id,collection,profile_id,name,scope,mode,columns) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [command.draftId, ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.collection, command.id, command.name, command.scope, command.mapping.mode, JSON.stringify(prepared.columns)]);
      else await tx.query("UPDATE hs_data_import_profile_drafts SET name=$3, mode=$4, columns=$5, version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, existing.id, command.name, command.mapping.mode, JSON.stringify(prepared.columns)]);
      const saved = (await tx.query<DraftRow>("SELECT id, profile_id, collection, name, scope, mode, columns, version FROM hs_data_import_profile_drafts WHERE tenant_id=$1 AND actor_id=$2 AND profile_id=$3", [ctx.tenantId, ctx.actor.id, command.id])).rows[0];
      await tx.query("INSERT INTO hs_data_import_profile_operations(tenant_id,actor_id,operation_id,request_hash,profile_id,applied_version,kind) VALUES($1,$2,$3,$4,$5,$6,'draft')", [ctx.tenantId, ctx.actor.id, command.operationId, requestHash, command.id, saved.version]);
      await this.audit(tx, ctx, { id: command.id, collection: command.collection, version: saved.version, scope: command.scope, mode: command.mapping.mode }, command.operationId, "draft");
      return { id: command.id, draftId: saved.id, appliedVersion: saved.version, currentVersion: saved.version, replayed: false };
    });
  }

  async discardDraft(ctx: RecordContext, input: { id: string; operationId: string; expectedVersion: number }) {
    const parsed = versioned.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "discard", ...command });
    return this.transaction(ctx, async (tx) => {
      const prior = (await tx.query<{ request_hash: string; applied_version: number }>("SELECT request_hash, applied_version FROM hs_data_import_profile_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, command.operationId])).rows[0];
      const existing = (await tx.query<DraftRow>("SELECT id, profile_id, collection, name, scope, mode, columns, version FROM hs_data_import_profile_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND profile_id=$4 FOR UPDATE", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.id])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw fail("Operation identity was reused.", "operation_mismatch");
        return { id: command.id, discarded: !existing, replayed: true };
      }
      if (!existing || existing.version !== command.expectedVersion) throw fail("The draft changed. Keep this copy and review the saved draft.");
      const capabilities = await this.profileCaps(tx, ctx, existing.collection);
      const profile = (await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3", [command.id, ctx.tenantId, ctx.workspaceId])).rows[0];
      if (profile && !importProfileAccess({ scope: profile.scope, ownerId: profile.owner_id, actorId: ctx.actor.id, capabilities }).canManage) throw missing();
      await tx.query("DELETE FROM hs_data_import_profile_drafts WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, existing.id]);
      await tx.query("INSERT INTO hs_data_import_profile_operations(tenant_id,actor_id,operation_id,request_hash,profile_id,applied_version,kind) VALUES($1,$2,$3,$4,$5,$6,'discard')", [ctx.tenantId, ctx.actor.id, command.operationId, requestHash, command.id, existing.version]);
      await this.audit(tx, ctx, { id: command.id, collection: existing.collection, version: existing.version, scope: existing.scope, mode: existing.mode }, command.operationId, "discard");
      return { id: command.id, discarded: true, replayed: false };
    });
  }

  async deleteProfile(ctx: RecordContext, input: { id: string; operationId: string; expectedVersion: number }) {
    const parsed = versioned.safeParse(input);
    if (!parsed.success) throw invalid();
    const command = parsed.data;
    const requestHash = recordHash({ kind: "delete", ...command });
    return this.transaction(ctx, async (tx) => {
      const found = (await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE", [command.id, ctx.tenantId, ctx.workspaceId])).rows[0];
      if (!found) throw missing();
      const capabilities = await this.profileCaps(tx, ctx, found.collection);
      if (!importProfileAccess({ scope: found.scope, ownerId: found.owner_id, actorId: ctx.actor.id, capabilities }).canManage) throw found.scope === "personal" ? missing() : forbidden();
      const prior = (await tx.query<{ request_hash: string; applied_version: number }>("SELECT request_hash, applied_version FROM hs_data_import_profile_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3", [ctx.tenantId, ctx.actor.id, command.operationId])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw fail("Operation identity was reused.", "operation_mismatch");
        return { id: found.id, appliedVersion: prior.applied_version, currentVersion: found.version, deleted: found.deleted, replayed: true };
      }
      if (found.deleted || found.version !== command.expectedVersion) throw fail("The profile changed. Keep your draft and review the current version.");
      await tx.query("UPDATE hs_data_import_profiles SET deleted=true, version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, found.id]);
      await tx.query("DELETE FROM hs_data_import_profile_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND profile_id=$3 AND actor_id=$4", [ctx.tenantId, ctx.workspaceId, found.id, ctx.actor.id]);
      await tx.query("INSERT INTO hs_data_import_profile_operations(tenant_id,actor_id,operation_id,request_hash,profile_id,applied_version,kind) VALUES($1,$2,$3,$4,$5,$6,'delete')", [ctx.tenantId, ctx.actor.id, command.operationId, requestHash, found.id, found.version + 1]);
      await this.audit(tx, ctx, { ...found, version: found.version + 1 }, command.operationId, "delete");
      return { id: found.id, appliedVersion: found.version + 1, currentVersion: found.version + 1, deleted: true, replayed: false };
    });
  }

  async applyProfile(ctx: RecordContext, input: { id: string; operationId: string; jobId: string; draft?: boolean }): Promise<ImportProfilePreview & { profileId: string; version: number }> {
    const parsed = apply.safeParse(input);
    if (!parsed.success || profilePayloadHasSecrets(input)) throw invalid();
    const command = parsed.data;
    return this.transaction(ctx, async (tx) => {
      const profileRow = (await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3", [command.id, ctx.tenantId, ctx.workspaceId])).rows[0];
      const draftRow = command.draft ? (await tx.query<DraftRow>("SELECT id, profile_id, collection, name, scope, mode, columns, version FROM hs_data_import_profile_drafts WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND profile_id=$4", [ctx.tenantId, ctx.workspaceId, ctx.actor.id, command.id])).rows[0] : undefined;
      const collection = draftRow?.collection ?? profileRow?.collection;
      if (!collection) throw missing();
      const capabilities = await this.profileCaps(tx, ctx, collection);
      if (profileRow) {
        const access = importProfileAccess({ scope: profileRow.scope, ownerId: profileRow.owner_id, actorId: ctx.actor.id, capabilities });
        if (!access.visible || profileRow.deleted) throw missing();
        if (!access.canUse) throw forbidden();
      } else if (!draftRow) throw missing();
      else if (!importProfileAccess({ scope: draftRow.scope, ownerId: ctx.actor.id, actorId: ctx.actor.id, capabilities }).canUse) throw forbidden();
      const columns = this.columnsOf(command.draft ? draftRow?.columns : profileRow?.columns);
      const bindings = command.draft ? snapshotBindings(columns ?? [], await this.catalogue(tx, ctx, collection)) : this.bindingsOf(profileRow?.bindings);
      const mode = command.draft ? draftRow?.mode : profileRow?.mode;
      if (!columns || !bindings || !mode) throw invalid("This profile needs repair before it can be applied.");
      const fields = await this.catalogue(tx, ctx, collection);
      const job = await this.ownedJob(tx, ctx, command.jobId, collection);
      const samples = await this.samples(tx, job.id);
      const preview = applyImportProfile({ collection, mode, columns, bindings, fields, headers: job.headers, samples });
      await this.audit(tx, ctx, { id: command.id, collection, version: command.draft ? draftRow!.version : profileRow!.version, scope: command.draft ? draftRow!.scope : profileRow!.scope, mode }, command.operationId, "apply");
      return { ...preview, profileId: command.id, version: command.draft ? draftRow!.version : profileRow!.version };
    });
  }

  async profileHistory(ctx: RecordContext, profileId: string) {
    return this.transaction(ctx, async (tx) => {
      const row = (await tx.query<Profile>("SELECT * FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3", [profileId, ctx.tenantId, ctx.workspaceId])).rows[0];
      if (!row) throw missing();
      const capabilities = await this.profileCaps(tx, ctx, row.collection);
      const access = importProfileAccess({ scope: row.scope, ownerId: row.owner_id, actorId: ctx.actor.id, capabilities });
      if (!access.visible) throw missing();
      const fields = await this.catalogue(tx, ctx, row.collection);
      const versions = await tx.query<{ version: number; name: string; mode: ImportProfileMode; schema_version: number; columns: unknown; actor_id: string; operation_id: string; source: string; created_at: string }>("SELECT version, name, mode, schema_version, columns, actor_id, operation_id, source, created_at FROM hs_data_import_profile_versions WHERE tenant_id=$1 AND profile_id=$2 ORDER BY version", [ctx.tenantId, row.id]);
      return {
        profileId: row.id,
        versions: versions.rows.map((version) => {
          const columns = this.columnsOf(version.columns);
          const hidden = !columns || this.restricted(columns, fields);
          return { version: version.version, name: version.name, mode: version.mode, schemaVersion: version.schema_version, actorId: version.actor_id, source: version.source, atIst: formatIst(version.created_at), operationId: version.operation_id, restricted: hidden, columns: hidden ? null : columns };
        }),
      };
    });
  }

  async downloadProfile(ctx: RecordContext, profileId: string) {
    return this.transaction(ctx, async (tx) => {
      const located = (await tx.query<{ collection: string }>("SELECT collection FROM hs_data_import_profiles WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND deleted=false", [profileId, ctx.tenantId, ctx.workspaceId])).rows[0];
      if (!located) throw missing();
      const capabilities = await this.profileCaps(tx, ctx, located.collection);
      const { row } = await this.profile(tx, ctx, profileId, capabilities);
      const fields = await this.catalogue(tx, ctx, row.collection);
      const view = this.present(row, fields, capabilities, ctx.actor.id);
      if (!view.canUse || view.restricted || !view.columns) throw fail("A mapped field is not permitted.", "import_profile_field_unavailable", 403);
      const body = { name: row.name, collection: row.collection, scope: row.scope, mode: row.mode, schemaVersion: row.schema_version, version: row.version, columns: view.columns, samplesStored: false };
      if (profilePayloadHasSecrets(body)) throw invalid("A profile cannot store samples or secrets.");
      return { filename: "import-mapping-profile.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from(JSON.stringify(body), "utf8") };
    });
  }
}

export type { SaveInput };
