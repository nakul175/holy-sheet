import { DocumentError } from "./document";

export const connectorSource = "governed-connector";
export const connectorSharing = "off" as const;
export const connectorBoundary = "A connector registers an approved type, tenant source, stable identifiers, and an explicit direction. It does not open a live connection.";
export const connectorAssignment = "Configuring a connector, naming a manager, or assigning a source does not grant access to a page, record, collection, or field.";
export const connectorSecrets = "Runtime credentials stay in the suite secret store. Secret values are not collected, rotated, exported, logged, or shown.";
export const connectorDelegation = "Runtime uses the delegated user's and app's existing rights and field ownership. Connector configuration does not grant those rights.";
export const connectorActivation = "No connector is activated by this task. Connection setup stays separately authorised and sharing stays off.";
export const connectorSchedules = "Existing schedules stay paused. Connectors do not activate a schedule.";
export const connectorRecoverable = "A recoverable draft is kept when the version changes.";
export const connectorEdge = "Connector responses stay with the tenant and use cache no-store. Public caching is off.";
export const connectorCanonical = "Pause and disconnect keep canonical records unchanged and stop later writes.";
export const connectorControlSize = 44;
export const connectorRetryBound = 3;
export const connectorTypes = ["records", "directory"] as const;
export const connectorDirections = ["read", "write", "read-write"] as const;
export const connectorStatuses = ["draft", "enabled", "paused", "disconnected"] as const;
export const connectorActorActions = ["configure", "search", "preview", "download", "history", "enable", "pause", "disconnect", "delegate", "sync", "review", "merge"] as const;
export const connectorLimits = { name: 80, source: 41, mappings: 12, records: 20, items: 20, text: 2000, externalId: 80, externalField: 40 } as const;

export type ConnectorType = (typeof connectorTypes)[number];
export type ConnectorDirection = (typeof connectorDirections)[number];
export type ConnectorStatus = (typeof connectorStatuses)[number];
export type ConnectorActorAction = (typeof connectorActorActions)[number];
export type ConnectorStableId = { externalId: string; recordId: string };
export type ConnectorMapping = { externalField: string; field: string; stable: true };
export type ConnectorDefinition = {
  type: ConnectorType;
  scope: { source: string; collection: string; recordIds: string[] };
  direction: ConnectorDirection;
  stableIds: ConnectorStableId[];
  mappings: ConnectorMapping[];
  secretRef: string | null;
  edge: { cache: "no-store"; residency: "tenant"; public: false };
  retry: { bound: typeof connectorRetryBound };
};
export type SyncIncoming = {
  externalId: string;
  externalField: string;
  value: string;
  externalVersion: number;
  tombstone: boolean;
  canonicalVersion: number | null;
};
export type LedgerState = "proposed" | "conflict" | "tombstone" | "merged" | "rejected" | "failed";
export type LedgerRow = {
  externalId: string;
  externalField: string;
  value: string;
  proposedValue: string | null;
  externalVersion: number;
  canonicalVersion: number | null;
  state: LedgerState;
  attempts: number;
  mergedInto: string | null;
};
export type CanonicalFact = { externalId: string; externalField: string; version: number; value: string | null };
export type SyncEffect = {
  externalId: string;
  externalField: string;
  state: LedgerState;
  value: string;
  proposedValue: string | null;
  externalVersion: number;
  canonicalVersion: number | null;
  attempts: number;
  deduped: boolean;
  overwritten: false;
  insert: boolean;
};
export type SyncPlan = {
  ok: boolean;
  code?: "connector_writes_stopped" | "connector_checkpoint" | "connector_retry_bound" | "connector_direction";
  message?: string;
  writesStopped: boolean;
  canonicalPreserved: true;
  checkpoint: string | null;
  generation: number;
  advanced: boolean;
  effects: SyncEffect[];
};
export type ConnectorRights = { view: boolean; write: boolean; history: boolean; fieldOwned: boolean; accessGranted: false };

