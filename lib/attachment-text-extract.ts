import { deflateSync, inflateSync } from "node:zlib";
import yauzl from "yauzl";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";

/** In-boundary classical extraction and template OCR. This module does not call a network or a generative model. */
export const attachmentTextByteLimit = 20 * 1024 * 1024;
export const attachmentTextPageLimit = 500;
export const attachmentTextLanguage = "en" as const;
export const attachmentTextBoundary = "Text is extracted and recognised inside this workspace. No generative model, summary, field extraction, record update, or external processor is used.";

export type AttachmentTextLanguage = typeof attachmentTextLanguage;
export type AttachmentTextStatus = "extracted" | "ocr" | "ocr-error" | "unsupported" | "oversize" | "page-limit" | "failed" | "empty";
export type AttachmentRecognition = "text" | "ocr";
export type ExtractedPage = { page: number; text: string; recognition: AttachmentRecognition; ocrErrors: string[] };
export type AttachmentExtraction = {
  status: AttachmentTextStatus;
  language: AttachmentTextLanguage;
  mime: string;
  pageCount: number;
  pages: ExtractedPage[];
  failure: string | null;
};

const mimeKind: Record<string, "txt" | "pdf" | "docx" | "png" | "jpeg"> = {
  "text/plain": "txt",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "png",
  "image/jpeg": "jpeg",
};

const glyphs: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "11111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10001"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["11111", "00010", "00010", "00010", "10010", "10010", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10001"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01111"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00101"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00101"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00101"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["01111", "00100", "00100", "00100", "00100", "00100", "11111"],
  "2": ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01111", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01001"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "11110"],
};
const templates = new Map(Object.entries(glyphs).map(([char, rows]) => [rows.join(""), char]));

type Gray = { width: number; height: number; gray: Uint8Array };

function failed(mime: string, failure: string): AttachmentExtraction {
  return { status: "failed", language: attachmentTextLanguage, mime, pageCount: 0, pages: [], failure: failure.slice(0, 300) };
}

function pack(mime: string, pages: ExtractedPage[], detected: number): AttachmentExtraction {
  if (detected > attachmentTextPageLimit) {
    return { status: "page-limit", language: attachmentTextLanguage, mime, pageCount: attachmentTextPageLimit, pages: [], failure: "Page count exceeds 500." };
  }
  const kept = pages.slice(0, attachmentTextPageLimit).map(page => ({
    ...page,
    text: page.text.slice(0, 8000),
    ocrErrors: page.ocrErrors.slice(0, 8).map(error => error.slice(0, 120)),
  }));
  const ocrError = kept.some(page => page.ocrErrors.length > 0);
  const ocr = kept.some(page => page.recognition === "ocr");
  const text = kept.some(page => page.text.trim().length > 0);
  const status: AttachmentTextStatus = ocrError ? "ocr-error" : ocr ? "ocr" : text ? "extracted" : "empty";
  return { status, language: attachmentTextLanguage, mime, pageCount: kept.length, pages: status === "empty" ? [] : kept, failure: null };
}

export function renderGlyphImage(value: string, scale = 1, noise = false): Gray {
  const lines = value.split("\n");
  const margin = scale;
  const letterGap = scale;
  const wordGap = scale * 3;
  const lineGap = scale * 2;
  let maxWidth = 1;
  for (const line of lines) {
    let width = 0;
    for (const char of line) width += char === " " ? wordGap : 5 * scale + letterGap;
    maxWidth = Math.max(maxWidth, width);
  }
  const width = margin * 2 + maxWidth + (noise ? 16 * scale : 0);
  const height = margin * 2 + lines.length * 7 * scale + Math.max(0, lines.length - 1) * lineGap;
  const gray = new Uint8Array(width * height);
  gray.fill(255);
  const dot = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < width && y < height) gray[y * width + x] = 0; };
  let y = margin;
  for (const line of lines) {
    let x = margin;
    for (const char of line) {
      if (char === " ") { x += wordGap; continue; }
      const rows = glyphs[char];
      if (!rows) throw new Error(`Unsupported recognition fixture character ${char}`);
      for (let gy = 0; gy < 7; gy += 1) for (let gx = 0; gx < 5; gx += 1) if (rows[gy][gx] === "1") {
        for (let sy = 0; sy < scale; sy += 1) for (let sx = 0; sx < scale; sx += 1) dot(x + gx * scale + sx, y + gy * scale + sy);
      }
      x += 5 * scale + letterGap;
    }
    y += 7 * scale + lineGap;
  }
  if (noise) for (let ny = margin; ny < margin + 7 * scale; ny += 1) for (let nx = width - 8 * scale; nx < width - 3 * scale; nx += 1) dot(nx, ny);
  return { width, height, gray };
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

