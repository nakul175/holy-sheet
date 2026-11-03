import { DocumentError, safeUrl } from "./document";

export const guestPortalSource = "guest-portal";
export const guestPortalSharing = "off" as const;
export const guestPortalBoundary = "A guest portal shows only the screens, records, fields, and actions an administrator configures. It does not open the workspace.";
export const guestPortalAssignment = "Configuring a portal, linking a suite identity, or naming a manager does not grant access to a page, record, collection, or field.";
export const guestPortalAuthority = "Guest access needs an explicit current grant and eligible suite authentication. A URL, a domain match, or an account assignment does not grant access.";
export const guestPortalActivation = "Sharing stays off until a separate explicit activation path. This portal does not send invitations or store credentials.";
export const guestPortalSchedules = "Existing schedules stay paused. Portals do not activate a schedule.";
export const guestPortalRecoverable = "A recoverable draft is kept when the version changes.";
export const guestPortalEdge = "Guest responses stay with the tenant and use cache no-store. Public caching is off.";
export const guestPortalControlSize = 44;
export const guestPortalActions = ["view", "form", "comment", "file", "export", "history"] as const;
export const guestPortalStatuses = ["draft", "preview", "paused", "revoked"] as const;
export const guestPortalActorActions = ["configure", "search", "preview", "download", "history", "pause", "revoke", "form", "comment", "file", "export", "link"] as const;
export const guestPortalLimits = { name: 80, screens: 6, fields: 12, records: 20, text: 4000, file: 200, domain: 200, hours: 8760 } as const;

export type GuestPortalAction = (typeof guestPortalActions)[number];
export type GuestPortalStatus = (typeof guestPortalStatuses)[number];
export type GuestPortalActorAction = (typeof guestPortalActorActions)[number];
export type GuestField = { key: string; mode: "view" | "edit" };
export type GuestScreen = { id: string; name: string; fields: string[]; actions: GuestPortalAction[] };
export type GuestPortalDefinition = {
  screens: GuestScreen[];
  scope: { collection: string; recordIds: string[] };
  fields: GuestField[];
  actions: GuestPortalAction[];
  expiry: { hours: number };
  edge: { cache: "no-store"; residency: "tenant"; public: false };
  guestPreview: true;
  domain: string | null;
};
export type AccessClaim = {
  authenticated: boolean;
  suiteSubject: string | null;
  urlToken: string | null;
  domain: string | null;
  accountAssigned: boolean;
};
export type AccessFacts = {
  status: GuestPortalStatus;
  suiteSubject: string | null;
  identityLinked: boolean;
  grant: "current" | "revoked" | "expired" | "missing";
  expiredByPolicy: boolean;
  audienceDomain: string | null;
};
export type AccessDecision = { allowed: true; reason: "grant-and-authentication" } | { allowed: false; reason: "url" | "domain" | "assignment" | "authentication" | "grant" | "expiry" | "paused" | "revoked" };

