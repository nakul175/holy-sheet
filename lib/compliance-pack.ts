import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import JSZip from "jszip";
import type { Actor } from "./auth";
import { identityTokenFromRequest } from "./auth";
import type { Sql } from "./database";
import type { Repository } from "./repository";
import { DocumentError, schemaVersion, stableStringify, validateDocument, type RichNode } from "./document";
import { publishedDocument } from "./document-publishing";
import { renderMarkdown, type ExportFormat, type ExportInput, type ExportReference } from "./export-plan";
import { formatIst } from "./ist-label";
import { exportRecordPageRefs } from "./record-page-ref-store";
import type { RecordExportSlice } from "./record-page-refs";
import { canEdit } from "./types";
import {
  ATTACHMENTS_EXCLUDED_NOTE,
  COMPLIANCE_READY_BODY,
  COMPLIANCE_READY_SUBJECT,
  acknowledgementEvidenceCsv,
  attachmentFile,
  auditEvidenceCsv,
  complianceSigningKey,
  etaSeconds,
  exporterVisibleRecords,
  recordSnapshotFiles,
  renderComplianceHtml,
  restorerCanIncludeTrash,
  selectAttachmentDescriptors,
  signManifest,
  type AcknowledgementEvidenceRow,
  type AttachmentDescriptor,
  type AuditEvidenceRow,
  type ComplianceCounts,
  type ComplianceFormat,
  type ComplianceManifest,
  type ComplianceScope,
  type PackFile,
} from "./compliance-pack-plan";

export type { ComplianceFormat, ComplianceScope, ComplianceCounts } from "./compliance-pack-plan";
export { COMPLIANCE_READY_BODY, COMPLIANCE_READY_SUBJECT, ATTACHMENTS_EXCLUDED_NOTE } from "./compliance-pack-plan";

export type ComplianceOptions = { includeDraft: boolean; includeTrash: boolean; allAttachmentVersions: boolean };
export type ComplianceJobView = {
  id: string;
  scope: ComplianceScope;
  format: ComplianceFormat;
  state: string;
  progress: number;
  etaSeconds: number;
  counts: ComplianceCounts;
  notes: string[];
  manifestHash: string | null;
  expiresAt: string | null;
  downloadToken: string | null;
  atIst: string;
  replayed?: boolean;
};
export type ComplianceBuildDeps = {
  renderPdf?: (input: ExportInput) => Promise<Buffer>;
  beforeItem?: (tx: Sql, index: number, jobId: string) => Promise<void>;
};

type JobRow = {
  id: string;
  workspace_id: string;
  actor_id: string;
  operation_id: string;
  scope: ComplianceScope;
  format: ComplianceFormat;
  target_id: string;
  options: unknown;
  request_hash: string;
  session_binding: string;
  state: string;
  progress: number;
  eta_seconds: number;
  item_counts: unknown;
  notes: unknown;
  manifest_hash: string | null;
  signature: string | null;
  download_token: string | null;
  expires_at: string | null;
  created_at: string;
  completed_at: string | null;
};
type PageRow = { id: string; parent_id: string | null; space_id: string; owner_id: string; title: string; deleted_at: string | null; version: number; schema_version: number };
type Member = { role: string; export_enabled: boolean };

const unavailable = () => new DocumentError("Export unavailable", "not_found", 404);
const emptyCounts = (): ComplianceCounts => ({ pages: 0, records: 0, restrictedRecords: 0, attachments: 0, acknowledgements: 0, auditRows: 0 });
const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value == null ? fallback : value as T;
};
const digest = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const sameSecret = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function complianceSessionBinding(request: Request, actorId: string) {
  const token = identityTokenFromRequest(request) ?? `local:${actorId}`;
  return createHash("sha256").update(`hs-compliance-session:${token}`).digest("hex");
}

function origin() {
  if (process.env.NODE_ENV === "production" && !process.env.HS_ORIGIN) throw new DocumentError("Export origin unavailable", "export_unavailable", 503);
  const value = process.env.HS_ORIGIN ?? "http://localhost:3000";
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.origin !== value) throw new DocumentError("Export origin unavailable", "export_unavailable", 503);
  return value;
}

