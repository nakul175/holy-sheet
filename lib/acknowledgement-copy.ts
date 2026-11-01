export const CANNOT_ASSIGN_REASON = "Cannot be assigned — no access";
export const LOST_ACCESS_LABEL = "Lost access";
export const SHORT_ACKNOWLEDGEMENT_CHARS = 1200;
export const ACK_WAIT_SECONDS = 30;

export function acknowledgementBannerCopy(versionLabel: string) {
  return `Please read and acknowledge ${versionLabel}`;
}

export function acknowledgementVersionLabel(versionNumber: number) {
  return `v${versionNumber}`;
}

export type AcknowledgementGate = "ready" | "confirm" | "read";

export function acknowledgementAllowed(input: { confirm: boolean; reachedEnd: boolean; shortDocument: boolean; waitedSeconds: number }): AcknowledgementGate {
  if (!input.confirm) return "confirm";
  if (input.reachedEnd || (input.shortDocument && input.waitedSeconds >= ACK_WAIT_SECONDS)) return "ready";
  return "read";
}

export type AcknowledgementStatus = "pending" | "overdue" | "acknowledged" | "lost_access";

export function acknowledgementStatusLabel(status: AcknowledgementStatus) {
  if (status === "lost_access") return LOST_ACCESS_LABEL;
  if (status === "overdue") return "Overdue";
  if (status === "acknowledged") return "Acknowledged";
  return "Pending";
}

export type AcknowledgementCsvRow = { name: string; status: string; versionLabel: string; acknowledgedAtIst: string };

function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function acknowledgementCsv(rows: AcknowledgementCsvRow[]) {
  const lines = ["name,status,version,acknowledged_at_ist", ...rows.map(row => [row.name, row.status, row.versionLabel, row.acknowledgedAtIst].map(csvCell).join(","))];
  return `${lines.join("\n")}\n`;
}

export type AcknowledgementRoleId = "workspace:owner" | "workspace:admin" | "workspace:member" | "workspace:observer" | "space:leader" | "space:editor" | "space:viewer";

export type AudienceTarget =
  | { kind: "user"; id: string }
  | { kind: "group"; id: string }
  | { kind: "role"; id: AcknowledgementRoleId }
  | { kind: "space"; id: string };

export type AcknowledgementBanner = {
  campaignId: string;
  versionId: string;
  versionLabel: string;
  shortDocument: boolean;
  status: "pending" | "acknowledged";
  acknowledgedAtIst: string | null;
  copy: string;
};

export type AcknowledgementAssignment = {
  userId: string;
  name: string;
  status: AcknowledgementStatus;
  statusLabel: string;
  versionLabel: string;
  acknowledgedAt: string | null;
  acknowledgedAtIst: string | null;
};

export type AcknowledgementExcluded = { userId: string; name: string | null; reason: string };

export type AcknowledgementAudienceChoices = {
  users: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  roles: { id: AcknowledgementRoleId; label: string }[];
  space: { id: string; name: string } | null;
};

export type AcknowledgementOwnerView = {
  scope: "owner";
  publication: { versionId: string; versionLabel: string; bump: "major" | "minor" } | null;
  audienceChoices: AcknowledgementAudienceChoices;
  campaign: {
    id: string;
    status: "active" | "paused" | "superseded";
    paused: boolean;
    versionId: string;
    versionLabel: string;
    dueAt: string;
    dueAtIst: string;
    completion: { acknowledged: number; assigned: number; label: string };
    retainedRecords: number;
  } | null;
  assignments: AcknowledgementAssignment[];
  excluded: AcknowledgementExcluded[];
  banner: AcknowledgementBanner | null;
};

export type AcknowledgementReaderView = { scope: "reader"; banner: AcknowledgementBanner | null };

export type AcknowledgementView = AcknowledgementOwnerView | AcknowledgementReaderView;

export const acknowledgementRoles: AcknowledgementAudienceChoices["roles"] = [
  { id: "workspace:owner", label: "Workspace owners" },
  { id: "workspace:admin", label: "Workspace administrators" },
  { id: "workspace:member", label: "Workspace members" },
  { id: "workspace:observer", label: "Workspace observers" },
  { id: "space:leader", label: "Space leaders" },
  { id: "space:editor", label: "Space editors" },
  { id: "space:viewer", label: "Space viewers" },
];
