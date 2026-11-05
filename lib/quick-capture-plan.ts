import type { AnyNode, Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { DocumentError, type RichNode, safeUrl } from "./document";
import { quickCaptureOfflinePolicy, type QuickCaptureSourceAccess } from "./quick-capture-local";

export const quickCaptureSource = "quick-capture";
export const quickCaptureBoundary = "Quick capture saves only the text, link, or note you select. It does not browse, watch, or fetch a page for you.";
export const quickCaptureAssignment = "Configuring capture or naming an operator does not grant access to a page, record, collection, space, or field.";
export const quickCaptureSharing = "The default destination is private and permitted. Capture does not inherit external sharing.";
export const quickCaptureOffline = "An offline capture stays as a local draft on this device. It is not an authoritative save until a permitted destination accepts it.";
export const quickCaptureSchedules = "Existing schedules stay paused. Capture does not activate a schedule.";
export const quickCaptureRecoverable = "A recoverable draft is kept when the version changes.";
export const quickCaptureProvenance = "Each capture records the source address, title, and time you supply. Aplyd Pages does not open that address.";
export const quickCaptureAssets = "Source assets are imported only when you select them. Remote images, hidden form values, and cookies are not collected.";
export const quickCaptureVisibility = "private" as const;
export const quickCaptureKinds = ["text", "link", "note"] as const;
export const quickCaptureActions = ["capture", "preview", "commit", "search", "download", "history", "configure"] as const;
export const quickCaptureDestinations = ["space", "intake"] as const;
export const quickCaptureLimits = { title: 200, body: 20_000, sourceTitle: 200, sourceUrl: 2_000, query: 80, assets: 20, assetName: 200 } as const;

export type QuickCaptureKind = (typeof quickCaptureKinds)[number];
export type QuickCaptureAction = (typeof quickCaptureActions)[number];
export type QuickCaptureDestination = (typeof quickCaptureDestinations)[number];
export type CaptureAsset = { name: string; imported: true; fetched: false };
export type SanitisedCapture = {
  text: string;
  links: { href: string; label: string }[];
  assets: CaptureAsset[];
  excluded: string[];
};

const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const skipTags = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "link", "meta", "template", "noscript", "head", "input", "textarea", "select", "option", "button"]);
const invalid = () => new DocumentError("Check the capture.", "quick_capture_validation", 422);

