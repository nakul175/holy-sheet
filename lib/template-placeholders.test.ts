import { describe, expect, it } from "vitest";
import { ensureIds, validateDocument } from "./document";
import { applyTemplateString, bindTemplateDocument, inspectTemplate, placeholderPrompts, recordPlaceholderAttributeError, todayIst } from "./template-placeholders";

const placeholder = (display: "chip" | "card" | "view", extra: Record<string, unknown> = {}) => ({
  type: "recordPlaceholder",
  attrs: { id: "client-block", key: "client", label: "Client", collectionId: "organisations", display, fields: display === "card" ? ["core:notes"] : [], columns: display === "view" ? ["name"] : [], limit: 10, ...extra },
});

describe("template placeholders", () => {
  it("reads variables in order and groups record placeholders without record values", () => {
    const document = validateDocument(ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello {{client}} on {{date}}" }] }, placeholder("chip"), placeholder("card", { id: "client-card" }), placeholder("view", { id: "client-view" })] }));
    expect(inspectTemplate(document).variables).toEqual(["client", "date"]);
    expect(placeholderPrompts(document)).toEqual([{ key: "client", label: "Client", collectionId: "organisations", displays: ["chip", "card", "view"] }]);
    expect(JSON.stringify(document)).not.toContain("secret-note");
  });

  it("defaults a missing date token to the IST calendar day and inserts the other values once", () => {
    expect(todayIst(new Date("2026-11-02T20:30:00.000Z"))).toBe("03 Nov 2026");
    expect(applyTemplateString("{{client}} / {{date}} / {{client}}", { client: "North", date: "03 Nov 2026" })).toBe("North / 03 Nov 2026 / North");
    const bound = bindTemplateDocument(validateDocument(ensureIds({ type: "doc", content: [placeholder("chip")] })), {}, new Map([["client-block", { type: "paragraph", attrs: { id: "kept" } }]]));
    expect(bound.content?.[0].type).toBe("paragraph");
  });

  it("rejects a placeholder that would carry nested content or a record value", () => {
    expect(recordPlaceholderAttributeError({ key: "Client", label: "Client", collectionId: "organisations", display: "chip" })).toMatch(/invalid/i);
    expect(() => validateDocument({ type: "doc", content: [{ ...placeholder("chip"), content: [{ type: "text", text: "hidden" }] }] })).toThrow(/nested/i);
  });
});
