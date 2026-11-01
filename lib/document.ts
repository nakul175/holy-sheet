import { z } from "zod";
import { blockTypes,mediaIdPattern,type Block } from './types';
import { recordRefAttributeError } from "./record-page-refs";
import { richSchema } from "./rich-schema";

export type RichNode = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: RichNode[] };
export const schemaVersion = 2;
export const documentLimits = {bytes:25_000_000,blocks:10_000,depth:12} as const;
export const languages = ["plaintext", "bash", "javascript", "typescript", "json", "html", "css", "sql", "python", "java", "csharp", "cpp", "go", "rust", "php", "ruby", "yaml", "markdown"];
export const palette = ["#171717", "#6b7280", "#1d4ed8", "#15803d", "#92400e", "#b91c1c", "#6d28d9"];
export const highlights = ["#fef3c7", "#dbeafe", "#dcfce7", "#fee2e2", "#ede9fe"];
export const nodeTypes = ["doc", "text", "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "horizontalRule", "blockquote", "callout", "codeBlock", "table", "tableRow", "tableCell", "tableHeader", "image", "file", "details", "detailsSummary", "detailsContent", "tableOfContents", "pageLink", "recordRef", "recordView", "syncedBlock", "hardBreak"];
export const idTypes = nodeTypes.filter(t => !["doc", "text", "hardBreak"].includes(t));
export function stableStringify(value:unknown):string {
  function sort(v:unknown):unknown { if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,sort(item)]));return v; }
  return JSON.stringify(sort(value));
}
const marks = new Set(["bold", "italic", "underline", "strike", "textStyle", "highlight", "link", "code"]);

