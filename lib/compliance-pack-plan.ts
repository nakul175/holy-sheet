import { createHash, createHmac } from "node:crypto";
import { stableStringify, type RichNode } from "./document";
import type { RecordExportSlice } from "./record-page-refs";

export const COMPLIANCE_READY_SUBJECT = "Your compliance pack is ready";
export const COMPLIANCE_READY_BODY = "Your Pages by Aplyd compliance pack is ready to download for 24 hours. This message does not include pack contents.";
export const ATTACHMENTS_EXCLUDED_NOTE = "Attachments excluded by export policy.";
export const RESTRICTED_RECORD = "Restricted record";
export const COMPLIANCE_SECONDS_PER_ITEM = 2;

export type ComplianceScope = "page" | "tree" | "space";
export type ComplianceFormat = "pdf" | "html" | "markdown" | "compliance-pack";
export type ComplianceCounts = {
  pages: number;
  records: number;
  restrictedRecords: number;
  attachments: number;
  acknowledgements: number;
  auditRows: number;
};

export type ComplianceManifest = {
  jobId: string;
  scope: ComplianceScope;
  format: ComplianceFormat;
  createdAt: string;
  createdAtIst: string;
  counts: ComplianceCounts;
  notes: string[];
  files: { path: string; sha256: string }[];
  signature?: string;
};

export type PackFile = { path: string; bytes: Buffer };

