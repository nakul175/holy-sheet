import { expect, it } from "vitest";
import { bodyShape, median, runOracle } from "../scripts/verify-space-directory-leak-oracle.mjs";

function response(body: string, status = 404, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "private, no-store", vary: "cookie", ...extra } });
}

it("compares exactly twenty interleaved hidden and missing responses without returning request data", async () => {
  const calls: Array<{ url: string; cookie: string | null }> = [];
  let tick = 0;
  const result = await runOracle({
    hidden: { url: "https://staging.example.test/s/secret", method: "GET" },
    control: { url: "https://staging.example.test/s/missing", method: "GET" },
    cookie: "session=never-print-this",
    clock: () => ++tick,
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), cookie: headers.get("cookie") });
      return response('{"code":"not_found","message":"This space is unavailable"}');
    },
  });
  expect(calls).toHaveLength(40);
  expect(calls.filter(call => call.url.endsWith("/secret"))).toHaveLength(20);
  expect(calls.filter(call => call.url.endsWith("/missing"))).toHaveLength(20);
  expect(calls.every(call => call.cookie === "session=never-print-this")).toBe(true);
  expect(result).toMatchObject({ runsPerTarget: 20, pass: true, comparable: { hiddenStable: true, controlStable: true, status: true, headers: true, bodyShape: true, bodyDigest: true } });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("missing");
  expect(JSON.stringify(result)).not.toContain("never-print-this");
});

it("fails when a foreign target differs from the missing control", async () => {
  let tick = 0;
  const result = await runOracle({
    hidden: { url: "https://staging.example.test/api/migration/foreign", method: "POST", body: { targetSpaceId: "foreign" } },
    control: { url: "https://staging.example.test/api/migration/missing", method: "POST", body: { targetSpaceId: "missing" } },
    cookie: "session=opaque",
    clock: () => ++tick,
    fetchImpl: async url => String(url).endsWith("/foreign") ? response('{"code":"forbidden"}', 403) : response('{"code":"not_found"}', 404),
  });
  expect(result.pass).toBe(false);
  expect(result.comparable).toMatchObject({ status: false, bodyDigest: false });
});

it("fails when either target changes shape between runs", async () => {
  let tick = 0;
  let hiddenCalls = 0;
  const result = await runOracle({
    hidden: { url: "https://staging.example.test/s/secret", method: "GET" },
    control: { url: "https://staging.example.test/s/missing", method: "GET" },
    cookie: "session=opaque",
    clock: () => ++tick,
    fetchImpl: async url => {
      if (String(url).endsWith("/secret")) {
        hiddenCalls += 1;
        return response(hiddenCalls === 20 ? '{"code":"different"}' : '{"code":"not_found"}');
      }
      return response('{"code":"not_found"}');
    },
  });
  expect(result.pass).toBe(false);
  expect(result.comparable.hiddenStable).toBe(false);
});

it("summarizes JSON structure and calculates an even median", () => {
  expect(bodyShape('{"message":"hidden","meta":{"count":2},"items":[1,2]}')).toEqual({
    kind: "json",
    shape: { items: { array: ["number"] }, message: "string", meta: { count: "number" } },
  });
  expect(median([9, 1, 5, 3])).toBe(4);
});
