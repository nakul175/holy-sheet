const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reviewHash = /^[a-f0-9]{64}$/;
const fieldKey = /^[A-Za-z0-9:_-]{1,100}$/;
const cursorToken = /^[A-Za-z0-9_-]{43}$/;
const kind = /^[a-z][a-z0-9-]{0,63}$/;
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const labelText = /^[^\p{Cc}]{1,200}$/u;
const withheldKinds = new Set(["attachment", "record"]);
const reReview = new Set([
  "record_history_conflict",
  "record_version_conflict",
  "record_schema_conflict",
  "record_history_expired",
  "record_unique_conflict",
  "record_history_field_unavailable",
  "record_history_reference_unavailable",
  "record_history_unavailable",
  "record_history_selection",
]);

export class RecordHistoryRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, status: number, code: string, retryable: boolean) {
    super(message);
    this.name = "RecordHistoryRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export type HistorySide = "before" | "after";
export type HistoryFieldInput = { key: string; label: string; kind: string; canWrite: boolean; canHistory: boolean };
export type HistorySnapshot = { name: string; values: Record<string, unknown> };
export type HistoryEventView = {
  id: string;
  version: number;
  actorId: string;
  sourceApp: string;
  serviceSubject: string | null;
  operationId: string;
  kind: string;
  batchId: string | null;
  sourceRow: number | null;
  at: string;
  before: HistorySnapshot | null;
  after: HistorySnapshot;
};
export type HistoryPage = { events: HistoryEventView[]; nextCursor: string | null; anchorVersion: number };
export type HistoryPreviewRequest = { kind: "preview"; eventId: string; side: HistorySide; fields: string[]; expectedVersion: number };
export type HistoryPreviewView = {
  previewId: string;
  reviewHash: string;
  recordId: string;
  expectedVersion: number;
  sourceVersion: number;
  side: HistorySide;
  fields: string[];
  before: { name?: string; values: Record<string, unknown> };
  after: { name?: string; values: Record<string, unknown> };
};
export type HistoryApplyRequest = { kind: "apply"; previewId: string; reviewHash: string; operationId: string; confirm: "restore-selected-values" };

export function historyRestoreNeedsReview(code: string) {
  return reReview.has(code);
}

export async function historyRequestError(response: Response) {
  let body: { error?: unknown; code?: unknown; retryable?: unknown } = {};
  try { body = await response.json(); } catch { /* The status is the contract. */ }
  const message = typeof body.error === "string" && body.error.trim() && body.error.length <= 300 ? body.error : "Record history is unavailable.";
  const code = typeof body.code === "string" && /^[a-z0-9_-]{1,80}$/i.test(body.code) ? body.code : "record_history_unavailable";
  return new RecordHistoryRequestError(message, response.status, code, body.retryable === true || response.status >= 500);
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.length >= 1 && value.length <= max && labelText.test(value) ? value : null;
}

function acceptName(value: unknown) {
  return typeof value === "string" && Array.from(value).length >= 1 && Array.from(value).length <= 200 && labelText.test(value) ? value : null;
}

function acceptValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 20_000 && !value.includes("\0");
  if (depth >= 6) return false;
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => acceptValue(item, depth + 1));
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length <= 40 && entries.every(([key, item]) => fieldKey.test(key) && acceptValue(item, depth + 1));
  }
  return false;
}

function eventSnapshot(value: unknown): HistorySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "name" && key !== "values")) return null;
  const name = acceptName(record.name);
  if (!name || !record.values || typeof record.values !== "object" || Array.isArray(record.values)) return null;
  const entries = Object.entries(record.values as Record<string, unknown>);
  if (entries.length > 100 || entries.some(([key, item]) => !fieldKey.test(key) || key === "name" || !acceptValue(item))) return null;
  return { name, values: Object.fromEntries(entries) };
}

function reviewSnapshot(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "name" && key !== "values")) return null;
  const selected = new Set(fields);
  const wantsName = selected.has("name");
  let name: string | undefined;
  if ("name" in record) {
    if (!wantsName) return null;
    const accepted = acceptName(record.name);
    if (!accepted) return null;
    name = accepted;
  } else if (wantsName) return null;
  if (!record.values || typeof record.values !== "object" || Array.isArray(record.values)) return null;
  const entries = Object.entries(record.values as Record<string, unknown>);
  const values: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (!selected.has(key) || key === "name" || !acceptValue(item)) return null;
    values[key] = item;
  }
  for (const key of fields) if (key !== "name" && !Object.hasOwn(values, key)) return null;
  return { ...(name ? { name } : {}), values };
}