export function sha256Bytes(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function complianceSigningKey() {
  const key = process.env.HS_EXPORT_SIGNING_KEY;
  if (key && key.length >= 16) return key;
  if (process.env.NODE_ENV === "production") return "";
  return "hs-n49-dev-signing-key";
}

export function signManifest(manifest: Omit<ComplianceManifest, "signature">, key: string) {
  const signature = createHmac("sha256", key).update(stableStringify(manifest)).digest("hex");
  const document: ComplianceManifest = { ...manifest, signature };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { document, bytes, hash: sha256Bytes(bytes), signature };
}

export function verifyComplianceManifest(document: ComplianceManifest, key: string) {
  if (!document.signature || !key) return false;
  const { signature, ...rest } = document;
  const expected = createHmac("sha256", key).update(stableStringify(rest)).digest("hex");
  return signature === expected;
}

export function exporterVisibleRecords(records: Record<string, RecordExportSlice> | null) {
  if (!records) return null;
  const visible: Record<string, RecordExportSlice> = {};
  for (const [key, slice] of Object.entries(records)) {
    if (!slice.available) {
      visible[key] = slice;
      continue;
    }
    if (slice.kind === "record") {
      visible[key] = { ...slice, fields: slice.fields.filter(field => field.value !== null) };
      continue;
    }
    const kept = slice.columns.map((column, index) => ({ column, index })).filter(item => !item.column.hidden);
    visible[key] = {
      ...slice,
      columns: kept.map(item => ({ ...item.column, hidden: false })),
      rows: slice.rows.map(row => ({ ...row, cells: kept.map(item => row.cells[item.index] ?? null) })),
    };
  }
  return visible;
}

export function recordSnapshotFiles(records: Record<string, RecordExportSlice> | null): { files: PackFile[]; records: number; restrictedRecords: number } {
  const files: PackFile[] = [];
  let recordCount = 0;
  let restricted = 0;
  const entries = Object.entries(exporterVisibleRecords(records) ?? {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [, slice] of entries) {
    if (!slice.available || slice.kind !== "record") {
      if (!slice.available) {
        restricted += 1;
        files.push({ path: `records/restricted-record-${restricted}.txt`, bytes: Buffer.from(`${RESTRICTED_RECORD}\n`, "utf8") });
      }
      continue;
    }
    recordCount += 1;
    const body = { title: slice.title, fields: slice.fields.map(field => ({ label: field.label, value: field.value })) };
    files.push({ path: `records/visible-record-${recordCount}.json`, bytes: Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8") });
  }
  return { files, records: recordCount, restrictedRecords: restricted };
}

function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export type AcknowledgementEvidenceRow = {
  name: string;
  status: string;
  versionLabel: string;
  acknowledgedAtIst: string;
  chainHash: string;
  prevHash: string;
};

export function acknowledgementEvidenceCsv(rows: AcknowledgementEvidenceRow[]) {
  const lines = ["name,status,version,acknowledged_at_ist,chain_hash,prev_hash", ...rows.map(row => [row.name, row.status, row.versionLabel, row.acknowledgedAtIst, row.chainHash, row.prevHash].map(csvCell).join(","))];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export type AuditEvidenceRow = { action: string; actorId: string; pageId: string; correlationId: string; atIst: string };

export function auditEvidenceCsv(rows: AuditEvidenceRow[]) {
  const lines = ["action,actor_id,page_id,correlation_id,at_ist", ...rows.map(row => [row.action, row.actorId, row.pageId, row.correlationId, row.atIst].map(csvCell).join(","))];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export type AttachmentDescriptor = { name: string; mime: string; sha256: string; size: number; version: number };

export function attachmentFile(pageId: string, descriptor: AttachmentDescriptor, allVersions: boolean): PackFile {
  const suffix = allVersions ? `-v${descriptor.version}` : "";
  const body = `name: ${descriptor.name}\nmime: ${descriptor.mime}\nsha256: ${descriptor.sha256}\nsize: ${descriptor.size}\nversion: ${descriptor.version}\n`;
  return { path: `attachments/${pageId}/${descriptor.sha256.slice(0, 12)}${suffix}.txt`, bytes: Buffer.from(body, "utf8") };
}

export function selectAttachmentDescriptors(current: AttachmentDescriptor | null, versions: AttachmentDescriptor[], allVersions: boolean) {
  const usable = versions.filter(version => version.version > 0);
  if (!allVersions) {
    if (current) return [current];
    const latest = [...usable].sort((a, b) => b.version - a.version)[0];
    return latest ? [latest] : [];
  }
  return usable.length ? [...usable].sort((a, b) => a.version - b.version) : current ? [current] : [];
}

export function restorerCanIncludeTrash(workspaceRole: string, pageOwnerId: string, actorId: string) {
  return pageOwnerId === actorId || workspaceRole === "owner" || workspaceRole === "admin";
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineText(nodes: RichNode[]): string {
  return nodes.map(node => node.type === "text" ? node.text ?? "" : node.type === "hardBreak" ? "\n" : inlineText(node.content ?? [])).join("");
}

export function renderComplianceHtml(input: { title: string; document: RichNode; records: Record<string, RecordExportSlice> | null; attachmentsExcluded: boolean }) {
  const records = exporterVisibleRecords(input.records);
  const parts: string[] = [`<h1>${escapeHtml(input.title)}</h1>`];
  const visit = (nodes: RichNode[]) => {
    for (const node of nodes) {
      if (node.type === "heading") {
        const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
        parts.push(`<h${level}>${escapeHtml(inlineText(node.content ?? []))}</h${level}>`);
        continue;
      }
      if (node.type === "recordRef" || node.type === "recordView") {
        const key = node.type === "recordRef" ? String(node.attrs?.recordId ?? "") : `view:${String(node.attrs?.viewId ?? "")}`;
        const slice = records?.[key];
        if (!slice?.available) {
          parts.push(`<p>${RESTRICTED_RECORD}</p>`);
          continue;
        }
        if (slice.kind === "record") {
          const fields = slice.fields.map(field => `<li>${escapeHtml(field.label)}: ${escapeHtml(field.value ?? "")}</li>`).join("");
          parts.push(`<section><h2>${escapeHtml(slice.title)}</h2>${fields ? `<ul>${fields}</ul>` : ""}</section>`);
          continue;
        }
        parts.push(`<section><h2>${escapeHtml(slice.collectionName)}</h2><p>${escapeHtml(slice.countLabel)}</p></section>`);
        continue;
      }
      if (node.type === "image" || node.type === "file") {
        const label = node.type === "image" ? String(node.attrs?.alt ?? "Image") : String(node.attrs?.title ?? "File");
        parts.push(`<p>${escapeHtml(input.attachmentsExcluded ? "Attachment excluded by export policy." : label)}</p>`);
        continue;
      }
      if (node.type === "paragraph" || node.type === "detailsSummary") {
        parts.push(`<p>${escapeHtml(inlineText(node.content ?? []))}</p>`);
        continue;
      }
      if (node.content?.length) visit(node.content);
    }
  };
  visit(input.document.content ?? []);
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title></head><body>\n${parts.join("\n")}\n</body></html>\n`;
}

export function etaSeconds(remaining: number) {
  return Math.max(0, remaining) * COMPLIANCE_SECONDS_PER_ITEM;
}
