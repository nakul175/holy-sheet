import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileKnowledgeSite, knowledgeSiteReport, renderPublicSite, type KnowledgeSiteDefinition, type SourcePage, type SourceRecord } from "./knowledge-site-plan";

const pageId = "00000000-0000-4000-8000-00000000a101";
const secretPage = "00000000-0000-4000-8000-00000000a102";
const mediaId = "00000000-0000-4000-8000-00000000a201";
const badMedia = "00000000-0000-4000-8000-00000000a202";
const recordId = "00000000-0000-4000-8000-00000000a301";
const secretField = "00000000-0000-4000-8000-00000000a401";
const objectKey = "tenants/secret/object-key";

function definition(extra: Record<string, unknown> = {}): KnowledgeSiteDefinition {
  return compileKnowledgeSite({
    pages: [{ pageId, revision: 2, path: "help/start", label: "Start" }],
    navigation: [{ path: "help/start", label: "Start", parent: null }],
    assets: [{ mediaId, pageId }],
    records: [{ recordId, fields: ["core:notes", secretField] }],
    edge: { cache: "no-store", residency: "tenant", public: false },
    cacheBoundSeconds: 0,
    ...extra,
  });
}

function source(): SourcePage {
  return {
    pageId, revision: 2, currentVersion: 3, title: "Approved help", ownerId: "owner-user", visibility: "private",
    document: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "APPROVED_HELP_TEXT", marks: [{ type: "link", attrs: { href: "https://files.example/secret-object" } }] }] },
        { type: "image", attrs: { attachmentId: mediaId, src: `/api/media/${mediaId}`, alt: "Help diagram" } },
        { type: "file", attrs: { attachmentId: badMedia, title: "secret.pdf" } },
        { type: "pageLink", attrs: { pageId: secretPage } },
      ],
    },
    acl: [{ subject: "secret-reader", role: "viewer" }],
    comments: [{ id: "comment-1", body: "CONFIDENTIAL_COMMENT" }],
    history: [{ version: 1, title: "SECRET_REVISION_TITLE" }, { version: 2, title: "Approved help" }, { version: 3, title: "SECRET_INTERNAL_UPDATE" }],
    assets: [
      { mediaId, name: "help.png", mime: "image/png", state: "ready", objectKey, deleted: false },
      { mediaId: badMedia, name: "secret.pdf", mime: "application/pdf", state: "rejected", objectKey: "tenants/secret/rejected-object", deleted: false },
    ],
  };
}

it("selects approved revisions and paths and keeps the public edge private", () => {
  const compiled = definition();
  expect(compiled.pages).toEqual([{ pageId, revision: 2, path: "help/start", label: "Start" }]);
  expect(compiled.navigation[0]).toEqual({ path: "help/start", label: "Start", parent: null });
  expect(compiled.edge).toEqual({ cache: "no-store", residency: "tenant", public: false });
  expect(compiled.cacheBoundSeconds).toBe(0);
  expect(() => definition({ edge: { cache: "public", residency: "tenant", public: true } })).toThrow(/no-store/i);
  expect(() => definition({ domain: "help.example" })).toThrow(/check the knowledge site/i);
  expect(() => definition({ pages: [{ pageId, revision: 2, path: "Help Start", label: "Start" }] })).toThrow(/check the knowledge site/i);
});

it("previews public content and lists sensitive dependencies without private payloads", () => {
  const record: SourceRecord = {
    recordId, name: "Visible clinic", view: true,
    values: { "core:notes": "Visible note", [secretField]: "hidden-salary-value" },
    fields: [{ key: "core:notes", sensitive: false, view: true }, { key: secretField, sensitive: true, view: true }],
  };
  const projection = renderPublicSite(definition(), [source()], [record]);
  const body = JSON.stringify(projection);
  expect(body).toContain("APPROVED_HELP_TEXT");
  expect(body).toContain("help.png");
  expect(body).toContain("Visible note");
  expect(body).not.toContain("CONFIDENTIAL_COMMENT");
  expect(body).not.toContain("secret-reader");
  expect(body).not.toContain("SECRET_REVISION_TITLE");
  expect(body).not.toContain("SECRET_INTERNAL_UPDATE");
  expect(body).not.toContain("SECRET_PAGE_TITLE");
  expect(body).not.toContain(objectKey);
  expect(body).not.toContain("/api/media/");
  expect(body).not.toContain("https://files.example/secret-object");
  expect(body).not.toContain("secret.pdf");
  expect(body).not.toContain("hidden-salary-value");
  expect(body).not.toContain("owner-user");
  expect(projection.assets).toEqual([{ mediaId, pageId, name: "help.png", mime: "image/png", scan: "clean", quarantined: false, url: null }]);
  expect(projection.liveSite).toBe(false);
  expect(projection.sharing).toBe("off");
  expect(projection.domain).toBeNull();
  expect(projection.manifest).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "comment", reason: "stripped", included: false }),
    expect.objectContaining({ kind: "acl", reason: "stripped", included: false }),
    expect.objectContaining({ kind: "history", reason: "newer-revision", included: false }),
    expect.objectContaining({ kind: "asset", reason: "quarantine", included: false }),
    expect.objectContaining({ kind: "page", id: secretPage, reason: "private", included: false }),
    expect.objectContaining({ kind: "field", id: secretField, reason: "sensitive", included: false }),
    expect.objectContaining({ kind: "url", reason: "direct-url", included: false }),
  ]));
  const report = knowledgeSiteReport("Help centre", projection);
  expect(report).toContain("Cache bound: 0 seconds.");
  expect(report).toContain("do not retract copies already held by a third party");
  expect(report).not.toContain(objectKey);
  const sql = readFileSync("db/135_public_knowledge_sites.sql", "utf8").replace(/--.*$/gm, "");
  expect(sql).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(sql).not.toMatch(/parent_organisation_id/);
  expect(sql).not.toMatch(/release\.py/);
});
