// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import UniqueID from "@tiptap/extension-unique-id";
import { expect, it } from "vitest";
import { SyncedBlock } from "../components/editor/synced-block";
import { SnippetPlacementChrome } from "../components/editor/snippet-block";
import { ensureIds, idTypes, type RichNode } from "./document";
import { SNIPPET_DELETED_BADGE, SNIPPET_DETACH_LABEL, SNIPPET_EDIT_LABEL, SNIPPET_RESTRICTED_LABEL, SNIPPET_RETIRED_BADGE, SNIPPET_UPDATE_LABEL } from "./snippet-copy";

function editorFor(content: RichNode[]) {
  return new Editor({ extensions: [StarterKit.configure({ trailingNode: false }), SyncedBlock, UniqueID.configure({ types: idTypes })], content: ensureIds({ type: "doc", content }) });
}

it("refuses typing inside a snippet placement", () => {
  const editor = editorFor([{ type: "syncedBlock", attrs: { snippetId: crypto.randomUUID(), syncLocked: true, syncState: "live" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Approved wording" }] }] }]);
  try {
    const before = JSON.stringify(editor.getJSON());
    editor.commands.setTextSelection(2);
    editor.commands.insertContent("HACKED");
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    expect(JSON.stringify(editor.getJSON())).not.toContain("HACKED");
  } finally { editor.destroy(); }
});

it("reuses the restricted placeholder and shows snippet chrome", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SnippetPlacementChrome, {
      view: { state: "live", label: "Medical disclaimer", badge: SNIPPET_RETIRED_BADGE, updateLabel: SNIPPET_UPDATE_LABEL, approvedAtIst: "01 Nov 2026, 09:41 IST" },
      editHref: "/workspaces/ws/snippets?snippet=1",
      onDetach: () => undefined,
      onUpdate: () => undefined,
    })));
    expect(host.textContent).toContain(SNIPPET_EDIT_LABEL);
    expect(host.textContent).toContain(SNIPPET_DETACH_LABEL);
    expect(host.textContent).toContain(SNIPPET_UPDATE_LABEL);
    expect(host.textContent).toContain(SNIPPET_RETIRED_BADGE);
    await act(async () => root.render(createElement(SnippetPlacementChrome, { view: { state: "live", label: "Medical disclaimer", badge: SNIPPET_DELETED_BADGE, updateLabel: null, approvedAtIst: null } })));
    expect(host.textContent).toContain(SNIPPET_DELETED_BADGE);
    await act(async () => root.render(createElement(SnippetPlacementChrome, { view: { state: "restricted", label: SNIPPET_RESTRICTED_LABEL, badge: null, updateLabel: null, approvedAtIst: null } })));
    expect(host.textContent).toContain(SNIPPET_RESTRICTED_LABEL);
    expect(host.textContent).not.toContain("SECRET_SNIPPET");
    expect(host.querySelector("[data-synced-state='restricted']")).toBeTruthy();
  } finally { root.unmount(); }
});