export function safeUrl(raw: string): boolean {
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw) || raw.startsWith("//")) return false;
  if (/^\/pages\/[a-zA-Z0-9_-]+(?:#[a-zA-Z0-9_-]+)?$/.test(raw)) return true;
  try { return ["https:", "http:", "mailto:", "tel:"].includes(new URL(raw).protocol); } catch { return false; }
}

export class DocumentError extends Error {
  constructor(message: string, public code = "invalid_document", public status = 422, public details?: unknown) { super(message); }
}
export const saveInput = z.object({ operationId: z.string().uuid(), baseVersion: z.number().int().positive(), title: z.string().max(240), document: z.unknown() }).strict();
const allowedAttrs = new Set(["id", "level", "start", "checked", "language", "colspan", "rowspan", "colwidth", "align", "theme", "icon", "alt", "title", "caption", "width", "attachmentId", "src", "pageId", "open", "syncedId", "syncVersion", "syncState", "syncLocked", "syncUndo"]);
const recordAttrs: Record<string, string[]> = { recordRef: ["nodeVersion", "recordId", "collectionId", "display", "fields"], recordView: ["nodeVersion", "viewId", "collectionId", "layout", "columns", "limit"] };

export function validateDocument(input: unknown): RichNode {
  if (new TextEncoder().encode(JSON.stringify(input) ?? "").byteLength > documentLimits.bytes) throw new DocumentError("Document exceeds the 25 MB safety limit. Split the page; your draft is retained.", "payload_too_large", 413);
  const ids = new Set<string>(); let count = 0;
  function visit(value: unknown, depth: number, parent?: string, listDepth = 0, inTable=false): RichNode {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocumentError("Invalid block");
    const n = value as RichNode;
    if (!nodeTypes.includes(n.type) || Object.keys(n).some(k => !["type", "text", "attrs", "marks", "content"].includes(k))) throw new DocumentError("Unsupported block or attribute");
    if(inTable&&!["tableRow","tableCell","tableHeader","paragraph","taskList","taskItem","text","hardBreak"].includes(n.type))throw new DocumentError("Unsupported content inside a table cell");
    if (depth > documentLimits.depth || (idTypes.includes(n.type) && ++count > documentLimits.blocks)) throw new DocumentError("Document nesting or block safety limit exceeded; split this page.");
    if (n.type === "doc" && parent) throw new DocumentError("Nested document");
    if (n.type === "text" && (typeof n.text !== "string" || n.content)) throw new DocumentError("Invalid text");
    if (n.type !== "text" && n.text !== undefined) throw new DocumentError("Text must use structured text nodes");
    if (n.attrs && (typeof n.attrs !== "object" || Array.isArray(n.attrs) || Object.keys(n.attrs).some(k => !allowedAttrs.has(k) && !recordAttrs[n.type]?.includes(k)))) throw new DocumentError(`Unsupported attributes on ${n.type}`);
    for (const [key,v] of Object.entries(n.attrs ?? {})) {
      if ((key === "fields" || key === "columns") && Array.isArray(v)) {
        if (v.length > 12 || v.some(item => typeof item !== "string" || item.length > 100)) throw new DocumentError("Invalid record block fields");
        continue;
      }
      if (key !== "colwidth" && !["string", "number", "boolean"].includes(typeof v) && v !== null) throw new DocumentError("Invalid attribute value");
      if (typeof v === "string" && v.length > 2048) throw new DocumentError("Attribute too long");
    }
    const recordError = recordRefAttributeError(n.type, n.attrs);
    if (recordError) throw new DocumentError(recordError);
    if ((n.type === "recordRef" || n.type === "recordView") && n.content?.length) throw new DocumentError("Record blocks cannot store nested content");
    if (idTypes.includes(n.type)) {
      const id = n.attrs?.id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ids.has(id)) throw new DocumentError("Missing or duplicate stable block ID");
      ids.add(id);
    }
    if (n.type === "heading" && ![1,2,3].includes(Number(n.attrs?.level))) throw new DocumentError("Unsupported heading level");
    if(n.attrs?.align!=null)throw new DocumentError("Unsupported table alignment");
    if (n.type === "codeBlock" && !languages.includes(String(n.attrs?.language ?? "plaintext"))) throw new DocumentError("Unsupported code language");
    if (n.type === "callout" && !["neutral","blue","green","amber","red"].includes(String(n.attrs?.theme ?? "neutral"))) throw new DocumentError("Unsupported callout theme");
    if (["image","file"].includes(n.type) && (!mediaIdPattern.test(String(n.attrs?.attachmentId)) || (n.type === "image" && !String(n.attrs?.alt ?? "").trim()))) throw new DocumentError("Media requires a verified attachment and image alternative text");
    if (n.attrs?.src && n.attrs.src !== `/api/media/${n.attrs.attachmentId}`) throw new DocumentError("Images must use the protected HS media gateway");
    if (n.type === "pageLink" && !/^[a-zA-Z0-9_-]{1,100}$/.test(String(n.attrs?.pageId))) throw new DocumentError("Invalid page reference");
    if (n.type === "syncedBlock") {
      if (parent === "syncedBlock") throw new DocumentError("Synced blocks cannot contain synced blocks");
      const syncedId = n.attrs?.syncedId;
      if (syncedId != null && syncedId !== "" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(syncedId))) throw new DocumentError("Invalid synced block");
      const syncState = n.attrs?.syncState;
      if (syncState != null && !["live", "restricted", "unavailable", "trash"].includes(String(syncState))) throw new DocumentError("Invalid synced block");
      const syncVersion = n.attrs?.syncVersion;
      if (syncVersion != null && !(Number.isInteger(syncVersion) && Number(syncVersion) >= 0)) throw new DocumentError("Invalid synced block");
      if (n.attrs?.syncLocked != null && typeof n.attrs.syncLocked !== "boolean") throw new DocumentError("Invalid synced block");
      if (n.attrs?.syncUndo != null && typeof n.attrs.syncUndo !== "boolean") throw new DocumentError("Invalid synced block");
    }
    if (n.type === "tableOfContents" && parent !== "doc") throw new DocumentError("Table of contents must be at page root");
    if (n.type === "detailsSummary" && !plainText(n).trim()) throw new DocumentError("Section title is required");
    if (n.marks && (!Array.isArray(n.marks) || n.marks.some(m => !m || typeof m!=='object' || !marks.has(m.type)))) throw new DocumentError("Unsupported text style");
    for (const m of n.marks ?? []) {
      const a = m.attrs ?? {};
      const markKeys = m.type === "link" ? ["href","target","rel","class"] : m.type === "textStyle" ? ["color"] : m.type === "highlight" ? ["color"] : [];
      if (Object.keys(a).some(k => !markKeys.includes(k))) throw new DocumentError("Unsupported style attributes");
      if (m.type === "link" && (!safeUrl(String(a.href)) || (a.target && a.target !== "_blank"))) throw new DocumentError("Unsafe link destination");
      if(m.type==='link'&&a.class!=null)throw new DocumentError('Unsupported link styling');
      if(m.type==='link'&&a.rel!==undefined){const tokens=typeof a.rel==='string'?a.rel.split(/\s+/):[];if(!tokens.includes('noopener')||!tokens.includes('noreferrer')||tokens.some(t=>!['noopener','noreferrer','nofollow'].includes(t)))throw new DocumentError('Unsafe link relationship');}
      if (m.type === "textStyle" && a.color && !palette.includes(String(a.color))) throw new DocumentError("Unsupported text colour");
      if (m.type === "highlight" && a.color && !highlights.includes(String(a.color))) throw new DocumentError("Unsupported highlight");
    }
    if (n.content && !Array.isArray(n.content)) throw new DocumentError("Invalid children");
    const nextListDepth = listDepth + (["bulletList","orderedList","taskList"].includes(n.type) ? 1 : 0);
    if (nextListDepth > 8) throw new DocumentError("Lists support eight nesting levels");
    const children = (n.content ?? []).map(c => visit(c, depth + (n.type === "text" ? 0 : 1), n.type, nextListDepth, inTable||n.type==='table'));
    if (["paragraph","heading","detailsSummary","codeBlock"].includes(n.type) && children.some(c => !["text","hardBreak"].includes(c.type))) throw new DocumentError("Invalid inline content");
    if (["bulletList","orderedList","taskList"].includes(n.type) && children.some(c => c.type !== (n.type === "taskList" ? "taskItem" : "listItem"))) throw new DocumentError("Invalid list children");
    if (["tableCell","tableHeader"].includes(n.type) && children.some(c => !["paragraph","taskList"].includes(c.type))) throw new DocumentError("Table cells support text and checklists");
    if (["tableCell","tableHeader"].includes(n.type) && ((n.attrs?.colspan ?? 1) !== 1 || (n.attrs?.rowspan ?? 1) !== 1)) throw new DocumentError("Merged cells are not supported");
    if (n.type === "tableRow" && children.some(c => !["tableCell","tableHeader"].includes(c.type))) throw new DocumentError("Invalid table row");
    if (n.type === "table") {
      if (!children.length || children.length > 100 || children.some(c => c.type !== "tableRow") || !children[0].content?.length || children[0].content.length > 20 || children.some(c => c.content?.length !== children[0].content?.length)) throw new DocumentError("Tables must be rectangular, with at most 100 rows and 20 columns");
    }
    if (n.type === "details" && (children.length !== 2 || children[0].type !== "detailsSummary" || children[1].type !== "detailsContent")) throw new DocumentError("A collapsible section needs a title and content");
    return { type:n.type, ...(n.text !== undefined ? {text:n.text} : {}), ...(n.attrs ? {attrs:structuredClone(n.attrs)} : {}), ...(n.marks ? {marks:structuredClone(n.marks)} : {}), ...(n.content ? {content:children} : {}) };
  }
  const result = visit(input, 0);
  if (result.type !== "doc" || !result.content?.length) throw new DocumentError("Document must contain at least one block");
  try{richSchema().nodeFromJSON(result).check();}catch{throw new DocumentError("The block structure is not supported by this editor");}
  return result;
}

