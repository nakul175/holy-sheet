/** Internal contract amendments, extensions, and renewals.
 * A date or status records a decision. It does not sign, execute, or commit a renewal.
 */

import { parseEffectiveInstant } from "./effective-dates";

export const changeKinds = ["amendment", "extension", "renewal"] as const;
export type ChangeKind = (typeof changeKinds)[number];
export const changeStatuses = ["draft", "proposed", "approved", "effective"] as const;
export type ChangeStatus = (typeof changeStatuses)[number];
export const renewalDecisions = ["undecided", "renew", "do-not-renew"] as const;
export type RenewalDecision = (typeof renewalDecisions)[number];
export const noCommitmentNote = "A date or status is an internal record only. It does not sign, execute, or commit a renewal.";

const forward: Record<ChangeStatus, ChangeStatus | null> = {
  draft: "proposed",
  proposed: "approved",
  approved: "effective",
  effective: null,
};

export type ChangeEdge = { parentId: string; successorId: string };
export type ChangeAssignment = { canPropose: boolean; canApprove: boolean; canEffectuate: boolean; canDecide: boolean };

export function statusStep(from: ChangeStatus, to: ChangeStatus) {
  return forward[from] === to;
}

/** Original points at the successor. The new edge cycles when the successor can already reach the original. */
export function createsCycle(edges: readonly ChangeEdge[], parentId: string, successorId: string) {
  if (!parentId || !successorId || parentId === successorId) return true;
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const list = next.get(edge.parentId);
    if (list) list.push(edge.successorId);
    else next.set(edge.parentId, [edge.successorId]);
  }
  const seen = new Set<string>();
  const stack = [successorId];
  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const child of next.get(current) ?? []) {
      if (child === parentId) return true;
      stack.push(child);
    }
  }
  return false;
}

export function contractChangeAccess(input: {
  recordCapabilities: readonly string[];
  assignment: ChangeAssignment | null;
  canViewRecords: boolean;
}) {
  const caps = new Set(input.recordCapabilities);
  const view = input.canViewRecords && caps.has("view");
  const assignment = input.assignment;
  return {
    canView: view,
    canSearch: view,
    canPropose: view && caps.has("edit") && caps.has("link") && assignment?.canPropose === true,
    canApprove: view && caps.has("review") && assignment?.canApprove === true,
    canEffectuate: view && caps.has("edit") && assignment?.canEffectuate === true,
    canDecide: view && caps.has("edit") && assignment?.canDecide === true,
    canConfigure: caps.has("manage-contract-changes"),
    canAssign: caps.has("manage-contract-changes"),
    canHistory: view && caps.has("history"),
    canExport: view && caps.has("export"),
    legalCommitment: false as const,
    commitsRenewal: false as const,
  };
}

export function approvalAllowed(input: { reviewRequired: boolean; proposerId: string; approverId: string }) {
  if (input.reviewRequired && input.proposerId === input.approverId) {
    return { ok: false as const, message: "Configured review requires a different reviewer." };
  }
  return { ok: true as const };
}

export function effectuateAllowed(status: ChangeStatus, effectiveStart: Date, now: Date) {
  if (status !== "approved") return { ok: false as const, code: "change_status" as const, message: "Only an approved change can become effective." };
  if (effectiveStart.getTime() > now.getTime()) return { ok: false as const, code: "change_not_due" as const, message: "The effective date has not been reached. The change stays approved and does not commit a renewal." };
  return { ok: true as const };
}

export function explicitRenewalDecision(decision: RenewalDecision, responsibleUserId: string | null) {
  if ((decision === "renew" || decision === "do-not-renew") && !responsibleUserId) {
    return { ok: false as const, message: "Name the person responsible for this renewal decision." };
  }
  return { ok: true as const };
}

export function parseProposedEnd(value: string | null | undefined) {
  if (value === undefined || value === null || value.trim() === "") return { ok: true as const, end: null };
  const end = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return { ok: false as const, message: "Enter the proposed end date as YYYY-MM-DD. It does not commit a renewal." };
  const parsed = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== end) return { ok: false as const, message: "Enter a real proposed end date." };
  return { ok: true as const, end };
}

export function parseChangeInstant(value: string, timezone: string) {
  return parseEffectiveInstant(value, timezone);
}

export function renewalDecisionView(input: {
  kind: ChangeKind;
  status: ChangeStatus;
  decision: RenewalDecision;
  responsibleUserId: string | null;
  originalEnd: string | null;
  currentEnd: string | null;
  proposedEnd: string | null;
  effectiveStart: string | null;
}) {
  return {
    kind: input.kind,
    status: input.status,
    originalEnd: input.originalEnd,
    currentEnd: input.currentEnd,
    proposedEnd: input.proposedEnd,
    effectiveStart: input.effectiveStart,
    responsibility: { userId: input.responsibleUserId, explicit: true as const, assigned: input.responsibleUserId !== null },
    decision: { value: input.decision, explicit: true as const },
    legalCommitment: false as const,
    commitsRenewal: false as const,
    note: noCommitmentNote,
  };
}
