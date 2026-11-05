// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import InPageSubpages from "../components/in-page-subpages";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", () => ({ requestJson: mocks.request }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); mocks.request.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(canCreate = true) { await act(async () => root.render(createElement(InPageSubpages, { workspaceId: "ws", spaceId: "space", pageId: "parent", canCreate, onOpen: vi.fn(), onCreate: vi.fn() }))); await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

it("shows only direct readable children from the permission-filtered tree endpoint", async () => {
  mocks.request.mockResolvedValue({ workspaceId: "ws", spaceId: "space", parentId: "parent", treeVersion: 3, canCreateInSpace: true, nextCursor: null, nodes: [{ id: "visible", title: "Visible child", spaceId: "space", parentId: "parent", position: 0, version: 1, role: "viewer", hasVisibleChildren: false }] });
  await render(false);
  expect(mocks.request).toHaveBeenCalledWith("/api/v1/workspaces/ws/page-tree?spaceId=space&parentId=parent");
  expect(host.getElementsByTagName("h2")[0]?.textContent).toBe("Subpages");
  expect(host.textContent).toContain("Visible child");
  expect(host.textContent).not.toContain("Hidden child");
  expect(host.querySelector("button[aria-label='Open subpage Visible child']")).not.toBeNull();
  expect(host.textContent).not.toContain("Add subpage");
});

it("offers a compact first-subpage action to an editor and stays absent for an empty read-only page", async () => {
  mocks.request.mockResolvedValue({ workspaceId: "ws", spaceId: "space", parentId: "parent", treeVersion: 3, canCreateInSpace: true, nextCursor: null, nodes: [] });
  await render(true);
  expect(host.textContent).toContain("Break out a substantial section");
  expect(host.textContent).toContain("Add subpage");
  await act(async () => root.unmount()); root = createRoot(host);
  await render(false);
  expect(host.querySelector(".in-page-subpages")).toBeNull();
});