export function plainText(n: RichNode): string {
  // Page labels are resolved separately per reader and never indexed here.
  if (["pageLink","tableOfContents","syncedBlock"].includes(n.type)) return "";
  return n.text ?? (n.content ?? []).map(plainText).join(["paragraph","heading","detailsSummary","codeBlock"].includes(n.type) ? "" : "\n");
}
export function ensureIds(doc: RichNode, fresh = false): RichNode {
  const seen = new Set<string>();
  function walk(n: RichNode): RichNode {
    const attrs = {...n.attrs};
    if(idTypes.includes(n.type)) { if(fresh || !attrs.id || seen.has(String(attrs.id))) attrs.id = crypto.randomUUID(); seen.add(String(attrs.id)); }
    return {...n, ...(idTypes.includes(n.type) || n.attrs ? {attrs}:{}), ...(n.content ? {content:n.content.map(walk)}:{})};
  }
  return walk(doc);
}
export function fromLegacy(blocks: Block[]): RichNode {
  const used = new Set<string>(), positions = new Set<number>();
  const sourcePage = blocks[0]?.pageId;
  const review = (message:string):never => { throw new DocumentError(`Legacy migration needs review: ${message}. Source content was not changed.`, 'legacy_review_required'); };
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Object.keys(block).some(key=>!['id','pageId','parentBlockId','type','text','checked','position'].includes(key))) review('unsupported source fields');
    if (typeof block.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(block.id) || used.has(block.id)) review('invalid or duplicate source IDs');
    if (typeof block.pageId !== 'string' || !block.pageId || block.pageId !== sourcePage) review('blocks must belong to one page');
    if (block.parentBlockId !== null) review('nested blocks require an explicit mapping');
    if (!blockTypes.includes(block.type) || typeof block.text !== 'string' || (block.checked !== undefined && typeof block.checked !== 'boolean')) review('unsupported block content');
    if (block.type !== 'checklist' && block.checked === true) review('checked state on a non-checklist block');
    if (!Number.isSafeInteger(block.position) || block.position < 0 || positions.has(block.position)) review('invalid or ambiguous positions');
    used.add(block.id); positions.add(block.position);
  }
  const helper = (prefix:string,id:string) => {
    const base = `${prefix}-${id}`.slice(0,90); let candidate=base,index=0;
    while(used.has(candidate)) candidate=`${base}-${++index}`;
    used.add(candidate); return candidate;
  };
  const nodes: RichNode[] = [...blocks].sort((a,b)=>a.position-b.position).map(b => {
    const text: RichNode[] = b.text ? [{type:"text",text:b.text}] : [];
    if(["bullet","number","checklist"].includes(b.type)) return {type:b.type === "checklist" ? "taskList" : b.type === "number" ? "orderedList" : "bulletList",attrs:{id:helper("list",b.id)},content:[{type:b.type === "checklist" ? "taskItem" : "listItem",attrs:{id:b.id,...(b.type === "checklist" ? {checked:!!b.checked}:{})},content:[{type:"paragraph",attrs:{id:helper("text",b.id)},content:text}]}]};
    return {type:b.type === "heading" ? "heading" : "paragraph",attrs:{id:b.id,...(b.type === "heading" ? {level:2}:{})},content:text};
  });
  return validateDocument({type:"doc",content:nodes.length ? nodes : [{type:"paragraph",attrs:{id:crypto.randomUUID()}}]});
}
function skeleton(n: RichNode): unknown { return n.type === "text" || n.type === "hardBreak" ? null : [n.type,n.attrs?.id,(n.content ?? []).filter(c=>!["text","hardBreak"].includes(c.type)).map(skeleton)]; }
export function mergeDocuments(base: RichNode, latest: RichNode, local: RichNode): RichNode | null {
  if (JSON.stringify(skeleton(base)) !== JSON.stringify(skeleton(latest)) || JSON.stringify(skeleton(base)) !== JSON.stringify(skeleton(local))) return null;
  const content: RichNode[] = [];
  for (let i=0;i<(base.content?.length ?? 0);i++) {
    const b=stableStringify(base.content![i]), r=stableStringify(latest.content![i]), l=stableStringify(local.content![i]);
    if(r!==b && l!==b && r!==l) return null;
    content.push(structuredClone(l===b ? latest.content![i] : local.content![i]));
  }
  return {type:"doc",content};
}
export function documentBlocks(document: RichNode) {
  const rows: {id:string;parentId:string|null;position:number;type:string;node:RichNode}[] = [];
  function walk(n: RichNode,parentId:string|null,position:number) {
    if (!idTypes.includes(n.type)) return;
    rows.push({id:String(n.attrs!.id),parentId,position,type:n.type,node:n});
    // Rows/cells live inside their table payload.
    if(n.type!=="table") (n.content ?? []).forEach((c,i)=>walk(c,String(n.attrs!.id),i));
  }
  document.content?.forEach((n,i)=>walk(n,null,i)); return rows;
}
