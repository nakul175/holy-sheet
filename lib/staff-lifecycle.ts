/** Employee onboarding and offboarding.
 * Directory lifecycle is an HR record. It does not provision an account or transfer login credentials.
 */

import { z } from "zod";

export const lifecycleStates = ["planned", "start", "active", "leaving", "left"] as const;
export type LifecycleState = (typeof lifecycleStates)[number];
export const checklistPhases = ["onboarding", "offboarding"] as const;
export type ChecklistPhase = (typeof checklistPhases)[number];
export const directoryNote = "Directory lifecycle is an HR record for this employee. It does not provision or deprovision an account, transfer access or login credentials, run payroll, or record an employment decision.";

export const checklistItemSchema = z.object({
  id: z.string().uuid(),
  phase: z.enum(checklistPhases),
  title: z.string().min(1).max(200),
  dueOn: z.string().min(10).max(10),
  ownerUserId: z.string().min(1).max(200),
  done: z.boolean(),
}).strict();

export type ChecklistItem = {
  id: string;
  phase: ChecklistPhase;
  title: string;
  dueOn: string;
  ownerUserId: string;
  done: boolean;
};

export type LifecycleDates = {
  plannedOn: string | null;
  startOn: string | null;
  leavingOn: string | null;
  leftOn: string | null;
};

export type StaffAssignment = {
  canMaintain: boolean;
  canHandover: boolean;
  canRecordEvidence: boolean;
};

export type HistoryEvent = {
  version: number;
  kind: string;
  state: LifecycleState;
  evidenceClass: "hr-record" | "identity-evidence";
  evidenceReference: string | null;
  observedAccessRevoked: boolean;
  source: string;
  actorId: string;
  operationId: string;
  at: string | null;
};

const dateOrder = ["plannedOn", "startOn", "leavingOn", "leftOn"] as const;

export function stateStep(from: LifecycleState, to: LifecycleState) {
  return lifecycleStates.indexOf(to) === lifecycleStates.indexOf(from) + 1;
}

export function parseDay(value: string | null | undefined) {
  if (value === undefined || value === null || value.trim() === "") return { ok: true as const, day: null };
  const day = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false as const, message: "Enter the date as YYYY-MM-DD." };
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return { ok: false as const, message: "Enter a real date." };
  return { ok: true as const, day };
}

function ordered(dates: LifecycleDates) {
  const present = dateOrder.map((key) => dates[key]).filter((day): day is string => !!day);
  for (let index = 1; index < present.length; index += 1) if (present[index]! < present[index - 1]!) return false;
  return true;
}

export function openingDates(plannedOn: string) {
  const parsed = parseDay(plannedOn);
  if (!parsed.ok || !parsed.day) return { ok: false as const, message: "Enter the planned date." };
  return { ok: true as const, dates: { plannedOn: parsed.day, startOn: null, leavingOn: null, leftOn: null } };
}

export function transitionDates(to: LifecycleState, dates: LifecycleDates, supplied: string | null) {
  if (to === "planned") return { ok: false as const, message: "Planned is the opening state." };
  const next: LifecycleDates = { ...dates };
  if (to === "start" || to === "leaving" || to === "left") {
    const parsed = parseDay(supplied);
    if (!parsed.ok || !parsed.day) return { ok: false as const, message: to === "start" ? "Enter the start date." : to === "leaving" ? "Enter the leaving date." : "Enter the left date." };
    if (to === "start") next.startOn = parsed.day;
    if (to === "leaving") next.leavingOn = parsed.day;
    if (to === "left") next.leftOn = parsed.day;
  }
  if (to === "active" && !next.startOn) return { ok: false as const, message: "A start date is required before active." };
  if (!next.plannedOn) return { ok: false as const, message: "A planned date is required." };
  if (!ordered(next)) return { ok: false as const, message: "Keep planned, start, leaving, and left dates in order." };
  return { ok: true as const, dates: next };
}

export function normaliseChecklist(value: unknown) {
  const parsed = z.array(checklistItemSchema).max(50).safeParse(value);
  if (!parsed.success) return { ok: false as const, message: "Review the checklist. Each item needs a date and a responsible owner." };
  const items: ChecklistItem[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data) {
    if (seen.has(item.id)) return { ok: false as const, message: "A checklist item was listed twice." };
    seen.add(item.id);
    const title = item.title.trim().normalize("NFC");
    if (!title || [...title].length > 200) return { ok: false as const, message: "Enter a checklist title." };
    const due = parseDay(item.dueOn);
    if (!due.ok || !due.day) return { ok: false as const, message: "Enter a real due date for each checklist item." };
    items.push({ id: item.id, phase: item.phase, title, dueOn: due.day, ownerUserId: item.ownerUserId, done: item.done });
  }
  return { ok: true as const, items };
}

export function normaliseAccountIds(ids: readonly string[]) {
  if (ids.length > 50) return { ok: false as const, message: "Link at most 50 accounts." };
  if (new Set(ids).size !== ids.length) return { ok: false as const, message: "An account was listed twice." };
  return { ok: true as const, accountIds: [...ids] };
}

