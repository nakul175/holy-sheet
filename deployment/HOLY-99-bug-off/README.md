# HOLY-99 — Shared classification and tagging

Bug Off folder: `HOLY-99 — Shared classification and tagging (HS N54)`.

Cases HS-TC-N54-01 through HS-TC-N54-06 map to HS-AC-N54-01 through HS-AC-N54-06 and to Bug Off F01 through F06. F07 through F09 stay in the same folder so the Bug Off sheet matches the N53 layout. Each case is **Not Run**. Do not mark a case Passed from local Vitest. Record the candidate SHA, environment (isolated staging or production), executor, IST time, and sanitized evidence when the case is executed. Local tests are not a Passed result. Open live gates keep this story out of Done.

| Case | AC | Bug Off | Result | Executor | Notes |
| --- | --- | --- | --- | --- | --- |
| HS-TC-N54-01 | HS-AC-N54-01 Taxonomy admins define stable tag ids, codes, labels, hierarchy, and scope | F01 | Not Run | | |
| HS-TC-N54-02 | HS-AC-N54-02 Assign and remove permitted tags; multiselect membership is audited | F02 | Not Run | | |
| HS-TC-N54-03 | HS-AC-N54-03 Search and views use tag ids; hidden tags do not leak through facets or counts | F03 | Not Run | | |
| HS-TC-N54-04 | HS-AC-N54-04 Deprecation, removal, and merge preview references and remap atomically | F04 | Not Run | | |
| HS-TC-N54-05 | HS-AC-N54-05 Tenant, record, field, and action permissions; configuration does not grant access | F05 | Not Run | | |
| HS-TC-N54-06 | HS-AC-N54-06 Versions, retries, recoverable drafts, audit, keyboard, and phone | F06 | Not Run | | |
| HS-TC-N54-07 | HS-AC-N54-07 Reserved | F07 | Not Run | | |
| HS-TC-N54-08 | HS-AC-N54-08 Reserved | F08 | Not Run | | |
| HS-TC-N54-09 | HS-AC-N54-09 Evidence and truthful closure | F09 | Not Run | | |

Scripts for each case are the HS-TC steps in the HOLY-99 story. Reset fixture pack FX-WIKI-20261031 on isolated signed-in staging (WS-A Acme Health and WS-B Bolt Logistics). Sign in as the actor in the Given clause. Do not use production data for the fixture run.
