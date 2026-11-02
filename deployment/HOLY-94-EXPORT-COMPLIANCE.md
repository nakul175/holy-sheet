# HOLY-94 export and compliance pack

Scope HS-SF-N49-r0-20261031 is still draft. This change implements HS-AC-N49-01 through HS-AC-N49-08 for a page, tree, or space export, including a signed compliance pack. HS-AC-N49-09 stays open: Bug Off F01–F09 are Not Run, and local tests are not a Passed result.

## What shipped

A workspace member starts an export from the page. Scope is this page, this page and its subpages, or this space. Format is PDF, HTML, Markdown, or a compliance pack. The job records progress and an ETA. A finished pack can be downloaded for 24 hours by the same sign-in that started it. Completion sends an email and an in-app notice that do not include pack contents.

A compliance pack is a ZIP:

- HTML and PDF for each included page. The published snapshot is included when one exists. The current draft is included only when requested and the exporter can edit that page.
- Record snapshots for referenced records, limited to fields that exporter can see. A record they cannot read is the text `Restricted record`.
- Current attachment descriptors, or every remaining version when that option is on.
- `acknowledgements.csv` with chain hashes, `audit.csv` without stored bodies, and `manifest.json` with a SHA-256 for each other file and an HMAC signature.

Space attachment policy is separate from the existing workspace export on/off switch. When a space forbids attachments, those files are left out and the manifest says `Attachments excluded by export policy.` Turning document export off still blocks the job.

The exporter's effective access is checked while the pack is built. Pages they cannot read are absent, including their titles. Trash is absent unless Include trash is set and the exporter can restore that page (page owner, or workspace owner or administrator). If workspace access is revoked while the job is running, the job aborts, partial files are deleted, and no download token is issued.

A download is tied to the job, the actor, and the session binding. Another workspace member, or the same account on another session, gets the same `Export unavailable` 404 as an unknown job id.

Audit rows `compliance-export.queue`, `compliance-export.complete`, and `compliance-export.download` store the actor, scope, counts, manifest hash, and an IST timestamp. They do not store page bodies or record values.

## Migration

`db/120_compliance_exports.sql` adds compliance jobs, pack files, the completion email outbox, and per-space attachment policy. It also allows the `compliance-export` notification kind. Re-running it is safe. It does not alter `hs_export_jobs` or `release.py`.

Signing uses `HS_EXPORT_SIGNING_KEY` when set (at least 16 characters). Production without that key refuses to sign a pack.

## Staging QA

Bug Off folder to create, status Not Run until an isolated signed-in FX-WIKI-20261031 run: `HOLY-94 — Export and compliance pack  (HS N49)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | HS-AC-N49-01 Choose scope and format | `lib/compliance-pack.test.ts` progress, 24h expiry, session binding, content-free email | Not Run |
| F02 | HS-AC-N49-02 Pack contents | HTML, PDF, visible fields, versions, acknowledgement chain hash, audit CSV, signed manifest | Not Run |
| F03 | HS-AC-N49-03 Export policy respected | Attachment policy omits files and writes the manifest note | Not Run |
| F04 | HS-AC-N49-04 Audit of exports | `compliance-export.complete` actor, scope, counts, manifest hash, IST | Not Run |
| F05 | HS-AC-N49-05 Exporter sees only what they can | Secret page absent; restricted record label; counts are included items | Not Run |
| F06 | HS-AC-N49-06 Revoke mid-export | Abort, partial files deleted, no download token | Not Run |
| F07 | HS-AC-N49-07 Trashed content | Editor include-trash omits trash; restorer include-trash keeps it | Not Run |
| F08 | HS-AC-N49-08 Cross-tenant download | Foreign actor matches an unknown job id | Not Run |
| F09 | HS-AC-N49-09 Evidence | Traceability only. Do not mark Done from this table | Not Run |

Reset FX-WIKI-20261031 on isolated staging. Sign in as the actor in each Given clause. Record the candidate SHA, environment, and an IST timestamp. Keep screenshots and sanitized responses. Adverse cases need LO-1, and F06 needs RV-1. Do not infer Passed from this repository's Vitest run.

## Local checks

`npx vitest run lib/compliance-pack-plan.test.ts lib/compliance-pack.test.ts lib/compliance-pack-route.test.ts lib/compliance-export-dialog.test.ts` covers the pack rules. `npm run typecheck` covers the TypeScript build.
