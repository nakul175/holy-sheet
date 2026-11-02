import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { RichNode } from "../../lib/document";

/** Inserts one search reference as a single editor transaction so one undo removes it. */
export function insertSearchNode(editor: Editor, node: RichNode) {
  const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
  return editor.chain().focus().insertContent(node).command(({ tr }) => {
    let after = tr.selection.from;
    tr.doc.descendants((child, pos) => {
      if (id && child.attrs?.id === id) after = pos + child.nodeSize;
    });
    const next = Math.max(0, Math.min(after, tr.doc.content.size));
    tr.setSelection(TextSelection.near(tr.doc.resolve(next), 1));
    return true;
  }).run();
}
