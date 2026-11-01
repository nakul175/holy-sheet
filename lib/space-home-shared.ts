/** Reader-facing space home constants. Safe to import from client components. */
export const SPACE_HOME_TEMPLATE_ID = "starter-space-home";
export const SPACE_HOME_TITLE = "Space home";
export const SPACE_HOME_DESCRIPTION = "Overview of this space for people who just arrived.";
export const SPACE_HOME_START = "Start here";
export const SPACE_HOME_INTRO = "Begin with the pinned pages, recent updates, and the people who keep this space current.";
export const SPACE_HOME_UNAVAILABLE = "Space is restricted or unavailable";
export const SPACE_HOME_PAGE_UNAVAILABLE = "Page is restricted or unavailable";
export const SPACE_HOME_NOT_ALLOWED = "Not allowed";
/** Same recheck cadence as other HOLY-4 surfaces. The next read drops a revoked reader. */
export const SPACE_HOME_REFRESH_MS = 4000;
/** Staging p75 budget. This build does not record a Lighthouse run. */
export const SPACE_HOME_LCP_BUDGET_MS = 2000;
export const SPACE_HOME_PIN_LIMIT = 24;
export const SPACE_HOME_RECENT_LIMIT = 10;

/** Read of the current Space home template page for an active space member. No other page matches. */
export function spaceHomeMemberRead(actorParam: "$1" | "$2") {
  return `EXISTS (SELECT 1 FROM hs_spaces hs JOIN hs_page_template_sources src ON src.page_id = p.id AND src.template_id = '${SPACE_HOME_TEMPLATE_ID}' JOIN hs_space_members sm ON sm.space_id = p.space_id AND sm.user_id = ${actorParam} AND sm.active = true WHERE hs.id = p.space_id AND hs.home_page_id = p.id)`;
}

export function movePin(pageIds: readonly string[], pageId: string, direction: -1 | 1) {
  const index = pageIds.indexOf(pageId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= pageIds.length) return [...pageIds];
  const next = [...pageIds];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export type SpaceHomePinView = {
  pageId: string;
  title: string;
  summary: string;
  icon: "document";
  updatedAtIst: string;
};

export type SpaceHomeRecentView = {
  pageId: string;
  title: string;
  editorName: string | null;
  updatedAtIst: string;
};

export type SpaceHomeRecordView = {
  pageId: string;
  pageTitle: string;
  viewId: string;
  collectionId: string;
  layout: "table" | "list";
  icon: "grid";
};

export type SpaceHomeOwnerView = {
  userId: string;
  name: string;
  role: "leader" | "page-owner";
};

export type SpaceHomePageView = {
  pageId: string;
  title: string;
  summary: string;
  headings: string[];
  templateName: string | null;
  role: string;
  updatedAtIst: string;
};

export type SpaceHomeView = {
  workspaceId: string;
  spaceId: string;
  spaceName: string;
  canManage: boolean;
  home: SpaceHomePageView | null;
  widgets: {
    pinned: SpaceHomePinView[];
    recent: SpaceHomeRecentView[];
    recordViews: SpaceHomeRecordView[];
    owners: SpaceHomeOwnerView[];
  };
  pinCandidates: { pageId: string; title: string }[];
  replayed?: boolean;
};

export function dropPin(pageIds: readonly string[], fromId: string, toId: string) {
  const from = pageIds.indexOf(fromId);
  const to = pageIds.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return [...pageIds];
  const next = [...pageIds];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
