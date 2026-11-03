# HOLY-98 attachment text search and OCR

Scope is HS N53. This change implements AC1 through AC6 for classical attachment text extraction and OCR. Bug Off F01–F09 are Not Run, and local tests are not a Passed result.

## What shipped

An authorised editor can index the current or chosen version of a permitted PDF, DOCX, TXT, PNG, or JPEG attachment. Text PDFs, DOCX, and TXT are extracted in this workspace. Image-only PDF pages, PNG, and JPEG are recognised with a local template recogniser. Files over 20 MiB or 500 pages are refused with an explicit status. Every index row stores the language (`en`) and a status (`extracted`, `ocr`, `ocr-error`, `unsupported`, `oversize`, `page-limit`, `failed`, or `empty`).

Search returns the filename, page, snippet, language, and status for attachments the caller can already view. Opening a hit reads that indexed version and page, including when a record pin points at an older version. OCR errors are shown on the result and on the opened page. The recogniser does not summarise, extract fields, or update the record.

Extraction, the page cache, search, preview, download, and history check the tenant, the record grant, and field view when the file is bound to a field. Revoking the grant or the field permission hides cached text. A text-index manager can change configuration and does not receive a record, field, or page grant. No processor URL is accepted and extraction does not call the network.

Reindex is limited to 20 files, 20 MiB, and 500 pages. The same operation id returns the first result. A failed parse can be retried up to five times against the expected index version; a stale version does not write. A failed file does not change its bytes or the surrounding record, and the other files in the request still index.

Configuration is versioned. A mismatched save leaves the recoverable draft in place. Audit rows record the actor, source `attachment-text`, IST time, and operation id, without the extracted text. The dialog is opened from Page options, uses labelled 44px controls, wraps its actions, and Cancel does not save.

## Migration

`db/124_attachment_text.sql` adds the index, page cache, configuration, revision, draft, manager, and operation tables. Re-running it is safe. It does not alter `release.py`.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in FX-WIKI-20261031 run: `HOLY-98 — Attachment text search and OCR (HS N53)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | AC1 Index and OCR | PDF, DOCX, TXT, PNG, JPEG, 20 MiB, 500 pages, language and status | Not Run |
| F02 | AC2 Search and pin | Filename, page, snippet, exact version, visible OCR error | Not Run |
| F03 | AC3 Rights and boundary | Field revocation, tenant boundary, no external processor | Not Run |
| F04 | AC4 Reindex | Idempotent retry, five-attempt bound, source unchanged, sibling indexed | Not Run |
| F05 | AC5 Permissions | Search, preview, download, history, and cross-workspace 404 | Not Run |
| F06 | AC6 Versions and access | Conflict keeps the draft; audit actor, source, time, operation; dialog cancel | Not Run |
| F07 | Reserved | Not Run | Not Run |
| F08 | Reserved | Not Run | Not Run |
| F09 | Evidence | Traceability only. Do not mark Done from this table | Not Run |

## Local checks

`npx vitest run lib/attachment-text-extract.test.ts lib/attachment-text.test.ts lib/attachment-text-route.test.ts lib/attachment-text-dialog.test.ts`