const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fieldPattern = /^(?:core:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const slugPattern = /^[a-z][a-z0-9-]{0,40}$/;
const externalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const externalFieldPattern = /^[a-z][a-z0-9_]{0,39}$/;
const secretRefPattern = /^suite-secret:[a-z][a-z0-9-]{0,63}$/;
const hiddenKeys = new Set(["secret", "secretref", "password", "token", "credential", "credentials", "apikey", "authorization", "bearer"]);
const secretValue = /(?:bearer\s+[a-z0-9._~+/-]{8,}|sk_(?:live|test)_[a-z0-9]+|hs-secret:\S+|password\s*[:=]\s*\S+)/i;

const invalid = () => new DocumentError("Check the connector.", "connector_validation", 422);
const secretError = () => new DocumentError(connectorSecrets, "connector_secret", 422);
const edgeError = () => new DocumentError(connectorEdge, "connector_edge", 422);

function text(value: unknown, limit: number) {
  if (typeof value !== "string") throw invalid();
  const next = value.trim().normalize("NFC");
  if (!next || Array.from(next).length > limit || control.test(next)) throw invalid();
  if (secretValue.test(next) || /suite-secret:/i.test(next)) throw secretError();
  return next;
}
function unique<T>(values: T[], same: (left: T, right: T) => boolean) {
  const next: T[] = [];
  for (const value of values) {
    if (next.some(item => same(item, value))) throw invalid();
    next.push(value);
  }
  return next;
}
function keyName(value: string) {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

export function connectorName(value: string) {
  return text(value, connectorLimits.name);
}
export function connectorQuery(value: string) {
  const query = value.trim().toLocaleLowerCase();
  if (!query || Array.from(query).length > 80 || control.test(query) || secretValue.test(query) || /suite-secret:/i.test(query)) throw invalid();
  return query;
}

export function assertNoSecret(value: unknown) {
  if (typeof value === "string") {
    if (secretValue.test(value) || /suite-secret:/i.test(value)) throw secretError();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecret(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (hiddenKeys.has(keyName(key))) throw secretError();
    assertNoSecret(item);
  }
}

export function redactConnector<T>(value: T): T {
  if (typeof value === "string") return (secretValue.test(value) || /suite-secret:/i.test(value) ? "[redacted]" : value) as T;
  if (Array.isArray(value)) return value.map(item => redactConnector(item)) as T;
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (hiddenKeys.has(keyName(key))) continue;
    output[key] = redactConnector(item);
  }
  return output as T;
}

export function compileConnector(input: unknown): ConnectorDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const source = input as Record<string, unknown>;
  const allowed = ["type", "scope", "direction", "stableIds", "mappings", "secretRef", "edge", "retry"];
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      if (hiddenKeys.has(keyName(key))) throw secretError();
      throw invalid();
    }
  }
  if (source.type !== "records" && source.type !== "directory") throw invalid();
  if (source.direction !== "read" && source.direction !== "write" && source.direction !== "read-write") throw invalid();
  if (!source.scope || typeof source.scope !== "object" || Array.isArray(source.scope)) throw invalid();
  const scope = source.scope as Record<string, unknown>;
  if (Object.keys(scope).some(key => !["source", "collection", "recordIds"].includes(key))) throw invalid();
  const sourceName = text(scope.source, connectorLimits.source);
  if (!slugPattern.test(sourceName)) throw invalid();
  const collection = text(scope.collection, connectorLimits.source);
  if (!slugPattern.test(collection)) throw invalid();
  if (!Array.isArray(scope.recordIds) || scope.recordIds.length < 1 || scope.recordIds.length > connectorLimits.records) throw invalid();
  const recordIds = unique(scope.recordIds.map(id => {
    const recordId = text(id, 80).toLowerCase();
    if (!uuidPattern.test(recordId)) throw invalid();
    return recordId;
  }), (left, right) => left === right);
  if (!Array.isArray(source.stableIds) || source.stableIds.length < 1 || source.stableIds.length > connectorLimits.records) throw invalid();
  const stableIds = unique(source.stableIds.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !["externalId", "recordId"].includes(key))) throw invalid();
    const externalId = text(row.externalId, connectorLimits.externalId);
    if (!externalIdPattern.test(externalId)) throw invalid();
    const recordId = text(row.recordId, 80).toLowerCase();
    if (!uuidPattern.test(recordId) || !recordIds.includes(recordId)) throw invalid();
    return { externalId, recordId };
  }), (left, right) => left.externalId === right.externalId || left.recordId === right.recordId);
  if (!Array.isArray(source.mappings) || source.mappings.length < 1 || source.mappings.length > connectorLimits.mappings) throw invalid();
  const mappings = unique(source.mappings.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !["externalField", "field", "stable"].includes(key))) throw invalid();
    if (row.stable !== undefined && row.stable !== true) throw invalid();
    const externalField = text(row.externalField, connectorLimits.externalField);
    if (!externalFieldPattern.test(externalField)) throw invalid();
    const field = text(row.field, 80);
    if (!fieldPattern.test(field)) throw invalid();
    const mapping: ConnectorMapping = { externalField, field, stable: true };
    return mapping;
  }), (left, right) => left.externalField === right.externalField || left.field.toLowerCase() === right.field.toLowerCase());
  let secretRef: string | null = null;
  if (source.secretRef !== undefined && source.secretRef !== null) {
    if (typeof source.secretRef !== "string" || !secretRefPattern.test(source.secretRef.trim())) throw secretError();
    secretRef = source.secretRef.trim();
  }
  if (!source.edge || typeof source.edge !== "object" || Array.isArray(source.edge)) throw invalid();
  const edge = source.edge as Record<string, unknown>;
  if (Object.keys(edge).some(key => !["cache", "residency", "public"].includes(key))) throw invalid();
  if (edge.cache !== "no-store" || edge.residency !== "tenant" || edge.public !== false) throw edgeError();
  if (!source.retry || typeof source.retry !== "object" || Array.isArray(source.retry)) throw invalid();
  const retry = source.retry as Record<string, unknown>;
  if (Object.keys(retry).some(key => key !== "bound") || retry.bound !== connectorRetryBound) throw invalid();
  return {
    type: source.type,
    scope: { source: sourceName, collection, recordIds },
    direction: source.direction,
    stableIds,
    mappings,
    secretRef,
    edge: { cache: "no-store", residency: "tenant", public: false },
    retry: { bound: connectorRetryBound },
  };
}

