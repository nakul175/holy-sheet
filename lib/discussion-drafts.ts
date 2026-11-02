const PREFIX = "hs-discussion-draft:v1:";

export type DraftStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
};

export function browserDraftStore(): DraftStore {
  return {
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: key => localStorage.removeItem(key),
    keys: () => {
      const keys: string[] = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key) keys.push(key);
      }
      return keys;
    },
  };
}

function pageKey(pageId: string) {
  return `${PREFIX}${pageId}`;
}

async function aesKey(actorId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`holy-sheet.discussion-draft.v1\0${actorId}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function text(value: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Drop drafts sealed for anyone other than the signed-in actor. Other storage keys stay. */
export function purgeForeignDiscussionDrafts(actorId: string, store: DraftStore = browserDraftStore()) {
  if (!actorId) return;
  for (const key of store.keys()) {
    if (!key.startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(store.getItem(key) || "") as { actorId?: string };
      if (!parsed || parsed.actorId !== actorId) store.removeItem(key);
    } catch {
      store.removeItem(key);
    }
  }
}

export async function saveDiscussionDraft<T>(pageId: string, actorId: string, draft: T, store: DraftStore = browserDraftStore()) {
  if (!actorId || !pageId) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(actorId), new TextEncoder().encode(JSON.stringify(draft)));
  store.setItem(pageKey(pageId), JSON.stringify({ v: 1, actorId, iv: text(iv.buffer), cipher: text(cipher) }));
}

export async function loadDiscussionDraft<T>(pageId: string, actorId: string, store: DraftStore = browserDraftStore()): Promise<T | null> {
  if (!actorId || !pageId) return null;
  const raw = store.getItem(pageKey(pageId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: number; actorId?: string; iv?: string; cipher?: string };
    if (parsed.v !== 1 || parsed.actorId !== actorId || !parsed.iv || !parsed.cipher) {
      if (parsed.actorId !== actorId) store.removeItem(pageKey(pageId));
      return null;
    }
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(parsed.iv) }, await aesKey(actorId), bytes(parsed.cipher));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    store.removeItem(pageKey(pageId));
    return null;
  }
}
