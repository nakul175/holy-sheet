# HOLY-60 document associations

Scope HS-SF-N23-r0-20261031 is still draft. This change implements HS-AC-N23-01 through HS-AC-N23-09 for the associations the current tip can support. HS-AC-N23-10 stays open: Bug Off has not been executed on staging, and local tests are not a Passed result.

## What shipped

One page or one file can be linked to several records. The link is a row in `hs_document_record_links`. Opening the document from any of those records reads the same page or the same `hs_linked_files` row. Unlink deletes the row only.

- Linked records sidebar on a page (`/api/v1/pages/:id/linked-records`).
- Documents tab on a record, with type, owner, and updated filters and 20-row pages (`/api/v1/workspaces/:id/document-record-links`).
- Also link to… adds another record for the same file id.
- The last file link asks for Delete or Keep in Unlinked files. Keep retains the file for 30 days. A later link clears that bin state.
- Lists omit documents and records the viewer cannot see. The count reads “you can see” and does not include a hidden total. Direct failures for a hidden, foreign, or missing id share one not-found message.
- Readers do not see a trashed page or an archived or trashed record on the other side. The page owner, or a record restorer, sees the label “In trash”.
- Link and unlink require edit on the document and view plus link on an active record. The controls stay hidden when that is false. The API returns `document_link_forbidden` when the record is visible but the action is not allowed.
- Each mutation writes `hs_audit` with the actor, operation id, and target ids. Titles and file names are not stored. The UI shows the link time in IST.

## Migration

`db/096_document_record_links.sql` adds `hs_linked_files`, `hs_document_record_links`, and `hs_document_record_link_operations`. It does not update or backfill existing rows. Re-running it is safe.

`hs_linked_files.id` is the stable file identity. HOLY-61 versions should reference that id. This change does not create a version table.

## Deferred for HOLY-61

HS-AC-N23-02’s “same file on every linked record” is implemented: one `hs_linked_files` row is what every Documents tab reads, including a later name or `updated_at` change, and an optional `media_id` points at existing media bytes without copying them.

HS-AC-N23-02’s “upload v2 and the new version shows everywhere” is implemented by HOLY-61. Versions hang off `hs_linked_files.id`, and `current_version_id` is what every linked record’s Documents tab reads. See `deployment/HOLY-61-VERSIONED-ATTACHMENTS.md`.

## Staging QA

Bug Off folder to create, status Not Run until an isolated signed-in FX-WIKI-20261031 run: `HOLY-60 — Associate documents with multiple records`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | HS-AC-N23-01 | `lib/document-record-links.test.ts` page many-to-many | Not Run |
| F02 | HS-AC-N23-02 | Same file id on three records. Version step is covered by HOLY-61 | Not Run |
| F03 | HS-AC-N23-03 | Unlink, last-link choice, 30-day bin | Not Run |
| F04 | HS-AC-N23-04 | 30 documents, type, owner, updated, cursor | Not Run |
| F05 | HS-AC-N23-05 | Viewer and read-only page refused | Not Run |
| F06 | HS-AC-N23-06 | Hidden page and record titles absent | Not Run |
| F07 | HS-AC-N23-07 | Grant revoke removes the row; page open matches a missing id | Not Run |
| F08 | HS-AC-N23-08 | Trash and archive hidden for readers; restorers see In trash | Not Run |
| F09 | HS-AC-N23-09 | Foreign record id matches a random id | Not Run |
| F10 | HS-AC-N23-10 | Traceability only. Do not mark Done from this table | Not Run |

Reset FX-WIKI-20261031 on isolated staging. Sign in as the actor in each Given clause. Record the candidate SHA, environment, and an IST timestamp. Keep screenshots and sanitized responses. Do not infer Passed from this repository’s Vitest run.

## Local checks

`npx vitest run lib/document-record-links.test.ts lib/document-associations.test.ts` covers the association rules and the link/unlink controls. `npm run typecheck` covers the TypeScript build.
