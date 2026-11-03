import { DocumentError } from "./document";

export const knowledgeSiteSource = "knowledge-site";
export const knowledgeSiteSharing = "off" as const;
export const knowledgeSiteBoundary = "A knowledge site publishes a reviewed subset of approved page revisions, paths, and navigation. It does not open a live public site, domain, or share.";
export const knowledgeSiteAssignment = "Configuring a site, naming a publisher, or assigning a page, record, or asset does not grant access to a page, record, collection, or field.";
export const knowledgeSiteAudience = "Publish needs the separate publish capability and an explicit public-audience confirmation. Internal edits never publish themselves.";
export const knowledgeSiteLive = "No public site, domain, or sharing is enabled by this task.";
export const knowledgeSiteSchedules = "Existing schedules stay paused. Knowledge sites do not activate a schedule.";
export const knowledgeSiteRecoverable = "A recoverable draft is kept when the version changes.";
export const knowledgeSiteEdge = "Knowledge-site responses stay with the tenant and use cache no-store. Public caching is off.";
export const knowledgeSiteCacheBound = "First-party search, download, and asset routes drop an unpublished or rolled-back snapshot on the next request. Responses use cache no-store and a zero-second bound. Unpublish and rollback do not retract copies already held by a third party.";
export const knowledgeSiteRetraction = "Unpublish and rollback do not retract copies already held by a third party.";
export const knowledgeSiteQuarantine = "An asset is served only when it is pinned to the approved revision and its scan is clean. Direct asset URLs are removed.";
export const knowledgeSiteCacheBoundSeconds = 0;
export const knowledgeSiteControlSize = 44;
export const knowledgeSiteActions = ["configure", "search", "preview", "download", "history", "publish", "unpublish", "rollback", "render"] as const;
export const knowledgeSiteStatuses = ["draft", "published", "unpublished"] as const;
export const knowledgeSiteLimits = { name: 80, pages: 12, assets: 12, records: 8, fields: 8, text: 2000, path: 80, label: 80 } as const;

export type KnowledgeSiteAction = (typeof knowledgeSiteActions)[number];
export type KnowledgeSiteStatus = (typeof knowledgeSiteStatuses)[number];
export type SitePageRef = { pageId: string; revision: number; path: string; label: string };
export type SiteNavItem = { path: string; label: string; parent: string | null };
export type SiteAssetRef = { mediaId: string; pageId: string };
export type SiteRecordRef = { recordId: string; fields: string[] };
export type KnowledgeSiteDefinition = {
  pages: SitePageRef[];
  navigation: SiteNavItem[];
  assets: SiteAssetRef[];
  records: SiteRecordRef[];
  edge: { cache: "no-store"; residency: "tenant"; public: false };
  cacheBoundSeconds: 0;
};
export type DocNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: DocNode[];
};
export type SourceAsset = { mediaId: string; name: string; mime: string; state: string; objectKey: string; deleted: boolean };
export type SourcePage = {
  pageId: string;
  revision: number;
  currentVersion: number;
  title: string;
  document: DocNode;
  ownerId: string;
  visibility: string;
  acl: { subject: string; role: string }[];
  comments: { id: string; body: string }[];
  history: { version: number; title: string }[];
  assets: SourceAsset[];
};
export type SourceField = { key: string; sensitive: boolean; view: boolean };
export type SourceRecord = { recordId: string; name: string; view: boolean; values: Record<string, unknown>; fields: SourceField[] };
export type ManifestItem = {
  kind: "metadata" | "acl" | "comment" | "history" | "asset" | "page" | "url" | "record" | "field";
  id: string;
  reason: "stripped" | "quarantine" | "unapproved" | "private" | "direct-url" | "sensitive" | "newer-revision";
  included: false;
};
export type PublicBlock =
  | { type: "text"; text: string }
  | { type: "asset"; mediaId: string; name: string; mime: string; alt: string }
  | { type: "path"; path: string; label: string };
export type PublicPage = { pageId: string; path: string; label: string; revision: number; title: string; blocks: PublicBlock[] };
export type PublicAsset = { mediaId: string; pageId: string; name: string; mime: string; scan: "clean"; quarantined: false; url: null };
export type PublicProjection = {
  pages: PublicPage[];
  navigation: SiteNavItem[];
  records: { recordId: string; name: string; fields: { key: string; value: string }[] }[];
  manifest: ManifestItem[];
  assets: PublicAsset[];
  cache: "no-store";
  cacheBoundSeconds: 0;
  retraction: false;
  liveSite: false;
  sharing: "off";
  domain: null;
};

