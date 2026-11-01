import { expect, it } from "vitest";
import {
  classifyIdentifierWrite,
  externalIdentifierAccess,
  identifierPayloadHasCredential,
  parseExternalIdentifier,
  planMergeIdentifierRedirect,
  type ExternalIdentifierSnapshot,
} from "./external-identifier-mapping";

const existing: ExternalIdentifierSnapshot = { id: "mapping-1", namespace: "billing.app", externalId: "cust-1", recordId: "record-a", originalRecordId: "record-origin", state: "active", version: 3 };
const write = { namespace: existing.namespace, externalId: existing.externalId, provenanceLabel: "billing import", recordId: "record-b" };

it("keeps namespace, tenant scope and external ID unique until an explicit review", () => {
  expect(classifyIdentifierWrite(null, { ...write, recordId: "record-a" })).toEqual({ action: "create" });
  expect(classifyIdentifierWrite(existing, { ...write, recordId: "record-a" })).toEqual({ action: "unchanged" });
  expect(classifyIdentifierWrite(existing, write)).toEqual({ action: "conflict", mappingId: "mapping-1", recordId: "record-a", state: "active", version: 3 });
  expect(classifyIdentifierWrite({ ...existing, state: "archived" }, { ...write, recordId: "record-a" }).action).toBe("conflict");
  expect(classifyIdentifierWrite({ ...existing, state: "deleted" }, write).action).toBe("conflict");
});

it("reassigns only when the review names the current mapping and version", () => {
  const reassign = { decision: "reassign" as const, mappingId: existing.id, version: existing.version, confirm: "reassign-external-identifier" as const };
  expect(classifyIdentifierWrite(existing, { ...write, review: reassign })).toEqual({ action: "reassign", mappingId: existing.id, fromRecordId: "record-a", toRecordId: "record-b", version: 3 });
  expect(classifyIdentifierWrite(existing, { ...write, review: { ...reassign, decision: "keep", confirm: "keep-external-identifier" } })).toEqual({ action: "unchanged" });
  expect(classifyIdentifierWrite(existing, { ...write, review: { ...reassign, version: 2 } })).toEqual({ action: "reject", code: "review_stale" });
  expect(classifyIdentifierWrite(existing, { ...write, review: { ...reassign, confirm: "keep-external-identifier" } })).toEqual({ action: "reject", code: "review_unconfirmed" });
  expect(classifyIdentifierWrite(null, { ...write, review: reassign })).toEqual({ action: "reject", code: "review_not_applicable" });
});

it("redirects merged mappings to the survivor and preserves source identity and explicit state", () => {
  const archived: ExternalIdentifierSnapshot = { ...existing, id: "archived", state: "archived", version: 4, externalId: "ext-archived" };
  const deleted: ExternalIdentifierSnapshot = { ...existing, id: "deleted", state: "deleted", version: 2, externalId: "ext-deleted", originalRecordId: "record-origin" };
  const survivor: ExternalIdentifierSnapshot = { ...existing, id: "survivor", recordId: "record-b", externalId: "ext-survivor" };
  const plan = planMergeIdentifierRedirect([archived, deleted, survivor], "record-a", "record-b");
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.redirects.map((row) => row.id)).toEqual(["archived", "deleted"]);
  expect(plan.redirects[0]).toMatchObject({ externalId: "ext-archived", originalRecordId: "record-origin", state: "archived", recordId: "record-b", redirectedFromRecordId: "record-a", version: 5 });
  expect(plan.redirects[1]).toMatchObject({ externalId: "ext-deleted", state: "deleted", originalRecordId: "record-origin", recordId: "record-b" });
  expect(planMergeIdentifierRedirect([existing], "record-a", "record-a").ok).toBe(false);
});

it("treats an integration grant as metadata access and never as record access", () => {
  const grant = { canRead: true, canWrite: true, canExport: true, canHistory: true };
  expect(externalIdentifierAccess({ recordCapabilities: ["manage-external-ids", "edit", "export", "history"], integration: grant })).toEqual({ canRead: false, canWrite: false, canExport: false, canHistory: false });
  expect(externalIdentifierAccess({ recordCapabilities: ["view", "edit", "manage-external-ids", "export", "history"], integration: null }).canWrite).toBe(false);
  expect(externalIdentifierAccess({ recordCapabilities: ["view", "edit", "export", "history"], integration: grant }).canWrite).toBe(false);
  expect(externalIdentifierAccess({ recordCapabilities: ["view", "edit", "manage-external-ids", "export", "history"], integration: grant })).toMatchObject({ canRead: true, canWrite: true, canExport: true, canHistory: true });
});

it("bounds malformed identifiers and rejects credential material", () => {
  expect(parseExternalIdentifier({ namespace: "billing.app", externalId: "cust-1", provenanceLabel: "billing import" })).toMatchObject({ ok: true, namespace: "billing.app", externalId: "cust-1" });
  expect(parseExternalIdentifier({ namespace: "Billing", externalId: "cust-1" }).ok).toBe(false);
  expect(parseExternalIdentifier({ namespace: "billing", externalId: " cust-1 " }).ok).toBe(false);
  expect(parseExternalIdentifier({ namespace: "billing", externalId: "a".repeat(201) }).ok).toBe(false);
  expect(parseExternalIdentifier({ namespace: "billing", externalId: "api_key=live" }).ok).toBe(false);
  expect(parseExternalIdentifier({ namespace: "token", externalId: "cust-1" }).ok).toBe(false);
  expect(parseExternalIdentifier({ namespace: "billing", externalId: "secretary" }).ok).toBe(true);
  expect(identifierPayloadHasCredential({ password: "hunter2" })).toBe(true);
  expect(identifierPayloadHasCredential({ externalId: "Bearer live-token" })).toBe(true);
  expect(identifierPayloadHasCredential({ externalId: "cust-1" })).toBe(false);
});
