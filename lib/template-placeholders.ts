import { DocumentError, type RichNode } from "./document";
import { recordPlaceholderAttributeError } from "./record-page-refs";

export { recordPlaceholderAttributeError };

const variableToken = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;

export type PlaceholderDisplay = "chip" | "card" | "view";
export type TemplatePlaceholder = {
  blockId: string;
  key: string;
  label: string;
  collectionId: string;
  display: PlaceholderDisplay;
  fields: string[];
  columns: string[];
  limit: number;
};
export type TemplatePlaceholderPrompt = { key: string; label: string; collectionId: string; displays: PlaceholderDisplay[] };
export type TemplateInspection = { variables: string[]; placeholders: TemplatePlaceholder[] };

export function todayIst(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}`;
}

function visit(document: RichNode, onNode: (node: RichNode) => void) {
  const walk = (node: RichNode) => { onNode(node); node.content?.forEach(walk); };
  walk(document);
}

export function inspectTemplate(document: RichNode): TemplateInspection {
  const variables: string[] = [];
  const seen = new Set<string>();
  const placeholders: TemplatePlaceholder[] = [];
  visit(document, node => {
    if (node.type === "text" && node.text) {
      for (const match of node.text.matchAll(variableToken)) {
        if (!seen.has(match[1])) { seen.add(match[1]); variables.push(match[1]); }
      }
    }
    if (node.type !== "recordPlaceholder") return;
    const attrs = node.attrs ?? {};
    placeholders.push({
      blockId: String(attrs.id ?? ""),
      key: String(attrs.key ?? ""),
      label: String(attrs.label ?? "").trim(),
      collectionId: String(attrs.collectionId ?? ""),
      display: attrs.display as PlaceholderDisplay,
      fields: Array.isArray(attrs.fields) ? attrs.fields.map(String) : [],
      columns: Array.isArray(attrs.columns) ? attrs.columns.map(String) : [],
      limit: Number(attrs.limit ?? 10),
    });
  });
  return { variables, placeholders };
}

export function placeholderPrompts(document: RichNode): TemplatePlaceholderPrompt[] {
  const prompts = new Map<string, TemplatePlaceholderPrompt>();
  for (const item of inspectTemplate(document).placeholders) {
    const current = prompts.get(item.key);
    if (!current) prompts.set(item.key, { key: item.key, label: item.label, collectionId: item.collectionId, displays: [item.display] });
    else if (!current.displays.includes(item.display)) current.displays.push(item.display);
  }
  return [...prompts.values()];
}

export function applyTemplateString(value: string, values: Record<string, string>) {
  return value.replace(variableToken, (match, key: string) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match);
}

export function bindTemplateDocument(document: RichNode, values: Record<string, string>, replacements: Map<string, RichNode>): RichNode {
  function walk(node: RichNode): RichNode {
    if (node.type === "recordPlaceholder") {
      const next = replacements.get(String(node.attrs?.id ?? ""));
      if (!next) throw new DocumentError("Check the template fields and try again.", "template_binding", 422);
      return next;
    }
    const text = node.type === "text" && typeof node.text === "string" ? applyTemplateString(node.text, values) : node.text;
    return { ...node, ...(text !== undefined ? { text } : {}), ...(node.content ? { content: node.content.map(walk) } : {}) };
  }
  return walk(document);
}

export function assertNoRecordPlaceholders(document: RichNode) {
  visit(document, node => {
    if (node.type === "recordPlaceholder") throw new DocumentError("Record placeholders are resolved when a page is created from a template.", "template_placeholder", 422);
  });
}
