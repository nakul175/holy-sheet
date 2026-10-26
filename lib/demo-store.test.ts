import { describe, expect, it } from "vitest";
import { createDemoPage, saveDemoPage } from "./demo-store";

describe("demo page store", () => {
  it("preserves stable IDs and rejects stale saves", () => {
    const created = createDemoPage({ title: "Runbook", spaceId: "space-product" });
    const blocks = [{ id: "stable", pageId: created.id, parentBlockId: null, type: "paragraph" as const, text: "First", position: 0 }];
    const saved = saveDemoPage(created.id, 1, created.title, blocks);
    expect(saved.status).toBe("saved");
    if (saved.status === "saved") expect(saved.page.blocks[0].id).toBe("stable");
    expect(saveDemoPage(created.id, 1, created.title, blocks).status).toBe("conflict");
  });
});