export function acceptedHistoryPage(body: unknown): HistoryPage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const page = body as Record<string, unknown>;
  const anchorVersion = positive(page.anchorVersion);
  if (!anchorVersion || !Array.isArray(page.events) || page.events.length > 50) return null;
  if (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !cursorToken.test(page.nextCursor))) return null;
  const events: HistoryEventView[] = [];
  const seen = new Set<string>();
  for (const item of page.events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const event = item as Record<string, unknown>;
    const version = positive(event.version);
    const actorId = text(event.actorId, 200);
    const sourceApp = text(event.sourceApp, 200);
    const serviceSubject = event.serviceSubject === null ? null : text(event.serviceSubject, 200);
    const id = typeof event.id === "string" && uuid.test(event.id) ? event.id : null;
    const operationId = typeof event.operationId === "string" && uuid.test(event.operationId) ? event.operationId : null;
    const batchId = event.batchId === null ? null : typeof event.batchId === "string" && uuid.test(event.batchId) ? event.batchId : undefined;
    const sourceRow = event.sourceRow === null ? null : typeof event.sourceRow === "number" && Number.isSafeInteger(event.sourceRow) && event.sourceRow >= 0 ? event.sourceRow : undefined;
    const before = event.before === null ? null : eventSnapshot(event.before);
    const after = eventSnapshot(event.after);
    const subjectMissing = event.serviceSubject !== null && !serviceSubject;
    if (!id || !version || !actorId || !sourceApp || subjectMissing || !operationId || typeof event.kind !== "string" || !kind.test(event.kind) || batchId === undefined || sourceRow === undefined || typeof event.at !== "string" || !isoTime.test(event.at) || (event.before !== null && !before) || !after || seen.has(id)) return null;
    seen.add(id);
    events.push({ id, version, actorId, sourceApp, serviceSubject, operationId, kind: event.kind, batchId, sourceRow, at: event.at, before, after });
  }
  return { events, nextCursor: page.nextCursor, anchorVersion };
}

export function restorableHistoryFields(fields: readonly HistoryFieldInput[], snapshot: HistorySnapshot | null) {
  if (!snapshot) return [];
  const choices: { key: string; label: string }[] = [{ key: "name", label: "Name" }];
  const seen = new Set(["name"]);
  for (const field of fields) {
    if (!field.canWrite || !field.canHistory || withheldKinds.has(field.kind) || seen.has(field.key) || !fieldKey.test(field.key)) continue;
    if (!Object.hasOwn(snapshot.values, field.key) || !text(field.label, 100)) continue;
    seen.add(field.key);
    choices.push({ key: field.key, label: field.label });
  }
  return choices;
}

export function historyPreviewBody(input: { eventId: string; side: string; fields: readonly string[]; expectedVersion: number; allowedFields: readonly string[] }): HistoryPreviewRequest | null {
  const expectedVersion = positive(input.expectedVersion);
  if (!uuid.test(input.eventId) || (input.side !== "before" && input.side !== "after") || !expectedVersion) return null;
  if (input.fields.length < 1 || input.fields.length > 100 || new Set(input.fields).size !== input.fields.length) return null;
  const allowed = new Set(input.allowedFields);
  if (input.fields.some((key) => !allowed.has(key) || !fieldKey.test(key) && key !== "name")) return null;
  if (input.fields.some((key) => key !== "name" && !fieldKey.test(key))) return null;
  return { kind: "preview", eventId: input.eventId, side: input.side, fields: [...input.fields], expectedVersion };
}

export function acceptedHistoryPreview(body: unknown, request: HistoryPreviewRequest, recordId: string): HistoryPreviewView | null {
  if (!body || typeof body !== "object" || Array.isArray(body) || !uuid.test(recordId)) return null;
  const preview = body as Record<string, unknown>;
  const expectedVersion = positive(preview.expectedVersion);
  const sourceVersion = positive(preview.sourceVersion);
  const previewId = typeof preview.previewId === "string" && uuid.test(preview.previewId) ? preview.previewId : null;
  const fields = Array.isArray(preview.fields) && preview.fields.length === request.fields.length && preview.fields.every((key, index) => key === request.fields[index]) ? request.fields : null;
  if (!previewId || typeof preview.reviewHash !== "string" || !reviewHash.test(preview.reviewHash) || preview.recordId !== recordId || expectedVersion !== request.expectedVersion || !sourceVersion || preview.side !== request.side || !fields) return null;
  const before = reviewSnapshot(preview.before, fields);
  const after = reviewSnapshot(preview.after, fields);
  if (!before || !after) return null;
  return { previewId, reviewHash: preview.reviewHash, recordId, expectedVersion, sourceVersion, side: request.side, fields: [...fields], before, after };
}

export function historyApplyBody(input: { previewId: string; reviewHash: string; operationId: string }): HistoryApplyRequest | null {
  if (!uuid.test(input.previewId) || !uuid.test(input.operationId) || !reviewHash.test(input.reviewHash)) return null;
  return { kind: "apply", previewId: input.previewId, reviewHash: input.reviewHash, operationId: input.operationId, confirm: "restore-selected-values" };
}

export function acceptedHistoryRestore(body: unknown, recordId: string) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const result = body as Record<string, unknown>;
  const appliedVersion = positive(result.appliedVersion);
  if (!appliedVersion || typeof result.replayed !== "boolean") return null;
  if (result.record && typeof result.record === "object" && !Array.isArray(result.record) && (result.record as { id?: unknown }).id !== recordId) return null;
  return { appliedVersion, replayed: result.replayed };
}
