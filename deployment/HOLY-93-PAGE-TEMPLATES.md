# HOLY-93 page templates with record placeholders

Scope HS-SF-N48-r0-20261031 is still draft. This change implements HS-AC-N48-01 through HS-AC-N48-08 for the template gallery, variables, and record placeholders the current tip can support. HS-AC-N48-09 stays open: Bug Off has not been executed on staging, and local tests are not a Passed result.

## What shipped

A space owner publishes a page template. An editor opens New page and gets a gallery. Space templates are listed before personal templates. Search and category narrow the gallery. The preview shows the template structure. It does not load record values.

- `{{date}}` defaults to the IST calendar day when the value is left blank. Other tokens such as `{{client}}` are required. The values are written into the new page only.
- A Client record placeholder becomes a chip, a card, and a view filtered to the chosen record. The page is associated to that record through `hs_document_record_links`.
- Editing a template publishes a new revision. Pages already created keep the revision they were copied from. Page history shows that revision.
- A restricted space template, an archived template, and a template id from another workspace all return the same not-found response as an unknown id. The gallery omits a restricted template instead of including its name.
- If record access is gone when the page is created, the request fails with the same not-found response as an unknown record. The transaction does not leave a page, a view, or a link.
- Creation retries use the existing template operation id. The audit row stores the actor, operation id, page id, template id, revision, and record ids. It does not store variable values or record field values. Provenance and history render the template time in IST.

## Migration

`db/119_page_template_placeholders.sql` adds `category` and `restricted` on `hs_templates`, and `category` on `hs_template_revisions`. It does not update existing template bodies. Re-running it is safe.

## Staging QA

Bug Off folder to create, status Not Run until an isolated signed-in FX-WIKI-20261031 run: `HOLY-93 — Page templates with record placeholders`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | HS-AC-N48-01 Gallery | `lib/template-gallery.test.ts`, `lib/templates.test.ts` order and category | Not Run |
| F02 | HS-AC-N48-02 Variables | IST date default and inserted text | Not Run |
| F03 | HS-AC-N48-03 Record placeholder | Chip, card, filtered view, document link | Not Run |
| F04 | HS-AC-N48-04 Versioning | Old page unchanged; history revision | Not Run |
| F05 | HS-AC-N48-05 Restricted template | Same 404 as an unknown id; name omitted from the list | Not Run |
| F06 | HS-AC-N48-06 Revoke during creation | Same not-found as an unknown record; no new page | Not Run |
| F07 | HS-AC-N48-07 Trashed template | Archived template matches an unknown id; earlier page remains | Not Run |
| F08 | HS-AC-N48-08 Cross-tenant | Workspace B using a Workspace A template id matches an unknown id | Not Run |
| F09 | HS-AC-N48-09 Evidence | Traceability only. Do not mark Done from this table | Not Run |

Reset FX-WIKI-20261031 on isolated staging. Sign in as the actor in each Given clause. Record the candidate SHA, environment, and an IST timestamp. Keep screenshots and sanitized responses. Do not infer Passed from this repository’s Vitest run.

## Local checks

`npx vitest run lib/template-placeholders.test.ts lib/template-gallery.test.ts lib/templates.test.ts lib/templates-dialog.test.ts lib/record-page-refs.test.ts` covers the binding rules and the gallery. `npm run typecheck` covers the TypeScript build.
