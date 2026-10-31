export const recordExportRequestLimit = 1024 * 1024;
export const recordExportRecordLimit = 10_000;
export const recordExportColumnLimit = 100;
export const recordExportCollections = ["organisations", "accounts", "contacts", "employees", "contracts"] as const;
export type RecordExportCollection = (typeof recordExportCollections)[number];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reviewHash = /^[a-f0-9]{64}$/;
const columnKey = /^[A-Za-z0-9:_-]{1,100}$/;
const warningCode = /^[a-z0-9-]{1,80}$/;
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const collections = new Set<string>(recordExportCollections);
const formats = new Set(["csv", "xlsx"]);
const kinds = new Set(["identity", "text", "long-text", "number", "currency", "date", "boolean", "single-select", "multi-select", "email", "phone", "url", "attachment", "record"]);
const reservedColumns = new Set(["id", "parentOrganisationId", "legalOrganisationIds", "accountIds"]);
const withheldKinds = new Set(["attachment", "record"]);
const issueCode = /^[a-z][a-z0-9_:-]{0,99}$/i;

export class RecordExportRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, status: number, code: string, retryable: boolean) {
    super(message);
    this.name = "RecordExportRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export type ExportFormat = "csv" | "xlsx";
export type ExportFieldInput = { key: string; label: string; kind: string };
export type ExportColumnView = { key: string; label: string; kind: string };
export type ExportJobView = {
  id: string;
  collection: string;
  format: ExportFormat;
  rowCount: number;
  columns: ExportColumnView[];
  warnings: string[];
  reviewHash: string;
  state: "ready";
  createdAt: string;
  expiresAt: string;
  pinned: true;
};

export function isRecordExportId(value: string) {
  return uuid.test(value);
}

export function relationshipColumnCount(collection: string) {
  if (collection === "contracts") return 2;
  if (collection === "accounts" || collection === "contacts" || collection === "employees") return 1;
  return 0;
}

export function explicitExportColumns(fields: readonly ExportFieldInput[]): ExportColumnView[] {
  const columns: ExportColumnView[] = [{ key: "name", label: "Name", kind: "text" }];
  const seen = new Set(["name"]);
  for (const field of fields) {
    if (typeof field.key !== "string" || !columnKey.test(field.key) || seen.has(field.key) || reservedColumns.has(field.key) || withheldKinds.has(field.kind)) continue;
    if (typeof field.label !== "string" || !field.label || field.label.length > 100 || /[\p{Cc}]/u.test(field.label)) continue;
    if (typeof field.kind !== "string" || !kinds.has(field.kind)) continue;
    seen.add(field.key);
    columns.push({ key: field.key, label: field.label, kind: field.kind });
  }
  return columns;
}

export function withheldReferenceFields(fields: readonly ExportFieldInput[]) {
  return fields.filter((field) => typeof field.key === "string" && columnKey.test(field.key) && typeof field.label === "string" && field.label.length > 0 && field.label.length <= 100 && withheldKinds.has(field.kind));
}

function positive(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function flags(includeIds: boolean, includeRelationships: boolean, collection: string) {
  if (typeof includeIds !== "boolean" || typeof includeRelationships !== "boolean") return null;
  if (includeRelationships && relationshipColumnCount(collection) === 0) return null;
  return { includeIds, includeRelationships };
}

function columnBudget(selected: number, includeIds: boolean, includeRelationships: boolean, collection: string) {
  return selected + (includeIds ? 1 : 0) + (includeRelationships ? relationshipColumnCount(collection) : 0);
}

export function viewExportScope(input: {
  collection: string;
  viewId: string;
  expectedViewVersion: number;
  viewColumnCount: number;
  expectedSchemaVersion: number;
  format: string;
  includeIds: boolean;
  includeRelationships: boolean;
}) {
  if (!collections.has(input.collection) || !uuid.test(input.viewId) || !formats.has(input.format)) return null;
  const expectedViewVersion = positive(input.expectedViewVersion);
  const expectedSchemaVersion = positive(input.expectedSchemaVersion);
  const choice = flags(input.includeIds, input.includeRelationships, input.collection);
  if (!expectedViewVersion || !expectedSchemaVersion || !choice) return null;
  if (!Number.isSafeInteger(input.viewColumnCount) || input.viewColumnCount < 1) return null;
  if (columnBudget(input.viewColumnCount, choice.includeIds, choice.includeRelationships, input.collection) > recordExportColumnLimit) return null;
  return {
    kind: "view" as const,
    viewId: input.viewId,
    expectedViewVersion,
    expectedSchemaVersion,
    format: input.format as ExportFormat,
    includeIds: choice.includeIds,
    includeRelationships: choice.includeRelationships,
  };
}

export function recordExportScope(input: {
  collection: string;
  recordIds: readonly string[];
  columns: readonly string[];
  allowedColumns: readonly string[];
  expectedSchemaVersion: number;
  format: string;
  includeIds: boolean;
  includeRelationships: boolean;
}) {
  if (!collections.has(input.collection) || !formats.has(input.format)) return null;
  const expectedSchemaVersion = positive(input.expectedSchemaVersion);
  const choice = flags(input.includeIds, input.includeRelationships, input.collection);
  if (!expectedSchemaVersion || !choice) return null;
  if (input.recordIds.length < 1 || input.recordIds.length > recordExportRecordLimit) return null;
  if (input.recordIds.some((id) => !uuid.test(id)) || new Set(input.recordIds).size !== input.recordIds.length) return null;
  const allowed = new Set(input.allowedColumns);
  if (input.columns.length < 1 || input.columns.length > recordExportColumnLimit) return null;
  if (input.columns.some((key) => !columnKey.test(key) || reservedColumns.has(key) || !allowed.has(key)) || new Set(input.columns).size !== input.columns.length) return null;
  if (columnBudget(input.columns.length, choice.includeIds, choice.includeRelationships, input.collection) > recordExportColumnLimit) return null;
  return {
    kind: "records" as const,
    collection: input.collection,
    recordIds: [...input.recordIds],
    columns: [...input.columns],
    expectedSchemaVersion,
    format: input.format as ExportFormat,
    includeIds: choice.includeIds,
    includeRelationships: choice.includeRelationships,
  };
}

export function exportPrepareBody(id: string, scope: { kind: string } | null) {
  if (!scope || !uuid.test(id)) return null;
  return { id, ...scope };
}

function columnView(value: unknown): ExportColumnView | null {
  if (!value || typeof value !== "object") return null;
  const column = value as Record<string, unknown>;
  if (typeof column.key !== "string" || !columnKey.test(column.key)) return null;
  if (typeof column.label !== "string" || !column.label || column.label.length > 100 || /[\p{Cc}]/u.test(column.label)) return null;
  if (typeof column.kind !== "string" || !kinds.has(column.kind)) return null;
  return { key: column.key, label: column.label, kind: column.kind };
}

export function acceptedExport(value: unknown): ExportJobView | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.id !== "string" || !uuid.test(body.id) || typeof body.collection !== "string" || !collections.has(body.collection)) return null;
  if ((body.format !== "csv" && body.format !== "xlsx") || body.state !== "ready" || body.pinned !== true) return null;
  if (typeof body.rowCount !== "number" || !Number.isSafeInteger(body.rowCount) || body.rowCount < 1 || body.rowCount > recordExportRecordLimit) return null;
  if (!Array.isArray(body.columns) || body.columns.length < 1 || body.columns.length > recordExportColumnLimit) return null;
  const columns: ExportColumnView[] = [];
  for (const column of body.columns) {
    const parsed = columnView(column);
    if (!parsed) return null;
    columns.push(parsed);
  }
  if (new Set(columns.map((column) => column.key)).size !== columns.length) return null;
  if (!Array.isArray(body.warnings) || body.warnings.length > 8 || body.warnings.some((warning) => typeof warning !== "string" || !warningCode.test(warning))) return null;
  if (typeof body.reviewHash !== "string" || !reviewHash.test(body.reviewHash) || !isoTime.test(String(body.createdAt)) || !isoTime.test(String(body.expiresAt))) return null;
  return {
    id: body.id,
    collection: body.collection,
    format: body.format,
    rowCount: body.rowCount,
    columns,
    warnings: [...body.warnings],
    reviewHash: body.reviewHash,
    state: "ready",
    createdAt: body.createdAt as string,
    expiresAt: body.expiresAt as string,
    pinned: true,
  };
}