function view(row: JobRow, token: boolean): ComplianceJobView {
  return {
    id: row.id,
    scope: row.scope,
    format: row.format,
    state: row.state,
    progress: Number(row.progress),
    etaSeconds: Number(row.eta_seconds),
    counts: { ...emptyCounts(), ...json(row.item_counts, {}) },
    notes: json<string[]>(row.notes, []),
    manifestHash: row.manifest_hash,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    downloadToken: token ? row.download_token : null,
    atIst: formatIst(row.completed_at ?? row.created_at),
  };
}

async function member(tx: Sql, workspaceId: string, actorId: string): Promise<Member | null> {
  const result = await tx.query<Member>("SELECT m.role, w.export_enabled FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1", [workspaceId, actorId]);
  return result.rows[0] ?? null;
}

async function spaceInWorkspace(tx: Sql, workspaceId: string, spaceId: string) {
  const result = await tx.query<{ id: string }>("SELECT id FROM hs_spaces WHERE id=$1 AND workspace_id=$2", [spaceId, workspaceId]);
  return result.rows[0] ?? null;
}

export async function exportAttachmentPolicy(r: Repository, actor: Actor, workspaceId: string, spaceId: string) {
  return r.db.transaction(async tx => {
    const access = await member(tx, workspaceId, actor.id);
    if (!access || !await spaceInWorkspace(tx, workspaceId, spaceId)) throw unavailable();
    const policy = await tx.query<{ attachments: boolean; version: number }>("SELECT attachments, version FROM hs_space_export_policy WHERE space_id=$1 AND workspace_id=$2", [spaceId, workspaceId]);
    const row = policy.rows[0];
    return { spaceId, attachments: row?.attachments ?? true, version: row ? Number(row.version) : 1, manage: access.role === "owner" || access.role === "admin" };
  });
}

export async function changeExportAttachmentPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; spaceId: string; attachments: boolean; expectedVersion: number }) {
  const requestHash = digest(input);
  return r.db.transaction(async tx => {
    const access = await member(tx, workspaceId, actor.id);
    if (!access || !await spaceInWorkspace(tx, workspaceId, input.spaceId)) throw unavailable();
    if (access.role !== "owner" && access.role !== "admin") throw new DocumentError("A native workspace administrator must change export policy.", "admin_required", 403);
    const prior = await tx.query<{ request_hash: string; result: { attachments: boolean; version: number } }>("SELECT request_hash, result FROM hs_space_export_policy_operations WHERE space_id=$1 AND actor_id=$2 AND operation_id=$3", [input.spaceId, actor.id, input.operationId]);
    const storedPolicy = await tx.query<{ attachments: boolean; version: number }>("SELECT attachments, version FROM hs_space_export_policy WHERE space_id=$1 AND workspace_id=$2", [input.spaceId, workspaceId]);
    const current = { spaceId: input.spaceId, attachments: storedPolicy.rows[0]?.attachments ?? true, version: storedPolicy.rows[0] ? Number(storedPolicy.rows[0].version) : 1, manage: true };
    if (prior.rows.length) {
      if (prior.rows[0].request_hash !== requestHash) throw new DocumentError("Policy operation ID was reused.", "operation_mismatch", 409);
      return { ...current, replayed: true, applied: json(prior.rows[0].result, prior.rows[0].result) };
    }
    if (current.version !== input.expectedVersion) throw new DocumentError("Export policy changed. Refresh and review it.", "export_policy_conflict", 409);
    const result = { attachments: input.attachments, version: current.version + 1 };
    await tx.query(`INSERT INTO hs_space_export_policy(space_id, workspace_id, attachments, version) VALUES($1,$2,$3,$4)
      ON CONFLICT(space_id) DO UPDATE SET attachments=EXCLUDED.attachments, version=EXCLUDED.version, workspace_id=EXCLUDED.workspace_id`, [input.spaceId, workspaceId, result.attachments, result.version]);
    await tx.query("INSERT INTO hs_space_export_policy_operations(space_id, actor_id, operation_id, request_hash, result) VALUES($1,$2,$3,$4,$5)", [input.spaceId, actor.id, input.operationId, requestHash, JSON.stringify(result)]);
    await tx.query("INSERT INTO hs_audit(id, actor_id, action, after_value, correlation_id) VALUES($1,$2,'export.attachment-policy',$3,$4)", [randomUUID(), actor.id, JSON.stringify({ workspaceId, spaceId: input.spaceId, attachments: result.attachments, version: result.version, atIst: formatIst(new Date()) }), input.operationId]);
    return { spaceId: input.spaceId, ...result, manage: true, replayed: false };
  });
}

