import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessVerification,
  knowledgeVerificationAssignment,
  knowledgeVerificationBoundary,
  knowledgeVerificationStatement,
  knowledgeVerificationTitleOnly,
  knowledgeVerificationTitleOnlyPolicy,
  pageFingerprint,
  recordFingerprint,
  verificationBasis,
  verificationDocument,
  verificationExpiryDays,
  verificationProjection,
  verificationReason,
} from "./knowledge-verification-plan";

const now = new Date("2026-11-03T12:00:00.000Z");
const later = new Date("2026-12-03T12:00:00.000Z");
const attested = pageFingerprint("Clinic handbook", { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1", pageId: "welcome" }, content: [{ type: "text", text: "Hours" }] }] });

describe("N67 verification rules", () => {
  it("accepts an owner basis and an expiry of 1–365 days", () => {
    expect(verificationExpiryDays(1)).toBe(1);
    expect(verificationExpiryDays(365)).toBe(365);
    expect(() => verificationExpiryDays(0)).toThrow(/1–365/);
    expect(() => verificationExpiryDays(366)).toThrow(/1–365/);
    expect(verificationBasis("source-reviewed", ["source-reviewed"])).toBe("source-reviewed");
    expect(() => verificationBasis("guessed", ["source-reviewed"])).toThrow(/basis/);
    expect(knowledgeVerificationBoundary).toContain("not an AI truth score");
    expect(knowledgeVerificationBoundary).toContain("not a legal certification");
    expect(knowledgeVerificationStatement).toContain("Not an AI truth score");
  });

  it("keeps a title-only change current and marks content or source changes stale", () => {
    const same = pageFingerprint("Clinic handbook", { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1", pageId: "welcome" }, content: [{ type: "text", text: "Hours" }] }] });
    expect(assessVerification({ attested, live: same, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" }).status).toBe("current");
    const titled = pageFingerprint("Renamed handbook", { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1", pageId: "welcome" }, content: [{ type: "text", text: "Hours" }] }] });
    const titleOnly = assessVerification({ attested, live: titled, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" });
    expect(titleOnly).toMatchObject({ status: "current", reason: "title-only", titleChanged: true, titleOnlyPolicy: "preserve" });
    expect(knowledgeVerificationTitleOnly).toContain("title-only change keeps the badge current");
    expect(knowledgeVerificationTitleOnlyPolicy).toBe("preserve");
    const rewritten = pageFingerprint("Clinic handbook", { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1", pageId: "welcome" }, content: [{ type: "text", text: "Changed hours" }] }] });
    expect(assessVerification({ attested, live: rewritten, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" }).reason).toBe("content-changed");
    const sourced = pageFingerprint("Clinic handbook", { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1", pageId: "other" }, content: [{ type: "text", text: "Hours" }] }] });
    expect(assessVerification({ attested, live: sourced, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" }).reason).toBe("source-changed");
    const both = pageFingerprint("Clinic handbook", { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1", pageId: "other" }, content: [{ type: "text", text: "Changed" }] }] });
    expect(assessVerification({ attested, live: both, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" }).reason).toBe("content-and-source-changed");
    expect(assessVerification({ attested, live: same, storedStatus: "current", expiresAt: later, now, titleOnly: "invalidate" }).reason).toBe("title-policy-unknown");
    expect(assessVerification({ attested, live: null, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" }).reason).toBe("unpublished");
    expect(assessVerification({ attested, live: same, storedStatus: "revoked", expiresAt: later, now, titleOnly: "preserve" }).status).toBe("revoked");
    expect(assessVerification({ attested, live: same, storedStatus: "current", expiresAt: now, now, titleOnly: "preserve" }).status).toBe("expired");
  });

  it("shows a badge only when content and verification metadata are both permitted", () => {
    const badge = { status: "current" };
    expect(verificationProjection({ contentPermitted: true, metadataPermitted: true, badge })).toEqual({ include: true, badge });
    expect(verificationProjection({ contentPermitted: true, metadataPermitted: false, badge })).toEqual({ include: true, badge: null });
    expect(verificationProjection({ contentPermitted: false, metadataPermitted: true, badge }).include).toBe(false);
    expect(verificationProjection({ contentPermitted: false, metadataPermitted: false, badge }).badge).toBeNull();
    const record = recordFingerprint("North", { "core:notes": "original", "source:dossier": "file-a" }, ["wiki:page:1"]);
    const renamed = recordFingerprint("South", { "core:notes": "original", "source:dossier": "file-a" }, ["wiki:page:1"]);
    const edited = recordFingerprint("North", { "core:notes": "edited", "source:dossier": "file-a" }, ["wiki:page:1"]);
    const resourced = recordFingerprint("North", { "core:notes": "original", "source:dossier": "file-b" }, ["wiki:page:1"]);
    expect(assessVerification({ attested: record, live: renamed, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" }).status).toBe("current");
    expect(assessVerification({ attested: record, live: edited, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" }).reason).toBe("content-changed");
    expect(assessVerification({ attested: record, live: resourced, storedStatus: "current", expiresAt: later, now, titleOnly: "preserve" }).reason).toBe("source-changed");
  });

  it("uses the synthetic staging fixture and states that assignment is not access", () => {
    const fixture = JSON.parse(readFileSync("fixtures/knowledge-verification/staging.json", "utf8")) as { synthetic: boolean; expiryDays: number; titleOnlyPolicy: string; note: string };
    expect(fixture.synthetic).toBe(true);
    expect(fixture.expiryDays).toBeGreaterThanOrEqual(1);
    expect(fixture.expiryDays).toBeLessThanOrEqual(365);
    expect(fixture.titleOnlyPolicy).toBe("preserve");
    expect(fixture.note).toContain("does not grant access");
    expect(knowledgeVerificationAssignment).toContain("does not grant access");
    expect(verificationReason("The hours disagree with the source.")).toContain("hours");
    expect(verificationDocument({
      kind: "page", title: "Clinic handbook", status: "Verified", owner: "Ada", basis: "source-reviewed",
      basisNote: "Read the source", expiresAt: later.toISOString(), revision: 2, titleChanged: false, reason: null,
    })).toContain("Not a legal certification");
  });
});
