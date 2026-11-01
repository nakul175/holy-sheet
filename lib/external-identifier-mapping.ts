/** External identifier mappings are identity metadata.
 * They never store credentials and never grant record, field, or integration access.
 */

export const externalIdentifierStates = ["active", "archived", "deleted"] as const;
export type ExternalIdentifierState = (typeof externalIdentifierStates)[number];
export type ExternalIdentifierReviewDecision = "keep" | "reassign";

export type ExternalIdentifierSnapshot = {
  id: string;
  namespace: string;
  externalId: string;
  recordId: string;
  originalRecordId: string;
  state: ExternalIdentifierState;
  version: number;
};

export type ExternalIdentifierReview = {
  decision: ExternalIdentifierReviewDecision;
  mappingId: string;
  version: number;
  confirm: "keep-external-identifier" | "reassign-external-identifier";
};

export type ExternalIdentifierWrite = {
  namespace: string;
  externalId: string;
  recordId: string;
  provenanceLabel: string;
  review?: ExternalIdentifierReview;
};

export type ExternalIdentifierClassification =
  | { action: "create" }
  | { action: "unchanged" }
  | { action: "conflict"; mappingId: string; recordId: string; state: ExternalIdentifierState; version: number }
  | { action: "reassign"; mappingId: string; fromRecordId: string; toRecordId: string; version: number }
  | { action: "reject"; code: "identifier_mismatch" | "review_not_applicable" | "review_stale" | "review_unconfirmed" };

export type ExternalIdentifierRedirect = ExternalIdentifierSnapshot & {
  recordId: string;
  redirectedFromRecordId: string;
  version: number;
};

const credentialKey = /^(password|passwd|secret|token|bearer|api[_-]?key|authorization|credential|client[_-]?secret)$/i;
const credentialValue = /(api[_-]?key|password|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[:=]/i;
const credentialPrefix = /^(bearer|basic)\s+\S+/i;
const credentialToken = /^(sk_live_|sk_test_|ghp_|xox[baprs]-|ya29\.)/;
const namespacePattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function looksLikeCredential(value: string) {
  return credentialKey.test(value) || credentialValue.test(value) || credentialPrefix.test(value) || credentialToken.test(value) || value.includes("-----BEGIN") || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);
}

function bounded(value: unknown, max: number, allowEmpty: boolean) {
  if (typeof value !== "string") return null;
  if (value !== value.trim() || value !== value.normalize("NFC")) return null;
  if (/[\p{Cc}]/u.test(value)) return null;
  const length = Array.from(value).length;
  if (length > max || (length === 0 && !allowEmpty)) return null;
  if (looksLikeCredential(value)) return null;
  return value;
}

export function identifierPayloadHasCredential(value: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return looksLikeCredential(item);
    if (!item || typeof item !== "object") return false;
    if (seen.has(item)) return false;
    seen.add(item);
    const entries = Array.isArray(item) ? item.map((entry, index) => [String(index), entry] as const) : Object.entries(item);
    return entries.some(([key, entry]) => credentialKey.test(key) || visit(entry));
  };
  return visit(value);
}

export function parseExternalIdentifier(input: { namespace: unknown; externalId: unknown; provenanceLabel?: unknown }) {
  if (identifierPayloadHasCredential(input)) return { ok: false as const, code: "identifier_invalid" as const, message: "An external identifier cannot carry a credential or secret." };
  const namespace = bounded(input.namespace, 80, false);
  const externalId = bounded(input.externalId, 200, false);
  const provenanceLabel = bounded(input.provenanceLabel ?? "", 120, true);
  if (!namespace || !namespacePattern.test(namespace) || !externalId || provenanceLabel === null) {
    return { ok: false as const, code: "identifier_invalid" as const, message: "Use a namespace, external ID, and provenance label without spaces, control characters, or credentials." };
  }
  return { ok: true as const, namespace, externalId, provenanceLabel };
}

/** Unique tenant + namespace + external ID. A different record is a conflict until review names the current mapping. */
export function classifyIdentifierWrite(existing: ExternalIdentifierSnapshot | null, request: ExternalIdentifierWrite): ExternalIdentifierClassification {
  if (existing && (existing.namespace !== request.namespace || existing.externalId !== request.externalId)) return { action: "reject", code: "identifier_mismatch" };
  if (!existing) return request.review ? { action: "reject", code: "review_not_applicable" } : { action: "create" };
  const sameRecord = existing.recordId === request.recordId;
  if (!request.review) {
    if (sameRecord && existing.state === "active") return { action: "unchanged" };
    return { action: "conflict", mappingId: existing.id, recordId: existing.recordId, state: existing.state, version: existing.version };
  }
  if (request.review.mappingId !== existing.id || request.review.version !== existing.version) return { action: "reject", code: "review_stale" };
  if (request.review.decision === "keep") {
    if (request.review.confirm !== "keep-external-identifier") return { action: "reject", code: "review_unconfirmed" };
    return { action: "unchanged" };
  }
  if (request.review.confirm !== "reassign-external-identifier") return { action: "reject", code: "review_unconfirmed" };
  if (sameRecord) return { action: "unchanged" };
  return { action: "reassign", mappingId: existing.id, fromRecordId: existing.recordId, toRecordId: request.recordId, version: existing.version };
}

/** Move mappings onto the survivor. Original record, external ID, namespace, and explicit state stay put. */
export function planMergeIdentifierRedirect(rows: readonly ExternalIdentifierSnapshot[], sourceId: string, survivorId: string) {
  if (!sourceId || sourceId === survivorId) return { ok: false as const, code: "merge_identity" as const };
  const redirects: ExternalIdentifierRedirect[] = [];
  for (const row of rows) {
    if (row.recordId !== sourceId) continue;
    redirects.push({ ...row, recordId: survivorId, redirectedFromRecordId: sourceId, version: row.version + 1 });
  }
  return { ok: true as const, redirects };
}

export function externalIdentifierAccess(input: {
  recordCapabilities: readonly string[];
  integration: { canRead: boolean; canWrite: boolean; canExport: boolean; canHistory: boolean } | null;
}) {
  const view = input.recordCapabilities.includes("view");
  const grant = input.integration;
  const canRead = view && grant?.canRead === true;
  return {
    canRead,
    canWrite: canRead && input.recordCapabilities.includes("edit") && input.recordCapabilities.includes("manage-external-ids") && grant?.canWrite === true,
    canExport: canRead && input.recordCapabilities.includes("export") && grant?.canExport === true,
    canHistory: view && input.recordCapabilities.includes("history") && grant?.canHistory === true,
  };
}
