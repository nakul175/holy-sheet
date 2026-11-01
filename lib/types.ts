export const blockTypes = ["paragraph", "heading", "bullet", "number", "checklist"] as const;
export type PageRole='owner'|'editor'|'commenter'|'viewer';
export type GrantRole=Exclude<PageRole,'owner'>;
export const mediaIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const canEdit=(role:string)=>role==='owner'||role==='editor';
export const canComment=(role:string)=>canEdit(role)||role==='commenter';
export type BlockType = (typeof blockTypes)[number];

export type Block = {
  id: string;
  pageId: string;
  parentBlockId: string | null;
  type: BlockType;
  text: string;
  checked?: boolean;
  position: number;
};

export type Page = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  spaceId: string;
  spaceName: string;
  parentPageId: string | null;
  parentTitle?: string | null;
  title: string;
  visibility: "private" | "space";
  version: number;
  position?: number;
  updatedAt: string;
  blocks: Block[];
};

export const searchKinds = ["page", "block", "record", "field", "attachment"] as const;
export type SearchKind = (typeof searchKinds)[number];
export type SearchResult = {
  id: string;
  kind?: SearchKind;
  title: string;
  spaceId: string;
  path: string[];
  preview: string;
  updatedAt: string;
  match: "title-exact" | "title" | "content" | "field" | "attachment";
  href?: string;
  collection?: string;
  badge?: string | null;
};

export type Space = { id: string; workspaceId: string; name: string };
