import { stableStringify } from "./document";
import { DocumentError } from "./document";
import { recordHash } from "./shared-record-types";

export const knowledgeVerificationSource = "knowledge-verification";
export const knowledgeVerificationBoundary = "Verification is a steward attestation of one published revision. It is not an AI truth score and it is not a legal certification.";
export const knowledgeVerificationAssignment = "Configuring verification or naming a steward does not grant access to a page, record, collection, or field.";
export const knowledgeVerificationTitleOnly = "A title-only change keeps the badge current. A change to the body or to the recorded source marks the badge stale.";
export const knowledgeVerificationTitleOnlyPolicy = "preserve" as const;
export const knowledgeVerificationSchedules = "Existing schedules stay paused. Verification does not activate a schedule.";
export const knowledgeVerificationRecoverable = "A recoverable draft is kept when the version changes.";
export const knowledgeVerificationStatement = "Steward attestation of one published revision. Not an AI truth score. Not a legal certification.";
export const knowledgeVerificationExpiry = { min: 1, max: 365 } as const;
export const knowledgeVerificationBases = ["source-reviewed", "owner-confirmed", "steward-attested"] as const;
export const knowledgeVerificationActions = ["verify", "renew", "revoke", "report", "download", "history", "configure"] as const;
export const knowledgeVerificationLimits = { basisNote: 240, reason: 500, bases: 8, query: 80, excerpt: 180 } as const;

export type VerificationBasis = (typeof knowledgeVerificationBases)[number];
export type VerificationAction = (typeof knowledgeVerificationActions)[number];
export type VerificationStatus = "current" | "stale" | "revoked" | "expired";
export type StoredVerificationStatus = "current" | "stale" | "revoked";
export type Fingerprint = { titleHash: string; contentHash: string; sourceHash: string };
export type VerificationAssessment = {
  status: VerificationStatus;
  reason: string | null;
  titleChanged: boolean;
  material: boolean;
  titleOnlyPolicy: typeof knowledgeVerificationTitleOnlyPolicy;
};

const control = /[\p{Cc}]/u;
const sourceAttrs = new Set(["pageId", "attachmentId", "sourceId"]);

const invalid = () => new DocumentError("Check the verification request.", "knowledge_verification_validation", 422);

export function verificationExpiryDays(value: number) {
  if (!Number.isInteger(value) || value < knowledgeVerificationExpiry.min || value > knowledgeVerificationExpiry.max) {
    throw new DocumentError("Enter an expiry of 1–365 days.", "knowledge_verification_expiry", 422);
  }
  return value;
}

export function verificationBasis(value: string, allowed: readonly string[]) {
  const basis = value.trim();
  if (!knowledgeVerificationBases.includes(basis as VerificationBasis) || !allowed.includes(basis)) {
    throw new DocumentError("Choose a verification basis.", "knowledge_verification_basis", 422);
  }
  return basis as VerificationBasis;
}

export function verificationBases(values: readonly string[]) {
  if (values.length < 1 || values.length > knowledgeVerificationLimits.bases) throw invalid();
  const next: VerificationBasis[] = [];
  for (const value of values) {
    const basis = verificationBasis(value, knowledgeVerificationBases);
    if (next.includes(basis)) throw invalid();
    next.push(basis);
  }
  return next;
}

export function verificationNote(value: string) {
  const note = value.trim().normalize("NFC");
  if (!note || Array.from(note).length > knowledgeVerificationLimits.basisNote || control.test(note)) {
    throw new DocumentError("Enter a basis note of 1–240 characters.", "knowledge_verification_basis", 422);
  }
  return note;
}

export function verificationReason(value: string) {
  const reason = value.trim().normalize("NFC");
  if (!reason || Array.from(reason).length > knowledgeVerificationLimits.reason || control.test(reason)) {
    throw new DocumentError("Enter a reason of 1–500 characters.", "knowledge_verification_reason", 422);
  }
  return reason;
}

export function verificationQuery(value: string) {
  const query = value.trim().toLocaleLowerCase();
  if (!query || Array.from(query).length > knowledgeVerificationLimits.query || control.test(query)) throw invalid();
  return query;
}

export function assertTitleOnlyPolicy(value: unknown) {
  if (value !== knowledgeVerificationTitleOnlyPolicy) {
    throw new DocumentError(knowledgeVerificationTitleOnly, "knowledge_verification_title", 422);
  }
  return knowledgeVerificationTitleOnlyPolicy;
}

function sourceKey(key: string) {
  return key === "core:source" || key.startsWith("source:");
}

export function stripSourceAttrs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSourceAttrs);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "attrs" && item && typeof item === "object" && !Array.isArray(item)) {
      const attrs: Record<string, unknown> = {};
      for (const [attr, attrValue] of Object.entries(item as Record<string, unknown>)) {
        if (!sourceAttrs.has(attr)) attrs[attr] = attrValue;
      }
      if (Object.keys(attrs).length) next.attrs = attrs;
      continue;
    }
    next[key] = stripSourceAttrs(item);
  }
  return next;
}