async function attachmentsAllowed(tx: Sql, workspaceId: string, spaceId: string) {
  const policy = await tx.query<{ attachments: boolean }>("SELECT attachments FROM hs_space_export_policy WHERE space_id=$1 AND workspace_id=$2", [spaceId, workspaceId]);
  return policy.rows[0]?.attachments ?? true;
}

async function pagesInWorkspace(tx: Sql, workspaceId: string) {
  const result = await tx.query<PageRow>("SELECT id, parent_id, space_id, owner_id, title, deleted_at, version, schema_version FROM hs_pages WHERE workspace_id=$1 ORDER BY position, id LIMIT 1001", [workspaceId]);
  if (result.rows.length > 1000) throw new DocumentError("This export supports up to 1,000 pages. No pack was issued.", "export_limit", 422);
  return result.rows;
}

function descendants(pages: PageRow[], rootId: string) {
  const children = new Map<string, PageRow[]>();
  for (const page of pages) {
    if (!page.parent_id) continue;
    children.set(page.parent_id, [...(children.get(page.parent_id) ?? []), page]);
  }
  const selected: PageRow[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const page = pages.find(item => item.id === id);
    if (!page) return;
    selected.push(page);
    for (const child of children.get(id) ?? []) walk(child.id);
  };
  walk(rootId);
  return selected;
}

async function audit(tx: Sql, actorId: string, action: string, operationId: string, pageId: string | null, after: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_audit(id, actor_id, action, page_id, after_value, correlation_id) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), actorId, action, pageId, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId]);
}

async function abortJob(tx: Sql, row: JobRow) {
  await tx.query("DELETE FROM hs_compliance_files WHERE job_id=$1", [row.id]);
  await tx.query("UPDATE hs_compliance_jobs SET state='aborted', progress=0, eta_seconds=0, download_token=NULL, manifest_hash=NULL, signature=NULL, expires_at=NULL, completed_at=clock_timestamp(), item_counts=$2, notes=$3 WHERE id=$1", [row.id, JSON.stringify(emptyCounts()), JSON.stringify([])]);
  await audit(tx, row.actor_id, "compliance-export.abort", row.operation_id, null, { scope: row.scope, reason: "access_revoked" });
  const next = await tx.query<JobRow>("SELECT * FROM hs_compliance_jobs WHERE id=$1", [row.id]);
  return { ...view(next.rows[0], false), replayed: false };
}

async function loadDocument(tx: Sql, pageId: string) {
  const nodes = await tx.query<{ node: RichNode }>("SELECT node FROM hs_blocks WHERE page_id=$1 AND parent_id IS NULL ORDER BY position", [pageId]);
  return validateDocument({ type: "doc", content: nodes.rows.map(row => row.node) });
}

async function pageReferences(r: Repository, tx: Sql, actor: Actor, workspaceId: string, document: RichNode) {
  const ids = new Set<string>();
  const visit = (node: RichNode) => {
    if (node.type === "pageLink") ids.add(String(node.attrs?.pageId ?? ""));
    node.content?.forEach(visit);
  };
  visit(document);
  const refs: Record<string, ExportReference> = Object.create(null);
  for (const id of [...ids].sort()) {
    if (!id) continue;
    try {
      const page = await r.get(id, actor, tx);
      refs[id] = page.workspaceId === workspaceId ? { available: true, title: page.title, url: `${origin()}/pages/${encodeURIComponent(id)}` } : { available: false };
    } catch (error) {
      if (error instanceof DocumentError && [403, 404].includes(error.status)) refs[id] = { available: false };
      else throw error;
    }
  }
  return refs;
}

