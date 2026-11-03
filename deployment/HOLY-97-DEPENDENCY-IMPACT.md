# HOLY-97 document dependency impact

Scope is HS N52. This change implements AC1 through AC6 for explicit document dependency edges. Bug Off F01–F09 are Not Run, and local tests are not a Passed result.

## What shipped

An authorised dependency manager records a typed edge for an explicit link, template, snippet, or synced-source placement. The edge stores the source id, the source revision, the dependent page, and the responsible reviewer. Recording an edge does not copy page text, rewrite the dependent page, or write `hs_grants`.

A source material change, noted against a real new revision whose document digest differs, marks permitted dependents Needs review and stores the reason. An edit whose document digest is unchanged, and a note saved on the dependency, follow the rule `unrelated-metadata-does-not-mark-review` and leave the review state unchanged.

The assigned reviewer acknowledges the exact current source revision and dependent page revision. A mismatched pair is rejected as stale. A reviewer who cannot read both ends, or an observer, cannot acknowledge; a manager reassigns the review. Reassignment does not grant page access.

Impact traversal is cycle-safe, omits edges the reader cannot see, and stops at 50 pages. A retired source is reported and is not expanded. A merged source is followed to its successor without rewriting dependents. A deleted source title is withheld.

Search, preview, download, and history return only edges the reader can already open. Workspace membership, a dependency-manager grant, and reviewer assignment do not reveal a page, template, snippet, or synced source. Configuration is versioned. The same operation id returns the first result. A mismatched retry or a stale version does not add a revision. A recoverable draft survives a rejected save. Audit rows record the actor, source `dependency-impact`, IST time, and operation id. The dialog uses labelled buttons with a 44px target, a confirm step before retire, and Cancel does not save.

## Migration

`db/123_dependency_impact.sql` adds the source, edge, revision, draft, manager, and operation tables. Re-running it is safe. It does not alter `release.py`.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in FX-WIKI-20261031 run: `HOLY-97 — Document dependency impact tracking  (HS N52)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | AC1 Typed edges | Source id, revision, dependent page, reviewer, four provenance kinds | Not Run |
| F02 | AC2 Material versus metadata | Digest change marks Needs review; unchanged digest and notes do not | Not Run |
| F03 | AC3 Acknowledgement | Exact revisions; stale review; reassignment without a page grant | Not Run |
| F04 | AC4 Traversal | Cycle, page bound, hidden edge omitted, retired and merged sources | Not Run |
| F05 | AC5 Permissions | Search, preview, download, history, and cross-workspace 404 | Not Run |
| F06 | AC6 Versions and access | Conflict and replay add no extra revision; dialog confirm and cancel | Not Run |
| F07 | Reserved | Not Run | Not Run |
| F08 | Reserved | Not Run | Not Run |
| F09 | Evidence | Traceability only. Do not mark Done from this table | Not Run |

## Local checks

`npx vitest run lib/dependency-impact-plan.test.ts lib/dependency-impact.test.ts lib/dependency-impact-route.test.ts lib/dependency-impact-dialog.test.ts`
