export const recordImportSourceLimit = 20 * 1024 * 1024;

const jobStates = new Set(["staged", "reviewing", "reviewed", "running", "partial", "completed", "cancelled"]);
const rowStates = new Set(["unreviewed", "valid", "invalid", "applied", "blocked"]);
const issueCode = /^[a-z][a-z0-9_:-]{0,99}$/i;
const reviewHash = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RecordImportRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, status: number, code: string, retryable: boolean) {
    super(message);
    this.name = "RecordImportRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export type ImportFieldInput = { key: string; label: string; kind: string; referenceList?: boolean };
export type ImportFieldDraft = { column: string; lookup: "id" | "code" | "label"; currencyCode: string; currencyScale: string };
export type ImportMappingMode = "create" | "update";
export type ImportPreviewRow = {
  ordinal: number;
  sourceRow: number;
  state: string;
  duplicateWarning: boolean;
  errors: { code: string; fieldKey?: string }[];
  name?: string;
  values?: Record<string, unknown>;
  recordId?: string;
  appliedVersion?: number;
};
export type ImportJobView = {
  id: string;
  collection: string;
  name: string;
  format: "csv" | "xlsx";
  headers: string[];
  state: string;
  mode: ImportMappingMode | null;
  rowCount: number;
  version: number;
  reviewOffset: number;
  reviewHash: string | null;
  warnings: string[];
  expiresAt: string;
  counts: { unreviewed: number; valid: number; invalid: number; applied: number; blocked: number };
  rows: ImportPreviewRow[] | null;
  nextOffset: number | null;
};
export type ImportCommitChoices = { allowValidSubset: boolean; allowDuplicates: boolean; acknowledgeWarnings: boolean };

type MappingResult = { ok: true; mapping: Record<string, unknown> } | { ok: false; message: string };

function columnIndex(value: string, headerCount: number, label: string): number | null | string {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return `Choose a staged column for ${label}.`;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= headerCount) return `${label} is outside the staged columns.`;
  return index;
}

function assign(mapping: Record<string, unknown>, key: string, value: number | null | string) {
  if (typeof value === "number") mapping[key] = value;
}