export function encodeGrayPng(image: Gray) {
  const raw = Buffer.alloc(image.height * (image.width + 1));
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (image.width + 1)] = 0;
    Buffer.from(image.gray.buffer, image.gray.byteOffset + y * image.width, image.width).copy(raw, y * (image.width + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const a = Math.abs(estimate - left);
  const b = Math.abs(estimate - up);
  const c = Math.abs(estimate - upLeft);
  return a <= b && a <= c ? left : b <= c ? up : upLeft;
}

export function decodeGrayPng(bytes: Uint8Array): Gray {
  const png = Buffer.from(bytes);
  if (png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PNG signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  let color = -1;
  let depth = 0;
  const data: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString();
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > png.length) throw new Error("PNG truncated");
    const chunk = png.subarray(start, end);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      depth = chunk[8];
      color = chunk[9];
      if (chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) throw new Error("PNG interlaced");
    } else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (!width || !height || depth !== 8 || ![0, 2, 4, 6].includes(color) || width > 8000 || height > 8000 || width * height > 8_000_000) throw new Error("PNG unsupported");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color] ?? 1;
  const inflated = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const prior = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const gray = new Uint8Array(width * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source];
    source += 1;
    for (let index = 0; index < stride; index += 1) {
      const raw = inflated[source + index];
      const left = index >= channels ? current[index - channels] : 0;
      const up = prior[index];
      const upLeft = index >= channels ? prior[index - channels] : 0;
      current[index] = filter === 0 ? raw : filter === 1 ? (raw + left) & 255 : filter === 2 ? (raw + up) & 255 : filter === 3 ? (raw + Math.floor((left + up) / 2)) & 255 : filter === 4 ? (raw + paeth(left, up, upLeft)) & 255 : raw;
    }
    source += stride;
    prior.set(current);
    for (let x = 0; x < width; x += 1) {
      const pixel = x * channels;
      const alpha = color === 4 || color === 6 ? current[pixel + channels - 1] : 255;
      const red = current[pixel];
      const green = channels >= 3 ? current[pixel + 1] : red;
      const blue = channels >= 3 ? current[pixel + 2] : red;
      gray[y * width + x] = alpha === 0 ? 255 : Math.round((red + green + blue) / 3);
    }
  }
  return { width, height, gray };
}

function encodeGrayJpeg(image: Gray) {
  const data = new Uint8Array(image.width * image.height * 4);
  for (let index = 0; index < image.gray.length; index += 1) {
    data[index * 4] = data[index * 4 + 1] = data[index * 4 + 2] = image.gray[index];
    data[index * 4 + 3] = 255;
  }
  return Buffer.from(encodeJpeg({ data, width: image.width, height: image.height }, 100).data);
}

function decodeGrayJpeg(bytes: Uint8Array): Gray {
  const image = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
  if (!image.width || !image.height || image.width > 8000 || image.height > 8000) throw new Error("JPEG unsupported");
  const gray = new Uint8Array(image.width * image.height);
  for (let index = 0; index < gray.length; index += 1) gray[index] = Math.round((image.data[index * 4] + image.data[index * 4 + 1] + image.data[index * 4 + 2]) / 3);
  return { width: image.width, height: image.height, gray };
}

