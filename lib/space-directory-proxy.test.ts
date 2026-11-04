import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  readSpaceBySlug: vi.fn(),
}));

vi.mock("./auth", () => ({ authenticate: mocks.authenticate, localPreview: () => false }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./published-pages", () => ({ resolvePublishedPage: vi.fn() }));
vi.mock("./space-directory", () => ({
  readSpaceBySlug: mocks.readSpaceBySlug,
  SPACE_UNAVAILABLE: "This space is unavailable",
}));

import { proxy } from "../proxy";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ id: "viewer" });
  mocks.repository.mockResolvedValue({});
  mocks.readSpaceBySlug.mockRejectedValue(new Error("hidden or missing"));
});

it("returns byte-identical JSON for a hidden and a missing one-segment space slug", async () => {
  const request = (slug: string) => new NextRequest(`https://staging.holysheet.aplyd.org/s/${slug}`, {
    headers: { accept: "application/json", cookie: "opaque=test" },
  });
  const hidden = await proxy(request("n47-secret"));
  const missing = await proxy(request("n47-missing"));
  expect(hidden.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(await hidden.text()).toBe(await missing.text());
  expect(hidden.headers.get("content-type")).toBe(missing.headers.get("content-type"));
  expect(hidden.headers.get("cache-control")).toBe(missing.headers.get("cache-control"));
  expect(hidden.headers.get("vary")).toBe(missing.headers.get("vary"));
});

it("leaves ordinary HTML space navigation on the page route", async () => {
  const response = await proxy(new NextRequest("https://staging.holysheet.aplyd.org/s/n47-open", {
    headers: { accept: "text/html" },
  }));
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(mocks.authenticate).not.toHaveBeenCalled();
});