export function captureUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > quickCaptureLimits.sourceUrl || control.test(value) || !safeUrl(value)) return null;
  if (value.startsWith("/pages/")) return value;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (!["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function assertCapturePolicy(input: { offlinePolicy?: unknown; visibility?: unknown; inheritExternal?: unknown }) {
  if (input.offlinePolicy !== undefined && input.offlinePolicy !== quickCaptureOfflinePolicy) {
    throw new DocumentError(quickCaptureOffline, "quick_capture_offline", 422);
  }
  if (input.visibility !== undefined && input.visibility !== quickCaptureVisibility) {
    throw new DocumentError(quickCaptureSharing, "quick_capture_sharing", 422);
  }
  if (input.inheritExternal === true) throw new DocumentError(quickCaptureSharing, "quick_capture_sharing", 422);
  return { offlinePolicy: quickCaptureOfflinePolicy, visibility: quickCaptureVisibility, inheritExternal: false as const };
}

export function captureKinds(values: readonly string[]) {
  if (values.length < 1 || values.length > quickCaptureKinds.length) throw invalid();
  const next: QuickCaptureKind[] = [];
  for (const value of values) {
    if (!quickCaptureKinds.includes(value as QuickCaptureKind) || next.includes(value as QuickCaptureKind)) throw invalid();
    next.push(value as QuickCaptureKind);
  }
  return next;
}

export function captureDestinationKind(value: string) {
  if (!quickCaptureDestinations.includes(value as QuickCaptureDestination)) throw invalid();
  return value as QuickCaptureDestination;
}

export function captureQuery(value: string) {
  const query = value.trim().toLocaleLowerCase();
  if (!query || Array.from(query).length > quickCaptureLimits.query || control.test(query)) throw invalid();
  return query;
}

export function captureTitle(value: string) {
  const title = value.trim().normalize("NFC");
  if (!title || Array.from(title).length > quickCaptureLimits.title || control.test(title)) {
    throw new DocumentError("Enter a title of 1–200 characters.", "quick_capture_validation", 422);
  }
  return title;
}

function plain(value: string) {
  return value.normalize("NFC").replace(control, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tag(node: AnyNode) {
  return "name" in node && typeof node.name === "string" ? node.name.toLowerCase() : "";
}

function element(node: AnyNode): Element | null {
  return node.type === "tag" || node.type === "script" || node.type === "style" ? node as Element : null;
}

function hidden(node: Element) {
  const attrs = node.attribs ?? {};
  if ("hidden" in attrs || attrs["aria-hidden"] === "true" || (attrs.type ?? "").toLowerCase() === "hidden") return true;
  const style = (attrs.style ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden") || style.includes("opacity:0") || style.includes("font-size:0");
}

function cookieField(node: Element) {
  const attrs = node.attribs ?? {};
  const blob = `${attrs.name ?? ""} ${attrs.id ?? ""} ${attrs["http-equiv"] ?? ""} ${attrs.property ?? ""}`.toLowerCase();
  return blob.includes("cookie") || "data-cookie" in attrs || Object.keys(attrs).some(key => key.toLowerCase().includes("cookie"));
}

function children(node: AnyNode) {
  return "children" in node ? node.children ?? [] : [];
}

/** Turn a paste into text, safe links, and explicitly selected asset names. Hidden values, cookies, scripts, and remote images stay out. */
export function sanitiseCapture(html: string, selected: readonly string[]): SanitisedCapture {
  const names = new Set(selected.map(name => name.trim().toLocaleLowerCase()).filter(Boolean));
  const excluded = new Set<string>();
  const links: { href: string; label: string }[] = [];
  const assets: CaptureAsset[] = [];
  const parts: string[] = [];
  const visit = (node: AnyNode) => {
    if (node.type === "text") {
      parts.push(node.data);
      return;
    }
    const el = element(node);
    if (!el) return;
    const name = tag(el);
    if (cookieField(el)) {
      excluded.add("cookie");
      return;
    }
    if (hidden(el) || name === "input" || name === "textarea" || name === "select") {
      excluded.add("hidden-field");
      return;
    }
    if (skipTags.has(name)) {
      excluded.add(name === "script" || name === "style" || name === "noscript" ? "script" : "hidden-field");
      return;
    }
    if (name === "img") {
      const label = (el.attribs.alt || el.attribs.title || "").trim().normalize("NFC");
      if (label && names.has(label.toLocaleLowerCase())) assets.push({ name: label.slice(0, quickCaptureLimits.assetName), imported: true, fetched: false });
      else excluded.add("unselected-asset");
      if (el.attribs.src) excluded.add("remote-image");
      return;
    }
    if (name === "a") {
      const nested: string[] = [];
      const hold = parts.splice(0, parts.length);
      for (const child of children(el)) visit(child);
      nested.push(...parts);
      parts.splice(0, parts.length, ...hold);
      const label = plain(nested.join(" "));
      const href = el.attribs.href ?? "";
      const safe = href ? captureUrl(href) : null;
      if (href && !safe) excluded.add("unsafe-url");
      if (safe) links.push({ href: safe, label: label || safe });
      if (label) parts.push(label);
      return;
    }
    if (["p", "div", "li", "h1", "h2", "h3", "h4", "br", "tr"].includes(name) && parts.length && !parts.at(-1)?.endsWith("\n")) parts.push("\n");
    for (const child of children(el)) visit(child);
  };
  for (const node of parseDocument(html, { decodeEntities: true }).children) visit(node);
  let text = plain(parts.join(""));
  text = text.replace(/\b(?:javascript|data|vbscript|file):[^\s]*/gi, " ").replace(/https?:\/\/[^\s/]*:[^\s@/]*@[^\s]*/gi, " ");
  text = plain(text);
  if (Array.from(text).length > quickCaptureLimits.body) throw new DocumentError("The capture is too long.", "quick_capture_validation", 422);
  return { text, links, assets, excluded: [...excluded].sort() };
}

export function captureDocument(input: { text: string; links: { href: string; label: string }[]; assets: CaptureAsset[]; sourceUrl: string | null; sourceTitle: string | null; sourceAccess: QuickCaptureSourceAccess; capturedAt: string }, ids: () => string): RichNode {
  const content: RichNode[] = [];
  const blocks = input.text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  for (const line of blocks) content.push(paragraph(ids(), line));
  for (const link of input.links) {
    if (!content.some(block => JSON.stringify(block).includes(link.href))) content.push(paragraph(ids(), link.label || link.href, link.href));
  }
  for (const asset of input.assets) content.push(paragraph(ids(), `Selected asset: ${asset.name}`));
  const provenance = [`Source access: ${input.sourceAccess}.`, input.sourceTitle ? `Source title: ${input.sourceTitle}.` : "", input.sourceUrl ? "The source address was not opened." : "No external page was fetched.", `Captured ${input.capturedAt}.`].filter(Boolean).join(" ");
  content.push(paragraph(ids(), provenance));
  if (input.sourceUrl) content.push(paragraph(ids(), input.sourceUrl, input.sourceUrl));
  if (!content.length) content.push(paragraph(ids(), "Empty capture"));
  return { type: "doc", content };
}

function paragraph(id: string, text: string, href?: string): RichNode {
  const textNode: RichNode = { type: "text", text };
  if (href) textNode.marks = [{ type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer" } }];
  return { type: "paragraph", attrs: { id }, content: [textNode] };
}

export type PreparedCapture = {
  kind: QuickCaptureKind;
  title: string;
  text: string;
  links: { href: string; label: string }[];
  assets: CaptureAsset[];
  excluded: string[];
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePageId: string | null;
  sourceAccess: QuickCaptureSourceAccess;
  destinationKind: QuickCaptureDestination | null;
  destinationId: string | null;
  draftKey: string;
};

export function prepareCapture(input: {
  kind: string;
  title: string;
  body?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourcePageId?: string;
  sourceAccess?: string;
  destinationKind?: string;
  destinationId?: string;
  assets?: { name: string; selected: boolean }[];
  draftKey?: string;
  allowedKinds: readonly string[];
}): PreparedCapture {
  if (!quickCaptureKinds.includes(input.kind as QuickCaptureKind) || !input.allowedKinds.includes(input.kind)) {
    throw new DocumentError("Choose text, a link, or a note.", "quick_capture_validation", 422);
  }
  const title = captureTitle(input.title);
  const selected = (input.assets ?? []).filter(asset => asset.selected).map(asset => asset.name.trim()).filter(Boolean);
  if ((input.assets ?? []).length > quickCaptureLimits.assets || selected.some(name => Array.from(name).length > quickCaptureLimits.assetName || control.test(name))) throw invalid();
  const unselected = (input.assets ?? []).filter(asset => !asset.selected);
  const sanitised = sanitiseCapture(input.body ?? "", selected);
  if (unselected.length) sanitised.excluded = [...new Set([...sanitised.excluded, "unselected-asset"])].sort();
  const sourceUrl = input.sourceUrl?.trim() ? captureUrl(input.sourceUrl) : null;
  if (input.sourceUrl?.trim() && !sourceUrl) throw new DocumentError("Enter a safe source address. It was not opened.", "quick_capture_link", 422);
  if (input.kind === "link" && !sourceUrl) throw new DocumentError("Enter a safe link. It was not opened.", "quick_capture_link", 422);
  if ((input.kind === "text" || input.kind === "note") && !sanitised.text && !sanitised.assets.length) {
    throw new DocumentError("Enter the text or note to capture.", "quick_capture_validation", 422);
  }
  const sourceTitle = input.sourceTitle?.trim() ? input.sourceTitle.trim().normalize("NFC") : null;
  if (sourceTitle && (Array.from(sourceTitle).length > quickCaptureLimits.sourceTitle || control.test(sourceTitle))) throw invalid();
  const sourcePageId = input.sourcePageId?.trim() || null;
  if (sourcePageId && (sourcePageId.length > 200 || control.test(sourcePageId))) throw invalid();
  let sourceAccess: QuickCaptureSourceAccess = sourcePageId ? "permitted" : "not-opened";
  if (input.sourceAccess) {
    if (!["not-opened", "unavailable", "permitted"].includes(input.sourceAccess)) {
      throw new DocumentError("The source was not opened. Accessibility cannot be reported as fetched.", "quick_capture_source", 422);
    }
    if (!sourcePageId && input.sourceAccess !== "not-opened") {
      throw new DocumentError("The source address was not opened.", "quick_capture_source", 422);
    }
    sourceAccess = input.sourceAccess as QuickCaptureSourceAccess;
  }
  const destinationKind = input.destinationKind ? captureDestinationKind(input.destinationKind) : null;
  const destinationId = input.destinationId?.trim() || null;
  if (destinationId && (destinationId.length > 200 || control.test(destinationId))) throw invalid();
  if ((destinationKind && !destinationId) || (!destinationKind && destinationId)) throw invalid();
  const draftKey = (input.draftKey?.trim() || "current").normalize("NFC");
  if (!draftKey || Array.from(draftKey).length > 80 || control.test(draftKey)) throw invalid();
  return {
    kind: input.kind as QuickCaptureKind,
    title,
    text: sanitised.text,
    links: sanitised.links,
    assets: sanitised.assets,
    excluded: sanitised.excluded,
    sourceUrl,
    sourceTitle,
    sourcePageId,
    sourceAccess,
    destinationKind,
    destinationId,
    draftKey,
  };
}
