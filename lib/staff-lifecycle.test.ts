import { expect, it } from "vitest";
import {
  claimAccessRevoked,
  completeHandoverAllowed,
  directoryNote,
  handoverLink,
  lifecycleStates,
  normaliseChecklist,
  openingDates,
  presentLifecycleHistory,
  sameOperation,
  staffLifecycleAccess,
  stateStep,
  transitionDates,
} from "./staff-lifecycle";

const item = { id: "00000000-0000-4000-8000-000000000091", phase: "onboarding" as const, title: "Return badge", dueOn: "2026-05-01", ownerUserId: "ada", done: false };

it("keeps planned, start, active, leaving, and left as separate steps with dates and owners", () => {
  expect(new Set(lifecycleStates).size).toBe(5);
  expect(stateStep("planned", "start")).toBe(true);
  expect(stateStep("start", "active")).toBe(true);
  expect(stateStep("active", "leaving")).toBe(true);
  expect(stateStep("leaving", "left")).toBe(true);
  expect(stateStep("planned", "active")).toBe(false);
  expect(stateStep("planned", "left")).toBe(false);
  expect(stateStep("left", "active")).toBe(false);
  const opened = openingDates("2026-04-01");
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  expect(transitionDates("start", opened.dates, "2026-02-31").ok).toBe(false);
  const started = transitionDates("start", opened.dates, "2026-05-01");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  expect(transitionDates("active", started.dates, null).ok).toBe(true);
  const leaving = transitionDates("leaving", { ...started.dates, startOn: "2026-05-01" }, "2026-04-15");
  expect(leaving.ok).toBe(false);
  expect(normaliseChecklist([item]).ok).toBe(true);
  expect(normaliseChecklist([{ ...item, dueOn: "2026-02-31" }]).ok).toBe(false);
  expect(normaliseChecklist([{ ...item, title: "   ", dueOn: "2026-05-01" }]).ok).toBe(false);
  expect(normaliseChecklist([{ ...item, ownerUserId: "" }]).ok).toBe(false);
});

it("links account responsibilities and a recipient without transferring access or login credentials", () => {
  expect(handoverLink({ accountIds: ["account-1"], recipientUserId: "bea" })).toEqual({
    accountIds: ["account-1"],
    recipientUserId: "bea",
    accessTransferred: false,
    credentialsTransferred: false,
    loginChanged: false,
    responsibilityMoved: false,
  });
});

it("blocks a misleading complete handover until outstanding exceptions are acknowledged", () => {
  const open = { recipientUserId: "bea", outstandingCount: 2, exceptionsAcknowledged: false, exceptionNote: null, acknowledgementRequired: true, state: "leaving" as const };
  expect(completeHandoverAllowed(open)).toMatchObject({ ok: false, code: "handover_outstanding" });
  expect(completeHandoverAllowed({ ...open, state: "active" }).code).toBe("handover_state");
  expect(completeHandoverAllowed({ ...open, recipientUserId: null }).code).toBe("handover_recipient");
  expect(completeHandoverAllowed({ ...open, exceptionsAcknowledged: true, exceptionNote: null }).ok).toBe(false);
  const acknowledged = completeHandoverAllowed({ ...open, exceptionsAcknowledged: true, exceptionNote: "Badge and approval remain open." });
  expect(acknowledged).toMatchObject({ ok: true, cleanHandover: false, accessTransferred: false, credentialsTransferred: false, accessRevoked: false, loginChanged: false });
  expect(completeHandoverAllowed({ ...open, outstandingCount: 0, exceptionsAcknowledged: false })).toMatchObject({ ok: true, cleanHandover: true, accessTransferred: false });
  expect(directoryNote).toContain("does not provision");
});

it("separates HR history from identity evidence and does not claim access revoked without evidence", () => {
  expect(claimAccessRevoked({ evidenceClass: "hr-record", observedAccessRevoked: true })).toMatchObject({ ok: true, accessRevoked: false, evidenceClass: "hr-record", source: "holy-sheet" });
  expect(claimAccessRevoked({ evidenceClass: "identity-evidence", observedAccessRevoked: true, evidenceReference: "  " })).toMatchObject({ ok: false, code: "access_revoked_without_evidence" });
  expect(claimAccessRevoked({ evidenceClass: "identity-evidence", observedAccessRevoked: true, evidenceReference: "idp-evt-3154" })).toMatchObject({ ok: true, accessRevoked: true, evidenceClass: "identity-evidence" });
  const history = presentLifecycleHistory([
    { version: 1, kind: "transition", state: "left", evidenceClass: "hr-record", evidenceReference: null, observedAccessRevoked: true, source: "holy-sheet", actorId: "ada", operationId: "op-1", at: "2026-11-01T12:00:00.000Z" },
    { version: 2, kind: "identity-evidence", state: "left", evidenceClass: "identity-evidence", evidenceReference: "idp-evt-3154", observedAccessRevoked: true, source: "directory-idp", actorId: "ada", operationId: "op-2", at: "2026-11-01T12:05:00.000Z" },
  ]);
  expect(history[0]).toMatchObject({ evidenceClass: "hr-record", accessRevoked: false, revocationClaim: "hr-record", source: "holy-sheet", evidenceReference: null });
  expect(history[1]).toMatchObject({ evidenceClass: "identity-evidence", accessRevoked: true, revocationClaim: "identity-evidence", source: "directory-idp", evidenceReference: "idp-evt-3154" });
});

it("does not let configuration or assignment grant view, search, history, or download", () => {
  const assignment = { canMaintain: true, canHandover: true, canRecordEvidence: true };
  expect(staffLifecycleAccess({ recordCapabilities: ["manage-staff-lifecycle"], assignment, canViewRecords: false })).toMatchObject({ canConfigure: true, canAssign: true, canView: false, canSearch: false, canMaintain: false, canExport: false, canHistory: false, canPreview: false, accessTransferred: false, credentialsTransferred: false });
  expect(staffLifecycleAccess({ recordCapabilities: ["view"], assignment, canViewRecords: true })).toMatchObject({ canView: true, canSearch: true, canMaintain: false, canLink: false, canComplete: false, canRecordEvidence: false });
  expect(staffLifecycleAccess({ recordCapabilities: ["view", "edit", "link", "review", "export", "history"], assignment, canViewRecords: true })).toMatchObject({ canMaintain: true, canLink: true, canComplete: true, canRecordEvidence: true, canExport: true, canHistory: true });
});

it("replays an identical operation and rejects a reused operation with different fields", () => {
  const result = { appliedVersion: 2, accessTransferred: false };
  expect(sameOperation(null, "hash-a")).toEqual({ status: "apply" });
  expect(sameOperation({ requestHash: "hash-a", result }, "hash-a")).toEqual({ status: "replay", result });
  expect(sameOperation({ requestHash: "hash-a", result }, "hash-b").status).toBe("mismatch");
});
