export const bundleLimits = { name: 100, description: 2000, members: 100, retentionDays: 90 } as const;

export type BundleMode = "live" | "pinned";
export type StoredMember = { pageId: string; mode: BundleMode; pinnedVersion: number | null };
export type PackageAvailability = "ready" | "unpublished" | "missing";
export type PackageRetention = "clear" | "held" | "elapsed";

export function modeLabel(mode: BundleMode, pinnedVersion: number | null, frozenVersion?: number | null) {
  const base = mode === "live" ? "Live — latest published" : `Pinned to published revision ${pinnedVersion ?? ""}`.trim();
  return frozenVersion ? `${base} · frozen at published revision ${frozenVersion}` : base;
}

export function mergeMembers(stored: StoredMember[], submitted: StoredMember[], readable: ReadonlySet<string>): { ok: true; members: StoredMember[] } | { ok: false; reason: "duplicate" | "unreadable" | "limit" } {
  const seen = new Set<string>();
  const next: StoredMember[] = [];
  for (const member of submitted) {
    if (seen.has(member.pageId)) return { ok: false, reason: "duplicate" };
    if (!readable.has(member.pageId)) return { ok: false, reason: "unreadable" };
    seen.add(member.pageId);
    next.push({ pageId: member.pageId, mode: member.mode, pinnedVersion: member.mode === "pinned" ? member.pinnedVersion : null });
  }
  for (const member of stored) {
    if (readable.has(member.pageId) || seen.has(member.pageId)) continue;
    seen.add(member.pageId);
    next.push(member);
  }
  if (next.length > bundleLimits.members) return { ok: false, reason: "limit" };
  return { ok: true, members: next };
}

export function packageDecision(input: { availability: PackageAvailability; exportRight: boolean; unavailableAssets: number; retention: PackageRetention }) {
  if (input.availability !== "ready") return { exportable: false, reason: input.availability };
  if (!input.exportRight) return { exportable: false, reason: "export-right" };
  if (input.unavailableAssets > 0) return { exportable: false, reason: "asset-unavailable" };
  if (input.retention === "held") return { exportable: false, reason: "retention-hold" };
  if (input.retention === "elapsed") return { exportable: false, reason: "retention-elapsed" };
  return { exportable: true, reason: "ready" };
}

export function bundleFilename(name: string, immutable: boolean) {
  const slug = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document-bundle";
  return `${slug}-${immutable ? "package" : "draft"}.md`;
}