export function recordImportMetadata(value: { id: string; collection: string; name: string; format: "csv" | "xlsx"; sheetIndex?: number }) {
  const body: Record<string, unknown> = { id: value.id, collection: value.collection, name: value.name, format: value.format };
  if (value.sheetIndex !== undefined) body.sheetIndex = value.sheetIndex;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildImportMapping(input: {
  mode: ImportMappingMode;
  collection: string;
  canCreate: boolean;
  headerCount: number;
  nameColumn: string;
  idColumn: string;
  parentOrganisationColumn: string;
  legalOrganisationColumn: string;
  accountColumn: string;
  fields: ImportFieldInput[];
  drafts: Record<string, ImportFieldDraft>;
}): MappingResult {
  const name = columnIndex(input.nameColumn, input.headerCount, "Name");
  const id = columnIndex(input.mode === "update" ? input.idColumn : "", input.headerCount, "Record ID");
  const parent = columnIndex(input.mode === "create" && input.collection === "accounts" ? input.parentOrganisationColumn : "", input.headerCount, "Parent organisation");
  const legal = columnIndex(input.mode === "create" && input.collection === "contracts" ? input.legalOrganisationColumn : "", input.headerCount, "Legal organisation");
  const account = columnIndex(input.mode === "create" && input.collection === "contracts" ? input.accountColumn : "", input.headerCount, "Covered account");
  for (const value of [name, id, parent, legal, account]) if (typeof value === "string") return { ok: false, message: value };
  if (input.mode === "create" && !input.canCreate) return { ok: false, message: "Create needs the create capability." };
  if (input.mode === "create" && name === null) return { ok: false, message: "Create needs a name column." };
  if (input.mode === "update" && id === null) return { ok: false, message: "Update needs an immutable record ID column." };
  if (input.mode === "create" && input.collection === "accounts" && parent === null) return { ok: false, message: "Map the parent organisation ID column." };
  if (input.mode === "create" && input.collection === "contracts" && legal === null) return { ok: false, message: "Map the legal organisation ID column." };
  const mapped = [];
  for (const field of input.fields) {
    const draft = input.drafts[field.key] ?? { column: "", lookup: "id" as const, currencyCode: "", currencyScale: "" };
    const column = columnIndex(draft.column, input.headerCount, field.label);
    if (typeof column === "string") return { ok: false, message: column };
    if (column === null) continue;
    const item: Record<string, unknown> = { column, fieldKey: field.key };
    if (field.kind === "currency" && (draft.currencyCode.trim() || draft.currencyScale.trim())) {
      const code = draft.currencyCode.trim();
      const scale = draft.currencyScale.trim();
      if (!/^[A-Z]{3}$/.test(code) || !/^\d$/.test(scale) || Number(scale) > 4) return { ok: false, message: `Enter a currency code and scale for ${field.label}.` };
      item.currency = { code, scale: Number(scale) };
    }
    if (field.referenceList && draft.lookup !== "id") item.referenceLookup = draft.lookup;
    mapped.push(item);
  }
  if (input.mode === "update" && name === null && !mapped.length) return { ok: false, message: "Update needs a name column or a mapped field." };
  const mapping: Record<string, unknown> = { mode: input.mode, fields: mapped };
  assign(mapping, "nameColumn", name);
  assign(mapping, "idColumn", id);
  assign(mapping, "parentOrganisationColumn", parent);
  assign(mapping, "legalOrganisationColumn", legal);
  assign(mapping, "accountColumn", account);
  return { ok: true, mapping };
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function previewValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const items = value.map(previewValue);
    return items.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item)) ? items : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const currency = value as { currency?: unknown; minorUnits?: unknown; scale?: unknown };
  if (typeof currency.currency === "string" && typeof currency.minorUnits === "string" && typeof currency.scale === "number") return { currency: currency.currency, minorUnits: currency.minorUnits, scale: currency.scale };
  return undefined;
}

function previewRow(value: unknown, fieldKeys: ReadonlySet<string>): ImportPreviewRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.ordinal) || !Number.isSafeInteger(row.sourceRow) || typeof row.state !== "string" || !rowStates.has(row.state) || typeof row.duplicateWarning !== "boolean" || !Array.isArray(row.errors)) return null;
  const errors = row.errors.flatMap((issue) => {
    if (!issue || typeof issue !== "object") return [];
    const item = issue as { code?: unknown; fieldKey?: unknown };
    const code = typeof item.code === "string" && issueCode.test(item.code) ? item.code : "validation_error";
    return typeof item.fieldKey === "string" && fieldKeys.has(item.fieldKey) ? [{ code, fieldKey: item.fieldKey }] : [{ code }];
  });
  const preview: ImportPreviewRow = { ordinal: row.ordinal as number, sourceRow: row.sourceRow as number, state: row.state, duplicateWarning: row.duplicateWarning, errors };
  if (typeof row.name === "string") preview.name = row.name;
  if (row.values && typeof row.values === "object" && !Array.isArray(row.values)) {
    const values: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(row.values)) {
      if (!fieldKeys.has(key)) continue;
      const safe = previewValue(item);
      if (safe !== undefined) values[key] = safe;
    }
    preview.values = values;
  }
  if (typeof row.recordId === "string" && uuid.test(row.recordId)) preview.recordId = row.recordId;
  if (typeof row.appliedVersion === "number" && Number.isSafeInteger(row.appliedVersion) && row.appliedVersion > 0) preview.appliedVersion = row.appliedVersion;
  return preview;
}