export function collectDocumentSources(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const attrs = (node as { attrs?: Record<string, unknown> }).attrs ?? {};
    if (typeof attrs.pageId === "string" && attrs.pageId) found.push(`page:${attrs.pageId}`);
    if (typeof attrs.attachmentId === "string" && attrs.attachmentId) found.push(`attachment:${attrs.attachmentId}`);
    if (typeof attrs.sourceId === "string" && attrs.sourceId) found.push(`source:${attrs.sourceId}`);
    visit((node as { content?: unknown }).content);
  };
  visit(value);
  return [...new Set(found)].sort();
}

export function pageFingerprint(title: string, document: unknown): Fingerprint {
  return {
    titleHash: recordHash(title.trim().normalize("NFC")),
    contentHash: recordHash(stripSourceAttrs(document)),
    sourceHash: recordHash(collectDocumentSources(document)),
  };
}

export function recordFingerprint(name: string, fields: Record<string, unknown>, references: readonly string[]): Fingerprint {
  const content: Record<string, unknown> = {};
  const sources = references.map(item => `ref:${item}`);
  for (const [key, value] of Object.entries(fields)) {
    if (sourceKey(key)) sources.push(`field:${key}:${stableStringify(value)}`);
    else content[key] = value;
  }
  return {
    titleHash: recordHash(name.trim().normalize("NFC")),
    contentHash: recordHash(content),
    sourceHash: recordHash(sources.sort()),
  };
}

export function assessVerification(input: {
  attested: Fingerprint;
  live: Fingerprint | null;
  storedStatus: StoredVerificationStatus;
  expiresAt: Date;
  now: Date;
  titleOnly: string;
}): VerificationAssessment {
  const policy = knowledgeVerificationTitleOnlyPolicy;
  if (input.storedStatus === "revoked") {
    return { status: "revoked", reason: "revoked", titleChanged: false, material: false, titleOnlyPolicy: policy };
  }
  if (!input.live) {
    return { status: "stale", reason: "unpublished", titleChanged: false, material: true, titleOnlyPolicy: policy };
  }
  const titleChanged = input.attested.titleHash !== input.live.titleHash;
  const contentChanged = input.attested.contentHash !== input.live.contentHash;
  const sourceChanged = input.attested.sourceHash !== input.live.sourceHash;
  if (input.titleOnly !== policy) {
    return { status: "stale", reason: "title-policy-unknown", titleChanged, material: true, titleOnlyPolicy: policy };
  }
  if (contentChanged && sourceChanged) {
    return { status: "stale", reason: "content-and-source-changed", titleChanged, material: true, titleOnlyPolicy: policy };
  }
  if (contentChanged) return { status: "stale", reason: "content-changed", titleChanged, material: true, titleOnlyPolicy: policy };
  if (sourceChanged) return { status: "stale", reason: "source-changed", titleChanged, material: true, titleOnlyPolicy: policy };
  if (input.expiresAt.getTime() <= input.now.getTime()) {
    return { status: "expired", reason: "expiry", titleChanged, material: false, titleOnlyPolicy: policy };
  }
  return { status: "current", reason: titleChanged ? "title-only" : null, titleChanged, material: false, titleOnlyPolicy: policy };
}

export function verificationLabel(status: VerificationStatus) {
  if (status === "current") return "Verified";
  if (status === "stale") return "Stale";
  if (status === "expired") return "Expired";
  return "Revoked";
}

/** Badge metadata is returned only when both the content and the verification field are permitted. */
export function verificationProjection<T>(input: { contentPermitted: boolean; metadataPermitted: boolean; badge: T | null }) {
  if (!input.contentPermitted) return { include: false, badge: null as T | null };
  if (!input.metadataPermitted || !input.badge) return { include: true, badge: null as T | null };
  return { include: true, badge: input.badge };
}

export function textExcerpt(value: unknown, limit = knowledgeVerificationLimits.excerpt) {
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as { text?: unknown; content?: unknown };
    if (typeof record.text === "string") parts.push(record.text);
    visit(record.content);
  };
  visit(value);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function verificationDocument(input: {
  kind: "page" | "record";
  title: string;
  status: string;
  owner: string;
  basis: string;
  basisNote: string;
  expiresAt: string;
  revision: number;
  titleChanged: boolean;
  reason: string | null;
}) {
  const lines = [
    "# Knowledge verification",
    "",
    knowledgeVerificationStatement,
    knowledgeVerificationTitleOnly,
    knowledgeVerificationAssignment,
    "",
    `${input.kind === "page" ? "Page" : "Record"}: ${input.title}`,
    `Status: ${input.status}`,
    `Owner: ${input.owner}`,
    `Basis: ${input.basis}`,
    `Basis note: ${input.basisNote}`,
    `Expiry: ${input.expiresAt}`,
    `Published revision: ${input.revision}`,
    `Title changed: ${input.titleChanged ? "yes" : "no"}`,
    `Title-only policy: ${knowledgeVerificationTitleOnlyPolicy}`,
  ];
  if (input.reason) lines.push(`Scope note: ${input.reason}`);
  return lines.join("\n");
}
