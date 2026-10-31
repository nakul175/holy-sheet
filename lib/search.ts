import type { Page, SearchResult } from "./types";

export type ParsedQuery = { terms: string[]; phrases: string[]; prefix: string | null };

export function parseQuery(input: string): ParsedQuery {
  const normalized = input.trim().toLocaleLowerCase();
  const phrases = [...normalized.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim()).filter(Boolean);
  const unquoted = normalized.replace(/"[^"]+"/g, " ").match(/[\p{L}\p{N}]+/gu) ?? [];
  const prefix = unquoted.length ? unquoted.at(-1)! : null;
  return { terms: unquoted, phrases, prefix };
}

export function includesParsed(text: string, parsed: ParsedQuery) {
  const value = text.toLocaleLowerCase();
  if (!parsed.phrases.every((phrase) => new RegExp('(^|[^\\p{L}\\p{N}])'+phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^\\p{L}\\p{N}]|$)','u').test(value))) return false;
  return parsed.terms.every((term, index) => {
    if (index === parsed.terms.length - 1 && parsed.prefix) {
      return value.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(term));
    }
    return value.split(/[^\p{L}\p{N}]+/u).includes(term);
  });
}

export function searchPreview(text: string, parsed: ParsedQuery) {
  const source = text.replace(/[\p{Cc}]/gu, "");
  const needles = [...parsed.phrases, ...parsed.terms].filter(Boolean);
  const lower = source.toLocaleLowerCase();
  let at = -1;
  for (const needle of needles) {
    const found = lower.indexOf(needle);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, at < 0 ? 0 : at - 42);
  return source.slice(start, start + 150).trim();
}

export function searchHitRank(hit: SearchResult) {
  if (hit.kind === "block") return 3;
  if (hit.kind === "attachment" || hit.match === "attachment") return 4;
  if (hit.kind === "field" || hit.match === "field") return 2;
  if (hit.match === "title-exact") return 0;
  if (hit.match === "title") return 1;
  return 2;
}

export function searchPages(pages: Page[], input: string, spaceId?: string | null): SearchResult[] {
  const parsed = parseQuery(input);
  if (input.trim().length < 2) return [];
  return pages.flatMap((page) => {
    if (spaceId && page.spaceId !== spaceId) return [];
    const body = page.blocks.map((block) => block.text).join(" \n");
    const titleMatch = includesParsed(page.title, parsed);
    if (!includesParsed(page.title + " \n" + body, parsed)) return [];
    const exact = page.title.toLocaleLowerCase() === input.trim().toLocaleLowerCase();
    const previewSource = !titleMatch ? body : page.blocks[0]?.text ?? "";
    const needle = [...parsed.phrases, ...parsed.terms].find(term=>body.toLocaleLowerCase().includes(term)) ?? "";
    const at = previewSource.toLocaleLowerCase().indexOf(needle);
    const start = Math.max(0, at - 42);
    const preview = previewSource.slice(start, start + 150).trim();
    return [{
      id: page.id,
      title: page.title,
      spaceId: page.spaceId,
      path: [page.spaceName, ...(page.parentTitle ? [page.parentTitle] : [])],
      preview,
      updatedAt: page.updatedAt,
      match: exact ? "title-exact" : titleMatch ? "title" : "content",
    } satisfies SearchResult];
  }).sort((a, b) => {
    return searchHitRank(a) - searchHitRank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  });
}
