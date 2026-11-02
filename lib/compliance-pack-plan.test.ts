import { expect, it } from "vitest";
import { ensureIds } from "./document";
import {
  ATTACHMENTS_EXCLUDED_NOTE,
  RESTRICTED_RECORD,
  acknowledgementEvidenceCsv,
  attachmentFile,
  auditEvidenceCsv,
  exporterVisibleRecords,
  recordSnapshotFiles,
  renderComplianceHtml,
  restorerCanIncludeTrash,
  selectAttachmentDescriptors,
  sha256Bytes,
  signManifest,
  verifyComplianceManifest,
  type AttachmentDescriptor,
} from "./compliance-pack-plan";
import type { RecordExportSlice } from "./record-page-refs";

const recordId = "00000000-0000-4000-8000-000000000100";
const hidden = "00000000-0000-4000-8000-000000000200";

it("keeps exporter-visible record fields and labels a hidden record", () => {
  const slices: Record<string, RecordExportSlice> = {
    [recordId]: { kind: "record", available: true, title: "Northwind", url: "https://hs.example/record", fields: [{ label: "Job title", value: "Analyst" }, { label: "Email", value: null }] },
    [hidden]: { kind: "record", available: false },
  };
  const visible = exporterVisibleRecords(slices);
  expect(visible?.[recordId]).toMatchObject({ fields: [{ label: "Job title", value: "Analyst" }] });
  const files = recordSnapshotFiles(slices);
  const text = files.files.map(file => file.bytes.toString("utf8")).join("\n");
  expect(text).toContain("Analyst");
  expect(text).toContain(RESTRICTED_RECORD);
  expect(text).not.toContain("Email");
  expect(text).not.toContain(hidden);
  expect(files).toMatchObject({ records: 1, restrictedRecords: 1 });
});

it("signs a manifest over file hashes and verifies it", () => {
  const body = Buffer.from("hello\n", "utf8");
  const signed = signManifest({
    jobId: "job",
    scope: "space",
    format: "compliance-pack",
    createdAt: "2026-11-02T00:00:00.000Z",
    createdAtIst: "02 Nov 2026, 05:30 IST",
    counts: { pages: 1, records: 0, restrictedRecords: 0, attachments: 0, acknowledgements: 0, auditRows: 0 },
    notes: [ATTACHMENTS_EXCLUDED_NOTE],
    files: [{ path: "pages/a/current.html", sha256: sha256Bytes(body) }],
  }, "hs-n49-dev-signing-key");
  expect(verifyComplianceManifest(signed.document, "hs-n49-dev-signing-key")).toBe(true);
  expect(verifyComplianceManifest({ ...signed.document, signature: "0".repeat(64) }, "hs-n49-dev-signing-key")).toBe(false);
  expect(signed.document.notes).toEqual([ATTACHMENTS_EXCLUDED_NOTE]);
});

it("writes acknowledgement chain hashes and omits audit bodies", () => {
  const ack = acknowledgementEvidenceCsv([{ name: "=Ada", status: "acknowledged", versionLabel: "v2", acknowledgedAtIst: "02 Nov 2026, 12:00 IST", chainHash: "ab".repeat(32), prevHash: "0".repeat(64) }]).toString("utf8");
  expect(ack.split("\n")[0]).toBe("name,status,version,acknowledged_at_ist,chain_hash,prev_hash");
  expect(ack).toContain("'=Ada");
  expect(ack).toContain("ab".repeat(32));
  const audit = auditEvidenceCsv([{ action: "page.note", actorId: "ada", pageId: "p", correlationId: "op", atIst: "02 Nov 2026, 12:00 IST" }]).toString("utf8");
  expect(audit).toContain("page.note");
  expect(audit).not.toContain("secret");
});

it("selects the current attachment unless every version was requested", () => {
  const current: AttachmentDescriptor = { name: "now.txt", mime: "text/plain", sha256: "a".repeat(64), size: 1, version: 2 };
  const older: AttachmentDescriptor = { name: "old.txt", mime: "text/plain", sha256: "b".repeat(64), size: 1, version: 1 };
  expect(selectAttachmentDescriptors(current, [older, current], false).map(item => item.version)).toEqual([2]);
  expect(selectAttachmentDescriptors(current, [older, current], true).map(item => item.version)).toEqual([1, 2]);
  const file = attachmentFile("page", current, false);
  expect(file.path).toContain("page");
  expect(file.bytes.toString("utf8")).not.toContain("object");
});

it("renders restricted records without their identifiers", () => {
  const html = renderComplianceHtml({
    title: "Visible page",
    document: ensureIds({ type: "doc", content: [{ type: "recordRef", attrs: { nodeVersion: 1, recordId: hidden, collectionId: "contacts", display: "chip", fields: [] } }, { type: "paragraph", content: [{ type: "text", text: "Shown sentence" }] }, { type: "file", attrs: { attachmentId: "00000000-0000-4000-8000-0000000000aa", title: "Hidden file" } }] }),
    records: { [hidden]: { kind: "record", available: false } },
    attachmentsExcluded: true,
  });
  expect(html).toContain(RESTRICTED_RECORD);
  expect(html).toContain("Shown sentence");
  expect(html).toContain("Attachment excluded by export policy.");
  expect(html).not.toContain(hidden);
});

it("lets only a restorer opt into trash", () => {
  expect(restorerCanIncludeTrash("member", "owner", "owner")).toBe(true);
  expect(restorerCanIncludeTrash("admin", "owner", "admin")).toBe(true);
  expect(restorerCanIncludeTrash("member", "owner", "editor")).toBe(false);
});