const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pageIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const pathPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const fieldPattern = /^(?:core:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const invalid = () => new DocumentError("Check the knowledge site.", "knowledge_site_validation", 422);

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
function keys(value: object, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
function integer(value: unknown, max: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw invalid();
  return value;
}

export function knowledgeSiteName(value: string) {
  return text(value, knowledgeSiteLimits.name);
}
export function knowledgeSiteQuery(value: string) {
  const query = value.trim().toLocaleLowerCase();
  if (!query || Array.from(query).length > 80 || control.test(query)) throw invalid();
  return query;
}
export function storedDefinition(definition: KnowledgeSiteDefinition): KnowledgeSiteDefinition {
  return {
    pages: definition.pages.map(page => ({ ...page })),
    navigation: definition.navigation.map(item => ({ ...item })),
    assets: definition.assets.map(asset => ({ ...asset })),
    records: definition.records.map(record => ({ recordId: record.recordId, fields: [...record.fields] })),
    edge: { cache: "no-store", residency: "tenant", public: false },
    cacheBoundSeconds: 0,
  };
}

export function compileKnowledgeSite(input: unknown): KnowledgeSiteDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const source = input as Record<string, unknown>;
  keys(source, ["pages", "navigation", "assets", "records", "edge", "cacheBoundSeconds"]);
  if (!Array.isArray(source.pages) || source.pages.length < 1 || source.pages.length > knowledgeSiteLimits.pages) throw invalid();
  const pages = unique(source.pages.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    keys(row, ["pageId", "revision", "path", "label"]);
    const pageId = text(row.pageId, 80);
    if (!pageIdPattern.test(pageId)) throw invalid();
    const path = text(row.path, knowledgeSiteLimits.path).toLowerCase();
    if (!pathPattern.test(path)) throw invalid();
    return { pageId, revision: integer(row.revision, 1_000_000), path, label: text(row.label, knowledgeSiteLimits.label) };
  }), (left, right) => left.pageId === right.pageId || left.path === right.path);
  if (!Array.isArray(source.navigation) || source.navigation.length < 1 || source.navigation.length > knowledgeSiteLimits.pages) throw invalid();
  const navigation = unique(source.navigation.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    keys(row, ["path", "label", "parent"]);
    const path = text(row.path, knowledgeSiteLimits.path).toLowerCase();
    if (!pathPattern.test(path) || !pages.some(page => page.path === path)) throw invalid();
    const label = text(row.label, knowledgeSiteLimits.label);
    let parent: string | null = null;
    if (row.parent !== null && row.parent !== undefined) {
      parent = text(row.parent, knowledgeSiteLimits.path).toLowerCase();
      if (!pathPattern.test(parent) || parent === path) throw invalid();
    }
    return { path, label, parent };
  }), (left, right) => left.path === right.path);
  if (navigation.length !== pages.length || pages.some(page => !navigation.some(item => item.path === page.path))) throw invalid();
  const known = new Set(navigation.map(item => item.path));
  for (const item of navigation) if (item.parent && !known.has(item.parent)) throw invalid();
  for (const item of navigation) {
    const seen = new Set<string>();
    let cursor: string | null = item.path;
    while (cursor) {
      if (seen.has(cursor)) throw invalid();
      seen.add(cursor);
      cursor = navigation.find(entry => entry.path === cursor)?.parent ?? null;
    }
  }
  const assets = Array.isArray(source.assets) ? source.assets : null;
  if (!assets || assets.length > knowledgeSiteLimits.assets) throw invalid();
  const compiledAssets = unique(assets.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    keys(row, ["mediaId", "pageId"]);
    const mediaId = text(row.mediaId, 80).toLowerCase();
    const pageId = text(row.pageId, 80);
    if (!uuidPattern.test(mediaId) || !pages.some(page => page.pageId === pageId)) throw invalid();
    return { mediaId, pageId };
  }), (left, right) => left.mediaId === right.mediaId);
  const records = Array.isArray(source.records) ? source.records : null;
  if (!records || records.length > knowledgeSiteLimits.records) throw invalid();
  const compiledRecords = unique(records.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    keys(row, ["recordId", "fields"]);
    const recordId = text(row.recordId, 80).toLowerCase();
    if (!uuidPattern.test(recordId) || !Array.isArray(row.fields) || row.fields.length < 1 || row.fields.length > knowledgeSiteLimits.fields) throw invalid();
    const fields = unique(row.fields.map(field => {
      const key = text(field, 80);
      if (!fieldPattern.test(key)) throw invalid();
      return key;
    }), (left, right) => left.toLowerCase() === right.toLowerCase());
    return { recordId, fields };
  }), (left, right) => left.recordId === right.recordId);
  if (!source.edge || typeof source.edge !== "object" || Array.isArray(source.edge)) throw invalid();
  const edge = source.edge as Record<string, unknown>;
  keys(edge, ["cache", "residency", "public"]);
  if (edge.cache !== "no-store" || edge.residency !== "tenant" || edge.public !== false) throw new DocumentError(knowledgeSiteEdge, "knowledge_site_edge", 422);
  if (source.cacheBoundSeconds !== 0) throw invalid();
  return {
    pages, navigation, assets: compiledAssets, records: compiledRecords,
    edge: { cache: "no-store", residency: "tenant", public: false }, cacheBoundSeconds: 0,
  };
}

