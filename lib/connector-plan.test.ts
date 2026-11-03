import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  compileConnector,
  connectorReport,
  effectiveRights,
  planMerge,
  planSyncBatch,
  publicConnector,
  type ConnectorDefinition,
  type LedgerRow,
} from "./connector-plan";

const visible = "00000000-0000-4000-8000-00000000f301";
const north = "00000000-0000-4000-8000-00000000f305";
const secretField = "00000000-0000-4000-8000-00000000f201";

function definition(extra: Record<string, unknown> = {}): ConnectorDefinition {
  return compileConnector({
    type: "records",
    scope: { source: "clinic-source", collection: "organisations", recordIds: [visible, north] },
    direction: "read-write",
    stableIds: [{ externalId: "ext-clinic", recordId: visible }, { externalId: "ext-north", recordId: north }],
    mappings: [{ externalField: "notes", field: "core:notes" }, { externalField: "salary", field: secretField }],
    secretRef: "suite-secret:clinic-sync",
    edge: { cache: "no-store", residency: "tenant", public: false },
    retry: { bound: 3 },
    ...extra,
  });
}

const item = { externalId: "ext-clinic", externalField: "notes", value: "Visible note", externalVersion: 1, tombstone: false, canonicalVersion: 1 };

it("registers an approved type, scope, stable mappings, and direction", () => {
  const compiled = definition();
  expect(compiled.type).toBe("records");
  expect(compiled.scope).toEqual({ source: "clinic-source", collection: "organisations", recordIds: [visible, north] });
  expect(compiled.direction).toBe("read-write");
  expect(compiled.stableIds.map(row => row.externalId)).toEqual(["ext-clinic", "ext-north"]);
  expect(compiled.mappings.every(row => row.stable)).toBe(true);
  expect(publicConnector(compiled).secret).toEqual({ store: "suite-secret-store", present: true, visible: false });
  expect(JSON.stringify(publicConnector(compiled))).not.toContain("suite-secret:clinic-sync");
  expect(connectorReport(compiled, "Clinic", [])).toContain("Value hidden");
  expect(connectorReport(compiled, "Clinic", [])).not.toContain("suite-secret:");
  expect(() => definition({ type: "mailbox" })).toThrow(/check the connector/i);
  expect(() => definition({ edge: { cache: "public", residency: "tenant", public: true } })).toThrow(/no-store/i);
  expect(() => definition({ password: "hs-secret:super-secret-value" })).toThrow(/secret/i);
  expect(() => compileConnector({
    type: "records",
    scope: { source: "clinic-source", collection: "organisations", recordIds: [visible] },
    direction: "read",
    stableIds: [{ externalId: "ext-clinic", recordId: visible }],
    mappings: [{ externalField: "notes", field: "core:notes" }],
    secretRef: "hs-secret:super-secret-value",
    edge: { cache: "no-store", residency: "tenant", public: false },
    retry: { bound: 3 },
  })).toThrow(/secret/i);
});

it("delegates only rights the subject already holds", () => {
  expect(effectiveRights({ kind: "user", live: { view: true, write: true, history: false }, fieldOwned: true })).toEqual({ view: true, write: true, history: false, fieldOwned: true, accessGranted: false });
  expect(effectiveRights({ kind: "user", live: { view: true, write: true, history: true }, fieldOwned: false }).write).toBe(false);
  expect(effectiveRights({ kind: "app", live: { view: true, write: true, history: true }, fieldOwned: true })).toEqual({ view: false, write: false, history: false, fieldOwned: true, accessGranted: false });
});

it("dedupes, reviews conflicts, tombstones, merges, and bounds retries without canonical writes", () => {
  const initial = planSyncBatch({
    status: "enabled", direction: "read-write", mode: "initial", checkpoint: null, storedCheckpoint: null, generation: 0,
    items: [item, { ...item }], ledger: [], canonical: [{ externalId: "ext-clinic", externalField: "notes", version: 1, value: "Visible note" }], bound: 3, failed: false,
  });
  expect(initial.ok).toBe(true);
  expect(initial.effects).toHaveLength(1);
  expect(initial.effects[0]).toMatchObject({ state: "proposed", value: "Visible note", deduped: true, overwritten: false, insert: true });
  expect(initial.checkpoint).toBe("cp-1");
  expect(initial.canonicalPreserved).toBe(true);
  const prior: LedgerRow = { externalId: "ext-clinic", externalField: "notes", value: "Visible note", proposedValue: null, externalVersion: 1, canonicalVersion: 1, state: "proposed", attempts: 0, mergedInto: null };
  const conflict = planSyncBatch({
    status: "enabled", direction: "read-write", mode: "incremental", checkpoint: "cp-1", storedCheckpoint: "cp-1", generation: 1,
    items: [{ ...item, value: "Changed note", externalVersion: 2 }], ledger: [prior], canonical: [{ externalId: "ext-clinic", externalField: "notes", version: 1, value: "Visible note" }], bound: 3, failed: false,
  });
  expect(conflict.effects[0]).toMatchObject({ state: "conflict", value: "Visible note", proposedValue: "Changed note", overwritten: false });
  expect(planSyncBatch({
    status: "paused", direction: "read-write", mode: "incremental", checkpoint: "cp-1", storedCheckpoint: "cp-1", generation: 1,
    items: [item], ledger: [prior], canonical: [], bound: 3, failed: false,
  })).toMatchObject({ ok: false, code: "connector_writes_stopped", canonicalPreserved: true, effects: [] });
  const tombstone = planSyncBatch({
    status: "enabled", direction: "read-write", mode: "incremental", checkpoint: "cp-2", storedCheckpoint: "cp-2", generation: 2,
    items: [{ ...item, tombstone: true, externalVersion: 3 }], ledger: [{ ...prior, state: "conflict", proposedValue: "Changed note" }], canonical: [], bound: 3, failed: false,
  });
  expect(tombstone.effects[0]).toMatchObject({ state: "tombstone", value: "Visible note", overwritten: false });
  expect(planMerge({ row: { ...prior, state: "tombstone" }, decision: "merge", survivorExternalId: "ext-north", canonicalValue: "Visible note" })).toMatchObject({ ok: true, state: "merged", value: "Visible note", mergedInto: "ext-north", canonicalMutated: false, overwritten: false });
  expect(planMerge({ row: { ...prior, state: "conflict", proposedValue: "Changed note" }, decision: "accept-external", survivorExternalId: null, canonicalValue: "Visible note" })).toMatchObject({ value: "Changed note", canonicalMutated: false });
  const failed = (attempts: number) => planSyncBatch({
    status: "enabled", direction: "read-write", mode: "incremental", checkpoint: "cp-2", storedCheckpoint: "cp-2", generation: 2,
    items: [item], ledger: [{ ...prior, attempts }], canonical: [], bound: 3, failed: true,
  });
  expect(failed(2).effects[0]).toMatchObject({ state: "failed", attempts: 3, value: "Visible note" });
  expect(failed(3)).toMatchObject({ ok: false, code: "connector_retry_bound" });
  expect(planSyncBatch({
    status: "enabled", direction: "read-write", mode: "incremental", checkpoint: "cp-other", storedCheckpoint: "cp-2", generation: 2,
    items: [item], ledger: [prior], canonical: [], bound: 3, failed: false,
  }).code).toBe("connector_checkpoint");
  const sql = readFileSync("db/134_governed_connectors.sql", "utf8").replace(/--.*$/gm, "");
  expect(sql).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(sql).not.toMatch(/parent_organisation_id/);
  expect(sql).not.toMatch(/release\.py/);
});
