import { expect, it } from "vitest";
import { ensureIds, type RichNode } from "./document";
import { summarizePageChange } from "./page-follow-diff";

const heading = "heading-1";
const paragraph = "paragraph-1";

function page(headingText: string, text: string, extra?: string): RichNode {
  const content: RichNode[] = [
    { type: "heading", attrs: { id: heading, level: 2 }, content: [{ type: "text", text: headingText }] },
    { type: "paragraph", attrs: { id: paragraph }, content: [{ type: "text", text }] },
  ];
  if (extra !== undefined) content.push({ type: "paragraph", attrs: { id: "paragraph-2" }, content: [{ type: "text", text: extra }] });
  return ensureIds({ type: "doc", content });
}

it("ignores whitespace-only edits and summarizes blocks and headings", () => {
  const before = page("Scope", "One");
  expect(summarizePageChange(before, "Handbook", page("Scope", "One   "), "Handbook ").meaningful).toBe(false);
  const text = summarizePageChange(before, "Handbook", page("Scope updated", "Two"), "Handbook");
  expect(text.meaningful).toBe(true);
  expect(text.summary).toContain("Headings changed: Scope updated");
  expect(text.summary).not.toContain("Two");
  const added = summarizePageChange(before, "Handbook", page("Scope", "One", "More"), "Handbook");
  expect(added.summary).toContain("+1 / -0 blocks");
  expect(added.summary).not.toContain("More");
});