function recognise(image: Gray, page: number): { text: string; errors: string[] } {
  const ink = (x: number, y: number) => image.gray[y * image.width + x] < 160;
  const lines: { y0: number; y1: number }[] = [];
  let y = 0;
  while (y < image.height) {
    let row = false;
    for (let x = 0; x < image.width; x += 1) if (ink(x, y)) { row = true; break; }
    if (!row) { y += 1; continue; }
    const y0 = y;
    while (y < image.height) {
      let more = false;
      for (let x = 0; x < image.width; x += 1) if (ink(x, y)) { more = true; break; }
      if (!more) break;
      y += 1;
    }
    lines.push({ y0, y1: y });
  }
  let text = "";
  const errors: string[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    if (line) text += "\n";
    const { y0, y1 } = lines[line];
    const columns: boolean[] = [];
    for (let x = 0; x < image.width; x += 1) {
      let on = false;
      for (let row = y0; row < y1; row += 1) if (ink(x, row)) { on = true; break; }
      columns.push(on);
    }
    let x = 0;
    let gap = 0;
    let word = "";
    while (x < image.width) {
      if (!columns[x]) { gap += 1; x += 1; continue; }
      const x0 = x;
      while (x < image.width && columns[x]) x += 1;
      let minX = x;
      let maxX = x0;
      let minY = y1;
      let maxY = y0;
      let marks = 0;
      for (let row = y0; row < y1; row += 1) for (let col = x0; col < x; col += 1) if (ink(col, row)) {
        marks += 1;
        minX = Math.min(minX, col);
        maxX = Math.max(maxX, col + 1);
        minY = Math.min(minY, row);
        maxY = Math.max(maxY, row + 1);
      }
      const boxWidth = maxX - minX;
      if (marks < 8 || boxWidth < 2 || maxY - minY < 2) { gap = 0; continue; }
      if (word && gap > boxWidth * 0.35) word += " ";
      let bits = "";
      for (let gy = 0; gy < 7; gy += 1) for (let gx = 0; gx < 5; gx += 1) {
        const sx = Math.min(maxX - 1, minX + Math.floor(((gx + 0.5) / 5) * boxWidth));
        const sy = Math.min(maxY - 1, minY + Math.floor(((gy + 0.5) / 7) * (maxY - minY)));
        bits += ink(sx, sy) ? "1" : "0";
      }
      const char = templates.get(bits);
      if (char) word += char;
      else if (errors.length < 8) errors.push(`Unrecognized mark ${errors.length + 1} on page ${page}`);
      gap = 0;
    }
    text += word;
  }
  return { text: text.trim(), errors };
}

function recognisePage(image: Gray, page: number): ExtractedPage {
  const result = recognise(image, page);
  return { page, text: result.text, recognition: "ocr", ocrErrors: result.errors };
}

function pdfObjects(bytes: Uint8Array) {
  const buf = Buffer.from(bytes);
  const objects = new Map<number, { dict: string; stream: Uint8Array | null }>();
  let index = 0;
  while (index < buf.length - 6) {
    if (buf[index] < 48 || buf[index] > 57) { index += 1; continue; }
    let cursor = index;
    while (cursor < buf.length && buf[cursor] >= 48 && buf[cursor] <= 57) cursor += 1;
    if (buf[cursor] !== 32) { index += 1; continue; }
    let generation = cursor + 1;
    while (generation < buf.length && buf[generation] >= 48 && buf[generation] <= 57) generation += 1;
    if (buf.subarray(generation, generation + 4).toString() !== " obj") { index += 1; continue; }
    const id = Number(buf.subarray(index, cursor).toString());
    let body = generation + 4;
    while (body < buf.length && buf[body] <= 32) body += 1;
    let dict = "";
    let stream: Uint8Array | null = null;
    if (buf.subarray(body, body + 2).toString() === "<<") {
      const start = body;
      let depth = 0;
      while (body < buf.length - 1) {
        if (buf[body] === 60 && buf[body + 1] === 60) { depth += 1; body += 2; continue; }
        if (buf[body] === 62 && buf[body + 1] === 62) { depth -= 1; body += 2; if (depth === 0) break; continue; }
        body += 1;
      }
      dict = buf.subarray(start, body).toString("latin1");
      while (body < buf.length && buf[body] <= 32) body += 1;
      if (buf.subarray(body, body + 6).toString() === "stream") {
        body += 6;
        if (buf[body] === 13) body += 1;
        if (buf[body] === 10) body += 1;
        const length = /\/Length\s+(\d+)/.exec(dict);
        if (!length) throw new Error("PDF stream length");
        const size = Number(length[1]);
        if (size < 0 || size > attachmentTextByteLimit) throw new Error("PDF stream length");
        stream = buf.subarray(body, body + size);
        body += size;
      }
    }
    const end = buf.indexOf("endobj", body);
    if (end < 0) throw new Error("PDF truncated");
    objects.set(id, { dict, stream });
    if (objects.size > 2000) throw new Error("PDF is too complex to index.");
    index = end + 6;
  }
  return objects;
}

