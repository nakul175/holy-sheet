import type { Block, Page, Space } from "./types";
import { searchPages } from "./search";

export const demoWorkspace = { id: "ws-aplyd", name: "Aplyd" };
export const demoSpaces: Space[] = [
  { id: "space-private", workspaceId: demoWorkspace.id, name: "My pages" },
  { id: "space-product", workspaceId: demoWorkspace.id, name: "Product" },
];

let pages: Page[] = [{
  id: "welcome",
  workspaceId: demoWorkspace.id,
  workspaceName: demoWorkspace.name,
  spaceId: "space-product",
  spaceName: "Product",
  parentPageId: null,
  title: "Welcome to Holy Sheet",
  visibility: "private",
  version: 1,
  updatedAt: new Date().toISOString(),
  blocks: [
    { id: "welcome-heading", pageId: "welcome", parentBlockId: null, type: "heading", text: "Knowledge that stays close to the work", position: 0 },
    { id: "welcome-body", pageId: "welcome", parentBlockId: null, type: "paragraph", text: "Create pages from here today. SHO integration can link to the same page later.", position: 1 },
    { id: "welcome-check", pageId: "welcome", parentBlockId: null, type: "checklist", text: "Try searching for SHO integration", checked: false, position: 2 },
  ],
}];

export function listDemoPages() { return pages.map((page) => structuredClone(page)); }
export function listDemoSpaces() { return structuredClone(demoSpaces); }
export function createDemoSpace(name: string) {
  const space = { id: crypto.randomUUID(), workspaceId: demoWorkspace.id, name: name.trim() };
  demoSpaces.push(space);
  return structuredClone(space);
}
export function getDemoPage(id: string) { return pages.find((page) => page.id === id); }
export function createDemoPage(input: { title: string; spaceId: string; parentPageId?: string | null }) {
  const space = demoSpaces.find((item) => item.id === input.spaceId) ?? demoSpaces[0];
  const parent = input.parentPageId ? pages.find((item) => item.id === input.parentPageId) : null;
  const id = crypto.randomUUID();
  const page: Page = {
    id, workspaceId: demoWorkspace.id, workspaceName: demoWorkspace.name,
    spaceId: space.id, spaceName: space.name, parentPageId: parent?.id ?? null,
    parentTitle: parent?.title ?? null, title: input.title.trim() || "Untitled",
    visibility: "private", version: 1, updatedAt: new Date().toISOString(), blocks: [],
  };
  pages = [page, ...pages];
  return structuredClone(page);
}
export function saveDemoPage(id: string, expectedVersion: number, title: string, blocks: Block[]) {
  const index = pages.findIndex((page) => page.id === id);
  if (index < 0) return { status: "missing" as const };
  if (pages[index].version !== expectedVersion) return { status: "conflict" as const, page: structuredClone(pages[index]) };
  pages[index] = { ...pages[index], title: title.trim() || "Untitled", blocks: structuredClone(blocks), version: expectedVersion + 1, updatedAt: new Date().toISOString() };
  return { status: "saved" as const, page: structuredClone(pages[index]) };
}
export function searchDemoPages(query: string, spaceId?: string | null) { return searchPages(pages, query, spaceId); }
