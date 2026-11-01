export type ImportProfileMode = "create" | "update";
export type ImportProfileScope = "personal" | "shared";
export type ImportProfileRole = "name" | "record-id" | "parent-organisation" | "legal-organisation" | "covered-account" | "field";

export type ImportProfileColumn = {
  header: string;
  role: ImportProfileRole;
  fieldId?: string;
  lookup?: "id" | "code" | "label";
  currency?: { code: string; scale: number };
};

export type ImportProfileBinding = {
  fieldId: string;
  kind: string;
  choices: string[];
  required: boolean;
  unique: boolean;
  deprecated: boolean;
  referenceListId: string | null;
  referenceListVersion: number | null;
};

export type ImportProfileField = {
  fieldId: string;
  label: string;
  kind: string;
  choices: string[];
  required: boolean;
  unique: boolean;
  deprecated: boolean;
  referenceListId: string | null;
  referenceListVersion: number | null;
  sensitive: boolean;
  visible: boolean;
  writable: boolean;
};

export type PositionalImportMapping = {
  mode: ImportProfileMode;
  nameColumn?: number;
  idColumn?: number;
  parentOrganisationColumn?: number;
  legalOrganisationColumn?: number;
  accountColumn?: number;
  fields: { column: number; fieldKey: string; referenceLookup?: "id" | "code" | "label"; currency?: { code: string; scale: number } }[];
};

export type ImportProfileIssue = { code: string; header?: string; fieldId?: string; repair: boolean };
export type ImportProfileHeaderDiff = { header: string; status: "matched" | "missing" | "ambiguous" | "extra"; columnIndex?: number; role?: ImportProfileRole; fieldId?: string };
export type ImportProfileTypeDiff = { header: string; fieldId?: string; expectedKind: string; observedKind: string; difference: boolean; choiceMismatch: boolean };
export type ImportProfileReason = { code: string; fieldId?: string };

export type ImportProfilePreview = {
  compatibility: "compatible" | "incompatible";
  reasons: ImportProfileReason[];
  repairRequired: boolean;
  restricted: boolean;
  issues: ImportProfileIssue[];
  headerDiffs: ImportProfileHeaderDiff[];
  typeDiffs: ImportProfileTypeDiff[];
  mapping: PositionalImportMapping | null;
  samplesStored: false;
};

const roles = new Set<ImportProfileRole>(["name", "record-id", "parent-organisation", "legal-organisation", "covered-account", "field"]);
const forbiddenKeys = new Set(["sample", "samples", "secret", "secrets", "password", "passwords", "token", "tokens", "credential", "credentials", "rawcells", "cells", "file", "bytes", "authorization", "cookie"]);

export function headerKey(value: string) {
  return value.trim().normalize("NFC").toLowerCase();
}

export function profilePayloadHasSecrets(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(profilePayloadHasSecrets);
  return Object.entries(value).some(([key, item]) => forbiddenKeys.has(key.toLowerCase()) || profilePayloadHasSecrets(item));
}

export function importProfileAccess(input: { scope: ImportProfileScope; ownerId: string; actorId: string; capabilities: readonly string[] }) {
  const view = input.capabilities.includes("view");
  const canImport = input.capabilities.includes("import");
  const manageShared = input.capabilities.includes("manage-import-profiles");
  const base = view && canImport;
  if (input.scope === "personal") {
    const owner = input.ownerId === input.actorId;
    return { visible: owner && base, canManage: owner && base, canUse: owner && base };
  }
  return { visible: base, canManage: base && manageShared, canUse: base };
}

function sortedChoices(values: readonly string[]) {
  return [...values].sort();
}

