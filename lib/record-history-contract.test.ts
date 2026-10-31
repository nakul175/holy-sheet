import { expect, it } from "vitest";
import {
  acceptedHistoryPage,
  acceptedHistoryPreview,
  acceptedHistoryRestore,
  historyApplyBody,
  historyPreviewBody,
  historyRestoreNeedsReview,
  restorableHistoryFields,
} from "./record-history-contract";

const recordId = "00000000-0000-4000-8000-0000000000a1";
const eventId = "00000000-0000-4000-8000-0000000000e1";
const operationId = "00000000-0000-4000-8000-0000000000e2";
const previewId = "00000000-0000-4000-8000-0000000000e3";
const notes = "core:notes";
const attachment = "00000000-0000-4000-8000-0000000000f1";
const hash = "ab".repeat(32);
const secret = "Private historical note";
const event = {
  id: eventId,
  version: 2,
  actorId: "actor-1",
  sourceApp: "holy-sheet",
  serviceSubject: null,
  operationId,
  kind: "update",
  batchId: "00000000-0000-4000-8000-0000000000b1",
  sourceRow: 4,
  at: "2026-10-31T00:00:00.000Z",
  before: { name: "Before", values: { [notes]: "Old note" } },
  after: { name: "After", values: { [notes]: secret } },
};

it("accepts an anchored history page and drops relationship snapshots", () => {
  const page = acceptedHistoryPage({ anchorVersion: 8, nextCursor: "a".repeat(43), events: [event], parentOrganisationId: secret });
  expect(page).toMatchObject({ anchorVersion: 8, nextCursor: "a".repeat(43), events: [event] });
  expect(JSON.stringify(page)).not.toContain("parentOrganisationId");
  expect(acceptedHistoryPage({ ...page, events: [{ ...event, before: { name: "Before", values: {}, parentOrganisationId: recordId } }] })).toBeNull();
  expect(acceptedHistoryPage({ anchorVersion: 8, nextCursor: "short", events: [] })).toBeNull();
  expect(acceptedHistoryPage({ anchorVersion: 8, nextCursor: null, events: [{ ...event, before: { name: "Before" } }] })).toBeNull();
});

it("offers name and current writable history fields, never attachment or record references", () => {
  const fields = [
    { key: notes, label: "Notes", kind: "long-text", canWrite: true, canHistory: true },
    { key: attachment, label: "Brief", kind: "attachment", canWrite: true, canHistory: true },
    { key: "core:email", label: "Email", kind: "email", canWrite: true, canHistory: false },
    { key: "core:locked", label: "Locked", kind: "text", canWrite: false, canHistory: true },
  ];
  const snapshot = { name: "After", values: { [notes]: secret, [attachment]: [recordId], "core:email": "a@example.org", "missing": "old" } };
  expect(restorableHistoryFields(fields, snapshot).map((field) => field.key)).toEqual(["name", notes]);
  expect(restorableHistoryFields(fields, null)).toEqual([]);
  const body = historyPreviewBody({ eventId, side: "before", fields: ["name", notes], expectedVersion: 4, allowedFields: ["name", notes] });
  expect(body).toEqual({ kind: "preview", eventId, side: "before", fields: ["name", notes], expectedVersion: 4 });
  expect(body).not.toHaveProperty("values");
  expect(historyPreviewBody({ eventId, side: "after", fields: [attachment], expectedVersion: 4, allowedFields: ["name", notes] })).toBeNull();
  expect(historyPreviewBody({ eventId, side: "after", fields: ["name", "name"], expectedVersion: 4, allowedFields: ["name"] })).toBeNull();
  expect(historyPreviewBody({ eventId, side: "after", fields: [], expectedVersion: 4, allowedFields: ["name"] })).toBeNull();
});

it("accepts a pinned review of the requested fields and an idempotent apply", () => {
  const request = { kind: "preview" as const, eventId, side: "after" as const, fields: ["name", notes], expectedVersion: 4 };
  const raw = {
    previewId,
    reviewHash: hash,
    recordId,
    expectedVersion: 4,
    sourceVersion: 2,
    side: "after",
    fields: ["name", notes],
    before: { name: "Current", values: { [notes]: "Now" } },
    after: { name: "Before", values: { [notes]: secret } },
    values: { [notes]: "typed replacement" },
  };
  const preview = acceptedHistoryPreview(raw, request, recordId);
  expect(preview?.after.values).toEqual({ [notes]: secret });
  expect(JSON.stringify(preview)).not.toContain("typed replacement");
  expect(acceptedHistoryPreview({ ...raw, after: { name: "Before", values: { [notes]: secret, submitted: "forged" } } }, request, recordId)).toBeNull();
  expect(acceptedHistoryPreview({ ...raw, fields: [notes, "name"] }, request, recordId)).toBeNull();
  const apply = historyApplyBody({ previewId, reviewHash: hash, operationId });
  expect(apply).toEqual({ kind: "apply", previewId, reviewHash: hash, operationId, confirm: "restore-selected-values" });
  expect(apply).not.toHaveProperty("values");
  expect(acceptedHistoryRestore({ appliedVersion: 5, replayed: false, record: { id: recordId, name: secret } }, recordId)).toEqual({ appliedVersion: 5, replayed: false });
  expect(acceptedHistoryRestore({ appliedVersion: 5, replayed: false, record: { id: eventId } }, recordId)).toBeNull();
  expect(historyRestoreNeedsReview("record_history_conflict")).toBe(true);
  expect(historyRestoreNeedsReview("service_unavailable")).toBe(false);
});