const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fieldPattern = /^(?:core:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const slugPattern = /^[a-z][a-z0-9-]{0,40}$/;
const invalid = () => new DocumentError("Check the portal.", "guest_portal_validation", 422);
const linkError = () => new DocumentError("That link is not allowed.", "guest_portal_link", 422);

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

export function guestPortalName(value: string) {
  return text(value, guestPortalLimits.name);
}

export function guestPortalQuery(value: string) {
  const query = value.trim().toLocaleLowerCase();
  if (!query || Array.from(query).length > 80 || control.test(query)) throw invalid();
  return query;
}

export function compileGuestPortal(input: unknown): GuestPortalDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.some(key => !["screens", "scope", "fields", "actions", "expiry", "edge", "guestPreview", "domain"].includes(key))) throw invalid();
  if (source.guestPreview !== undefined && source.guestPreview !== true) throw invalid();
  if (!Array.isArray(source.screens) || source.screens.length < 1 || source.screens.length > guestPortalLimits.screens) throw invalid();
  if (!Array.isArray(source.fields) || source.fields.length < 1 || source.fields.length > guestPortalLimits.fields) throw invalid();
  if (!Array.isArray(source.actions) || source.actions.length < 1) throw invalid();
  const fields = unique(source.fields.map(field => {
    if (!field || typeof field !== "object" || Array.isArray(field)) throw invalid();
    const item = field as Record<string, unknown>;
    if (Object.keys(item).some(key => !["key", "mode"].includes(key))) throw invalid();
    const key = text(item.key, 80);
    if (!fieldPattern.test(key)) throw invalid();
    if (item.mode !== "view" && item.mode !== "edit") throw invalid();
    const mode: GuestField["mode"] = item.mode;
    return { key, mode };
  }), (left, right) => left.key.toLowerCase() === right.key.toLowerCase());
  const fieldKeys = new Set(fields.map(field => field.key.toLowerCase()));
  const actions = unique(source.actions.map(action => {
    if (typeof action !== "string" || !guestPortalActions.includes(action as GuestPortalAction)) throw invalid();
    return action as GuestPortalAction;
  }), (left, right) => left === right);
  if (!actions.includes("view")) throw invalid();
  const screens = unique(source.screens.map(screen => {
    if (!screen || typeof screen !== "object" || Array.isArray(screen)) throw invalid();
    const item = screen as Record<string, unknown>;
    if (Object.keys(item).some(key => !["id", "name", "fields", "actions"].includes(key))) throw invalid();
    const id = text(item.id, 41);
    if (!slugPattern.test(id)) throw invalid();
    const name = text(item.name, guestPortalLimits.name);
    if (!Array.isArray(item.fields) || !Array.isArray(item.actions) || item.fields.length < 1 || item.actions.length < 1) throw invalid();
    const screenFields = unique(item.fields.map(key => {
      const field = text(key, 80);
      if (!fieldKeys.has(field.toLowerCase())) throw invalid();
      return fields.find(candidate => candidate.key.toLowerCase() === field.toLowerCase())!.key;
    }), (left, right) => left === right);
    const screenActions = unique(item.actions.map(action => {
      if (typeof action !== "string" || !actions.includes(action as GuestPortalAction)) throw invalid();
      return action as GuestPortalAction;
    }), (left, right) => left === right);
    return { id, name, fields: screenFields, actions: screenActions };
  }), (left, right) => left.id === right.id);
  if (!source.scope || typeof source.scope !== "object" || Array.isArray(source.scope)) throw invalid();
  const scope = source.scope as Record<string, unknown>;
  if (Object.keys(scope).some(key => !["collection", "recordIds"].includes(key))) throw invalid();
  const collection = text(scope.collection, 41);
  if (!slugPattern.test(collection)) throw invalid();
  if (!Array.isArray(scope.recordIds) || scope.recordIds.length < 1 || scope.recordIds.length > guestPortalLimits.records) throw invalid();
  const recordIds = unique(scope.recordIds.map(id => {
    const recordId = text(id, 80);
    if (!uuidPattern.test(recordId)) throw invalid();
    return recordId.toLowerCase();
  }), (left, right) => left === right);
  if (!source.expiry || typeof source.expiry !== "object" || Array.isArray(source.expiry)) throw invalid();
  const expiry = source.expiry as Record<string, unknown>;
  if (Object.keys(expiry).some(key => key !== "hours") || typeof expiry.hours !== "number" || !Number.isInteger(expiry.hours) || expiry.hours < 1 || expiry.hours > guestPortalLimits.hours) throw invalid();
  if (!source.edge || typeof source.edge !== "object" || Array.isArray(source.edge)) throw invalid();
  const edge = source.edge as Record<string, unknown>;
  if (edge.cache !== "no-store" || edge.residency !== "tenant" || edge.public !== false) throw new DocumentError(guestPortalEdge, "guest_portal_edge", 422);
  if (Object.keys(edge).some(key => !["cache", "residency", "public"].includes(key))) throw invalid();
  let domain: string | null = null;
  if (source.domain !== undefined && source.domain !== null) {
    domain = text(source.domain, guestPortalLimits.domain).toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..") || domain.startsWith(".") || domain.endsWith(".")) throw invalid();
  }
  return {
    screens, scope: { collection, recordIds }, fields, actions, expiry: { hours: expiry.hours },
    edge: { cache: "no-store", residency: "tenant", public: false }, guestPreview: true, domain,
  };
}

/** A URL, a matching domain, or an account assignment never admits a guest by itself. */
export function evaluateGuestAccess(claim: AccessClaim, facts: AccessFacts): AccessDecision {
  if (facts.status === "revoked") return { allowed: false, reason: "revoked" };
  if (facts.status === "paused") return { allowed: false, reason: "paused" };
  if (facts.grant === "expired" || facts.expiredByPolicy) return { allowed: false, reason: "expiry" };
  const eligible = claim.authenticated === true && facts.identityLinked && claim.suiteSubject !== null && claim.suiteSubject === facts.suiteSubject;
  const current = facts.grant === "current" && !facts.expiredByPolicy;
  if (eligible && current) return { allowed: true, reason: "grant-and-authentication" };
  const domainMatch = Boolean(claim.domain && facts.audienceDomain && claim.domain.toLowerCase() === facts.audienceDomain.toLowerCase());
  const onlyUrl = Boolean(claim.urlToken) && !claim.authenticated && !claim.accountAssigned && !domainMatch && !current && !eligible;
  const onlyDomain = domainMatch && !claim.authenticated && !claim.accountAssigned && !claim.urlToken && !current && !eligible;
  const onlyAssignment = claim.accountAssigned && !claim.authenticated && !current && !eligible && !claim.urlToken && !domainMatch;
  if (onlyUrl) return { allowed: false, reason: "url" };
  if (onlyDomain) return { allowed: false, reason: "domain" };
  if (onlyAssignment) return { allowed: false, reason: "assignment" };
  if (claim.accountAssigned && claim.authenticated && !eligible && !current && !claim.urlToken && !domainMatch) return { allowed: false, reason: "assignment" };
  if (!eligible) return { allowed: false, reason: "authentication" };
  return { allowed: false, reason: "grant" };
}

export function assertGuestText(value: string, limit = guestPortalLimits.text) {
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

export function guestFileCitation(value: string) {
  const name = text(value, guestPortalLimits.file);
  if (/[/\\]/.test(name) || /^(?:javascript|data|vbscript|file|https?):/i.test(name) || name.includes("://")) throw linkError();
  return { name, fetched: false as const };
}

export function guestPortalDocument(definition: GuestPortalDefinition, name: string) {
  return [
    `# ${name}`,
    "",
    guestPortalBoundary,
    `Sharing: ${guestPortalSharing}.`,
    "Invitations: none. Credentials: none. Access grants created: none.",
    `Expiry: ${definition.expiry.hours} hours.`,
    `Edge: ${definition.edge.cache}, residency ${definition.edge.residency}.`,
    definition.domain ? `Domain match is not access: ${definition.domain}.` : "No audience domain is configured.",
    `Screens: ${definition.screens.map(screen => screen.name).join(", ")}.`,
    `Actions: ${definition.actions.join(", ")}.`,
  ].join("\n");
}
