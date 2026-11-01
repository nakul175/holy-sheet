/** Integration health compares the version-one outbox and reference ledger.
 * It does not activate a consumer, store a credential, or grant record access.
 */

import { identifierPayloadHasCredential, looksLikeCredential } from "./external-identifier-mapping";

export const mismatchClasses = ["unacknowledged", "version-lag", "version-ahead", "unknown-record", "missing-reference", "extra-reference", "reference-version", "poison"] as const;
export type MismatchClass = (typeof mismatchClasses)[number];
export const repairDecisions = ["queue-replay", "keep-canonical", "queue-reference-repair", "keep-isolated"] as const;
export type RepairDecision = (typeof repairDecisions)[number];
export const deliveryStates = ["pending", "failed", "poison", "replay-queued", "repaired"] as const;
export type DeliveryState = (typeof deliveryStates)[number];
export const integrationAttemptLimit = 5;
export const integrationBackoffCapSeconds = 3600;
export const integrationPageBound = 25;
export const integrationScanWindow = 200;

const reservedClients = new Set(["holy-sheet", "holy-sheet-import", "holy-sheet-template", "holy-sheet-intake"]);
const clientPattern = /^[a-z][a-z0-9-]{0,63}$/;
const labelPattern = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,99}$/u;
const failureCodePattern = /^[a-z][a-z0-9-]{0,40}$/;
const destructiveDecisions = new Set(["overwrite", "overwrite-canonical", "accept-ahead", "delete", "delete-reference", "delete-canonical", "create-record", "retry-poison", "clear-poison"]);

export type ObservedRecord = { recordId: string; version: number };
export type ObservedReference = { recordId: string; sourceType: string; sourceId: string; version: number };
export type IntegrationGrant = { canRead: boolean; canReconcile: boolean; canRepair: boolean; canExport: boolean; canHistory: boolean };

export function integrationHealthAccess(input: { recordCapabilities: readonly string[]; grant: IntegrationGrant | null }) {
  const view = input.recordCapabilities.includes("view");
  const grant = input.grant;
  const canRead = view && grant?.canRead === true;
  return {
    canRead,
    canReconcile: canRead && input.recordCapabilities.includes("manage-integration-health") && grant?.canReconcile === true,
    canRepair: canRead && input.recordCapabilities.includes("manage-integration-health") && grant?.canRepair === true,
    canExport: canRead && input.recordCapabilities.includes("export") && grant?.canExport === true,
    canHistory: view && input.recordCapabilities.includes("history") && grant?.canHistory === true,
  };
}

export function parseConsumerIdentity(input: { clientId: unknown; label: unknown }) {
  if (identifierPayloadHasCredential(input)) return { ok: false as const, message: "A consumer cannot carry a credential or secret." };
  if (typeof input.clientId !== "string" || typeof input.label !== "string") return { ok: false as const, message: "Use a consumer id and label." };
  const clientId = input.clientId.normalize("NFC");
  const label = input.label.normalize("NFC").trim();
  if (clientId !== input.clientId || !clientPattern.test(clientId) || reservedClients.has(clientId) || looksLikeCredential(clientId)) {
    return { ok: false as const, message: "Use a paused consumer id without spaces, credentials, or a reserved Holy Sheet channel." };
  }
  if (label !== input.label.trim() || !labelPattern.test(label) || /[\p{Cc}]/u.test(label) || looksLikeCredential(label)) {
    return { ok: false as const, message: "Use a consumer label of 1–100 characters without control characters or credentials." };
  }
  return { ok: true as const, clientId, label };
}

export function redactIntegrationText(value: string) {
  const cleaned = value.normalize("NFC").replace(/[\p{Cc}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || looksLikeCredential(cleaned)) return "[redacted]";
  const redacted = cleaned
    .replace(/\b(bearer|basic)\s+\S+/gi, "[redacted]")
    .replace(/\b(api[_-]?key|password|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b(sk_live_|sk_test_|ghp_|xox[baprs]-|ya29\.)\S+/gi, "[redacted]");
  return Array.from(redacted).slice(0, 200).join("");
}

export function parseFailureReport(input: { failureCode: unknown; failureDetail: unknown }) {
  if (identifierPayloadHasCredential(input) && typeof input.failureCode === "string" && !failureCodePattern.test(input.failureCode)) {
    return { ok: false as const, message: "Review the delivery failure." };
  }
  if (typeof input.failureCode !== "string" || !failureCodePattern.test(input.failureCode)) return { ok: false as const, message: "Use a short failure code." };
  if (typeof input.failureDetail !== "string") return { ok: false as const, message: "Review the delivery failure." };
  return { ok: true as const, failureCode: input.failureCode, failureRedacted: redactIntegrationText(input.failureDetail) };
}

export function queueAgeSeconds(oldest: string | null, now: Date) {
  if (!oldest) return null;
  const then = new Date(oldest).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 1000));
}

