# HOLY-61 versioned record attachments

Scope HS-SF-N24-r0-20261031 is still draft. This change implements HS-AC-N24-01 through HS-AC-N24-11 for the attachments the current tip can support. HS-AC-N24-12 stays open: Bug Off has not been executed on staging, and local tests are not a Passed result.

## What shipped

An attachment is still one `hs_linked_files` row. Versions are immutable blobs in `hs_attachment_versions`. Every record linked to that file reads the same current version.

The spec row `hs_record_attachments(id, record_id, field_id, current_version_id)` is not a second table:

| Spec column | This change |
| --- | --- |
| id | `hs_linked_files.id` |
| record_id | `hs_document_record_links` (`doc_type = file`) |
| field_id | `hs_linked_files.field_key` when an attachment field is bound |
| current_version_id | `hs_linked_files.current_version_id` |

- Upload new version reserves size and MIME first, then scans with the HOLY-3 ClamAV gateway. A clean file becomes the next linear version (uploader, IST time, size, checksum, optional note). The previous version stays.
- Versions lists number, uploader, IST time, size, note and scan status. Download URLs last at most 5 minutes and are checked against the same session on the next request.
- Restore copies an older version into a new version. The note is `Restored from vN`. Nothing is rewritten.
- A reference with no pin opens the current version. A pinned `@vN` stays on that version and is labelled `Not latest` when a newer version is current.
- EICAR is rejected with `File failed security scan` and is not stored as a version. Files over 50 MB and disallowed MIME types are rejected before a version exists.
- Create, restore and delete write `hs_data_events` (HOLY-28) on each linked record and `hs_audit` with the actor, operation id and target ids. File names and bodies are not stored in the audit.
- Delete is a soft delete kept 30 days. Workspace admins can still see it. The current version cannot be deleted until another version is chosen as current.
- Unreadable, foreign and archived-for-readers requests share `This item is restricted or unavailable.` A restorer opening an archived record sees `Record archived`. Storage keys are server-generated and are not accepted on any route.

## Migration

`db/097_attachment_versions.sql` adds version, reservation, download-token, pin and operation tables, plus `field_key` and `current_version_id` on `hs_linked_files`. It does not backfill bytes. Re-running it is safe.

## HOLY-60 follow-up

HS-AC-N23-02’s “upload v2 and the new version shows on every linked record” now reads `hs_linked_files.current_version_id`. The Documents tab on each linked record shows that same current version.

## Deferred

In-browser Office editing and OCR stay out of scope. Bug Off F01–F12 are Not Run until an isolated signed-in FX-WIKI-20261031 staging run. Do not mark HOLY-61 Done from local Vitest.

## Staging QA

Bug Off folder to create, status Not Run: `HOLY-61 — Versioned record attachments`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | HS-AC-N24-01 | Scan then v2; v1 retained | Not Run |
| F02 | HS-AC-N24-02 | Version list, IST, 5-minute session URL | Not Run |
| F03 | HS-AC-N24-03 | Restore copies v1 into v4 | Not Run |
| F04 | HS-AC-N24-04 | Current link and pinned `@vN` / Not latest | Not Run |
| F05 | HS-AC-N24-05 | EICAR, 50 MB and MIME rejection | Not Run |
| F06 | HS-AC-N24-06 | Record history kind, actor, IST | Not Run |
| F07 | HS-AC-N24-07 | Soft delete, 30-day admin retention, current rule | Not Run |
| F08 | HS-AC-N24-08 | Outsider 404 matches a random id; no filename header | Not Run |
| F09 | HS-AC-N24-09 | Revoke releases the reservation and refuses the URL | Not Run |
| F10 | HS-AC-N24-10 | Readers get not-found; restorers see Record archived | Not Run |
| F11 | HS-AC-N24-11 | Storage key is not accepted; generic 404 | Not Run |
| F12 | HS-AC-N24-12 | Traceability only. Do not mark Done from this table | Not Run |

Reset FX-WIKI-20261031 on isolated staging. Sign in as the actor in each Given clause. Record the candidate SHA, environment and an IST timestamp. Keep screenshots and sanitized responses. Do not infer Passed from this repository’s Vitest run.

## Local checks

`npx vitest run lib/attachment-versions.test.ts lib/attachment-versions-ui.test.ts` covers the version rules and the Versions drawer. `npx tsc --noEmit` covers the TypeScript build.
