/** Client-safe copy and shapes for the spaces directory. */

export const SPACE_UNAVAILABLE = "Space is restricted or unavailable";
export const SPACE_ARCHIVED_BANNER = "This space is archived and read-only.";

export type SpaceVisibility = "open" | "discoverable" | "private";
export type DirectoryAction = "open" | "join" | "request";

export type DirectorySpace = {
  id: string;
  name: string;
  visibility: SpaceVisibility;
  archived: boolean;
  archivedAtIst: string | null;
  action: DirectoryAction;
  requestPending: boolean;
};

export type DirectoryView = {
  workspaceId: string;
  canAdminister: boolean;
  includeArchived: boolean;
  spaces: DirectorySpace[];
};

export type AccessChange = {
  userId: string;
  name: string;
  pageId: string;
  before: string | null;
  after: string | null;
};

export type PersonRef = { userId: string; name: string };

export type MigrationPreview = {
  rootPageId: string;
  targetSpaceId: string;
  parentId: string | null;
  pageCount: number;
  trashedCount: number;
  accessChanges: AccessChange[];
  gains: PersonRef[];
  loses: PersonRef[];
  brokenReferences: number;
  redirectCount: number;
  treeVersion: number;
  digest: string;
};

export type MigrationJob = {
  jobId: string;
  status: "running" | "halted" | "completed";
  pageCount: number;
  movedPageIds: string[];
  remainingPageIds: string[];
  sourceSpaceId: string;
  targetSpaceId: string;
  haltReason: string | null;
  atIst: string;
  replayed: boolean;
};
