import { stableStringify } from "./document";
import { recordValueEmpty } from "./shared-record-types";

export const compareStatuses = ["same", "changed", "only-left", "only-right"] as const;
export type CompareStatus = (typeof compareStatuses)[number];

const fieldKinds = new Set(["text", "long-text", "number", "currency", "date", "boolean", "single-select", "multi-select", "email", "phone", "url", "attachment", "record"]);

export type CompareRecord = {
  id: string;
  name: string;
  collection: string;
  state: "active" | "archived";
  version: number;
};

export type CompareFieldValue = {
  recordId: string;
  present: boolean;
  value?: unknown;
};

export type CompareField = {
  key: string;
  label: string;
  kind: string;
  status: CompareStatus;
  values: CompareFieldValue[];
};

export type RecordComparison = {
  records: CompareRecord[];
  fields: CompareField[];
  mixedCollections: boolean;
};

export type CompareSide = CompareRecord & {
  fields: { key: string; label: string; kind: string; value: unknown }[];
};

const statusText: Record<CompareStatus, string> = {
  same: "Same",
  changed: "Changed",
  "only-left": "Only on the left",
  "only-right": "Only on the right",
};

export function compareStatusText(status: CompareStatus) {
  return statusText[status];
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function statusOf(values: CompareFieldValue[], leftId: string, rightId: string): CompareStatus {
  const present = values.filter((cell) => cell.present);
  if (!present.length) return "same";
  const canonical = stableStringify(present[0].value);
  const equal = present.every((cell) => stableStringify(cell.value) === canonical);
  if (equal && present.length === values.length) return "same";
  if (present.length === 1 && present[0].recordId === leftId) return "only-left";
  if (present.length === 1 && present[0].recordId === rightId) return "only-right";
  return "changed";
}

/** Field rows for records the caller has already permission-filtered. */
export function buildRecordComparison(sides: CompareSide[]): RecordComparison {
  if (sides.length < 2 || sides.length > 4) throw new Error("Compare two to four records.");
  const records = sides.map(({ fields: _fields, ...record }) => record);
  const meta = new Map<string, { label: string; kind: string }>();
  const keys: string[] = [];
  for (const side of sides) {
    for (const field of side.fields) {
      if (!text(field.key, 100) || !text(field.label, 200) || !fieldKinds.has(field.kind) || meta.has(field.key)) continue;
      meta.set(field.key, { label: field.label, kind: field.kind });
      keys.push(field.key);
    }
  }
  const pinned = ["name", "state", "parentOrganisation"];
  keys.sort((left, right) => {
    const leftPin = pinned.indexOf(left);
    const rightPin = pinned.indexOf(right);
    if (leftPin !== -1 || rightPin !== -1) return (leftPin === -1 ? pinned.length : leftPin) - (rightPin === -1 ? pinned.length : rightPin);
    const leftLabel = meta.get(left)!.label;
    const rightLabel = meta.get(right)!.label;
    return leftLabel.localeCompare(rightLabel) || left.localeCompare(right);
  });
  const fields: CompareField[] = keys.map((key) => {
    const info = meta.get(key)!;
    const values = sides.map((side) => {
      const field = side.fields.find((item) => item.key === key);
      if (!field || recordValueEmpty(field.value)) return { recordId: side.id, present: false };
      return { recordId: side.id, present: true, value: field.value };
    });
    return { key, label: info.label, kind: info.kind, status: statusOf(values, records[0].id, records[records.length - 1].id), values };
  });
  return { records, fields, mixedCollections: new Set(records.map((record) => record.collection)).size > 1 };
}

function jsonValue(value: unknown, depth = 0): unknown | undefined {
  if (depth > 5) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.length <= 20_000 ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > 100) return undefined;
    const items: unknown[] = [];
    for (const item of value) {
      const parsed = jsonValue(item, depth + 1);
      if (parsed === undefined) return undefined;
      items.push(parsed);
    }
    return items;
  }
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length > 8) return undefined;
  if (typeof row.id === "string" && typeof row.name === "string" && keys.every((key) => key === "id" || key === "name" || key === "state")) {
    const id = text(row.id, 200);
    const name = text(row.name, 240);
    if (!id || !name) return undefined;
    if (row.state !== undefined && row.state !== "active" && row.state !== "archived") return undefined;
    return { id, name, ...(row.state === "active" || row.state === "archived" ? { state: row.state } : {}) };
  }
  if (typeof row.currency === "string" && typeof row.minorUnits === "string" && keys.every((key) => key === "currency" || key === "minorUnits" || key === "scale")) {
    if (!/^[A-Z]{3}$/.test(row.currency) || !/^-?(0|[1-9]\d{0,17})$/.test(row.minorUnits)) return undefined;
    if (typeof row.scale !== "number" || !Number.isInteger(row.scale) || row.scale < 0 || row.scale > 4) return undefined;
    return { currency: row.currency, minorUnits: row.minorUnits, scale: row.scale };
  }
  return undefined;
}

function fieldValue(value: unknown, recordId: string): CompareFieldValue | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.recordId !== recordId || typeof row.present !== "boolean") return null;
  if (!row.present) return Object.keys(row).every((key) => key === "recordId" || key === "present") ? { recordId, present: false } : null;
  if (!Object.hasOwn(row, "value")) return null;
  const parsed = jsonValue(row.value);
  if (parsed === undefined) return null;
  return { recordId, present: true, value: parsed };
}

/** Copies only the comparison fields the screen is allowed to render. */
export function acceptedRecordComparison(value: unknown): RecordComparison | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.mixedCollections !== "boolean" || !Array.isArray(row.records) || !Array.isArray(row.fields)) return null;
  if (row.records.length < 2 || row.records.length > 4 || row.fields.length > 400) return null;
  const records: CompareRecord[] = [];
  for (const item of row.records) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const id = text(record.id, 200);
    const name = text(record.name, 240);
    const collection = text(record.collection, 100);
    if (!id || !name || !collection || (record.state !== "active" && record.state !== "archived") || typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version < 1) return null;
    records.push({ id, name, collection, state: record.state, version: record.version });
  }
  if (new Set(records.map((record) => record.id)).size !== records.length) return null;
  const fields: CompareField[] = [];
  const seen = new Set<string>();
  for (const item of row.fields) {
    if (!item || typeof item !== "object") return null;
    const field = item as Record<string, unknown>;
    const key = text(field.key, 100);
    const label = text(field.label, 200);
    if (!key || !label || seen.has(key) || typeof field.kind !== "string" || !fieldKinds.has(field.kind)) return null;
    if (typeof field.status !== "string" || !compareStatuses.includes(field.status as CompareStatus) || !Array.isArray(field.values) || field.values.length !== records.length) return null;
    const values: CompareFieldValue[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const cell = fieldValue(field.values[index], records[index].id);
      if (!cell) return null;
      values.push(cell);
    }
    seen.add(key);
    fields.push({ key, label, kind: field.kind, status: field.status as CompareStatus, values });
  }
  return { records, fields, mixedCollections: row.mixedCollections };
}

/** Renders a permitted value without printing unknown object keys. */
export function compareValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(compareValueText).filter(Boolean).join(", ");
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  if (typeof row.name === "string") return row.state === "archived" ? `${row.name} (archived)` : row.name;
  if (typeof row.currency === "string" && typeof row.minorUnits === "string") {
    const scale = typeof row.scale === "number" ? ` · scale ${row.scale}` : "";
    return `${row.currency} ${row.minorUnits}${scale}`;
  }
  return "";
}