async function mediaDescriptors(tx: Sql, workspaceId: string, pageId: string, document: RichNode, allVersions: boolean) {
    const ids = new Set<string>();
  const visit = (node: RichNode) => {
    if ((node.type === "image" || node.type === "file") && node.attrs?.attachmentId) ids.add(String(node.attrs.attachmentId));
    node.content?.forEach(visit);
  };
  visit(document);
  const mediaId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const files: PackFile[] = [];
  for (const id of [...ids].sort()) {
    if (!mediaId.test(id)) continue;
    const media = await tx.query<{ name: string; mime: string; size: string | number; sha256: string | null; state: string; deleted_at: string | null }>("SELECT name, mime, size, sha256, state, deleted_at FROM hs_media WHERE id=$1::uuid AND page_id=$2", [id, pageId]);
    const row = media.rows[0];
    if (!row || row.state !== "ready" || row.deleted_at || !row.sha256) continue;
    const current: AttachmentDescriptor = { name: row.name, mime: row.mime, sha256: row.sha256, size: Number(row.size), version: 1 };
    const versions = await tx.query<{ version_no: number; name: string; mime: string; checksum: string; size: string | number; deleted_at: string | null; current_version_id: string | null; version_id: string }>(`SELECT v.version_no, v.name, v.mime, v.checksum, v.size, v.deleted_at, f.current_version_id, v.id AS version_id
      FROM hs_linked_files f JOIN hs_attachment_versions v ON v.file_id=f.id
      WHERE f.media_id=$1::uuid AND f.workspace_id=$2 AND f.deleted_at IS NULL`, [id, workspaceId]);
    const described = versions.rows.filter(version => !version.deleted_at).map(version => ({ name: version.name, mime: version.mime, sha256: version.checksum, size: Number(version.size), version: Number(version.version_no) }));
    const currentVersion = versions.rows.find(version => version.version_id === version.current_version_id && !version.deleted_at);
    const selected = selectAttachmentDescriptors(currentVersion ? { name: currentVersion.name, mime: currentVersion.mime, sha256: currentVersion.checksum, size: Number(currentVersion.size), version: Number(currentVersion.version_no) } : described.length ? null : current, described, allVersions);
    for (const descriptor of selected) files.push(attachmentFile(pageId, descriptor, allVersions && selected.length > 1));
  }
  return files;
}

function exportInput(title: string, document: RichNode, version: number, format: ExportFormat, records: Record<string, RecordExportSlice> | null, references: Record<string, ExportReference>): ExportInput {
  return { title, document, version, createdAt: new Date().toISOString(), format, origin: origin(), references, recordReferences: exporterVisibleRecords(records) };
}

async function variantFiles(title: string, document: RichNode, version: number, format: ComplianceFormat, folder: string, kind: string, records: Record<string, RecordExportSlice> | null, references: Record<string, ExportReference>, attachmentsExcluded: boolean, render: (input: ExportInput) => Promise<Buffer>) {
  const files: PackFile[] = [];
  const base = `${folder}/${kind}`;
  if (format === "html" || format === "compliance-pack") files.push({ path: `${base}.html`, bytes: Buffer.from(renderComplianceHtml({ title, document, records, attachmentsExcluded }), "utf8") });
  if (format === "markdown") files.push({ path: `${base}.md`, bytes: Buffer.from(renderMarkdown(exportInput(title, document, version, "markdown", records, references)), "utf8") });
  if (format === "pdf" || format === "compliance-pack") files.push({ path: `${base}.pdf`, bytes: await render(exportInput(title, document, version, "pdf", records, references)) });
  return files;
}

async function storeFiles(tx: Sql, jobId: string, files: PackFile[]) {
  for (const file of files) {
    if (file.path.includes("..") || file.path.startsWith("/") || file.path.includes("\\")) throw new DocumentError("Export unavailable", "export_unavailable", 503);
    const sha = createHash("sha256").update(file.bytes).digest("hex");
    await tx.query("INSERT INTO hs_compliance_files(job_id, path, sha256, content) VALUES($1,$2,$3,$4)", [jobId, file.path, sha, file.bytes.toString("base64")]);
  }
}

