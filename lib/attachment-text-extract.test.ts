import JSZip from "jszip";
import { expect, it, vi } from "vitest";
import {
  attachmentTextByteLimit,
  attachmentTextBoundary,
  extractAttachmentText,
  fixtureBrokenPdf,
  fixtureJpeg,
  fixtureManyPdfPages,
  fixturePdfImage,
  fixturePdfText,
  fixturePng,
} from "./attachment-text-extract";

async function docx(pages: string[]) {
  const body = pages.map((page, index) => `${index ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ""}<w:p><w:r><w:t>${page}</w:t></w:r></w:p>`).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

it("extracts text and recognises images inside the byte and page caps", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const alphabet = await extractAttachmentText(fixturePng("ABCXYZ 019"), "image/png");
  expect(alphabet).toMatchObject({ status: "ocr", language: "en", pageCount: 1 });
  expect(alphabet.pages[0]).toMatchObject({ page: 1, text: "ABCXYZ 019", recognition: "ocr", ocrErrors: [] });
  const jpeg = await extractAttachmentText(fixtureJpeg("WARD 12"), "image/jpeg");
  expect(jpeg.language).toBe("en");
  expect(jpeg.pages[0]?.text).toBe("WARD 12");
  expect(jpeg.status).toBe("ocr");
  const scanned = await extractAttachmentText(fixturePdfImage("WARD 12"), "application/pdf");
  expect(scanned).toMatchObject({ status: "ocr", language: "en" });
  expect(scanned.pages[0]?.text).toBe("WARD 12");
  const pdf = await extractAttachmentText(fixturePdfText(["alpha needle", "beta needle"]), "application/pdf");
  expect(pdf).toMatchObject({ status: "extracted", language: "en", pageCount: 2 });
  expect(pdf.pages.map(page => page.text)).toEqual(["alpha needle", "beta needle"]);
  const word = await extractAttachmentText(await docx(["alpha needle", "beta needle"]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  expect(word).toMatchObject({ status: "extracted", language: "en", pageCount: 2 });
  expect(word.pages.map(page => page.text)).toEqual(["alpha needle", "beta needle"]);
  const text = await extractAttachmentText(new TextEncoder().encode("alpha needle\fbeta needle"), "text/plain");
  expect(text.pages.map(page => ({ page: page.page, text: page.text, recognition: page.recognition }))).toEqual([
    { page: 1, text: "alpha needle", recognition: "text" },
    { page: 2, text: "beta needle", recognition: "text" },
  ]);
  const noisy = await extractAttachmentText(fixturePng("WARD", true), "image/png");
  expect(noisy.status).toBe("ocr-error");
  expect(noisy.pages[0]?.text).toContain("WARD");
  expect(noisy.pages[0]?.ocrErrors[0]).toMatch(/Unrecognized mark 1 on page 1/);
  expect(await extractAttachmentText(fixtureManyPdfPages(501), "application/pdf")).toMatchObject({ status: "page-limit", language: "en", pages: [] });
  expect(await extractAttachmentText(new Uint8Array(attachmentTextByteLimit + 1), "text/plain")).toMatchObject({ status: "oversize", language: "en" });
  expect(await extractAttachmentText(Buffer.from("GIF89a"), "image/gif")).toMatchObject({ status: "unsupported", language: "en" });
  expect((await extractAttachmentText(fixtureBrokenPdf(), "application/pdf")).status).toBe("failed");
  expect(attachmentTextBoundary).toMatch(/No generative model/);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