function sameChoices(left: readonly string[], right: readonly string[]) {
  const a = sortedChoices(left);
  const b = sortedChoices(right);
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function snapshotBindings(columns: readonly ImportProfileColumn[], fields: readonly ImportProfileField[]): ImportProfileBinding[] {
  const bindings: ImportProfileBinding[] = [];
  for (const column of columns) {
    if (column.role !== "field" || !column.fieldId) continue;
    const field = fields.find((item) => item.fieldId === column.fieldId);
    if (!field) continue;
    bindings.push({
      fieldId: field.fieldId,
      kind: field.kind,
      choices: sortedChoices(field.choices),
      required: field.required,
      unique: field.unique,
      deprecated: field.deprecated,
      referenceListId: field.referenceListId,
      referenceListVersion: field.referenceListVersion,
    });
  }
  return bindings;
}

export function profileCompatibility(bindings: readonly ImportProfileBinding[], fields: readonly ImportProfileField[]): { compatibility: "compatible" | "incompatible"; reasons: ImportProfileReason[] } {
  const reasons: ImportProfileReason[] = [];
  for (const binding of bindings) {
    const field = fields.find((item) => item.fieldId === binding.fieldId);
    if (!field) {
      reasons.push({ code: "field_missing", fieldId: binding.fieldId });
      continue;
    }
    if (field.deprecated) reasons.push({ code: "field_deprecated", fieldId: field.fieldId });
    if (field.kind !== binding.kind) reasons.push({ code: "kind_changed", fieldId: field.fieldId });
    if (!sameChoices(field.choices, binding.choices)) reasons.push({ code: "choices_changed", fieldId: field.fieldId });
    if (field.unique !== binding.unique) reasons.push({ code: "key_changed", fieldId: field.fieldId });
    if (field.required !== binding.required || field.referenceListId !== binding.referenceListId || field.referenceListVersion !== binding.referenceListVersion) reasons.push({ code: "schema_changed", fieldId: field.fieldId });
  }
  const mapped = new Set(bindings.map((binding) => binding.fieldId));
  for (const field of fields) {
    if (field.required && !field.deprecated && field.visible && field.writable && !mapped.has(field.fieldId)) reasons.push({ code: "required_field_added", fieldId: field.fieldId });
  }
  return { compatibility: reasons.length ? "incompatible" : "compatible", reasons };
}

function cellKind(value: string) {
  const text = value.trim();
  if (!text) return "empty";
  if (/^(true|false)$/i.test(text)) return "boolean";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "date";
  if (/^[A-Z]{3}:-?(?:0|[1-9]\d*):[0-4]$/.test(text) || /^[A-Z]{3}\s+-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return "currency";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "email";
  if (/^https?:\/\//i.test(text)) return "url";
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return "number";
  if (text.startsWith("[") || text.includes(";")) return "multi-select";
  if (/^\+?[0-9][0-9\s().-]{6,}$/.test(text)) return "phone";
  return "text";
}

export function inferSampleKind(samples: readonly string[]) {
  const kinds = samples.map(cellKind).filter((kind) => kind !== "empty");
  if (!kinds.length) return "empty";
  const unique = new Set(kinds);
  return unique.size === 1 ? [...unique][0] : "mixed";
}

function typeDifference(expected: string, observed: string) {
  if (observed === "empty") return false;
  if (observed === "mixed") return true;
  if (expected === "text" || expected === "long-text" || expected === "single-select") return false;
  if (expected === "multi-select") return observed !== "multi-select" && observed !== "text";
  if (expected === "phone") return observed !== "phone" && observed !== "text" && observed !== "number";
  return observed !== expected;
}

function columnError(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

export function columnsFromPositionalMapping(headers: readonly string[], mapping: PositionalImportMapping, collection?: string): { ok: true; columns: ImportProfileColumn[] } | { ok: false; message: string } {
  const columns: ImportProfileColumn[] = [];
  const take = (index: number | undefined, role: ImportProfileRole, fieldId?: string, lookup?: ImportProfileColumn["lookup"], currency?: ImportProfileColumn["currency"]) => {
    if (index === undefined) return null;
    const header = headers[index];
    if (typeof header !== "string" || !headerKey(header)) return `Column ${index + 1} is not in the staged file.`;
    const column: ImportProfileColumn = { header: header.trim().normalize("NFC"), role };
    if (fieldId) column.fieldId = fieldId;
    if (lookup && lookup !== "id") column.lookup = lookup;
    if (currency) column.currency = currency;
    columns.push(column);
    return null;
  };
  for (const message of [
    take(mapping.nameColumn, "name"),
    take(mapping.idColumn, "record-id"),
    take(mapping.parentOrganisationColumn, "parent-organisation"),
    take(mapping.legalOrganisationColumn, "legal-organisation"),
    take(mapping.accountColumn, "covered-account"),
  ]) if (message) return columnError(message);
  for (const field of mapping.fields) {
    const message = take(field.column, "field", field.fieldKey, field.referenceLookup, field.currency);
    if (message) return columnError(message);
  }
  return validateProfileColumns(mapping.mode, columns, collection);
}

export function validateProfileColumns(mode: ImportProfileMode, columns: readonly ImportProfileColumn[], collection?: string): { ok: true; columns: ImportProfileColumn[] } | { ok: false; message: string } {
  if (!columns.length || columns.length > 100) return columnError("Map at least one column.");
  const keys = new Set<string>();
  const fieldIds = new Set<string>();
  const normalized: ImportProfileColumn[] = [];
  for (const column of columns) {
    if (!roles.has(column.role) || !headerKey(column.header) || column.header.trim().length > 200 || /[\p{Cc}]/u.test(column.header)) return columnError("Use a staged column header.");
    const key = headerKey(column.header);
    if (keys.has(key)) return columnError("Map each column header once.");
    keys.add(key);
    if (column.role === "field") {
      if (!column.fieldId || column.fieldId.length > 100 || fieldIds.has(column.fieldId)) return columnError("Map each field once by its field id.");
      fieldIds.add(column.fieldId);
    } else if (column.fieldId) return columnError("Only field columns carry a field id.");
    if (column.currency && !/^[A-Z]{3}$/.test(column.currency.code)) return columnError("Use an explicit currency code and scale.");
    normalized.push({
      header: column.header.trim().normalize("NFC"),
      role: column.role,
      ...(column.fieldId ? { fieldId: column.fieldId } : {}),
      ...(column.lookup && column.lookup !== "id" ? { lookup: column.lookup } : {}),
      ...(column.currency ? { currency: { code: column.currency.code, scale: column.currency.scale } } : {}),
    });
  }
  const count = (role: ImportProfileRole) => normalized.filter((column) => column.role === role).length;
  if (mode === "create" && count("name") !== 1) return columnError("Create needs a name column.");
  if (mode === "create" && count("record-id") !== 0) return columnError("Create does not map an immutable record id.");
  if (mode === "update" && count("record-id") !== 1) return columnError("Update needs an immutable record ID column.");
  if (mode === "update" && count("name") + count("field") < 1) return columnError("Update needs a name column or a mapped field.");
  if (mode === "update" && (count("parent-organisation") || count("legal-organisation") || count("covered-account"))) return columnError("Relationship changes stay in their own workflow.");
  if (collection === "accounts" && mode === "create" && count("parent-organisation") !== 1) return columnError("Map the parent organisation column.");
  if (collection === "contracts" && mode === "create" && count("legal-organisation") !== 1) return columnError("Map the legal organisation column.");
  if (collection && collection !== "accounts" && count("parent-organisation")) return columnError("Parent organisation applies to accounts.");
  if (collection && collection !== "contracts" && (count("legal-organisation") || count("covered-account"))) return columnError("Contract relationships apply to contracts.");
  if (profilePayloadHasSecrets(normalized)) return columnError("A profile cannot store samples or secrets.");
  return { ok: true, columns: normalized };
}

function matches(headers: readonly string[], header: string) {
  const key = headerKey(header);
  return headers.flatMap((item, index) => headerKey(item) === key ? [index] : []);
}

export function applyImportProfile(input: {
  collection: string;
  mode: ImportProfileMode;
  columns: readonly ImportProfileColumn[];
  bindings: readonly ImportProfileBinding[];
  fields: readonly ImportProfileField[];
  headers: readonly string[];
  samples?: readonly (readonly string[])[];
}): ImportProfilePreview {
  const checked = validateProfileColumns(input.mode, input.columns, input.collection);
  const columns = checked.ok ? checked.columns : input.columns;
  const compatibility = profileCompatibility(input.bindings, input.fields);
  const issues: ImportProfileIssue[] = [];
  const headerDiffs: ImportProfileHeaderDiff[] = [];
  const typeDiffs: ImportProfileTypeDiff[] = [];
  const hidden = columns.some((column) => {
    if (column.role !== "field" || !column.fieldId) return false;
    const field = input.fields.find((item) => item.fieldId === column.fieldId);
    return !field || !field.visible;
  });
  if (hidden) {
    return { compatibility: "incompatible", reasons: [{ code: "field_forbidden" }], repairRequired: true, restricted: true, issues: [{ code: "field_forbidden", repair: true }], headerDiffs: [], typeDiffs: [], mapping: null, samplesStored: false };
  }
  const mapping: PositionalImportMapping = { mode: input.mode, fields: [] };
  const used = new Set<string>();
  for (const column of columns) {
    used.add(headerKey(column.header));
    const found = matches(input.headers, column.header);
    if (found.length > 1) {
      headerDiffs.push({ header: column.header, status: "ambiguous", role: column.role, ...(column.fieldId ? { fieldId: column.fieldId } : {}) });
      issues.push({ code: "ambiguous_header", header: column.header, ...(column.fieldId ? { fieldId: column.fieldId } : {}), repair: true });
      continue;
    }
    if (found.length === 0) {
      const requiredRole = column.role === "name" && input.mode === "create" || column.role === "record-id" || column.role === "parent-organisation" || column.role === "legal-organisation";
      const field = column.fieldId ? input.fields.find((item) => item.fieldId === column.fieldId) : undefined;
      const requiredField = !!field && field.required && !field.deprecated;
      headerDiffs.push({ header: column.header, status: "missing", role: column.role, ...(column.fieldId ? { fieldId: column.fieldId } : {}) });
      issues.push({ code: requiredRole || requiredField ? "missing_required" : "missing_column", header: column.header, ...(column.fieldId ? { fieldId: column.fieldId } : {}), repair: requiredRole || requiredField });
      continue;
    }
    const columnIndex = found[0];
    headerDiffs.push({ header: column.header, status: "matched", columnIndex, role: column.role, ...(column.fieldId ? { fieldId: column.fieldId } : {}) });
    if (column.role === "name") mapping.nameColumn = columnIndex;
    if (column.role === "record-id") mapping.idColumn = columnIndex;
    if (column.role === "parent-organisation") mapping.parentOrganisationColumn = columnIndex;
    if (column.role === "legal-organisation") mapping.legalOrganisationColumn = columnIndex;
    if (column.role === "covered-account") mapping.accountColumn = columnIndex;
    if (column.role === "field" && column.fieldId) {
      const field = input.fields.find((item) => item.fieldId === column.fieldId);
      if (!field || field.deprecated || !field.writable) {
        issues.push({ code: field?.deprecated ? "field_deprecated" : "field_forbidden", header: column.header, fieldId: column.fieldId, repair: true });
        continue;
      }
      const samples = (input.samples ?? []).slice(0, 3).map((row) => row[columnIndex] ?? "");
      const observedKind = inferSampleKind(samples);
      const choiceMismatch = (field.kind === "single-select" || field.kind === "multi-select") && samples.some((sample) => {
        const text = sample.trim();
        return !!text && !field.choices.includes(text) && !text.startsWith("[");
      });
      typeDiffs.push({ header: column.header, fieldId: field.fieldId, expectedKind: field.kind, observedKind, difference: typeDifference(field.kind, observedKind) || choiceMismatch, choiceMismatch });
      mapping.fields.push({ column: columnIndex, fieldKey: field.fieldId, ...(column.lookup ? { referenceLookup: column.lookup } : {}), ...(column.currency ? { currency: column.currency } : {}) });
    }
  }
  for (const header of input.headers) {
    if (!headerKey(header) || used.has(headerKey(header))) continue;
    headerDiffs.push({ header, status: "extra" });
  }
  for (const reason of compatibility.reasons) issues.push({ code: reason.code, ...(reason.fieldId ? { fieldId: reason.fieldId } : {}), repair: true });
  if (input.mode === "create" && mapping.nameColumn === undefined && !issues.some((issue) => issue.code === "missing_required" || issue.code === "ambiguous_header")) issues.push({ code: "missing_required", repair: true });
  if (input.mode === "update" && mapping.idColumn === undefined && !issues.some((issue) => issue.header && (issue.code === "missing_required" || issue.code === "ambiguous_header"))) issues.push({ code: "missing_required", repair: true });
  const repairRequired = !checked.ok || compatibility.compatibility === "incompatible" || issues.some((issue) => issue.repair);
  return {
    compatibility: compatibility.compatibility,
    reasons: compatibility.reasons,
    repairRequired,
    restricted: false,
    issues,
    headerDiffs,
    typeDiffs,
    mapping: repairRequired ? null : mapping,
    samplesStored: false,
  };
}

function stringHeader(value: unknown) {
  return typeof value === "string" && !!headerKey(value) && value.trim().length <= 200 && !/[\p{Cc}]/u.test(value);
}

export function acceptedPositionalMapping(value: unknown): PositionalImportMapping | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.mode !== "create" && body.mode !== "update") return null;
  if (profilePayloadHasSecrets(body)) return null;
  const index = (item: unknown) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 99 ? item : undefined;
  const mapping: PositionalImportMapping = { mode: body.mode, fields: [] };
  for (const [key, target] of [["nameColumn", "nameColumn"], ["idColumn", "idColumn"], ["parentOrganisationColumn", "parentOrganisationColumn"], ["legalOrganisationColumn", "legalOrganisationColumn"], ["accountColumn", "accountColumn"]] as const) {
    if (body[key] === undefined) continue;
    const parsed = index(body[key]);
    if (parsed === undefined) return null;
    mapping[target] = parsed;
  }
  if (!Array.isArray(body.fields) || body.fields.length > 100) return null;
  for (const field of body.fields) {
    if (!field || typeof field !== "object") return null;
    const item = field as Record<string, unknown>;
    const column = index(item.column);
    if (column === undefined || typeof item.fieldKey !== "string" || !item.fieldKey || item.fieldKey.length > 100) return null;
    const next: PositionalImportMapping["fields"][number] = { column, fieldKey: item.fieldKey };
    if (item.referenceLookup !== undefined) {
      if (item.referenceLookup !== "id" && item.referenceLookup !== "code" && item.referenceLookup !== "label") return null;
      if (item.referenceLookup !== "id") next.referenceLookup = item.referenceLookup;
    }
    if (item.currency !== undefined) {
      if (!item.currency || typeof item.currency !== "object") return null;
      const currency = item.currency as { code?: unknown; scale?: unknown };
      if (typeof currency.code !== "string" || !/^[A-Z]{3}$/.test(currency.code) || typeof currency.scale !== "number" || !Number.isInteger(currency.scale) || currency.scale < 0 || currency.scale > 4) return null;
      next.currency = { code: currency.code, scale: currency.scale };
    }
    mapping.fields.push(next);
  }
  return mapping;
}

export function acceptedProfileColumn(value: unknown): ImportProfileColumn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!stringHeader(body.header) || typeof body.role !== "string" || !roles.has(body.role as ImportProfileRole)) return null;
  if (profilePayloadHasSecrets(body)) return null;
  const column: ImportProfileColumn = { header: (body.header as string).trim().normalize("NFC"), role: body.role as ImportProfileRole };
  if (body.fieldId !== undefined) {
    if (typeof body.fieldId !== "string" || !body.fieldId || body.fieldId.length > 100) return null;
    column.fieldId = body.fieldId;
  }
  if (body.lookup !== undefined) {
    if (body.lookup !== "code" && body.lookup !== "label" && body.lookup !== "id") return null;
    if (body.lookup !== "id") column.lookup = body.lookup;
  }
  if (body.currency !== undefined) {
    if (!body.currency || typeof body.currency !== "object") return null;
    const currency = body.currency as { code?: unknown; scale?: unknown };
    if (typeof currency.code !== "string" || !/^[A-Z]{3}$/.test(currency.code) || typeof currency.scale !== "number" || currency.scale < 0 || currency.scale > 4) return null;
    column.currency = { code: currency.code, scale: currency.scale };
  }
  return column;
}