async function acknowledgementRows(tx: Sql, pageIds: string[]): Promise<AcknowledgementEvidenceRow[]> {
  if (!pageIds.length) return [];
  const result = await tx.query<{ name: string; status: string; version_number: number; acknowledged_at: string; hash: string; prev_hash: string }>(`SELECT u.name, a.status, rec.version_number, rec.acknowledged_at, rec.hash, rec.prev_hash
    FROM hs_ack_records rec JOIN hs_ack_assignments a ON a.id=rec.assignment_id JOIN hs_users u ON u.id=rec.user_id
    WHERE rec.page_id=ANY($1::text[]) ORDER BY rec.acknowledged_at, rec.id LIMIT 5000`, [pageIds]);
  return result.rows.map(row => ({ name: row.name, status: row.status, versionLabel: `v${row.version_number}`, acknowledgedAtIst: formatIst(row.acknowledged_at), chainHash: row.hash, prevHash: row.prev_hash }));
}

async function auditRows(tx: Sql, pageIds: string[]): Promise<AuditEvidenceRow[]> {
  if (!pageIds.length) return [];
  const result = await tx.query<{ action: string; actor_id: string; page_id: string; correlation_id: string; created_at: string }>("SELECT action, actor_id, page_id, correlation_id, created_at FROM hs_audit WHERE page_id=ANY($1::text[]) ORDER BY created_at, id LIMIT 5000", [pageIds]);
  return result.rows.map(row => ({ action: row.action, actorId: row.actor_id, pageId: row.page_id, correlationId: row.correlation_id, atIst: formatIst(row.created_at) }));
}

