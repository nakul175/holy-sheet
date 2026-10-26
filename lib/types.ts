export const blockTypes = ["paragraph", "heading", "bullet", "number", "checklist"] as const;
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
  updatedAt: string;
  blocks: Block[];
};

export type SearchResult = {
  id: string;
  title: string;
  spaceId: string;
  path: string[];
  preview: string;
  updatedAt: string;
  match: "title-exact" | "title" | "content";
};

export type Space = { id: string; workspaceId: string; name: string };