export function storedDefinition(definition: ConnectorDefinition) {
  return {
    type: definition.type,
    scope: definition.scope,
    direction: definition.direction,
    stableIds: definition.stableIds,
    mappings: definition.mappings.map(mapping => ({ externalField: mapping.externalField, field: mapping.field })),
    edge: definition.edge,
    retry: definition.retry,
  };
}

export function publicConnector(definition: ConnectorDefinition) {
  const stored = storedDefinition(definition);
  return {
    ...stored,
    mappings: stored.mappings.map(mapping => ({ ...mapping, stable: true as const })),
    secret: { store: "suite-secret-store" as const, present: Boolean(definition.secretRef), visible: false as const },
    secretVisible: false as const,
    credentialsStored: false as const,
  };
}

export function compileSyncItems(input: unknown): SyncIncoming[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > connectorLimits.items) throw invalid();
  return input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !["externalId", "externalField", "value", "externalVersion", "tombstone", "canonicalVersion"].includes(key))) {
      if (Object.keys(row).some(key => hiddenKeys.has(keyName(key)))) throw secretError();
      throw invalid();
    }
    const externalId = text(row.externalId, connectorLimits.externalId);
    if (!externalIdPattern.test(externalId)) throw invalid();
    const externalField = text(row.externalField, connectorLimits.externalField);
    if (!externalFieldPattern.test(externalField)) throw invalid();
    const value = text(row.value, connectorLimits.text);
    if (typeof row.externalVersion !== "number" || !Number.isInteger(row.externalVersion) || row.externalVersion < 1 || row.externalVersion > 1_000_000) throw invalid();
    const tombstone = row.tombstone === undefined ? false : row.tombstone;
    if (typeof tombstone !== "boolean") throw invalid();
    let canonicalVersion: number | null = null;
    if (row.canonicalVersion !== undefined && row.canonicalVersion !== null) {
      if (typeof row.canonicalVersion !== "number" || !Number.isInteger(row.canonicalVersion) || row.canonicalVersion < 1) throw invalid();
      canonicalVersion = row.canonicalVersion;
    }
    return { externalId, externalField, value, externalVersion: row.externalVersion, tombstone, canonicalVersion };
  });
}