export async function createComplianceExport(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; scope: ComplianceScope; format: ComplianceFormat; targetId: string } & ComplianceOptions, sessionBinding: string, deps: ComplianceBuildDeps = {}) {
  const requestHash = digest({ workspaceId, scope: input.scope, format: input.format, targetId: input.targetId, includeDraft: input.includeDraft, includeTrash: input.includeTrash, allAttachmentVersions: input.allAttachmentVersions });
  const render = deps.renderPdf ?? (async input => (await import("./export-render")).renderPdf(input));
  return r.db.transaction(async tx => {
    const access = await member(tx, workspaceId, actor.id);
    if (!access) throw unavailable();
    if (!access.export_enabled) throw new DocumentError("This workspace has disabled document exports.", "export_disabled", 403);
    const prior = await tx.query<JobRow>("SELECT * FROM hs_compliance_jobs WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3 FOR UPDATE", [workspaceId, actor.id, input.operationId]);
    if (prior.rows.length) {
      const row = prior.rows[0];
      if (row.request_hash !== requestHash || row.session_binding !== sessionBinding) throw new DocumentError("Export attempt was reused with different fields.", "operation_mismatch", 409);
      return { ...view(row, row.state === "ready"), replayed: true };
    }
    const catalogue = await pagesInWorkspace(tx, workspaceId);
    let selected: PageRow[] = [];
    if (input.scope === "space") {
      if (!await spaceInWorkspace(tx, workspaceId, input.targetId)) throw unavailable();
      selected = catalogue.filter(page => page.space_id === input.targetId);
    } else {
      if (!catalogue.some(page => page.id === input.targetId)) throw unavailable();
      selected = input.scope === "page" ? catalogue.filter(page => page.id === input.targetId) : descendants(catalogue, input.targetId);
      if (!selected.length) throw unavailable();
    }
    const anchor = selected[0];
    if (input.scope !== "space") {
      const root = catalogue.find(page => page.id === input.targetId);
      if (!root) throw unavailable();
      const readable = !root.deleted_at || (input.includeTrash && restorerCanIncludeTrash(access.role, root.owner_id, actor.id));
      if (!readable) throw unavailable();
      if (!root.deleted_at) {
        try { await r.access(tx, root.id, actor, false, true); } catch (error) { if (error instanceof DocumentError && [403, 404].includes(error.status)) throw unavailable(); throw error; }
      }
    }
    const jobId = randomUUID();
    const options = { includeDraft: input.includeDraft, includeTrash: input.includeTrash, allAttachmentVersions: input.allAttachmentVersions };
    await tx.query(`INSERT INTO hs_compliance_jobs(id, workspace_id, actor_id, operation_id, scope, format, target_id, options, request_hash, session_binding, state, progress, eta_seconds)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running',0,$11)`, [jobId, workspaceId, actor.id, input.operationId, input.scope, input.format, input.targetId, JSON.stringify(options), requestHash, sessionBinding, etaSeconds(selected.length)]);
    await audit(tx, actor.id, "compliance-export.queue", input.operationId, input.scope === "space" ? null : anchor?.id ?? null, { scope: input.scope, format: input.format, targetId: input.targetId });
    const row = (await tx.query<JobRow>("SELECT * FROM hs_compliance_jobs WHERE id=$1", [jobId])).rows[0];
    const included: string[] = [];
    const recordMap: Record<string, RecordExportSlice> = {};
    let attachmentFiles: PackFile[] = [];
    let sawAttachmentPolicyDenial = false;
    const spacePolicy = new Map<string, boolean>();
    for (let index = 0; index < selected.length; index += 1) {
      await deps.beforeItem?.(tx, index, jobId);
      const still = await member(tx, workspaceId, actor.id);
      if (!still || !still.export_enabled) return abortJob(tx, row);
      if (input.scope !== "space") {
        const root = catalogue.find(page => page.id === input.targetId);
        if (!root) return abortJob(tx, row);
        if (!root.deleted_at) {
          try { await r.access(tx, root.id, actor, false, true); } catch (error) { if (error instanceof DocumentError && [403, 404].includes(error.status)) return abortJob(tx, row); throw error; }
        } else if (!input.includeTrash || !restorerCanIncludeTrash(still.role, root.owner_id, actor.id)) return abortJob(tx, row);
      }
      const page = selected[index];
      if (page.deleted_at && (!input.includeTrash || !restorerCanIncludeTrash(still.role, page.owner_id, actor.id))) continue;
      let title = "";
      let version = page.version;
      let draft: RichNode | null = null;
      let published: { title: string; document: RichNode; version: number } | null = null;
      let role = "viewer";
      if (page.deleted_at) {
        if (page.schema_version !== schemaVersion) continue;
        title = page.title;
        draft = await loadDocument(tx, page.id);
      } else {
        try {
          const readable = await r.get(page.id, actor, tx);
          title = readable.title;
          version = readable.version;
          role = readable.role;
          draft = readable.document;
          try {
            const publication = await publishedDocument(r, tx, actor, page.id);
            if (publication) published = { title: publication.title, document: publication.document, version: publication.version };
          } catch (error) {
            if (!(error instanceof DocumentError) || error.status >= 500) throw error;
          }
        } catch (error) {
          if (error instanceof DocumentError && [403, 404].includes(error.status)) continue;
          throw error;
        }
      }
      if (!draft && !published) continue;
      if (!spacePolicy.has(page.space_id)) spacePolicy.set(page.space_id, await attachmentsAllowed(tx, workspaceId, page.space_id));
      const allowed = spacePolicy.get(page.space_id) ?? true;
      if (!allowed) sawAttachmentPolicyDenial = true;
      const includeDraft = !!draft && (!published || (input.includeDraft && (page.deleted_at || canEdit(role))));
      const variants: { kind: string; title: string; document: RichNode; version: number }[] = [];
      if (published) variants.push({ kind: "published", title: published.title, document: published.document, version: published.version });
      if (includeDraft && draft) variants.push({ kind: published ? "draft" : "current", title, document: draft, version });
      const folder = `pages/${page.id}`;
      const pageFiles: PackFile[] = [];
      const seenAttachments = new Set(attachmentFiles.map(file => file.path));
      for (const variant of variants) {
        const references = page.deleted_at ? {} : await pageReferences(r, tx, actor, workspaceId, variant.document);
        let records: Record<string, RecordExportSlice> | null = null;
        try { records = page.deleted_at ? null : await exportRecordPageRefs(tx, actor, workspaceId, variant.document, origin()); } catch { records = null; }
        for (const [key, slice] of Object.entries(records ?? {})) if (!recordMap[key]?.available) recordMap[key] = slice;
        pageFiles.push(...await variantFiles(variant.title, variant.document, variant.version, input.format, folder, variant.kind, records, references, !allowed, render));
        if (!allowed) continue;
        for (const file of await mediaDescriptors(tx, workspaceId, page.id, variant.document, input.allAttachmentVersions)) {
          if (seenAttachments.has(file.path)) continue;
          seenAttachments.add(file.path);
          attachmentFiles.push(file);
        }
      }
      await storeFiles(tx, jobId, pageFiles);
      included.push(page.id);
      const progress = Math.min(99, Math.round(((index + 1) / selected.length) * 100));
      await tx.query("UPDATE hs_compliance_jobs SET progress=$2, eta_seconds=$3 WHERE id=$1", [jobId, progress, etaSeconds(selected.length - index - 1)]);
    }
    const snapshots = input.format === "compliance-pack" ? recordSnapshotFiles(recordMap) : { files: [], records: 0, restrictedRecords: 0 };
    const acks = input.format === "compliance-pack" ? await acknowledgementRows(tx, included) : [];
    const audits = input.format === "compliance-pack" ? await auditRows(tx, included) : [];
    const notes = sawAttachmentPolicyDenial ? [ATTACHMENTS_EXCLUDED_NOTE] : [];
    if (input.includeDraft) notes.push("Current drafts are included only for pages you can edit.");
    if (input.includeTrash) notes.push("Trashed pages are included only when you can restore them.");
    const evidence: PackFile[] = [...snapshots.files];
    if (input.format === "compliance-pack") {
      evidence.push({ path: "acknowledgements.csv", bytes: acknowledgementEvidenceCsv(acks) });
      evidence.push({ path: "audit.csv", bytes: auditEvidenceCsv(audits) });
      evidence.push(...attachmentFiles);
    }
    const counts: ComplianceCounts = {
      pages: included.length,
      records: snapshots.records,
      restrictedRecords: snapshots.restrictedRecords,
      attachments: sawAttachmentPolicyDenial ? 0 : attachmentFiles.length,
      acknowledgements: acks.length,
      auditRows: audits.length,
    };
    const stored = await tx.query<{ path: string; sha256: string }>("SELECT path, sha256 FROM hs_compliance_files WHERE job_id=$1 ORDER BY path", [jobId]);
    const listed = [...stored.rows.map(file => ({ path: file.path, sha256: file.sha256 })), ...evidence.map(file => ({ path: file.path, sha256: createHash("sha256").update(file.bytes).digest("hex") }))].sort((a, b) => a.path.localeCompare(b.path));
    const key = complianceSigningKey();
    if (!key) throw new DocumentError("Export signing is not configured", "export_unavailable", 503);
    const signed = signManifest({ jobId, scope: input.scope, format: input.format, createdAt: new Date().toISOString(), createdAtIst: formatIst(new Date()), counts, notes, files: listed }, key);
    evidence.push({ path: "manifest.json", bytes: signed.bytes });
    await storeFiles(tx, jobId, evidence);
    const token = randomBytes(32).toString("base64url");
    await tx.query(`UPDATE hs_compliance_jobs SET state='ready', progress=100, eta_seconds=0, item_counts=$2, notes=$3, manifest_hash=$4, signature=$5, download_token=$6, completed_at=clock_timestamp(), expires_at=clock_timestamp()+interval '24 hours' WHERE id=$1`, [jobId, JSON.stringify(counts), JSON.stringify(notes), signed.hash, signed.signature, token]);
    await tx.query("INSERT INTO hs_compliance_email_outbox(id, job_id, recipient_id, subject, body) VALUES($1,$2,$3,$4,$5)", [randomUUID(), jobId, actor.id, COMPLIANCE_READY_SUBJECT, COMPLIANCE_READY_BODY]);
    if (included[0]) await tx.query("INSERT INTO hs_notifications(id, recipient_id, page_id, kind, summary) VALUES($1,$2,$3,'compliance-export',$4)", [randomUUID(), actor.id, included[0], COMPLIANCE_READY_BODY]);
    await audit(tx, actor.id, "compliance-export.complete", input.operationId, included[0] ?? null, { scope: input.scope, format: input.format, counts, manifestHash: signed.hash });
    const done = (await tx.query<JobRow>("SELECT * FROM hs_compliance_jobs WHERE id=$1", [jobId])).rows[0];
    return { ...view(done, true), replayed: false };
  });
}

