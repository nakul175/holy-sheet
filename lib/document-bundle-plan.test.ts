import { expect, it } from "vitest";
import { bundleFilename, mergeMembers, modeLabel, packageDecision, type StoredMember } from "./document-bundle-plan";

const live = (pageId: string): StoredMember => ({ pageId, mode: "live", pinnedVersion: null });
const pinned = (pageId: string, pinnedVersion: number): StoredMember => ({ pageId, mode: "pinned", pinnedVersion });

it("labels live and pinned modes and keeps an immutable freeze visible", () => {
  expect(modeLabel("live", null)).toBe("Live — latest published");
  expect(modeLabel("pinned", 3)).toBe("Pinned to published revision 3");
  expect(modeLabel("live", null, 2)).toBe("Live — latest published · frozen at published revision 2");
});

it("reorders documents the editor can read and preserves hidden references", () => {
  const stored = [live("visible-a"), live("hidden"), pinned("visible-b", 4)];
  const merged = mergeMembers(stored, [pinned("visible-b", 4), live("visible-c")], new Set(["visible-a", "visible-b", "visible-c"]));
  expect(merged).toEqual({ ok: true, members: [pinned("visible-b", 4), live("visible-c"), live("hidden")] });
  expect(mergeMembers(stored, [live("visible-a"), live("visible-a")], new Set(["visible-a"]))).toMatchObject({ ok: false, reason: "duplicate" });
  expect(mergeMembers(stored, [live("secret")], new Set())).toMatchObject({ ok: false, reason: "unreadable" });
});

it("blocks export when rights, assets, publication, or retention fail", () => {
  expect(packageDecision({ availability: "ready", exportRight: true, unavailableAssets: 0, retention: "clear" })).toEqual({ exportable: true, reason: "ready" });
  expect(packageDecision({ availability: "unpublished", exportRight: true, unavailableAssets: 0, retention: "clear" }).reason).toBe("unpublished");
  expect(packageDecision({ availability: "ready", exportRight: false, unavailableAssets: 0, retention: "clear" }).reason).toBe("export-right");
  expect(packageDecision({ availability: "ready", exportRight: true, unavailableAssets: 2, retention: "clear" }).reason).toBe("asset-unavailable");
  expect(packageDecision({ availability: "ready", exportRight: true, unavailableAssets: 0, retention: "held" }).reason).toBe("retention-hold");
  expect(packageDecision({ availability: "ready", exportRight: true, unavailableAssets: 0, retention: "elapsed" }).reason).toBe("retention-elapsed");
  expect(bundleFilename("Clinic packet", true)).toBe("clinic-packet-package.md");
});
