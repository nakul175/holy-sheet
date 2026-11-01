// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import UniqueID from "@tiptap/extension-unique-id";
import { expect, it } from "vitest";
import { ensureIds, idTypes, validateDocument, type RichNode } from "./document";
import { normalizeRichDocument } from "./editor-document";
import { SYNCED_CONFLICT_MESSAGE, SYNCED_POLL_MS, parseSyncedClipboard, syncedClipboardPayload, syncedPlacementLabel } from "./synced-block-copy";
import { applyRemoteSyncedContent, purgeSyncedContent, turnIntoSyncedBlock, unsyncLocal } from "./synced-block-editor";
import { SyncedBlock, SyncedBlockChrome, SyncedBlockFrame } from "../components/editor/synced-block";

function editorFor(content: RichNode[]) {
  return new Editor({ extensions: [StarterKit.configure({ trailingNode: false }), SyncedBlock, UniqueID.configure({ types: idTypes })], content: ensureIds({ type: "doc", content }) });
}

it("turns three blocks into one synced block and one undo restores them", () => {
  const editor = editorFor([
    { type: "paragraph", content: [{ type: "text", text: "One" }] },
    { type: "paragraph", content: [{ type: "text", text: "Two" }] },
    { type: "paragraph", content: [{ type: "text", text: "Three" }] },
  ]);
  try {
    const before = editor.getJSON();
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    turnIntoSyncedBlock(editor);
    const wrapped = editor.getJSON() as RichNode;
    expect(wrapped.content).toHaveLength(1);
    expect(wrapped.content![0].type).toBe("syncedBlock");
    expect(wrapped.content![0].content).toHaveLength(3);
    expect(() => validateDocument(normalizeRichDocument(wrapped))).not.toThrow();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  } finally { editor.destroy(); }
});

it("copies a placement payload and unsyncs one local copy", () => {
  const syncedId = crypto.randomUUID();
  expect(parseSyncedClipboard(syncedClipboardPayload(syncedId))).toBe(syncedId);
  expect(parseSyncedClipboard("hello")).toBeNull();
  const editor = editorFor([{ type: "syncedBlock", attrs: { syncedId, syncState: "live" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Kept" }] }] }]);
  try {
    const id = String((editor.getJSON() as RichNode).content![0].attrs!.id);
    unsyncLocal(editor, id);
    const next = editor.getJSON() as RichNode;
    expect(next.content![0].type).toBe("paragraph");
    expect(JSON.stringify(next)).toContain("Kept");
    expect(editor.commands.undo()).toBe(true);
    expect((editor.getJSON() as RichNode).content![0].type).toBe("syncedBlock");
  } finally { editor.destroy(); }
});

it("applies a remote edit and purges restricted content from the document", () => {
  expect(SYNCED_POLL_MS).toBeLessThanOrEqual(5000);
  const editor = editorFor([{ type: "syncedBlock", attrs: { syncVersion: 1, syncState: "live" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Old secret" }] }] }]);
  try {
    const id = String((editor.getJSON() as RichNode).content![0].attrs!.id);
    expect(applyRemoteSyncedContent(editor, id, [{ type: "paragraph", attrs: { id: crypto.randomUUID() }, content: [{ type: "text", text: "New shared" }] }], 2)).toBe(true);
    expect(JSON.stringify(editor.getJSON())).toContain("New shared");
    expect(JSON.stringify(editor.getJSON())).not.toContain("Old secret");
    expect(purgeSyncedContent(editor, id)).toBe(true);
    const purged = JSON.stringify(editor.getJSON());
    expect(purged).not.toContain("New shared");
    expect((editor.getJSON() as RichNode).content![0].attrs).toMatchObject({ syncState: "restricted", syncedId: null });
  } finally { editor.destroy(); }
});

it("renders synced chrome, the restricted placeholder, and both conflict versions", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SyncedBlockChrome, {
      view: { state: "live", label: syncedPlacementLabel(2), pages: [{ id: "p-100", title: "P-100" }, { id: "p-101", title: "P-101" }], canEdit: true, hint: null, updatedAtIst: "01 Nov 2026, 09:41 IST" },
      onCopy: () => undefined,
      onUnsync: () => undefined,
      onDeleteAll: () => undefined,
      conflict: { serverText: "Server copy", clientText: "Local copy" },
    })));
    expect(host.querySelector(".synced-label")?.textContent).toBe("Synced to 2 pages");
    expect(host.textContent).toContain("P-100");
    expect(host.textContent).toContain("Copy synced block");
    expect(host.textContent).toContain(SYNCED_CONFLICT_MESSAGE);
    expect(host.textContent).toContain("Server copy");
    expect(host.textContent).toContain("Local copy");
    expect(host.textContent).toContain("01 Nov 2026, 09:41 IST");
    await act(async () => root.render(createElement(SyncedBlockFrame, { view: { state: "live", label: "Synced" }, content: "SECRET_SYNC_BODY" })));
    expect(host.textContent).toContain("SECRET_SYNC_BODY");
    await act(async () => root.render(createElement(SyncedBlockFrame, { view: { state: "restricted", label: "Restricted content" }, content: "SECRET_SYNC_BODY" })));
    expect(host.textContent).toContain("Restricted content");
    expect(host.textContent).not.toContain("SECRET_SYNC_BODY");
    expect(host.querySelector(".synced-block")?.className).toContain("synced-block");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
