import { expect, it } from "vitest";
import { loadDiscussionDraft, purgeForeignDiscussionDrafts, saveDiscussionDraft, type DraftStore } from "./discussion-drafts";

function memory(): DraftStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: key => raw.get(key) ?? null,
    setItem: (key, value) => { raw.set(key, value); },
    removeItem: key => { raw.delete(key); },
    keys: () => [...raw.keys()],
  };
}

it("degrades to session-only when storage throws", async () => {
  const denied: DraftStore = {
    getItem() { throw new DOMException("Denied", "SecurityError"); },
    setItem() { throw new DOMException("Quota", "QuotaExceededError"); },
    removeItem() { throw new DOMException("Denied", "SecurityError"); },
    keys() { throw new DOMException("Denied", "SecurityError"); },
  };
  expect(() => purgeForeignDiscussionDrafts("actor-a", denied)).not.toThrow();
  await expect(saveDiscussionDraft("page-1", "actor-a", { body: "SECRET_DRAFT" }, denied)).resolves.toBeUndefined();
  await expect(loadDiscussionDraft("page-1", "actor-a", denied)).resolves.toBeNull();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("Denied", "SecurityError"); } });
  try {
    expect(() => purgeForeignDiscussionDrafts("actor-a")).not.toThrow();
    await expect(saveDiscussionDraft("page-1", "actor-a", { body: "SECRET_DRAFT" })).resolves.toBeUndefined();
    await expect(loadDiscussionDraft("page-1", "actor-a")).resolves.toBeNull();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

it("encrypts a discussion draft for one actor and purges it when the actor changes", async () => {
  const store = memory();
  store.setItem("unrelated", "keep");
  const draft = { new: { body: "SECRET_DRAFT", people: [], records: [] } };
  await saveDiscussionDraft("page-1", "actor-a", draft, store);
  const stored = store.raw.get("hs-discussion-draft:v1:page-1") ?? "";
  expect(stored).not.toContain("SECRET_DRAFT");
  expect(await loadDiscussionDraft("page-1", "actor-a", store)).toEqual(draft);
  expect(await loadDiscussionDraft("page-1", "actor-b", store)).toBeNull();
  expect(store.raw.has("hs-discussion-draft:v1:page-1")).toBe(false);
  await saveDiscussionDraft("page-1", "actor-a", draft, store);
  await saveDiscussionDraft("page-2", "actor-b", { new: { body: "other", people: [], records: [] } }, store);
  purgeForeignDiscussionDrafts("actor-b", store);
  expect(store.raw.has("hs-discussion-draft:v1:page-1")).toBe(false);
  expect(await loadDiscussionDraft("page-2", "actor-b", store)).toEqual({ new: { body: "other", people: [], records: [] } });
  expect(store.raw.get("unrelated")).toBe("keep");
});
