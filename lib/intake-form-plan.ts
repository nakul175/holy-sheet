import { DocumentError, safeUrl } from "./document";

export const intakeSource = "intake-form";
export const intakeSharing = "off" as const;
export const intakeBoundary = "An intake form accepts allowlisted fields into a private queue. It does not open internal records.";
export const intakeAssignment = "Configuring a form, naming a manager, or assigning a queue does not grant access to a page, record, collection, or field.";
export const intakeAnonymousCopy = "Anonymous intake is optional only when an administrator sets an explicit policy. It is off by default.";
export const intakeActivation = "No external form is activated by this task. Sharing stays off and no live grant is created.";
export const intakeQuarantine = "Untrusted intake stays in quarantine until a permitted reviewer commits it. A matching name never overwrites a central record.";
export const intakeSchedules = "Existing schedules stay paused. Intake forms do not activate a schedule.";
export const intakeRecoverable = "A recoverable draft is kept when the version changes.";
export const intakeEdge = "Intake responses stay with the tenant and use cache no-store. Public caching is off.";
export const intakeReceiptText = "Received. This receipt does not confirm a record was created.";
export const intakeControlSize = 44;
export const intakeRateLimit = 5;
export const intakeAudiences = ["public", "guest"] as const;
export const intakeStatuses = ["draft", "disabled", "expired", "revoked"] as const;
export const intakeValueTypes = ["text", "email"] as const;
export const intakeFileTypes = ["pdf", "png", "txt"] as const;
export const intakeActorActions = ["configure", "search", "preview", "download", "history", "disable", "review", "commit", "policy", "receipt"] as const;
export const intakeLimits = { name: 80, fields: 12, text: 2000, fileName: 120, bytes: 200_000, queue: 41, consent: 2000, hours: 8760 } as const;
export const intakeMedia: Record<(typeof intakeFileTypes)[number], string> = {
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
};

export type IntakeAudience = (typeof intakeAudiences)[number];
export type IntakeStatus = (typeof intakeStatuses)[number];
export type IntakeValueType = (typeof intakeValueTypes)[number];
export type IntakeFileType = (typeof intakeFileTypes)[number];
export type IntakeActorAction = (typeof intakeActorActions)[number];
export type IntakeField = { key: string; type: IntakeValueType; required: boolean; maxLength: number };
export type IntakeConsent = { text: string; version: number };
export type IntakeDefinition = {
  collection: string;
  fields: IntakeField[];
  validation: { required: string[] };
  queue: { name: string; private: true };
  audience: IntakeAudience;
  anonymous: boolean;
  expiry: { hours: number };
  consent: IntakeConsent | null;
  limits: { bytes: number; types: IntakeFileType[] };
  edge: { cache: "no-store"; residency: "tenant"; public: false };
  bot: { required: true };
};

