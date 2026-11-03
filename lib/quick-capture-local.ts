/** Device-local capture drafts. They are not an authoritative save and they never fetch a source. */

export const quickCaptureOfflinePolicy = "local-draft" as const;
export const quickCaptureStoragePrefix = "hs-quick-capture";
export const quickCaptureSourceAccess = ["not-opened", "unavailable", "permitted"] as const;

export type QuickCaptureSourceAccess = (typeof quickCaptureSourceAccess)[number];
export type LocalCaptureDraft = {
  version: 1;
  policy: typeof quickCaptureOfflinePolicy;
  authoritative: false;
  actorId: string;
  workspaceId: string;
  operationId: string;
  kind: "text" | "link" | "note";
  title: string;
  body: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceAccess: QuickCaptureSourceAccess;
  destinationKind: "space" | "intake" | "";
  destinationId: string;
  savedAt: string;
};
export type LocalCaptureStore = {
  version: 1;
  policy: typeof quickCaptureOfflinePolicy;
  authoritative: false;
  actorId: string;
  workspaceId: string;
  drafts: Record<string, LocalCaptureDraft>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const truthful = new Set<string>(quickCaptureSourceAccess);

export class LocalCaptureError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export function captureStorageKey(actorId: string, workspaceId: string) {
  return `${quickCaptureStoragePrefix}:${actorId}:${workspaceId}`;
}

export function captureDraftFingerprint(draft: Pick<LocalCaptureDraft, "actorId" | "workspaceId" | "kind" | "title" | "body" | "sourceUrl" | "sourceTitle" | "sourceAccess" | "destinationKind" | "destinationId">) {
  return JSON.stringify([draft.actorId, draft.workspaceId, draft.kind, draft.title, draft.body, draft.sourceUrl, draft.sourceTitle, draft.sourceAccess, draft.destinationKind, draft.destinationId]);
}

export function sourceAccessMessage(access: QuickCaptureSourceAccess, sourceUrl: string) {
  if (access === "unavailable") return "The source page is not available to you. Nothing was fetched.";
  if (sourceUrl) return "The source address was not opened.";
  if (access === "permitted") return "The Holy Sheet page is one you can open. No external page was fetched.";
  return "No external page was fetched.";
}

function empty(actorId: string, workspaceId: string): LocalCaptureStore {
  return { version: 1, policy: quickCaptureOfflinePolicy, authoritative: false, actorId, workspaceId, drafts: {} };
}

export function readLocalCapture(current: unknown, actorId: string, workspaceId: string): LocalCaptureStore {
  if (!current || typeof current !== "object" || Array.isArray(current)) return empty(actorId, workspaceId);
  const value = current as Partial<LocalCaptureStore>;
  if (value.version !== 1 || value.policy !== quickCaptureOfflinePolicy || value.authoritative !== false) return empty(actorId, workspaceId);
  if (value.actorId !== actorId || value.workspaceId !== workspaceId) return empty(actorId, workspaceId);
  const drafts: Record<string, LocalCaptureDraft> = {};
  if (value.drafts && typeof value.drafts === "object" && !Array.isArray(value.drafts)) {
    for (const [id, draft] of Object.entries(value.drafts)) {
      if (!draft || draft.version !== 1 || draft.policy !== quickCaptureOfflinePolicy || draft.authoritative !== false) continue;
      if (draft.actorId !== actorId || draft.workspaceId !== workspaceId || !truthful.has(draft.sourceAccess)) continue;
      drafts[id] = draft;
    }
  }
  return { version: 1, policy: quickCaptureOfflinePolicy, authoritative: false, actorId, workspaceId, drafts };
}

/** Keep one draft per attempt. A repeated attempt returns the original. A changed attempt leaves it in place. */
export function rememberLocalCapture(current: unknown, draft: LocalCaptureDraft) {
  if (draft.version !== 1 || draft.policy !== quickCaptureOfflinePolicy || draft.authoritative !== false) {
    throw new LocalCaptureError("Offline capture stays a local draft and is not an authoritative save.", "quick_capture_offline");
  }
  if (!truthful.has(draft.sourceAccess)) {
    throw new LocalCaptureError("The source was not opened. Say whether it is not opened, unavailable, or a page you can open.", "quick_capture_source");
  }
  if (!uuidPattern.test(draft.operationId) || !draft.actorId || !draft.workspaceId) {
    throw new LocalCaptureError("Check the capture.", "quick_capture_validation");
  }
  const store = readLocalCapture(current, draft.actorId, draft.workspaceId);
  const existing = store.drafts[draft.operationId];
  if (existing) {
    if (captureDraftFingerprint(existing) !== captureDraftFingerprint(draft)) {
      throw new LocalCaptureError("This attempt was reused with different fields. The local draft is kept.", "operation_mismatch");
    }
    return { store, replayed: true as const };
  }
  if (Object.keys(store.drafts).length >= 20) {
    throw new LocalCaptureError("This device already has 20 capture drafts. Confirm or remove one.", "quick_capture_offline");
  }
  store.drafts[draft.operationId] = { ...draft, version: 1, policy: quickCaptureOfflinePolicy, authoritative: false };
  return { store, replayed: false as const };
}
