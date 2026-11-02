export const RECORD_BACKLINK_POLL_MS = 4000;

export type MentionSort = "edited" | "title";

export type MentionItem = {
  pageId: string;
  title: string;
  spaceId: string;
  spaceName: string;
  breadcrumb: string;
  referenceType: "chip" | "card" | "link";
  referenceTypes: ("chip" | "card" | "link")[];
  referenceLabel: string;
  icon: string;
  snippet: string;
  editedAt: string;
  editedAtIst: string;
  blockId: string;
  href: string;
  trashLabel: "In trash" | null;
};

export type MentionList = {
  heading: string;
  count: number;
  items: MentionItem[];
  nextCursor: string | null;
  spaces: { id: string; name: string }[];
  canIncludeTrash: boolean;
  sort: MentionSort;
  order: "asc" | "desc";
  spaceId: string | null;
};

export type ViewMentionList = {
  section: "views";
  heading: "Appears in view blocks";
  items: { pageId: string; title: string; spaceName: string; viewName: string; blockId: string; href: string }[];
  limit: number;
};

export function acceptedMentionList(value: unknown): MentionList | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Partial<MentionList>;
  if (typeof body.heading !== "string" || typeof body.count !== "number" || !Array.isArray(body.items)) return null;
  if (body.items.some(item => !item || typeof item !== "object" || typeof item.pageId !== "string" || typeof item.title !== "string" || typeof item.snippet !== "string")) return null;
  return body as MentionList;
}

export function acceptedViewMentionList(value: unknown): ViewMentionList | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Partial<ViewMentionList>;
  if (body.section !== "views" || body.heading !== "Appears in view blocks" || !Array.isArray(body.items)) return null;
  return body as ViewMentionList;
}