export function nextBackoffSeconds(attemptCount: number) {
  const exponent = Math.min(Math.max(Math.floor(attemptCount), 1), 12);
  return Math.min(integrationBackoffCapSeconds, 2 ** exponent);
}

export function failureTransition(attemptCount: number) {
  const next = Math.max(0, Math.floor(attemptCount)) + 1;
  const state: "failed" | "poison" = next >= integrationAttemptLimit ? "poison" : "failed";
  return { state, attemptCount: next, backoffSeconds: nextBackoffSeconds(next) };
}

export function retryAllowed(input: { state: DeliveryState; attemptCount: number; nextAttemptAt: string | null; outage: "none" | "partial" | "isolated"; now: Date }) {
  if (input.outage === "isolated") return { ok: false as const, code: "integration_isolated" as const };
  if (input.state === "poison" || input.attemptCount >= integrationAttemptLimit) return { ok: false as const, code: "integration_poison" as const };
  if (input.state !== "failed") return { ok: false as const, code: "integration_retry_state" as const };
  if (input.nextAttemptAt && new Date(input.nextAttemptAt).getTime() > input.now.getTime()) return { ok: false as const, code: "integration_backoff" as const };
  return { ok: true as const };
}

export function replayAllowed(input: { state: DeliveryState | null; outage: "none" | "partial" | "isolated" }) {
  if (input.outage === "isolated") return { ok: false as const, code: "integration_isolated" as const };
  if (input.state === "poison") return { ok: false as const, code: "integration_poison" as const };
  return { ok: true as const };
}

export function classifyVisibleEvent(input: { sequence: number; acknowledgedSequence: number; deliveryState: DeliveryState | null }): MismatchClass | null {
  if (input.deliveryState === "poison") return "poison";
  if (input.sequence > input.acknowledgedSequence && input.deliveryState !== "repaired") return "unacknowledged";
  return null;
}

export function classifyObservedRecord(input: { found: boolean; canonicalVersion: number | null; observedVersion: number }): MismatchClass | null {
  if (!input.found || input.canonicalVersion === null) return "unknown-record";
  if (input.observedVersion < input.canonicalVersion) return "version-lag";
  if (input.observedVersion > input.canonicalVersion) return "version-ahead";
  return null;
}

export function referenceKey(input: { recordId: string; sourceType: string; sourceId: string }) {
  return `${input.recordId}:${input.sourceType}:${input.sourceId}`;
}

export function classifyCanonicalReference(canonical: ObservedReference, observed: ObservedReference | undefined): MismatchClass | null {
  if (!observed) return "missing-reference";
  if (observed.version !== canonical.version) return "reference-version";
  return null;
}

export function classifyExtraReference(canonical: ObservedReference | undefined): MismatchClass | null {
  return canonical ? null : "extra-reference";
}

export function classifyReferenceLedger(canonical: readonly ObservedReference[], observed: readonly ObservedReference[]) {
  const key = (item: ObservedReference) => referenceKey(item);
  const observedByKey = new Map(observed.map((item) => [key(item), item]));
  const canonicalByKey = new Map(canonical.map((item) => [key(item), item]));
  const mismatches: Array<{ class: MismatchClass; recordId: string; sourceType: string; sourceId: string; canonicalVersion: number | null; observedVersion: number | null }> = [];
  for (const item of canonical) {
    const match = observedByKey.get(key(item));
    const mismatch = classifyCanonicalReference(item, match);
    if (mismatch) mismatches.push({ class: mismatch, recordId: item.recordId, sourceType: item.sourceType, sourceId: item.sourceId, canonicalVersion: item.version, observedVersion: match?.version ?? null });
  }
  for (const item of observed) {
    if (classifyExtraReference(canonicalByKey.get(key(item)))) mismatches.push({ class: "extra-reference", recordId: item.recordId, sourceType: item.sourceType, sourceId: item.sourceId, canonicalVersion: null, observedVersion: item.version });
  }
  return mismatches;
}