export function acceptedImport(value: unknown, fieldKeys: readonly string[]): ImportJobView | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const counts = body.counts as Record<string, unknown> | undefined;
  const parsedCounts = {
    unreviewed: count(counts?.unreviewed),
    valid: count(counts?.valid),
    invalid: count(counts?.invalid),
    applied: count(counts?.applied),
    blocked: count(counts?.blocked),
  };
  if (Object.values(parsedCounts).some((item) => item === null)) return null;
  if (typeof body.id !== "string" || !uuid.test(body.id) || typeof body.collection !== "string" || typeof body.name !== "string") return null;
  if (body.format !== "csv" && body.format !== "xlsx") return null;
  if (typeof body.state !== "string" || !jobStates.has(body.state)) return null;
  if (!(body.mode === null || body.mode === "create" || body.mode === "update")) return null;
  if (!Array.isArray(body.headers) || body.headers.length > 100 || body.headers.some((header) => typeof header !== "string" || !header || header.length > 200)) return null;
  if (!Array.isArray(body.warnings) || body.warnings.length > 20 || body.warnings.some((warning) => typeof warning !== "string" || warning.length > 240)) return null;
  const rowCount = count(body.rowCount), version = count(body.version), reviewOffset = count(body.reviewOffset);
  if (typeof body.expiresAt !== "string" || rowCount === null || rowCount < 1 || version === null || version < 1 || reviewOffset === null) return null;
  if (!(body.reviewHash === null || (typeof body.reviewHash === "string" && reviewHash.test(body.reviewHash)))) return null;
  const allowed = new Set(fieldKeys);
  const rows = body.rows === undefined ? null : Array.isArray(body.rows) ? body.rows.flatMap((row) => { const parsed = previewRow(row, allowed); return parsed ? [parsed] : []; }) : null;
  if (body.rows !== undefined && !Array.isArray(body.rows)) return null;
  const nextOffset = body.nextOffset === undefined || body.nextOffset === null ? null : Number.isSafeInteger(body.nextOffset) && (body.nextOffset as number) >= 0 ? body.nextOffset as number : null;
  if (body.nextOffset !== undefined && body.nextOffset !== null && nextOffset === null) return null;
  return {
    id: body.id,
    collection: body.collection,
    name: body.name,
    format: body.format,
    headers: body.headers as string[],
    state: body.state,
    mode: body.mode,
    rowCount,
    version,
    reviewOffset,
    reviewHash: body.reviewHash as string | null,
    warnings: body.warnings as string[],
    expiresAt: body.expiresAt,
    counts: parsedCounts as ImportJobView["counts"],
    rows,
    nextOffset,
  };
}

export function importCommitBody(job: ImportJobView, commandId: string, choices: ImportCommitChoices) {
  if (!job.reviewHash || (job.mode !== "create" && job.mode !== "update") || !uuid.test(commandId)) return null;
  return {
    kind: "commit" as const,
    id: commandId,
    expectedVersion: job.version,
    reviewHash: job.reviewHash,
    confirm: job.mode === "create" ? "create-records" as const : "update-records" as const,
    allowValidSubset: choices.allowValidSubset,
    allowDuplicates: choices.allowDuplicates,
    acknowledgeWarnings: choices.acknowledgeWarnings,
  };
}

export async function importRequestError(response: Response) {
  let message = "Import request failed.";
  let code = "service_unavailable";
  let retryable = response.status >= 500;
  try {
    const body = await response.json() as { error?: unknown; code?: unknown; retryable?: unknown };
    if (typeof body.error === "string" && body.error) message = body.error;
    if (typeof body.code === "string" && issueCode.test(body.code)) code = body.code;
    if (typeof body.retryable === "boolean") retryable = body.retryable;
  } catch { /* The status still decides whether the same command should be retried. */ }
  return new RecordImportRequestError(message, response.status, code, retryable);
}

export function importCommitKeepsCommand(error: RecordImportRequestError) {
  return error.status >= 500 || error.code === "record_import_authority_changed" || error.code === "operation_mismatch";
}
