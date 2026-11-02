import { expect, it } from "vitest";
import type { RichNode } from "./document";
import { forkDocument, mergeWorkingCopy, redactTopLevel } from "./working-copy-plan";

const paragraph = (id: string, text: string): RichNode => ({ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] });
const doc = (...nodes: RichNode[]): RichNode => ({ type: "doc", content: nodes });

it("gives the copy fresh block ids and keeps a map back to the source", () => {
  const source = doc(paragraph("block-a", "Hello"), { type: "syncedBlock", attrs: { id: "sync-1", syncedId: "11111111-1111-4111-8111-111111111111", snippetId: "22222222-2222-4222-8222-222222222222" } });
  const forked = forkDocument(source);
  const ids = JSON.stringify(forked.document);
  expect(ids).not.toContain("block-a");
  expect(ids).not.toContain("sync-1");
  expect(ids).not.toContain("11111111-1111-4111-8111-111111111111");
  expect(ids).not.toContain("22222222-2222-4222-8222-222222222222");
  expect(forked.blockMap.map(link => link.sourceId).sort()).toEqual(["block-a", "sync-1"]);
  expect(new Set(forked.blockMap.map(link => link.copyId)).size).toBe(2);
});

it("requires an explicit choice when both sides edit the same block", () => {
  const base = doc(paragraph("a", "Base"));
  const original = doc(paragraph("a", "Original"));
  const copy = doc(paragraph("copy-a", "Copy"));
  const pending = mergeWorkingCopy({ baseTitle: "T", base, originalTitle: "T", original, originalRaw: original, copyTitle: "T", copy, blockMap: [{ sourceId: "a", copyId: "copy-a" }], mediaMap: [], redacted: [], hiddenFields: [], choices: {} });
  expect(pending.unresolved).toEqual(["a"]);
  expect(pending.document).toBeNull();
  const applied = mergeWorkingCopy({ ...pendingInput(base, original, copy), choices: { a: "copy" } });
  expect(applied.document?.content?.[0]).toMatchObject({ attrs: { id: "a" }, content: [{ text: "Copy" }] });
});

it("auto-merges a one-sided edit and keeps hidden record fields from the original", () => {
  const base = doc(paragraph("a", "Same"), paragraph("b", "Base"));
  const original = doc(paragraph("a", "Same"), paragraph("b", "Original"));
  const raw = doc(paragraph("a", "Same"), { type: "recordRef", attrs: { id: "b", nodeVersion: 1, recordId: "00000000-0000-4000-8000-0000000000c1", collectionId: "contacts", display: "card", fields: ["core:job-title", "core:email"] } });
  const copy = doc(paragraph("copy-a", "Copy only"), paragraph("copy-b", "Base"));
  const merged = mergeWorkingCopy({
    baseTitle: "T",
    base,
    originalTitle: "T",
    original,
    originalRaw: raw,
    copyTitle: "T",
    copy,
    blockMap: [{ sourceId: "a", copyId: "copy-a" }, { sourceId: "b", copyId: "copy-b" }],
    mediaMap: [],
    redacted: [],
    hiddenFields: [],
    choices: {},
  });
  expect(merged.unresolved).toEqual([]);
  expect(merged.document?.content?.[0]).toMatchObject({ content: [{ text: "Copy only" }] });
  expect(merged.document?.content?.[1]).toMatchObject({ type: "recordRef", attrs: { fields: ["core:job-title", "core:email"] } });
});

it("flags both order changes and keeps a redacted block from the raw original", () => {
  const base = doc(paragraph("a", "A"), paragraph("b", "B"), paragraph("c", "C"));
  const original = doc(paragraph("b", "B"), paragraph("c", "C"), paragraph("a", "A"));
  const raw = doc(paragraph("b", "B"), paragraph("c", "C"), paragraph("a", "A"), { type: "recordRef", attrs: { id: "d", recordId: "secret-record", collectionId: "contacts", display: "chip", fields: [], nodeVersion: 1 } });
  const copy = doc(paragraph("copy-c", "C"), paragraph("copy-a", "A"), paragraph("copy-b", "B"));
  const view = redactTopLevel(raw, new Set(["d"]), new Map());
  const merged = mergeWorkingCopy({
    baseTitle: "T",
    base,
    originalTitle: "Original title",
    original: view.document,
    originalRaw: raw,
    copyTitle: "Copy title",
    copy,
    blockMap: [{ sourceId: "a", copyId: "copy-a" }, { sourceId: "b", copyId: "copy-b" }, { sourceId: "c", copyId: "copy-c" }, { sourceId: "d", copyId: "copy-d" }],
    mediaMap: [],
    redacted: view.redacted,
    hiddenFields: [],
    choices: {},
  });
  expect(merged.conflicts.map(conflict => conflict.key).sort()).toEqual(["order", "title"]);
  expect(JSON.stringify(view.document)).not.toContain("secret-record");
  const applied = mergeWorkingCopy({
    baseTitle: "T",
    base,
    originalTitle: "Original title",
    original: view.document,
    originalRaw: raw,
    copyTitle: "Copy title",
    copy,
    blockMap: [{ sourceId: "a", copyId: "copy-a" }, { sourceId: "b", copyId: "copy-b" }, { sourceId: "c", copyId: "copy-c" }, { sourceId: "d", copyId: "copy-d" }],
    mediaMap: [],
    redacted: view.redacted,
    hiddenFields: [],
    choices: { order: "original", title: "copy" },
  });
  expect(applied.title).toBe("Copy title");
  expect(JSON.stringify(applied.document)).toContain("secret-record");
});

function pendingInput(base: RichNode, original: RichNode, copy: RichNode) {
  return { baseTitle: "T", base, originalTitle: "T", original, originalRaw: original, copyTitle: "T", copy, blockMap: [{ sourceId: "a", copyId: "copy-a" }], mediaMap: [], redacted: [], hiddenFields: [], choices: {} };
}
