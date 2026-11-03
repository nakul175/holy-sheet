import { expect, it } from "vitest";
import { rememberLocalCapture, sourceAccessMessage } from "./quick-capture-local";
import { assertCapturePolicy, captureUrl, prepareCapture, sanitiseCapture } from "./quick-capture-plan";

const pasted = `<p>Visible note</p><input type="hidden" name="csrf" value="secret-token"><input name="cookie" value="session=abc"><script>document.cookie='session=abc'</script><div style="display:none">hidden-cookie-value</div><a href="javascript:alert(1)">click</a><a href="https://user:secret@example.test/path">leaked</a><a href="https://example.com/clip">Safe</a><img src="https://tracker.example/pixel.png" alt="Diagram"><img src="https://tracker.example/other.png" alt="Skipped">`;

it("drops scripts, hidden values, cookies, unsafe addresses, and unselected images", () => {
  const clean = sanitiseCapture(pasted, []);
  const encoded = JSON.stringify(clean);
  expect(clean.text).toContain("Visible note");
  expect(clean.text).toContain("click");
  expect(clean.text).toContain("Safe");
  expect(clean.links.map(link => link.href)).toEqual(["https://example.com/clip"]);
  expect(encoded).not.toContain("secret-token");
  expect(encoded).not.toContain("document.cookie");
  expect(encoded).not.toContain("session=abc");
  expect(encoded).not.toContain("hidden-cookie-value");
  expect(encoded).not.toContain("javascript:");
  expect(encoded).not.toContain("user:secret");
  expect(encoded).not.toContain("tracker.example");
  expect(encoded).not.toContain("Diagram");
  expect(clean.assets).toEqual([]);
  expect(clean.excluded).toEqual(expect.arrayContaining(["script", "hidden-field", "cookie", "unsafe-url", "remote-image", "unselected-asset"]));
});

it("cites a selected asset without fetching or storing its address", () => {
  const clean = sanitiseCapture(pasted, ["Diagram"]);
  expect(clean.assets).toEqual([{ name: "Diagram", imported: true, fetched: false }]);
  expect(JSON.stringify(clean)).not.toContain("tracker.example");
  expect(JSON.stringify(clean)).not.toContain("Skipped");
});

it("rejects an inherited share, a fetched source, and an unsafe link", () => {
  expect(() => assertCapturePolicy({ visibility: "space" })).toThrow(/private/i);
  expect(() => assertCapturePolicy({ inheritExternal: true })).toThrow(/external sharing/i);
  expect(() => assertCapturePolicy({ offlinePolicy: "sync" })).toThrow(/local draft/i);
  expect(captureUrl("javascript:alert(1)")).toBeNull();
  expect(captureUrl("https://user:secret@example.test/a")).toBeNull();
  expect(() => prepareCapture({ kind: "link", title: "A link", sourceUrl: "javascript:alert(1)", allowedKinds: ["link"] })).toThrow(/not opened/i);
  expect(() => prepareCapture({ kind: "note", title: "Note", body: "Hello", sourceAccess: "fetched", allowedKinds: ["note"] })).toThrow(/not opened/i);
});

it("dedupes a local draft and keeps the original when a retry changes", () => {
  const draft = {
    version: 1 as const, policy: "local-draft" as const, authoritative: false as const, actorId: "ada", workspaceId: "ws",
    operationId: "00000000-0000-4000-8000-0000000000c1", kind: "note" as const, title: "Clinic", body: "Hours", sourceUrl: "https://example.com/a",
    sourceTitle: "Hours", sourceAccess: "not-opened" as const, destinationKind: "space" as const, destinationId: "space-private", savedAt: "2026-11-03T00:00:00.000Z",
  };
  const first = rememberLocalCapture(null, draft);
  const second = rememberLocalCapture(first.store, draft);
  expect(second.replayed).toBe(true);
  expect(Object.keys(second.store.drafts)).toEqual([draft.operationId]);
  expect(() => rememberLocalCapture(second.store, { ...draft, body: "Changed" })).toThrow(/local draft is kept/i);
  expect(second.store.drafts[draft.operationId].body).toBe("Hours");
  expect(() => rememberLocalCapture(null, { ...draft, operationId: "00000000-0000-4000-8000-0000000000c2", sourceAccess: "fetched" as "not-opened", authoritative: false })).toThrow(/not opened/i);
  expect(sourceAccessMessage("unavailable", "https://example.com/a")).toContain("Nothing was fetched");
  expect(sourceAccessMessage("not-opened", "https://example.com/a")).toContain("not opened");
  const other = rememberLocalCapture({ ...first.store, actorId: "someone-else" }, draft);
  expect(other.store.actorId).toBe("ada");
  expect(Object.keys(other.store.drafts)).toEqual([draft.operationId]);
});