export function handoverLink(input: { accountIds: readonly string[]; recipientUserId: string | null }) {
  return {
    accountIds: [...input.accountIds],
    recipientUserId: input.recipientUserId,
    accessTransferred: false as const,
    credentialsTransferred: false as const,
    loginChanged: false as const,
    responsibilityMoved: false as const,
  };
}

export function completeHandoverAllowed(input: {
  recipientUserId: string | null;
  outstandingCount: number;
  exceptionsAcknowledged: boolean;
  exceptionNote: string | null;
  acknowledgementRequired: boolean;
  state: LifecycleState;
}) {
  if (input.state !== "leaving" && input.state !== "left") {
    return { ok: false as const, code: "handover_state" as const, message: "Record the handover when the person is leaving or has left. Earlier states stay open." };
  }
  if (!input.recipientUserId) {
    return { ok: false as const, code: "handover_recipient" as const, message: "Name the handover recipient. Naming them does not transfer access or login credentials." };
  }
  if (input.outstandingCount > 0 && !input.exceptionsAcknowledged) {
    return { ok: false as const, code: "handover_outstanding" as const, message: "Outstanding owned records or approvals are still open. Acknowledge those exceptions before recording a complete handover." };
  }
  const note = input.exceptionNote?.trim() ?? "";
  if (input.outstandingCount > 0 && input.acknowledgementRequired && !note) {
    return { ok: false as const, code: "handover_outstanding" as const, message: "Name the exceptions you are acknowledging. A complete handover does not hide them." };
  }
  if ([...note].length > 500) return { ok: false as const, code: "handover_outstanding" as const, message: "Keep the exception note to 500 characters." };
  return {
    ok: true as const,
    cleanHandover: input.outstandingCount === 0,
    exceptionNote: note || null,
    accessTransferred: false as const,
    credentialsTransferred: false as const,
    accessRevoked: false as const,
    loginChanged: false as const,
  };
}

export function externalSource(value: string) {
  const source = value.trim();
  if (!source || [...source].length > 80 || source.toLowerCase() === "holy-sheet") {
    return { ok: false as const, message: "Name the external identity service. An HR record is not identity-service evidence." };
  }
  return { ok: true as const, source };
}

export function claimAccessRevoked(input: {
  evidenceClass: "hr-record" | "identity-evidence";
  evidenceReference?: string | null;
  observedAccessRevoked?: boolean;
}) {
  if (input.evidenceClass === "hr-record") {
    return { ok: true as const, accessRevoked: false as const, evidenceClass: "hr-record" as const, source: "holy-sheet" as const };
  }
  const reference = input.evidenceReference?.trim() ?? "";
  if (!reference || [...reference].length > 200) {
    return { ok: false as const, code: "access_revoked_without_evidence" as const, message: "Access revoked is not claimed without identity-service evidence." };
  }
  return {
    ok: true as const,
    accessRevoked: input.observedAccessRevoked === true,
    evidenceClass: "identity-evidence" as const,
    evidenceReference: reference,
  };
}

export function presentLifecycleHistory(events: readonly HistoryEvent[]) {
  return events.map((event) => {
    const claim = claimAccessRevoked({
      evidenceClass: event.evidenceClass,
      evidenceReference: event.evidenceReference,
      observedAccessRevoked: event.observedAccessRevoked,
    });
    const accessRevoked = claim.ok ? claim.accessRevoked : false;
    const revocationClaim = !claim.ok
      ? "withheld-without-evidence" as const
      : claim.evidenceClass === "hr-record"
        ? "hr-record" as const
        : accessRevoked
          ? "identity-evidence" as const
          : "not-observed" as const;
    return {
      version: event.version,
      kind: event.kind,
      state: event.state,
      evidenceClass: event.evidenceClass,
      evidenceReference: event.evidenceClass === "hr-record" || !claim.ok ? null : claim.evidenceReference,
      source: event.evidenceClass === "hr-record" ? "holy-sheet" : event.source,
      actorId: event.actorId,
      operationId: event.operationId,
      at: event.at,
      accessRevoked,
      revocationClaim,
    };
  });
}

export function staffLifecycleAccess(input: {
  recordCapabilities: readonly string[];
  assignment: StaffAssignment | null;
  canViewRecords: boolean;
}) {
  const caps = new Set(input.recordCapabilities);
  const view = input.canViewRecords && caps.has("view");
  const assignment = input.assignment;
  return {
    canView: view,
    canSearch: view,
    canMaintain: view && caps.has("edit") && assignment?.canMaintain === true,
    canLink: view && caps.has("link") && assignment?.canHandover === true,
    canComplete: view && caps.has("edit") && caps.has("review") && assignment?.canHandover === true,
    canRecordEvidence: view && caps.has("edit") && assignment?.canRecordEvidence === true,
    canConfigure: caps.has("manage-staff-lifecycle"),
    canAssign: caps.has("manage-staff-lifecycle"),
    canHistory: view && caps.has("history"),
    canExport: view && caps.has("export"),
    canPreview: view,
    accessTransferred: false as const,
    credentialsTransferred: false as const,
    provisionsAccount: false as const,
  };
}

export function sameOperation(prior: { requestHash: string; result: unknown } | null, requestHash: string) {
  if (!prior) return { status: "apply" as const };
  if (prior.requestHash !== requestHash) return { status: "mismatch" as const };
  return { status: "replay" as const, result: prior.result };
}