function decodedStream(dict: string, stream: Uint8Array | null) {
  if (!stream) return Buffer.alloc(0);
  if (dict.includes("/FlateDecode")) return inflateSync(Buffer.from(stream));
  return Buffer.from(stream);
}

function pdfLiteral(source: string, start: number) {
  let text = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === ")") return { text, next: index + 1 };
    if (char === "\\") {
      const next = source[index + 1];
      if (/[0-7]/.test(next)) {
        let octal = "";
        while (octal.length < 3 && /[0-7]/.test(source[index + 1 + octal.length] ?? "")) octal += source[index + 1 + octal.length];
        text += String.fromCharCode(parseInt(octal, 8));
        index += 1 + octal.length;
        continue;
      }
      text += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[next] ?? next ?? "";
      index += 2;
      continue;
    }
    text += char;
    index += 1;
  }
  throw new Error("PDF string");
}

function pdfText(content: string) {
  let text = "";
  let index = 0;
  while (index < content.length) {
    if (content[index] === "[") {
      const end = content.indexOf("]", index);
      if (end < 0) break;
      if (/^\s*TJ/.test(content.slice(end + 1))) {
        let cursor = index;
        while (cursor < end) {
          if (content[cursor] === "(") {
            const literal = pdfLiteral(content, cursor);
            text += literal.text;
            cursor = literal.next;
          } else cursor += 1;
        }
      }
      index = end + 1;
      continue;
    }
    if (content[index] === "(") {
      const literal = pdfLiteral(content, index);
      if (/^\s*(Tj|'|")/.test(content.slice(literal.next))) text += literal.text + (/^\s*'/.test(content.slice(literal.next)) ? "\n" : "");
      index = literal.next;
      continue;
    }
    index += 1;
  }
  return text;
}

function contentIds(dict: string) {
  const at = dict.indexOf("/Contents");
  if (at < 0) return [];
  const rest = dict.slice(at + "/Contents".length).trim();
  const body = rest.startsWith("[") ? rest.slice(1, rest.indexOf("]")) : rest;
  return [...body.matchAll(/(\d+)\s+\d+\s+R/g)].map(match => Number(match[1]));
}

function imageIds(dict: string) {
  const at = dict.indexOf("/XObject");
  if (at < 0) return [];
  const start = dict.indexOf("<<", at);
  const end = dict.indexOf(">>", start);
  if (start < 0 || end < 0) return [];
  return [...dict.slice(start, end).matchAll(/(\d+)\s+\d+\s+R/g)].map(match => Number(match[1]));
}

function imageFromObject(dict: string, stream: Uint8Array | null): Gray | null {
  if (!dict.includes("/Subtype /Image") || !stream) return null;
  const width = Number(/\/Width\s+(\d+)/.exec(dict)?.[1] ?? 0);
  const height = Number(/\/Height\s+(\d+)/.exec(dict)?.[1] ?? 0);
  if (!width || !height) return null;
  if (dict.includes("/DCTDecode")) return decodeGrayJpeg(stream);
  const pixels = decodedStream(dict, stream);
  if (dict.includes("/DeviceRGB") && pixels.length >= width * height * 3) {
    const gray = new Uint8Array(width * height);
    for (let index = 0; index < gray.length; index += 1) gray[index] = Math.round((pixels[index * 3] + pixels[index * 3 + 1] + pixels[index * 3 + 2]) / 3);
    return { width, height, gray };
  }
  if (pixels.length < width * height) throw new Error("PDF image");
  return { width, height, gray: new Uint8Array(pixels.subarray(0, width * height)) };
}

function extractPdf(bytes: Uint8Array, mime: string): AttachmentExtraction {
  if (!Buffer.from(bytes.subarray(0, 5)).toString().startsWith("%PDF-")) return failed(mime, "PDF could not be read.");
  if (Buffer.from(bytes).toString("latin1").includes("/Encrypt")) return failed(mime, "Encrypted PDF is not indexed.");
  const objects = pdfObjects(bytes);
  const pages = [...objects.entries()].filter(([, object]) => object.dict.includes("/Type /Page") && !object.dict.includes("/Type /Pages")).sort((a, b) => a[0] - b[0]);
  if (pages.length > attachmentTextPageLimit) return pack(mime, [], pages.length);
  const extracted: ExtractedPage[] = [];
  pages.forEach(([, object], index) => {
    const text = contentIds(object.dict).map(id => {
      const content = objects.get(id);
      if (!content?.stream) return "";
      return pdfText(decodedStream(content.dict, content.stream).toString("latin1"));
    }).join("");
    if (text.trim()) extracted.push({ page: index + 1, text: text.trim(), recognition: "text", ocrErrors: [] });
    else {
      const image = imageIds(object.dict).map(id => objects.get(id)).find(item => item && imageFromObject(item.dict, item.stream));
      if (!image) extracted.push({ page: index + 1, text: "", recognition: "text", ocrErrors: [] });
      else {
        const gray = imageFromObject(image.dict, image.stream);
        if (gray) extracted.push(recognisePage(gray, index + 1));
      }
    }
  });
  return pack(mime, extracted, pages.length);
}

function decodeXml(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function docxPages(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DOCX entities are not indexed.");
  const pages: string[] = [""];
  const pattern = /<w:p[\s>]|<\/w:p>|<w:br\b([^>]*)\/>|<w:lastRenderedPageBreak\/>|<w:t\b[^>]*>([^<]*)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    if (match[0].startsWith("</w:p>")) pages[pages.length - 1] += "\n";
    else if (match[0].startsWith("<w:lastRenderedPageBreak") || /w:type\s*=\s*"page"/.test(match[1] ?? "")) pages.push("");
    else if (match[2] != null) pages[pages.length - 1] += decodeXml(match[2]);
  }
  return pages.map(page => page.trim());
}

function readDocx(bytes: Buffer) {
  return new Promise<string>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new Error("DOCX could not be read.")); return; }
      let xml = "";
      let entries = 0;
      let total = 0;
      let settled = false;
      const fail = (message: string) => { if (settled) return; settled = true; zip.close(); reject(new Error(message)); };
      zip.on("error", () => fail("DOCX could not be read."));
      zip.on("end", () => { if (!settled) { settled = true; if (xml) resolve(xml); else reject(new Error("DOCX has no document body.")); } });
      zip.on("entry", entry => {
        const name = String(entry.fileName);
        if (++entries > 400 || /vbaProject|EncryptedPackage|EncryptionInfo/i.test(name) || name.includes("..")) { fail("DOCX macros or encryption are not indexed."); return; }
        total += entry.uncompressedSize;
        if (total > 40_000_000 || entry.uncompressedSize > 8_000_000) { fail("DOCX is too large to index."); return; }
        if (name !== "word/document.xml") { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail("DOCX could not be read."); return; }
          const chunks: Buffer[] = [];
          stream.on("data", chunk => chunks.push(chunk as Buffer));
          stream.on("error", () => fail("DOCX could not be read."));
          stream.on("end", () => { xml = Buffer.concat(chunks).toString("utf8"); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

function extractTxt(bytes: Uint8Array, mime: string): AttachmentExtraction {
  let text = "";
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return failed(mime, "TXT is not valid UTF-8."); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) return failed(mime, "TXT contains unsupported control characters.");
  const pages = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\f");
  return pack(mime, pages.map((page, index) => ({ page: index + 1, text: page.trim(), recognition: "text", ocrErrors: [] })), pages.length);
}

export async function extractAttachmentText(bytes: Uint8Array, mime: string): Promise<AttachmentExtraction> {
  if (bytes.length > attachmentTextByteLimit) return { status: "oversize", language: attachmentTextLanguage, mime, pageCount: 0, pages: [], failure: "File exceeds 20 MiB." };
  const kind = mimeKind[mime];
  if (!kind) return { status: "unsupported", language: attachmentTextLanguage, mime, pageCount: 0, pages: [], failure: "This file type is not indexed." };
  try {
    if (kind === "txt") return extractTxt(bytes, mime);
    if (kind === "png") return pack(mime, [recognisePage(decodeGrayPng(bytes), 1)], 1);
    if (kind === "jpeg") return pack(mime, [recognisePage(decodeGrayJpeg(bytes), 1)], 1);
    if (kind === "pdf") return extractPdf(bytes, mime);
    const xml = await readDocx(Buffer.from(bytes));
    const pages = docxPages(xml);
    return pack(mime, pages.map((page, index) => ({ page: index + 1, text: page, recognition: "text" as const, ocrErrors: [] })), pages.length);
  } catch (error) {
    return failed(mime, error instanceof Error ? error.message : "The file could not be indexed.");
  }
}

function pdfObject(id: number, dict: string, stream?: Buffer) {
  const head = Buffer.from(`${id} 0 obj\n${stream ? dict.replace("LENGTH", String(stream.length)) : dict}\n`);
  if (!stream) return Buffer.concat([head, Buffer.from("endobj\n")]);
  return Buffer.concat([head, Buffer.from("stream\n"), stream, Buffer.from("\nendstream\nendobj\n")]);
}

export function fixturePdfText(pages: string[]) {
  const objects = [
    pdfObject(1, "<< /Type /Catalog /Pages 2 0 R >>"),
    pdfObject(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(" ")}] >>`),
  ];
  pages.forEach((page, index) => {
    const contentId = pages.length + 3 + index;
    const stream = Buffer.from(`BT (${page.replace(/[()\\]/g, match => `\\${match}`)}) Tj ET`);
    objects.push(pdfObject(index + 3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents ${contentId} 0 R >>`));
    objects.push(pdfObject(contentId, "<< /Length LENGTH >>", stream));
  });
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), ...objects]);
}