export function acceptedProfilePreview(value: unknown): ImportProfilePreview | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.samplesStored !== false || profilePayloadHasSecrets(body)) return null;
  if (body.compatibility !== "compatible" && body.compatibility !== "incompatible") return null;
  if (typeof body.repairRequired !== "boolean" || typeof body.restricted !== "boolean") return null;
  if (!Array.isArray(body.issues) || !Array.isArray(body.headerDiffs) || !Array.isArray(body.typeDiffs) || !Array.isArray(body.reasons)) return null;
  const mapping = body.mapping === null ? null : acceptedPositionalMapping(body.mapping);
  if (body.mapping !== null && !mapping) return null;
  if (body.repairRequired && mapping) return null;
  return {
    compatibility: body.compatibility,
    reasons: body.reasons.flatMap((reason) => {
      if (!reason || typeof reason !== "object") return [];
      const item = reason as { code?: unknown; fieldId?: unknown };
      if (typeof item.code !== "string" || item.code.length > 80) return [];
      return [{ code: item.code, ...(typeof item.fieldId === "string" ? { fieldId: item.fieldId } : {}) }];
    }),
    repairRequired: body.repairRequired,
    restricted: body.restricted,
    issues: body.issues.flatMap((issue) => {
      if (!issue || typeof issue !== "object") return [];
      const item = issue as { code?: unknown; header?: unknown; fieldId?: unknown; repair?: unknown };
      if (typeof item.code !== "string" || typeof item.repair !== "boolean") return [];
      return [{ code: item.code, repair: item.repair, ...(typeof item.header === "string" ? { header: item.header } : {}), ...(typeof item.fieldId === "string" ? { fieldId: item.fieldId } : {}) }];
    }),
    headerDiffs: body.headerDiffs.flatMap((diff) => {
      if (!diff || typeof diff !== "object") return [];
      const item = diff as { header?: unknown; status?: unknown; columnIndex?: number; role?: unknown; fieldId?: unknown };
      if (!stringHeader(item.header) || (item.status !== "matched" && item.status !== "missing" && item.status !== "ambiguous" && item.status !== "extra")) return [];
      return [{ header: item.header as string, status: item.status, ...(typeof item.columnIndex === "number" ? { columnIndex: item.columnIndex } : {}), ...(typeof item.role === "string" && roles.has(item.role as ImportProfileRole) ? { role: item.role as ImportProfileRole } : {}), ...(typeof item.fieldId === "string" ? { fieldId: item.fieldId } : {}) }];
    }),
    typeDiffs: body.typeDiffs.flatMap((diff) => {
      if (!diff || typeof diff !== "object") return [];
      const item = diff as { header?: unknown; fieldId?: unknown; expectedKind?: unknown; observedKind?: unknown; difference?: unknown; choiceMismatch?: unknown };
      if (!stringHeader(item.header) || typeof item.expectedKind !== "string" || typeof item.observedKind !== "string" || typeof item.difference !== "boolean" || typeof item.choiceMismatch !== "boolean") return [];
      return [{ header: item.header as string, expectedKind: item.expectedKind, observedKind: item.observedKind, difference: item.difference, choiceMismatch: item.choiceMismatch, ...(typeof item.fieldId === "string" ? { fieldId: item.fieldId } : {}) }];
    }),
    mapping,
    samplesStored: false,
  };
}
