# HOLY-97 — Document dependency impact tracking

Bug Off folder: `HOLY-97 — Document dependency impact tracking  (HS N52)`.

Cases HS-TC-N52-01 through HS-TC-N52-06 map to HS-AC-N52-01 through HS-AC-N52-06 and to Bug Off F01 through F06. F07 through F09 stay in the same folder so the Bug Off sheet matches the N51 layout. Each case is **Not Run**. Do not mark a case Passed from local Vitest. Record the candidate SHA, environment (isolated staging or production), executor, IST time, and sanitized evidence when the case is executed. Local tests are not a Passed result. Open live gates keep this story out of Done.

| Case | Acceptance criterion | Bug Off | Result | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| HS-TC-N52-01 | HS-AC-N52-01 Typed dependency edge with source id, revision, dependent page, and reviewer | F01 | Not Run | | |
| HS-TC-N52-02 | HS-AC-N52-02 Material change marks Needs review; unrelated metadata follows the explicit rule | F02 | Not Run | | |
| HS-TC-N52-03 | HS-AC-N52-03 Acknowledgement of exact revisions; stale review or missing authority | F03 | Not Run | | |
| HS-TC-N52-04 | HS-AC-N52-04 Cycle-safe, permission-filtered, bounded traversal; retired and merged sources | F04 | Not Run | | |
| HS-TC-N52-05 | HS-AC-N52-05 Tenant, record, field, and action permissions on UI, API, search, preview, download, and history | F05 | Not Run | | |
| HS-TC-N52-06 | HS-AC-N52-06 Versioned configuration, retries, recoverable drafts, audit, keyboard and phone | F06 | Not Run | | |
| HS-TC-N52-07 | HS-AC-N52-07 Reserved | F07 | Not Run | | |
| HS-TC-N52-08 | HS-AC-N52-08 Reserved | F08 | Not Run | | |
| HS-TC-N52-09 | HS-AC-N52-09 Evidence and truthful closure | F09 | Not Run | | |

Scripts for each case are the HS-TC steps in the HOLY-97 story. Reset fixture pack FX-WIKI-20261031 on isolated signed-in staging (WS-A Acme Health and WS-B Bolt Logistics). Sign in as the actor in the Given clause. Do not use production data for the fixture run.