function add(manifest: ManifestItem[], item: ManifestItem) {
  if (!manifest.some(entry => entry.kind === item.kind && entry.id === item.id && entry.reason === item.reason)) manifest.push(item);
}
const urlPattern = /(?:https?:\/\/\S+|\/api\/media\/[0-9a-f-]{36})/gi;
function scrub(value: string, needles: string[], manifest: ManifestItem[], pageId: string) {
  let next = value;
  if (urlPattern.test(next)) {
    add(manifest, { kind: "url", id: pageId, reason: "direct-url", included: false });
    urlPattern.lastIndex = 0;
    next = next.replace(urlPattern, "");
  }
  urlPattern.lastIndex = 0;
  for (const needle of needles) {
    if (needle.length >= 8 && next.includes(needle)) {
      add(manifest, { kind: "url", id: pageId, reason: "direct-url", included: false });
      next = next.split(needle).join("");
    }
  }
  return next.replace(/[ \t]{2,}/g, " ").trim();
}
function purge(value: string, needles: string[]) {
  let next = value;
  for (const needle of needles) if (needle.length >= 8 && next.includes(needle)) next = next.split(needle).join("");
  urlPattern.lastIndex = 0;
  return next.replace(urlPattern, "").trim();
}

function walk(node: DocNode, page: SourcePage, definition: KnowledgeSiteDefinition, needles: string[], manifest: ManifestItem[], blocks: PublicBlock[]) {
  if (!node || typeof node !== "object") return;
  if (node.type === "text" && typeof node.text === "string") {
    const hrefs = (node.marks ?? []).map(mark => (mark.type === "link" ? String(mark.attrs?.href ?? "") : "")).filter(Boolean);
    for (const href of hrefs) add(manifest, { kind: "url", id: page.pageId, reason: "direct-url", included: false });
    const text = scrub(node.text, [...needles, ...hrefs], manifest, page.pageId);
    if (text) blocks.push({ type: "text", text });
    return;
  }
  if (node.type === "image" || node.type === "file") {
    const mediaId = String(node.attrs?.attachmentId ?? "").toLowerCase();
    const src = String(node.attrs?.src ?? "");
    if (src || node.attrs?.objectKey || node.attrs?.object_key || node.attrs?.url) add(manifest, { kind: "url", id: mediaId || page.pageId, reason: "direct-url", included: false });
    const approved = definition.assets.some(asset => asset.mediaId === mediaId && asset.pageId === page.pageId);
    const media = page.assets.find(asset => asset.mediaId === mediaId);
    const clean = Boolean(media && media.state === "ready" && !media.deleted);
    if (!approved || !media || !clean) {
      add(manifest, { kind: "asset", id: mediaId || page.pageId, reason: media && !clean ? "quarantine" : "unapproved", included: false });
      return;
    }
    const alt = scrub(String(node.attrs?.alt ?? media.name), needles, manifest, page.pageId) || media.name;
    blocks.push({ type: "asset", mediaId, name: media.name, mime: media.mime, alt });
    return;
  }
  if (node.type === "pageLink") {
    const target = String(node.attrs?.pageId ?? "");
    const dest = definition.pages.find(item => item.pageId === target);
    if (!dest) {
      add(manifest, { kind: "page", id: target || page.pageId, reason: "private", included: false });
      return;
    }
    blocks.push({ type: "path", path: dest.path, label: dest.label });
    return;
  }
  for (const child of node.content ?? []) walk(child, page, definition, needles, manifest, blocks);
}

