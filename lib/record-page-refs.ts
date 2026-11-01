/** Versioned record blocks. Pages store ids and display config, never field values. */
export const recordReferenceNodeVersion = 1;
export const restrictedRecordPlaceholder = { status: "restricted" } as const;
export const archivedRecordPlaceholder = { status: "archived" } as const;
export const recordRefErrorPlaceholder = { status: "error" } as const;

const fieldKey = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RecordRefDisplay = "chip" | "card";
export type RecordViewLayout = "table" | "list";

export function recordReferenceSupported(version: unknown) {
  return version === recordReferenceNodeVersion;
}

export function recordRefAttributeError(type: string, attrs: Record<string, unknown> | undefined): string | null {
  if (type !== "recordRef" && type !== "recordView") return null;
  const value = attrs ?? {};
  if (!recordReferenceSupported(value.nodeVersion)) return "Unsupported record block version";
  if (type === "recordRef") {
    if (!uuid.test(String(value.recordId ?? "")) || !fieldKey.test(String(value.collectionId ?? ""))) return "Invalid record reference";
    if (value.display !== "chip" && value.display !== "card") return "Invalid record display";
    if (!Array.isArray(value.fields) || value.fields.length > 12 || new Set(value.fields).size !== value.fields.length) return "Invalid record fields";
    if (value.fields.some(field => typeof field !== "string" || !fieldKey.test(field))) return "Invalid record fields";
    if (value.display === "chip" && value.fields.length) return "Inline chips do not store fields";
    return null;
  }
  if (!uuid.test(String(value.viewId ?? "")) || !fieldKey.test(String(value.collectionId ?? ""))) return "Invalid record view";
  if (value.layout !== "table" && value.layout !== "list") return "Invalid record view layout";
  if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 12 || new Set(value.columns).size !== value.columns.length) return "Invalid record view columns";
  if (value.columns.some(field => typeof field !== "string" || !fieldKey.test(field))) return "Invalid record view columns";
  if (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 25) return "Invalid record view limit";
  return null;
}

export function formatRecordFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(formatRecordFieldValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const money = value as { currency?: unknown; minorUnits?: unknown };
    if (typeof money.currency === "string" && typeof money.minorUnits === "string" && Object.keys(value).every(key => ["currency", "minorUnits", "scale"].includes(key))) return `${money.currency} ${money.minorUnits}`;
  }
  return "";
}

export function readerSort<T extends { field: string; direction: "asc" | "desc" }>(sort: T[], visible: Set<string>): { field: string; direction: "asc" | "desc" }[] {
  const safe = sort.filter(item => item.field === "name" || visible.has(item.field));
  return safe.length ? safe.map(item => ({ field: item.field, direction: item.direction })) : [{ field: "name", direction: "asc" }];
}

export function filterChip(label: string, operator: string, value: unknown): string {
  const words: Record<string, string> = { equal: "is", contains: "contains", prefix: "starts with", greater: "is greater than", less: "is less than", includes: "includes", empty: "is empty", in: "is any of" };
  const text = formatRecordFieldValue(value).slice(0, 80);
  const verb = words[operator] ?? "is";
  return text && operator !== "empty" ? `${label} ${verb} ${text}` : `${label} ${verb}`;
}

export function planRecordRefBatches(recordCount: number, viewCount: number) {
  const records = Math.max(0, Math.floor(recordCount));
  const views = Math.max(0, Math.floor(viewCount));
  const requests = Math.min(3, Math.max(records || views ? 1 : 0, Math.ceil(Math.min(records, 180) / 60), Math.ceil(Math.min(views, 9) / 3)));
  const recordSpan = requests ? Math.ceil(Math.min(records, 180) / requests) : 0;
  const viewSpan = requests ? Math.ceil(Math.min(views, 9) / requests) : 0;
  return { requests, recordSpan, viewSpan, deferredRecords: Math.max(0, records - 180), deferredViews: Math.max(0, views - 9) };
}

export function recordIcon(collection: string) {
  if (collection === "contacts" || collection === "employees") return "◉";
  if (collection === "contracts") return "▤";
  return "▣";
}

export function formatPrintedAtIst(date = new Date()) {
  const formatted = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `Printed at ${formatted} IST`;
}

export function recordPageHref(workspaceId: string, tenantId: string, collection: string, recordId?: string) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/records?collection=${encodeURIComponent(collection)}`;
  return recordId ? `${base}&record=${encodeURIComponent(recordId)}` : base;
}

export type RecordExportSlice =
  | { kind: "record"; available: false }
  | { kind: "record"; available: true; title: string; url: string; fields: { label: string; value: string | null }[] }
  | { kind: "view"; available: false }
  | { kind: "view"; available: true; collectionName: string; url: string; columns: { label: string; hidden: boolean }[]; rows: { name: string; cells: (string | null)[] }[]; countLabel: string };

export function purgeRecordRefKeys(keys: string[]) {
  return keys.filter(key => key.startsWith("hs-record-ref:"));
}