export function assertMappedItems(definition: ConnectorDefinition, items: SyncIncoming[]) {
  for (const item of items) {
    if (!definition.stableIds.some(row => row.externalId === item.externalId)) throw invalid();
    if (!definition.mappings.some(row => row.externalField === item.externalField)) throw invalid();
  }
}

function keyOf(externalId: string, externalField: string) {
  return `${externalId}\n${externalField}`;
}

function collapse(items: SyncIncoming[]) {
  const groups = new Map<string, SyncIncoming[]>();
  for (const item of items) {
    const key = keyOf(item.externalId, item.externalField);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map(group => {
    const ranked = [...group].sort((left, right) => left.externalVersion - right.externalVersion);
    const winner = ranked[ranked.length - 1];
    const conflicted = ranked.some(item => item.externalVersion === winner.externalVersion && (item.value !== winner.value || item.tombstone !== winner.tombstone));
    const proposed = conflicted ? ranked.find(item => item.value !== winner.value || item.tombstone !== winner.tombstone) ?? null : null;
    return { item: winner, duplicates: group.length > 1, conflicted, proposed };
  });
}

function stopped(input: { checkpoint: string | null; generation: number; code: NonNullable<SyncPlan["code"]>; message: string }): SyncPlan {
  return {
    ok: false, code: input.code, message: input.message, writesStopped: input.code === "connector_writes_stopped",
    canonicalPreserved: true, checkpoint: input.checkpoint, generation: input.generation, advanced: false, effects: [],
  };
}

/** Plans a ledger sync. Canonical records are never part of the write set. */
export function planSyncBatch(input: {
  status: ConnectorStatus;
  direction: ConnectorDirection;
  mode: "initial" | "incremental";
  checkpoint: string | null;
  storedCheckpoint: string | null;
  generation: number;
  items: SyncIncoming[];
  ledger: LedgerRow[];
  canonical: CanonicalFact[];
  bound: number;
  failed: boolean;
}): SyncPlan {
  if (input.status !== "enabled") {
    return stopped({ checkpoint: input.storedCheckpoint, generation: input.generation, code: "connector_writes_stopped", message: connectorCanonical });
  }
  if (input.mode === "initial" && (input.storedCheckpoint !== null || input.checkpoint !== null)) {
    return stopped({ checkpoint: input.storedCheckpoint, generation: input.generation, code: "connector_checkpoint", message: "The sync checkpoint does not match. Nothing was overwritten." });
  }
  if (input.mode === "incremental" && (input.storedCheckpoint === null || input.checkpoint !== input.storedCheckpoint)) {
    return stopped({ checkpoint: input.storedCheckpoint, generation: input.generation, code: "connector_checkpoint", message: "The sync checkpoint does not match. Nothing was overwritten." });
  }
  const collapsed = collapse(input.items);
  if (input.direction === "read" && collapsed.some(row => row.item.tombstone)) {
    return stopped({ checkpoint: input.storedCheckpoint, generation: input.generation, code: "connector_direction", message: "This connector direction does not accept that write." });
  }
  const ledger = new Map(input.ledger.map(row => [keyOf(row.externalId, row.externalField), row]));
  if (input.failed && collapsed.some(row => (ledger.get(keyOf(row.item.externalId, row.item.externalField))?.attempts ?? 0) >= input.bound)) {
    return stopped({ checkpoint: input.storedCheckpoint, generation: input.generation, code: "connector_retry_bound", message: "Retry is bounded. The earlier result is unchanged." });
  }
  const effects: SyncEffect[] = collapsed.map(row => {
    const prior = ledger.get(keyOf(row.item.externalId, row.item.externalField));
    const canonical = input.canonical.find(fact => fact.externalId === row.item.externalId && fact.externalField === row.item.externalField);
    const baseValue = prior?.value ?? canonical?.value ?? row.item.value;
    const held = prior?.value ?? row.item.value;
    if (input.failed) {
      return {
        externalId: row.item.externalId, externalField: row.item.externalField, state: "failed" as const,
        value: held, proposedValue: prior?.proposedValue ?? null, externalVersion: prior?.externalVersion ?? row.item.externalVersion,
        canonicalVersion: prior?.canonicalVersion ?? row.item.canonicalVersion, attempts: (prior?.attempts ?? 0) + 1,
        deduped: false, overwritten: false as const, insert: !prior,
      };
    }
    if (row.conflicted) {
      return {
        externalId: row.item.externalId, externalField: row.item.externalField, state: "conflict" as const, value: held,
        proposedValue: row.proposed?.value ?? row.item.value, externalVersion: prior?.externalVersion ?? row.item.externalVersion,
        canonicalVersion: row.item.canonicalVersion, attempts: prior?.attempts ?? 0, deduped: row.duplicates, overwritten: false as const, insert: !prior,
      };
    }
    if (prior && prior.value === row.item.value && prior.externalVersion === row.item.externalVersion && !row.item.tombstone && prior.state !== "conflict") {
      return {
        externalId: prior.externalId, externalField: prior.externalField, state: prior.state, value: prior.value, proposedValue: prior.proposedValue,
        externalVersion: prior.externalVersion, canonicalVersion: prior.canonicalVersion, attempts: prior.attempts,
        deduped: true, overwritten: false as const, insert: false,
      };
    }
    if (row.item.tombstone) {
      return {
        externalId: row.item.externalId, externalField: row.item.externalField, state: "tombstone" as const, value: held,
        proposedValue: prior?.proposedValue ?? null, externalVersion: row.item.externalVersion, canonicalVersion: row.item.canonicalVersion,
        attempts: prior?.attempts ?? 0, deduped: row.duplicates, overwritten: false as const, insert: !prior,
      };
    }
    const canonicalConflict = Boolean(canonical && canonical.value !== null && canonical.value !== row.item.value && canonical.version !== row.item.canonicalVersion);
    const priorConflict = Boolean(prior && prior.value !== row.item.value);
    const readConflict = input.direction === "read" && ((prior && prior.value !== row.item.value) || (canonical?.value !== null && canonical?.value !== undefined && canonical.value !== row.item.value));
    if (canonicalConflict || priorConflict || readConflict) {
      return {
        externalId: row.item.externalId, externalField: row.item.externalField, state: "conflict" as const,
        value: prior?.value ?? canonical?.value ?? baseValue, proposedValue: row.item.value,
        externalVersion: prior?.externalVersion ?? row.item.externalVersion, canonicalVersion: row.item.canonicalVersion,
        attempts: prior?.attempts ?? 0, deduped: row.duplicates, overwritten: false as const, insert: !prior,
      };
    }
    return {
      externalId: row.item.externalId, externalField: row.item.externalField, state: "proposed" as const, value: row.item.value,
      proposedValue: null, externalVersion: row.item.externalVersion, canonicalVersion: row.item.canonicalVersion,
      attempts: prior?.attempts ?? 0, deduped: row.duplicates, overwritten: false as const, insert: !prior,
    };
  });
  if (input.failed) {
    return { ok: true, writesStopped: false, canonicalPreserved: true, checkpoint: input.storedCheckpoint, generation: input.generation, advanced: false, effects };
  }
  const generation = input.generation + 1;
  return { ok: true, writesStopped: false, canonicalPreserved: true, checkpoint: `cp-${generation}`, generation, advanced: true, effects };
}

export function planMerge(input: {
  row: LedgerRow;
  decision: "keep-canonical" | "accept-external" | "merge";
  survivorExternalId: string | null;
  canonicalValue: string | null;
}) {
  if (input.row.state !== "conflict" && input.row.state !== "tombstone") {
    return { ok: false as const, code: "connector_validation" as const, message: "Check the connector." };
  }
  if (input.decision === "accept-external") {
    if (!input.row.proposedValue) return { ok: false as const, code: "connector_validation" as const, message: "Check the connector." };
    return { ok: true as const, state: "merged" as const, value: input.row.proposedValue, proposedValue: null, mergedInto: null, canonicalMutated: false as const, overwritten: false as const };
  }
  if (input.decision === "merge") {
    if (!input.survivorExternalId || input.survivorExternalId === input.row.externalId) {
      return { ok: false as const, code: "connector_validation" as const, message: "Check the connector." };
    }
    return { ok: true as const, state: "merged" as const, value: input.row.value, proposedValue: null, mergedInto: input.survivorExternalId, canonicalMutated: false as const, overwritten: false as const };
  }
  return {
    ok: true as const, state: "merged" as const, value: input.canonicalValue ?? input.row.value, proposedValue: null,
    mergedInto: null, canonicalMutated: false as const, overwritten: false as const,
  };
}

export function nextConnectorStatus(current: ConnectorStatus, action: "enable" | "pause" | "disconnect") {
  if (current === "disconnected" && action !== "disconnect") {
    return { ok: false as const, code: "connector_disconnected" as const, message: "This connector is disconnected. Canonical data is unchanged." };
  }
  if (action === "enable") return { ok: true as const, status: "enabled" as const, unchanged: current === "enabled" };
  if (action === "pause") return { ok: true as const, status: "paused" as const, unchanged: current === "paused" };
  return { ok: true as const, status: "disconnected" as const, unchanged: current === "disconnected" };
}

/** Delegation narrows runtime rights to rights the subject already holds. */
export function effectiveRights(input: { kind: "user" | "app"; live: { view: boolean; write: boolean; history: boolean }; fieldOwned: boolean }): ConnectorRights {
  if (input.kind === "app") return { view: false, write: false, history: false, fieldOwned: input.fieldOwned, accessGranted: false };
  return {
    view: input.live.view,
    write: input.live.write && input.fieldOwned,
    history: input.live.history,
    fieldOwned: input.fieldOwned,
    accessGranted: false,
  };
}

export function connectorHealth(status: ConnectorStatus, conflicts: number) {
  if (conflicts > 0) return "attention" as const;
  if (status === "enabled") return "ready" as const;
  if (status === "paused") return "paused" as const;
  if (status === "disconnected") return "disconnected" as const;
  return "registered" as const;
}

export function connectorInventory(status: ConnectorStatus, conflicts: number) {
  return {
    residency: "tenant" as const,
    health: connectorHealth(status, conflicts),
    liveActivation: false as const,
    connectionAuthorised: false as const,
    credentialsStored: false as const,
    secretVisible: false as const,
    schedulesPaused: true as const,
    canonicalPreserved: true as const,
    canonicalWrites: false as const,
    writesStopped: status !== "enabled",
    conflicts,
    cache: "no-store" as const,
  };
}

export function connectorReport(definition: ConnectorDefinition, name: string, lines: string[]) {
  const view = publicConnector(definition);
  return [
    `# ${name}`,
    "",
    connectorBoundary,
    connectorSecrets,
    `Sharing: ${connectorSharing}.`,
    "Activation: none. Connection setup: separately authorised. Access grants created: none.",
    `Type: ${view.type}.`,
    `Source: ${view.scope.source}.`,
    `Direction: ${view.direction}.`,
    `Stable identifiers: ${view.stableIds.map(item => item.externalId).join(", ")}.`,
    `Field mappings: ${view.mappings.map(item => `${item.externalField} -> ${item.field}`).join(", ")}.`,
    `Secret store: ${view.secret.store}. Value hidden.`,
    `Edge: ${view.edge.cache}. Residency: ${view.edge.residency}.`,
    `Retry bound: ${view.retry.bound}.`,
    ...lines,
  ].join("\n");
}
