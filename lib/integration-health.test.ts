import { expect, it } from "vitest";
import {
  classifyCanonicalReference,
  classifyExtraReference,
  classifyObservedRecord,
  classifyReferenceLedger,
  classifyRepair,
  classifyVisibleEvent,
  failureTransition,
  integrationAttemptLimit,
  integrationHealthAccess,
  nextBackoffSeconds,
  parseConsumerIdentity,
  parseObservations,
  queueAgeSeconds,
  redactIntegrationText,
  repairChoices,
  retryAllowed,
} from "./integration-health";

const record = "00000000-0000-4000-8000-000000000011";
const grant = { canRead: true, canReconcile: true, canRepair: true, canExport: true, canHistory: true };

it("classifies acknowledgement, version, reference, and poison mismatches", () => {
  expect(classifyVisibleEvent({ sequence: 4, acknowledgedSequence: 2, deliveryState: null })).toBe("unacknowledged");
  expect(classifyVisibleEvent({ sequence: 2, acknowledgedSequence: 2, deliveryState: "failed" })).toBeNull();
  expect(classifyVisibleEvent({ sequence: 8, acknowledgedSequence: 1, deliveryState: "poison" })).toBe("poison");
  expect(classifyObservedRecord({ found: false, canonicalVersion: null, observedVersion: 1 })).toBe("unknown-record");
  expect(classifyObservedRecord({ found: true, canonicalVersion: 3, observedVersion: 1 })).toBe("version-lag");
  expect(classifyObservedRecord({ found: true, canonicalVersion: 3, observedVersion: 5 })).toBe("version-ahead");
  expect(classifyObservedRecord({ found: true, canonicalVersion: 3, observedVersion: 3 })).toBeNull();
  expect(classifyCanonicalReference({ recordId: record, sourceType: "project", sourceId: "p-1", version: 2 }, undefined)).toBe("missing-reference");
  expect(classifyCanonicalReference({ recordId: record, sourceType: "project", sourceId: "p-1", version: 2 }, { recordId: record, sourceType: "project", sourceId: "p-1", version: 1 })).toBe("reference-version");
  expect(classifyExtraReference(undefined)).toBe("extra-reference");
  expect(classifyReferenceLedger(
    [{ recordId: record, sourceType: "project", sourceId: "p-1", version: 3 }],
    [{ recordId: record, sourceType: "project", sourceId: "p-extra", version: 1 }],
  ).map((item) => item.class).sort()).toEqual(["extra-reference", "missing-reference"]);
});

it("rejects destructive repairs and keeps poison isolated", () => {
  expect(repairChoices("version-ahead").map((choice) => choice.decision)).toEqual(["keep-canonical"]);
  expect(repairChoices("extra-reference").map((choice) => choice.decision)).toEqual(["keep-canonical"]);
  expect(repairChoices("poison").map((choice) => choice.decision)).toEqual(["keep-isolated"]);
  expect(classifyRepair("version-ahead", "overwrite-canonical")).toEqual({ ok: false, code: "repair_destructive" });
  expect(classifyRepair("extra-reference", "delete-reference")).toEqual({ ok: false, code: "repair_destructive" });
  expect(classifyRepair("poison", "retry-poison")).toEqual({ ok: false, code: "repair_destructive" });
  expect(classifyRepair("unknown-record", "create-record")).toEqual({ ok: false, code: "repair_destructive" });
  expect(classifyRepair("version-lag", "queue-replay").ok).toBe(true);
  expect(classifyRepair("missing-reference", "queue-reference-repair")).toMatchObject({ ok: true, effect: "reference-repair" });
});

it("applies backoff limits and redacts secrets without granting access", () => {
  expect(failureTransition(integrationAttemptLimit - 2).state).toBe("failed");
  expect(failureTransition(integrationAttemptLimit - 1)).toMatchObject({ state: "poison", attemptCount: integrationAttemptLimit });
  expect(nextBackoffSeconds(1)).toBe(2);
  expect(nextBackoffSeconds(20)).toBe(3600);
  const now = new Date("2026-11-01T12:00:00Z");
  const duringBackoff = retryAllowed({ state: "failed", attemptCount: 1, nextAttemptAt: "2026-11-01T12:05:00Z", outage: "none", now });
  const afterBackoff = retryAllowed({ state: "failed", attemptCount: 1, nextAttemptAt: "2026-11-01T11:00:00Z", outage: "none", now });
  const poison = retryAllowed({ state: "poison", attemptCount: 5, nextAttemptAt: null, outage: "partial", now });
  const isolated = retryAllowed({ state: "failed", attemptCount: 1, nextAttemptAt: null, outage: "isolated", now });
  expect(duringBackoff.ok).toBe(false);
  expect(afterBackoff.ok).toBe(true);
  expect(poison.ok).toBe(false);
  expect(isolated.ok).toBe(false);
  if (!poison.ok) expect(poison.code).toBe("integration_poison");
  if (!isolated.ok) expect(isolated.code).toBe("integration_isolated");
  expect(redactIntegrationText("api_key=hidden-field-secret")).toBe("[redacted]");
  expect(redactIntegrationText("bearer sk_live_secret")).toBe("[redacted]");
  expect(queueAgeSeconds("2026-11-01T11:58:00Z", now)).toBe(120);
  expect(parseConsumerIdentity({ clientId: "holy-sheet", label: "Native" }).ok).toBe(false);
  expect(parseConsumerIdentity({ clientId: "billing-app", label: "api_key=live" }).ok).toBe(false);
  expect(parseObservations({ records: [{ recordId: record, version: 1, name: "Secret" }] }).ok).toBe(false);
  expect(integrationHealthAccess({ recordCapabilities: ["view", "manage-integration-health", "export", "history"], grant: null }).canRead).toBe(false);
  expect(integrationHealthAccess({ recordCapabilities: ["manage-integration-health"], grant }).canRead).toBe(false);
  expect(integrationHealthAccess({ recordCapabilities: ["view", "export", "history"], grant }).canRepair).toBe(false);
  expect(integrationHealthAccess({ recordCapabilities: ["view", "manage-integration-health", "export", "history"], grant })).toMatchObject({ canRead: true, canReconcile: true, canRepair: true, canExport: true, canHistory: true });
});
