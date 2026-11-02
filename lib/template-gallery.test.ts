// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ default: () => createElement("div", null, "Template body"), Dialog: ({ children, title }: { children: ReactNode; title: string }) => createElement("div", { role: "dialog", "aria-label": title }, children) }));
import TemplatesDialog from "../components/templates-dialog";

const space = (index: number, category: string) => ({ id: `space-${index}`, name: `Space pack ${index}`, description: "Onboarding", category, restricted: false, scope: "space" as const, creator: "Owner", updatedAt: "2026-11-02T02:00:00.000Z", draftVersion: 1, publishedVersion: 1 });
const personal = (index: number) => ({ id: `personal-${index}`, name: `Personal pack ${index}`, description: "Mine", category: "Notes", restricted: false, scope: "personal" as const, creator: "Editor", updatedAt: "2026-11-02T02:00:00.000Z", draftVersion: 1, publishedVersion: 1 });

it("opens a gallery with search, categories and a preview that does not include record values", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const templates = [space(0, "Clients"), space(1, "Operations"), space(2, "Clients"), space(3, "Operations"), personal(0), personal(1), personal(2), personal(3)];
  const preview = { ...space(0, "Clients"), revision: 1, document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello {{client}}" }] }] }, variables: ["client", "date"], placeholders: [{ key: "client", label: "Client", collectionId: "organisations", displays: ["chip"] }], dateDefault: "02 Nov 2026" };
  mocks.request.mockResolvedValueOnce({ templates }).mockResolvedValueOnce(preview);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(TemplatesDialog, { workspaceId: "w", initialSpaceId: "s", spaces: [{ id: "s", workspaceId: "w", name: "Ops" }], gallery: true, onBlank: vi.fn(), onClose: vi.fn(), onCreated: vi.fn() })));
    expect(host.querySelector("[role='dialog']")?.getAttribute("aria-label")).toBe("New page");
    const names = [...host.querySelectorAll(".template-cards strong")].map(node => node.textContent);
    expect(names.slice(0, 4).every(name => name?.startsWith("Space pack"))).toBe(true);
    expect(names.slice(4).every(name => name?.startsWith("Personal pack"))).toBe(true);
    expect(host.textContent).not.toContain("salary-should-not-leak");
    const category = host.querySelector<HTMLSelectElement>("[aria-label='Template category']");
    await act(async () => { category!.value = "Notes"; category!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect([...host.querySelectorAll(".template-cards strong")].map(node => node.textContent)).toEqual(["Personal pack 0", "Personal pack 1", "Personal pack 2", "Personal pack 3"]);
    await act(async () => { category!.value = "all"; category!.dispatchEvent(new Event("change", { bubbles: true })); });
    const search = host.querySelector<HTMLInputElement>("[aria-label='Search templates']");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(search, "Operations"); search!.dispatchEvent(new Event("input", { bubbles: true })); });
    expect([...host.querySelectorAll(".template-cards strong")].map(node => node.textContent)).toEqual(["Space pack 1", "Space pack 3"]);
    await act(async () => host.querySelector<HTMLButtonElement>(".template-cards button")!.click());
    expect(host.textContent).toContain("Space pack 0");
    expect(host.querySelector<HTMLInputElement>("[aria-label='Value for date']")?.value).toBe("02 Nov 2026");
    expect(host.querySelector("[aria-label='Search Client records']")).toBeTruthy();
    expect(host.textContent).not.toContain("salary-should-not-leak");
    expect(mocks.request.mock.calls.some(call => String(call[0]).includes("record-refs"))).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