const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fieldPattern = /^(?:core:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const slugPattern = /^[a-z][a-z0-9-]{0,40}$/;
const invalid = () => new DocumentError("Check the form.", "intake_validation", 422);
const linkError = () => new DocumentError("That link is not allowed.", "intake_link", 422);

function text(value: unknown, limit: number) {
  if (typeof value !== "string") throw invalid();
  const next = value.trim().normalize("NFC");
  if (!next || Array.from(next).length > limit || control.test(next)) throw invalid();
  return next;
}
function unique<T>(values: T[], same: (left: T, right: T) => boolean) {
  const next: T[] = [];
  for (const value of values) {
    if (next.some(item => same(item, value))) throw invalid();
    next.push(value);
  }
  return next;
}
function sameKeys(left: string[], right: string[]) {
  const sort = (values: string[]) => values.map(value => value.toLowerCase()).sort();
  const a = sort(left);
  const b = sort(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function intakeName(value: string) {
  return text(value, intakeLimits.name);
}
export function intakeRecordName(value: string) {
  return text(value, intakeLimits.name);
}
export function intakeQuery(value: string) {
  const query = value.trim().toLocaleLowerCase();
  if (!query || Array.from(query).length > 80 || control.test(query)) throw invalid();
  return query;
}

export function compileIntakeForm(input: unknown): IntakeDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const source = input as Record<string, unknown>;
  const allowed = ["collection", "fields", "validation", "queue", "audience", "anonymous", "expiry", "consent", "limits", "edge", "bot"];
  if (Object.keys(source).some(key => !allowed.includes(key))) throw invalid();
  const collection = text(source.collection, 41);
  if (!slugPattern.test(collection)) throw invalid();
  if (!Array.isArray(source.fields) || source.fields.length < 1 || source.fields.length > intakeLimits.fields) throw invalid();
  const fields = unique(source.fields.map(field => {
    if (!field || typeof field !== "object" || Array.isArray(field)) throw invalid();
    const item = field as Record<string, unknown>;
    if (Object.keys(item).some(key => !["key", "type", "required", "maxLength"].includes(key))) throw invalid();
    const key = text(item.key, 80);
    if (!fieldPattern.test(key)) throw invalid();
    if (item.type !== "text" && item.type !== "email") throw invalid();
    if (typeof item.required !== "boolean") throw invalid();
    if (typeof item.maxLength !== "number" || !Number.isInteger(item.maxLength) || item.maxLength < 1 || item.maxLength > intakeLimits.text) throw invalid();
    const parsed: IntakeField = { key, type: item.type, required: item.required, maxLength: item.maxLength };
    return parsed;
  }), (left, right) => left.key.toLowerCase() === right.key.toLowerCase());
  if (!source.validation || typeof source.validation !== "object" || Array.isArray(source.validation)) throw invalid();
  const validation = source.validation as Record<string, unknown>;
  if (Object.keys(validation).some(key => key !== "required") || !Array.isArray(validation.required)) throw invalid();
  const required = unique(validation.required.map(key => {
    const field = text(key, 80);
    const found = fields.find(item => item.key.toLowerCase() === field.toLowerCase());
    if (!found) throw invalid();
    return found.key;
  }), (left, right) => left.toLowerCase() === right.toLowerCase());
  if (!sameKeys(required, fields.filter(field => field.required).map(field => field.key))) throw invalid();
  if (!source.queue || typeof source.queue !== "object" || Array.isArray(source.queue)) throw invalid();
  const queue = source.queue as Record<string, unknown>;
  if (Object.keys(queue).some(key => !["name", "private"].includes(key)) || queue.private !== true) throw invalid();
  const queueName = text(queue.name, intakeLimits.queue).toLowerCase();
  if (!slugPattern.test(queueName)) throw invalid();
  if (source.audience !== "public" && source.audience !== "guest") throw invalid();
  if (typeof source.anonymous !== "boolean") throw invalid();
  if (!source.expiry || typeof source.expiry !== "object" || Array.isArray(source.expiry)) throw invalid();
  const expiry = source.expiry as Record<string, unknown>;
  if (Object.keys(expiry).some(key => key !== "hours") || typeof expiry.hours !== "number" || !Number.isInteger(expiry.hours) || expiry.hours < 1 || expiry.hours > intakeLimits.hours) throw invalid();
  let consent: IntakeConsent | null = null;
  if (source.consent !== null) {
    if (!source.consent || typeof source.consent !== "object" || Array.isArray(source.consent)) throw invalid();
    const body = source.consent as Record<string, unknown>;
    if (Object.keys(body).some(key => !["text", "version"].includes(key))) throw invalid();
    const consentText = text(body.text, intakeLimits.consent);
    if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 1) throw invalid();
    consent = { text: consentText, version: body.version };
  }
  if (!source.limits || typeof source.limits !== "object" || Array.isArray(source.limits)) throw invalid();
  const limits = source.limits as Record<string, unknown>;
  if (Object.keys(limits).some(key => !["bytes", "types"].includes(key))) throw invalid();
  if (typeof limits.bytes !== "number" || !Number.isInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > intakeLimits.bytes) throw invalid();
  if (!Array.isArray(limits.types) || limits.types.length < 1) throw invalid();
  const types = unique(limits.types.map(type => {
    if (typeof type !== "string" || !intakeFileTypes.includes(type as IntakeFileType)) throw invalid();
    return type as IntakeFileType;
  }), (left, right) => left === right);
  if (!source.edge || typeof source.edge !== "object" || Array.isArray(source.edge)) throw invalid();
  const edge = source.edge as Record<string, unknown>;
  if (Object.keys(edge).some(key => !["cache", "residency", "public"].includes(key))) throw invalid();
  if (edge.cache !== "no-store" || edge.residency !== "tenant" || edge.public !== false) throw new DocumentError(intakeEdge, "intake_edge", 422);
  if (!source.bot || typeof source.bot !== "object" || Array.isArray(source.bot)) throw invalid();
  const bot = source.bot as Record<string, unknown>;
  if (Object.keys(bot).some(key => key !== "required") || bot.required !== true) throw invalid();
  return {
    collection,
    fields,
    validation: { required },
    queue: { name: queueName, private: true },
    audience: source.audience,
    anonymous: source.anonymous,
    expiry: { hours: expiry.hours },
    consent,
    limits: { bytes: limits.bytes, types },
    edge: { cache: "no-store", residency: "tenant", public: false },
    bot: { required: true },
  };
}

export function assertConsentAdvance(previous: IntakeConsent | null, next: IntakeConsent | null) {
  if (!previous || !next) return;
  if (previous.text === next.text && previous.version !== next.version) throw invalid();
  if (previous.text !== next.text && next.version <= previous.version) throw invalid();
}

/** Anonymous intake is accepted only when the form opts in and an administrator has set the policy. */
export function decideAnonymous(input: { requested: boolean; formAllows: boolean; policyAllows: boolean }) {
  if (!input.requested) return { accepted: true as const, anonymous: false as const };
  if (input.formAllows && input.policyAllows) return { accepted: true as const, anonymous: true as const };
  return { accepted: false as const, anonymous: false as const, reason: "policy" as const };
}

export function decideAbuse(input: {
  bytes: number;
  limitBytes: number;
  mediaType: string | null;
  allowedMedia: string[];
  rateCount: number;
  rateLimit: number;
  bot: "valid" | "missing" | "reused";
  intent: "new" | "replay" | "mismatch";
}) {
  if (input.bytes > input.limitBytes || input.bytes < 0) return { allowed: false as const, reason: "size" as const };
  if (input.mediaType !== null && !input.allowedMedia.includes(input.mediaType)) return { allowed: false as const, reason: "type" as const };
  if (input.rateCount > input.rateLimit) return { allowed: false as const, reason: "rate" as const };
  if (input.bot !== "valid") return { allowed: false as const, reason: "bot" as const };
  if (input.intent === "mismatch") return { allowed: false as const, reason: "intent" as const };
  return { allowed: true as const, reason: input.intent === "replay" ? "replay" as const : "ok" as const };
}

export function scanIntakeAttachment(file: { name: string; mediaType: string; byteSize: number }, limits: { bytes: number; types: readonly string[] }) {
  const name = text(file.name, intakeLimits.fileName);
  const kind = intakeFileTypes.find(type => intakeMedia[type] === file.mediaType);
  const unsafe = /[/\\]/.test(name)
    || /(?:javascript|data|vbscript|file):/i.test(name)
    || name.includes("://")
    || /eicar|hs-unsafe/i.test(name)
    || !kind
    || !limits.types.includes(kind)
    || !Number.isInteger(file.byteSize)
    || file.byteSize < 1
    || file.byteSize > limits.bytes;
  return { name, mediaType: file.mediaType, byteSize: file.byteSize, quarantined: true as const, fetched: false as const, scan: unsafe ? "rejected" as const : "clean" as const };
}

export function decideFence(input: { status: string; expired: boolean; formVersion: number; submissionVersion: number; state: string }) {
  if (input.state === "committed" || input.state === "rejected") return { fenced: false as const };
  if (input.state === "fenced") return { fenced: true as const };
  if (input.status !== "draft" || input.expired || input.submissionVersion !== input.formVersion) return { fenced: true as const };
  return { fenced: false as const };
}

/** A matching record name is never the update target. Update only follows an explicit record id. */
export function commitTarget(explicitRecordId: string | null, namedRecordId: string | null) {
  if (explicitRecordId) return { mode: "update" as const, recordId: explicitRecordId, namedRecordIdIgnored: namedRecordId };
  return { mode: "insert" as const, namedRecordIdIgnored: namedRecordId };
}

export function genericReceipt(code: string) {
  return { receipt: intakeReceiptText, code, recordCreated: false as const };
}

export function assertIntakeText(value: string, limit: number) {
  const body = text(value, limit);
  if (/(?:javascript|data|vbscript|file):/i.test(body)) throw linkError();
  const urls = body.match(/https?:\/\/[^\s]+/gi) ?? [];
  for (const raw of urls) {
    const candidate = raw.replace(/[),.;]+$/g, "");
    if (!safeUrl(candidate)) throw linkError();
    const url = new URL(candidate);
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) throw linkError();
  }
  return body;
}

export function assertIntakeEmail(value: string, limit: number) {
  const body = assertIntakeText(value, limit);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)) throw invalid();
  return body;
}

export function intakeReport(definition: IntakeDefinition, name: string, lines: string[]) {
  return [
    `# ${name}`,
    "",
    intakeBoundary,
    `Sharing: ${intakeSharing}.`,
    "Activation: none. Access grants created: none.",
    `Audience: ${definition.audience}.`,
    `Queue: ${definition.queue.name} (private).`,
    `Anonymous on form: ${definition.anonymous ? "yes" : "no"}.`,
    definition.consent ? `Consent version: ${definition.consent.version}.` : "No consent text is configured.",
    `Edge: ${definition.edge.cache}.`,
    ...lines,
  ].join("\n");
}

export function intakeUuid(value: string) {
  const id = text(value, 80);
  if (!uuidPattern.test(id)) throw invalid();
  return id.toLowerCase();
}