export async function listComplianceExports(r: Repository, actor: Actor, workspaceId: string, sessionBinding: string) {
  return r.db.transaction(async tx => {
    if (!await member(tx, workspaceId, actor.id)) throw unavailable();
    const result = await tx.query<JobRow>("SELECT * FROM hs_compliance_jobs WHERE workspace_id=$1 AND actor_id=$2 AND session_binding=$3 ORDER BY created_at DESC, id LIMIT 20", [workspaceId, actor.id, sessionBinding]);
    return { jobs: result.rows.map(row => view(row, false)) };
  });
}

export async function readComplianceExport(r: Repository, actor: Actor, id: string, sessionBinding: string) {
  return r.db.transaction(async tx => {
    const result = await tx.query<JobRow>("SELECT * FROM hs_compliance_jobs WHERE id=$1 AND actor_id=$2 AND session_binding=$3", [id, actor.id, sessionBinding]);
    if (!result.rows.length || !await member(tx, result.rows[0].workspace_id, actor.id)) throw unavailable();
    return view(result.rows[0], result.rows[0].state === "ready");
  });
}

export async function downloadComplianceExport(r: Repository, actor: Actor, id: string, token: string, sessionBinding: string) {
  const prepared = await r.db.transaction(async tx => {
    const result = await tx.query<JobRow>("SELECT * FROM hs_compliance_jobs WHERE id=$1 AND actor_id=$2 AND session_binding=$3 FOR UPDATE", [id, actor.id, sessionBinding]);
    const row = result.rows[0];
    const access = row ? await member(tx, row.workspace_id, actor.id) : null;
    if (!row || !row.download_token || row.state !== "ready" || !sameSecret(row.download_token, token) || !access) throw unavailable();
    const live = await tx.query<{ ok: boolean }>("SELECT expires_at>clock_timestamp() AS ok FROM hs_compliance_jobs WHERE id=$1", [id]);
    if (!live.rows[0]?.ok) {
      await tx.query("UPDATE hs_compliance_jobs SET state='expired', download_token=NULL WHERE id=$1", [id]);
      throw new DocumentError("This export was cancelled or expired.", "export_expired", 410);
    }
    if (!access.export_enabled) throw new DocumentError("This workspace has disabled document exports.", "export_disabled", 403);
    const files = await tx.query<{ path: string; content: string }>("SELECT path, content FROM hs_compliance_files WHERE job_id=$1 ORDER BY path", [id]);
    return { row, files: files.rows };
  });
  const zip = new JSZip();
  for (const file of prepared.files) zip.file(file.path, Buffer.from(file.content, "base64"));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  if (bytes.length > 25_000_000) throw new DocumentError("Export exceeds 25 MB.", "export_size", 413);
  await r.db.transaction(async tx => {
    const again = await tx.query<JobRow>("SELECT * FROM hs_compliance_jobs WHERE id=$1 AND actor_id=$2 AND session_binding=$3 FOR UPDATE", [id, actor.id, sessionBinding]);
    const row = again.rows[0];
    const access = row ? await member(tx, row.workspace_id, actor.id) : null;
    if (!row || row.state !== "ready" || !row.download_token || !sameSecret(row.download_token, token) || !access) {
      if (row && !access) {
        await tx.query("DELETE FROM hs_compliance_files WHERE job_id=$1", [row.id]);
        await tx.query("UPDATE hs_compliance_jobs SET state='aborted', download_token=NULL, expires_at=NULL WHERE id=$1", [row.id]);
      }
      throw unavailable();
    }
    if (!access.export_enabled) throw new DocumentError("This workspace has disabled document exports.", "export_disabled", 403);
    await audit(tx, actor.id, "compliance-export.download", row.operation_id, null, { jobId: id, bytes: bytes.length, scope: row.scope });
  });
  return { bytes, filename: "holy-sheet-compliance-pack.zip", contentType: "application/zip" };
}