export function repairChoices(mismatch: MismatchClass): ReadonlyArray<{ decision: RepairDecision; confirm: "repair-queue-replay" | "repair-keep-canonical" | "repair-reference" | "repair-keep-isolated"; label: string }> {
  switch (mismatch) {
    case "unacknowledged":
    case "version-lag":
      return [
        { decision: "queue-replay", confirm: "repair-queue-replay", label: "Queue a replay of the canonical change" },
        { decision: "keep-canonical", confirm: "repair-keep-canonical", label: "Keep the canonical record unchanged" },
      ];
    case "missing-reference":
    case "reference-version":
      return [
        { decision: "queue-reference-repair", confirm: "repair-reference", label: "Queue a reference repair without changing the canonical reference" },
        { decision: "keep-canonical", confirm: "repair-keep-canonical", label: "Keep the canonical reference unchanged" },
      ];
    case "version-ahead":
    case "unknown-record":
    case "extra-reference":
      return [{ decision: "keep-canonical", confirm: "repair-keep-canonical", label: "Keep canonical data unchanged" }];
    case "poison":
      return [{ decision: "keep-isolated", confirm: "repair-keep-isolated", label: "Keep this poison delivery isolated" }];
  }
}

export function classifyRepair(mismatch: MismatchClass, decision: string) {
  if (destructiveDecisions.has(decision)) return { ok: false as const, code: "repair_destructive" as const };
  const choice = repairChoices(mismatch).find((item) => item.decision === decision);
  if (!choice) return { ok: false as const, code: "repair_not_applicable" as const };
  const effect = decision === "queue-replay" ? "replay" as const : decision === "queue-reference-repair" ? "reference-repair" as const : decision === "keep-isolated" ? "isolate" as const : "hold" as const;
  return { ok: true as const, effect, confirm: choice.confirm, decision: choice.decision };
}

export function parseObservations(input: unknown) {
  if (input === undefined) return { ok: true as const, records: null, references: null };
  if (identifierPayloadHasCredential(input)) return { ok: false as const, message: "Reconciliation input cannot carry a credential or secret." };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false as const, message: "Review the reconciliation scope." };
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "records" && key !== "references")) return { ok: false as const, message: "Review the reconciliation scope." };
  const records = parseRecordObservations(body.records);
  const references = parseReferenceObservations(body.references);
  if (!records.ok || !references.ok) return { ok: false as const, message: "Review the reconciliation scope." };
  return { ok: true as const, records: records.value, references: references.value };
}

function parseRecordObservations(value: unknown) {
  if (value === undefined) return { ok: true as const, value: null };
  if (!Array.isArray(value) || value.length > 50) return { ok: false as const, value: null };
  const parsed: ObservedRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false as const, value: null };
    const record = item as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.recordId !== "string" || !/^[0-9a-f-]{36}$/i.test(record.recordId) || typeof record.version !== "number" || !Number.isInteger(record.version) || record.version < 1) return { ok: false as const, value: null };
    parsed.push({ recordId: record.recordId, version: record.version });
  }
  return { ok: true as const, value: parsed };
}

function parseReferenceObservations(value: unknown) {
  if (value === undefined) return { ok: true as const, value: null };
  if (!Array.isArray(value) || value.length > 50) return { ok: false as const, value: null };
  const parsed: ObservedReference[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false as const, value: null };
    const reference = item as Record<string, unknown>;
    if (Object.keys(reference).length !== 4 || typeof reference.recordId !== "string" || !/^[0-9a-f-]{36}$/i.test(reference.recordId) || typeof reference.sourceType !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(reference.sourceType) || typeof reference.sourceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(reference.sourceId) || typeof reference.version !== "number" || !Number.isInteger(reference.version) || reference.version < 1) return { ok: false as const, value: null };
    parsed.push({ recordId: reference.recordId, sourceType: reference.sourceType, sourceId: reference.sourceId, version: reference.version });
  }
  return { ok: true as const, value: parsed };
}

export function mismatchLabel(mismatch: MismatchClass) {
  switch (mismatch) {
    case "unacknowledged": return "The consumer has not acknowledged this change.";
    case "version-lag": return "The consumer is behind the canonical version.";
    case "version-ahead": return "The consumer reports a newer version than the canonical record. Canonical data is kept.";
    case "unknown-record": return "The reported record is not in this tenant.";
    case "missing-reference": return "The canonical reference is missing from the consumer ledger.";
    case "extra-reference": return "The consumer ledger has a reference that is not canonical. It is not deleted.";
    case "reference-version": return "The reference identity matches and the version differs. The canonical reference is kept.";
    case "poison": return "This delivery is isolated after repeated failures.";
  }
}
