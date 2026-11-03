# HOLY-98 — Attachment text search and OCR

Bug Off folder: `HOLY-98 — Attachment text search and OCR (HS N53)`.

Cases HS-TC-N53-01 through HS-TC-N53-06 map to HS-AC-N53-01 through HS-AC-N53-06 and to Bug Off F01 through F06. F07 through F09 stay in the same folder so the Bug Off sheet matches the N52 layout. Each case is **Not Run**. Do not mark a case Passed from local Vitest. Record the candidate SHA, environment (isolated staging or production), executor, IST time, and sanitized evidence when the case is executed. Local tests are not a Passed result. Open live gates keep this story out of Done.

| Case | Acceptance criterion | Bug Off | Result | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| HS-TC-N53-01 | HS-AC-N53-01 Index permitted PDF, DOCX, TXT, and OCR image-only PDF, PNG, and JPEG up to 20 MiB and 500 pages with language and status | F01 | Not Run | | |
| HS-TC-N53-02 | HS-AC-N53-02 Search returns filename, page, and snippet and opens the exact pinned version and page; OCR errors are visible | F02 | Not Run | | |
| HS-TC-N53-03 | HS-AC-N53-03 Extraction, index, and cache follow file, record, and field rights, revocation, and the tenant boundary | F03 | Not Run | | |
| HS-TC-N53-04 | HS-AC-N53-04 Reindex and retry are versioned, idempotent, and bounded; parse or OCR failure does not mutate the source or block other records | F04 | Not Run | | |
| HS-TC-N53-05 | HS-AC-N53-05 Tenant, record, field, and action permissions on UI, API, search, preview, download, and history | F05 | Not Run | | |
| HS-TC-N53-06 | HS-AC-N53-06 Versioned configuration, retries, recoverable drafts, audit, keyboard and phone | F06 | Not Run | | |
| HS-TC-N53-07 | HS-AC-N53-07 Reserved | F07 | Not Run | | |
| HS-TC-N53-08 | HS-AC-N53-08 Reserved | F08 | Not Run | | |
| HS-TC-N53-09 | HS-AC-N53-09 Evidence and truthful closure | F09 | Not Run | | |

Scripts for each case are the HS-TC steps in the HOLY-98 story. Reset fixture pack FX-WIKI-20261031 on isolated signed-in staging (WS-A Acme Health and WS-B Bolt Logistics). Sign in as the actor in the Given clause. Do not use production data for the fixture run.