/** Public projection of pinned revisions. Private metadata, comments, history, ACL, and direct asset URLs stay out. */
export function renderPublicSite(definition: KnowledgeSiteDefinition, pages: SourcePage[], records: SourceRecord[]): PublicProjection {
  const manifest: ManifestItem[] = [];
  const publicPages: PublicPage[] = [];
  const assets: PublicAsset[] = [];
  for (const selected of definition.pages) {
    const page = pages.find(item => item.pageId === selected.pageId && item.revision === selected.revision);
    if (!page) throw invalid();
    const needles = [
      ...page.assets.map(asset => asset.objectKey),
      ...page.comments.map(comment => comment.body),
      ...page.acl.map(entry => entry.subject),
      page.ownerId,
      ...page.history.filter(item => item.version !== page.revision).map(item => item.title),
    ].filter((item): item is string => typeof item === "string" && item.length >= 8);
    add(manifest, { kind: "metadata", id: page.pageId, reason: "stripped", included: false });
    if (page.acl.length) add(manifest, { kind: "acl", id: page.pageId, reason: "stripped", included: false });
    for (const comment of page.comments) add(manifest, { kind: "comment", id: comment.id, reason: "stripped", included: false });
    if (page.history.some(item => item.version !== page.revision)) add(manifest, { kind: "history", id: page.pageId, reason: "stripped", included: false });
    if (page.currentVersion !== page.revision) add(manifest, { kind: "history", id: `${page.pageId}@${page.currentVersion}`, reason: "newer-revision", included: false });
    const blocks: PublicBlock[] = [];
    walk(page.document, page, definition, needles, manifest, blocks);
    const title = purge(page.title, needles);
    publicPages.push({ pageId: page.pageId, path: selected.path, label: selected.label, revision: page.revision, title, blocks: blocks.map(block => block.type === "text" ? { ...block, text: purge(block.text, needles) } : block.type === "asset" ? { ...block, alt: purge(block.alt, needles), name: purge(block.name, needles) } : block) });
    for (const block of blocks) {
      if (block.type !== "asset" || assets.some(asset => asset.mediaId === block.mediaId)) continue;
      assets.push({ mediaId: block.mediaId, pageId: page.pageId, name: purge(block.name, needles), mime: block.mime, scan: "clean", quarantined: false, url: null });
    }
  }
  const publicRecords: PublicProjection["records"] = [];
  for (const selected of definition.records) {
    const record = records.find(item => item.recordId === selected.recordId);
    if (!record || !record.view) {
      add(manifest, { kind: "record", id: selected.recordId, reason: "private", included: false });
      continue;
    }
    const fields: { key: string; value: string }[] = [];
    for (const key of selected.fields) {
      const policy = record.fields.find(field => field.key.toLowerCase() === key.toLowerCase());
      if (!policy || policy.sensitive || !policy.view) {
        add(manifest, { kind: "field", id: key, reason: policy?.sensitive ? "sensitive" : "private", included: false });
        continue;
      }
      const value = record.values[key];
      if (typeof value !== "string") continue;
      const clean = purge(value, []);
      if (clean) fields.push({ key, value: clean });
    }
    if (fields.length) publicRecords.push({ recordId: record.recordId, name: record.name, fields });
  }
  return {
    pages: publicPages,
    navigation: definition.navigation.map(item => ({ ...item })),
    records: publicRecords,
    manifest,
    assets,
    cache: "no-store",
    cacheBoundSeconds: 0,
    retraction: false,
    liveSite: false,
    sharing: "off",
    domain: null,
  };
}

export function visibleProjection(projection: PublicProjection, pageIds: Set<string>, recordIds: Set<string>): PublicProjection {
  const pages = projection.pages.filter(page => pageIds.has(page.pageId));
  return {
    ...projection,
    pages,
    records: projection.records.filter(record => recordIds.has(record.recordId)),
    assets: projection.assets.filter(asset => pages.some(page => page.pageId === asset.pageId)),
  };
}

export function projectionText(projection: PublicProjection) {
  const lines: string[] = [];
  for (const page of projection.pages) {
    lines.push(page.title, page.label, page.path);
    for (const block of page.blocks) {
      if (block.type === "text") lines.push(block.text);
      if (block.type === "path") lines.push(block.path, block.label);
    }
  }
  for (const record of projection.records) {
    lines.push(record.name);
    for (const field of record.fields) lines.push(field.value);
  }
  return lines.join("\n");
}

export function knowledgeSiteReport(name: string, projection: PublicProjection) {
  const lines = [
    `# ${name}`,
    "Sharing: off.",
    "Live site: no.",
    "Domain: none.",
    "Cache: no-store.",
    `Cache bound: ${knowledgeSiteCacheBoundSeconds} seconds.`,
    knowledgeSiteRetraction,
    "",
  ];
  for (const item of projection.navigation) lines.push(`- ${item.label} (${item.path})`);
  for (const page of projection.pages) {
    lines.push(`## ${page.label}`, page.title, `path: ${page.path}`, `revision: ${page.revision}`);
    for (const block of page.blocks) {
      if (block.type === "text") lines.push(block.text);
      if (block.type === "asset") lines.push(`Asset: ${block.name} (mediated)`);
      if (block.type === "path") lines.push(`Path: ${block.path}`);
    }
  }
  for (const record of projection.records) {
    lines.push(`Record ${record.name}`);
    for (const field of record.fields) lines.push(`${field.key}: ${field.value}`);
  }
  lines.push(knowledgeSiteCacheBound);
  return lines.join("\n");
}

export function generationMatches(requested: number | null, current: number) {
  return requested === null || requested === current;
}