export function fixturePdfImage(value: string) {
  const image = renderGlyphImage(value, 1);
  const stream = deflateSync(Buffer.from(image.gray));
  const content = Buffer.from(`q ${image.width} 0 0 ${image.height} 0 0 cm /Im Do Q`);
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    pdfObject(1, "<< /Type /Catalog /Pages 2 0 R >>"),
    pdfObject(2, "<< /Type /Pages /Count 1 /Kids [3 0 R] >>"),
    pdfObject(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>`),
    pdfObject(4, "<< /Length LENGTH >>", content),
    pdfObject(5, `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length LENGTH >>`, stream),
  ]);
}

export function fixtureManyPdfPages(count: number) {
  const kids = Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(" ");
  const objects = [
    pdfObject(1, "<< /Type /Catalog /Pages 2 0 R >>"),
    pdfObject(2, `<< /Type /Pages /Count ${count} /Kids [${kids}] >>`),
    ...Array.from({ length: count }, (_, index) => pdfObject(index + 3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>")),
  ];
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), ...objects]);
}

export function fixtureBrokenPdf() {
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    pdfObject(1, "<< /Type /Page /Parent 2 0 R /Contents 2 0 R >>"),
    pdfObject(2, "<< /Filter /FlateDecode /Length LENGTH >>", Buffer.from("NOTFLATE")),
  ]);
}

export function fixturePng(value: string, noise = false) {
  return encodeGrayPng(renderGlyphImage(value, 1, noise));
}

export function fixtureJpeg(value: string) {
  return encodeGrayJpeg(renderGlyphImage(value, 4));
}
