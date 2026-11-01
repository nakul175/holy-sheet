# HOLY-59 live record references

Pages store record and view ids plus display config. Values are resolved per reader at read time.

## Staging QA

Set `HS_RECORD_REF_FAULT=1` only when exercising the failure path. Send `x-hs-record-ref-fault: 1` on `POST /api/v1/workspaces/:workspaceId/record-refs/resolve` to force one batch to fail. Leave the flag unset for normal traffic.

1. Edit a page, type `/record` or `@`, pick a record, and insert an inline chip and a card. Confirm the saved revision has ids and field keys only.
2. Change the record in another session. The open page should show the new value and “Updated just now” within about 5 seconds, with no new page revision.
3. Insert `/records view` against a saved view. Confirm the row count says “you can see”, filter chips are read-only, and archived rows are absent.
4. Open the same page as a reader who cannot see a field or a record. The field is an em dash. The record is “Restricted record” with Request access, identical for a deleted or unknown id.
5. Export Markdown and PDF as that reader. Markdown uses `[Record: title](link)` only for readable records. PDF includes a printed-at IST time.

Bug Off folder: `HOLY-59 — Live record reference blocks in pages`. Cases F01–F13 map to HS-TC-N22-01–13. Local automated coverage is in `lib/record-page-refs.test.ts`, `lib/record-page-ref-store.test.ts`, and `lib/record-ref-blocks.test.ts`. Staging runs stay Not Run until executed on FX-WIKI-20261031. Do not mark HOLY-59 Done from local results.

## Deferred

- HS-AC-N22-08 staging p95 and throttled-network timing.
- HS-AC-N22-06 axe scan at 390×844.
- HS-AC-N22-13 production evidence.
- Editing record values from a page block, and charts or aggregations.