export function acceptedExportCancellation(value: unknown, jobId: string) {
  if (!uuid.test(jobId) || !value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.id !== jobId || (body.state !== "cancelled" && body.state !== "expired")) return null;
  return { id: jobId, state: body.state };
}

export function exportDownloadBody(job: ExportJobView, acknowledgeEscaping: boolean) {
  if (!reviewHash.test(job.reviewHash) || typeof acknowledgeEscaping !== "boolean") return null;
  if (job.warnings.length > 0 && !acknowledgeEscaping) return null;
  return { reviewHash: job.reviewHash, acknowledgeEscaping };
}

export async function exportRequestError(response: Response) {
  let message = "Export request failed.";
  let code = "service_unavailable";
  let retryable = response.status >= 500;
  try {
    const body = await response.json() as { error?: unknown; code?: unknown; retryable?: unknown };
    if (typeof body.error === "string" && body.error) message = body.error;
    if (typeof body.code === "string" && issueCode.test(body.code)) code = body.code;
    if (typeof body.retryable === "boolean") retryable = body.retryable;
  } catch { /* The status still decides whether the same prepare should be retried. */ }
  return new RecordExportRequestError(message, response.status, code, retryable);
}

export function exportPrepareRetiresId(error: RecordExportRequestError) {
  return error.status < 500 && (error.code === "record_export_expired" || error.code === "record_export_cancelled" || error.code === "operation_mismatch");
}
