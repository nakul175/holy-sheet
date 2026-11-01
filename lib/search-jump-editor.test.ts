/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Node } from "@tiptap/core";
import { SEARCH_BLOCK_HIGHLIGHT_MS } from "./search-jump-model";
import { insertSearchNode } from "../components/editor/search-insert";
import { revealSearchBlock } from "../components/editor/search-block-jump";

const RecordAtom = Node.create({ name: "recordRef", group: "block", atom: true, addAttributes() { return { id: { default: null }, nodeVersion: { default: 1 }, recordId: { default: null }, collectionId: { default: null }, display: { default: "chip" }, fields: { default: [] } }; }, renderHTML: () => ["div", { "data-record-ref": "" }] });
const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); vi.useRealTimers(); });

it("inserts a live reference as one undoable step and returns focus after the node", () => {
  const editor = new Editor({ element: document.createElement("div"), extensions: [StarterKit.configure({ trailingNode: false }), RecordAtom], content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Caret" }] }] } });
  editors.push(editor);
  editor.commands.setTextSelection(2);
  const before = editor.getJSON();
  const node = { type: "recordRef", attrs: { id: "block-1", nodeVersion: 1, recordId: "00000000-0000-4000-8000-000000000010", collectionId: "organisations", display: "card", fields: [] } };
  expect(insertSearchNode(editor, node)).toBe(true);
  expect(JSON.stringify(editor.getJSON())).toContain("block-1");
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
  insertSearchNode(editor, node);
  let nodeAt = -1;
  editor.state.doc.descendants((child, at) => { if (child.attrs.id === "block-1") nodeAt = at; });
  expect(nodeAt).toBeGreaterThanOrEqual(0);
  expect(editor.state.selection.from).toBeGreaterThan(nodeAt);
});

it("opens a collapsed section, scrolls to the block, and clears the highlight", () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div class="rich-prose" role="textbox"><div data-type="details" data-id="section" class=""><button aria-expanded="false">Toggle</button><div><div data-type="detailsContent" hidden><h2 data-id="escalation">Escalation</h2></div></div></div></div>';
  const root = document.querySelector<HTMLElement>(".rich-prose")!;
  const heading = root.querySelector<HTMLElement>('[data-id="escalation"]')!;
  heading.scrollIntoView = vi.fn();
  expect(revealSearchBlock(root, "escalation", "actor:ws:page", SEARCH_BLOCK_HIGHLIGHT_MS)).toBe(true);
  expect(root.querySelector('[data-type="details"]')?.classList.contains("is-open")).toBe(true);
  expect(root.querySelector('[data-type="detailsContent"]')?.hasAttribute("hidden")).toBe(false);
  expect(heading.classList.contains("hs-block-highlight")).toBe(true);
  expect(heading.scrollIntoView).toHaveBeenCalled();
  vi.advanceTimersByTime(SEARCH_BLOCK_HIGHLIGHT_MS);
  expect(heading.classList.contains("hs-block-highlight")).toBe(false);
  expect(SEARCH_BLOCK_HIGHLIGHT_MS).toBe(2000);
});
