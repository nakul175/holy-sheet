import { expect, it } from "vitest";
import {
  approvalAllowed,
  changeStatuses,
  contractChangeAccess,
  createsCycle,
  effectuateAllowed,
  explicitRenewalDecision,
  noCommitmentNote,
  parseProposedEnd,
  renewalDecisionView,
  statusStep,
} from "./contract-changes";

const now = new Date("2026-11-01T12:00:00.000Z");

it("rejects circular chains and accepts a forward successor", () => {
  const chain = [
    { parentId: "a", successorId: "b" },
    { parentId: "b", successorId: "c" },
  ];
  expect(createsCycle(chain, "c", "a")).toBe(true);
  expect(createsCycle([{ parentId: "a", successorId: "b" }], "b", "a")).toBe(true);
  expect(createsCycle([], "a", "a")).toBe(true);
  expect(createsCycle(chain, "c", "d")).toBe(false);
});

it("keeps draft, proposed, approved, and effective as separate steps", () => {
  expect(new Set(changeStatuses).size).toBe(4);
  expect(statusStep("draft", "proposed")).toBe(true);
  expect(statusStep("draft", "approved")).toBe(false);
  expect(statusStep("draft", "effective")).toBe(false);
  expect(statusStep("proposed", "approved")).toBe(true);
  expect(statusStep("proposed", "effective")).toBe(false);
  expect(statusStep("approved", "effective")).toBe(true);
  expect(statusStep("effective", "draft")).toBe(false);
  expect(approvalAllowed({ reviewRequired: true, proposerId: "ada", approverId: "ada" }).ok).toBe(false);
  expect(approvalAllowed({ reviewRequired: true, proposerId: "ada", approverId: "bea" }).ok).toBe(true);
  expect(approvalAllowed({ reviewRequired: false, proposerId: "ada", approverId: "ada" }).ok).toBe(true);
  expect(effectuateAllowed("proposed", new Date("2026-01-01T00:00:00Z"), now).ok).toBe(false);
  expect(effectuateAllowed("approved", new Date("2027-01-01T00:00:00Z"), now)).toMatchObject({ ok: false, code: "change_not_due" });
  expect(effectuateAllowed("approved", new Date("2026-01-01T00:00:00Z"), now).ok).toBe(true);
});

it("does not treat configuration, assignment, a date, or a decision as a legal commitment", () => {
  const assignment = { canPropose: true, canApprove: true, canEffectuate: true, canDecide: true };
  expect(contractChangeAccess({ recordCapabilities: ["manage-contract-changes"], assignment: null, canViewRecords: false })).toMatchObject({ canConfigure: true, canView: false, canPropose: false, canExport: false, canHistory: false, legalCommitment: false });
  expect(contractChangeAccess({ recordCapabilities: ["view"], assignment, canViewRecords: true })).toMatchObject({ canView: true, canPropose: false, canApprove: false, canEffectuate: false });
  expect(contractChangeAccess({ recordCapabilities: ["view", "edit", "link", "review", "export", "history"], assignment, canViewRecords: true })).toMatchObject({ canPropose: true, canApprove: true, canEffectuate: true, canDecide: true, canExport: true, canHistory: true });
  expect(explicitRenewalDecision("renew", null).ok).toBe(false);
  expect(explicitRenewalDecision("undecided", null).ok).toBe(true);
  expect(parseProposedEnd("2028-02-31").ok).toBe(false);
  expect(parseProposedEnd("2028-01-01")).toMatchObject({ ok: true, end: "2028-01-01" });
  const view = renewalDecisionView({ kind: "renewal", status: "approved", decision: "undecided", responsibleUserId: null, originalEnd: "2026-12-31", currentEnd: "2026-12-31", proposedEnd: "2028-01-01", effectiveStart: "2027-01-01T00:00:00.000Z" });
  expect(view).toMatchObject({ legalCommitment: false, commitsRenewal: false, responsibility: { userId: null, explicit: true, assigned: false }, decision: { value: "undecided", explicit: true } });
  expect(view.note).toBe(noCommitmentNote);
});
