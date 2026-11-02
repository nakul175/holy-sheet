# HOLY-96 — Reusable document bundles

Bug Off folder: `HOLY-96 — Reusable document bundles  (HS N51)`.

Cases HS-TC-N51-01 through HS-TC-N51-06 map to HS-AC-N51-01 through HS-AC-N51-06 and to Bug Off F01 through F06. F07 through F09 stay in the same folder so the Bug Off sheet matches the N50 layout. Each case is **Not Run**. Do not mark a case Passed from local Vitest. Record the candidate SHA, environment (isolated staging or production), executor, IST time, and sanitized evidence when the case is executed. Local tests are not a Passed result. Open live gates keep this story out of Done.

| Case | Acceptance criterion | Bug Off | Status | Environment | Evidence |
| --- | --- | --- | --- | --- | --- |
| HS-TC-N51-01 | HS-AC-N51-01 Named bundle with description, owner, and ordered references | F01 | Not Run | | |
| HS-TC-N51-02 | HS-AC-N51-02 Per-reader members; hidden titles and counts; share does not expand access | F02 | Not Run | | |
| HS-TC-N51-03 | HS-AC-N51-03 Live latest-published or pinned revision; immutable package snapshot | F03 | Not Run | | |
| HS-TC-N51-04 | HS-AC-N51-04 Export preview checks rights, assets, and retention; removal does not delete the document | F04 | Not Run | | |
| HS-TC-N51-05 | HS-AC-N51-05 Tenant, record, field, and action permissions on UI, API, search, preview, download, and history | F05 | Not Run | | |
| HS-TC-N51-06 | HS-AC-N51-06 Versioned configuration, retries, recoverable drafts, audit, keyboard and phone | F06 | Not Run | | |
| HS-TC-N51-07 | HS-AC-N51-07 Reserved | F07 | Not Run | | |
| HS-TC-N51-08 | HS-AC-N51-08 Reserved | F08 | Not Run | | |
| HS-TC-N51-09 | HS-AC-N51-09 Evidence and truthful closure | F09 | Not Run | | |

Scripts for each case are the HS-TC steps in the HOLY-96 story. Reset fixture pack FX-WIKI-20261031 on isolated signed-in staging (WS-A Acme Health and WS-B Bolt Logistics). Sign in as the actor in the Given clause. Do not use production data for the fixture run.

F01 checks a bundle manager saves a 1–100 character name, description, owner, and ordered document references, and that the bundle tables do not contain the document body. F02 checks two readers of one shared bundle and that a hidden document's title, identifier, and count are absent. F03 checks live latest-published, an explicit pin, and a package snapshot that does not change after a later publication. F04 checks export rights, an unavailable attachment, retention, and that removing a member leaves the page in place. F05 and F06 are adverse cases: another workspace, search, preview, download, history, a lost edit right, and a reused operation id. No Passed is inferred from this repository's Vitest run.
