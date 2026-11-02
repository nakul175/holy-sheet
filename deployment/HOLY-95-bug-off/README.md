# HOLY-95 — Document working copies and reconciliation

Bug Off folder: `HOLY-95 — Document working copies and reconciliation  (HS N50)`.

Cases HS-TC-N50-01 through HS-TC-N50-06 map to HS-AC-N50-01 through HS-AC-N50-06 and to Bug Off F01 through F06. F07 through F09 stay in the same folder so the Bug Off sheet matches the N49 layout. Each case is **Not Run**. Do not mark a case Passed from local Vitest. Record the candidate SHA, environment (isolated staging or production), executor, IST time, and sanitized evidence when the case is executed. Local tests are not a Passed result. Open live gates keep this story out of Done.

| Case | Acceptance criterion | Bug Off | Status | Environment | Evidence |
| --- | --- | --- | --- | --- | --- |
| HS-TC-N50-01 | HS-AC-N50-01 Create a private working copy | F01 | Not Run | | |
| HS-TC-N50-02 | HS-AC-N50-02 Three-way reconciliation | F02 | Not Run | | |
| HS-TC-N50-03 | HS-AC-N50-03 Apply without skipping review | F03 | Not Run | | |
| HS-TC-N50-04 | HS-AC-N50-04 Abandon or archive | F04 | Not Run | | |
| HS-TC-N50-05 | HS-AC-N50-05 Permission enforcement | F05 | Not Run | | |
| HS-TC-N50-06 | HS-AC-N50-06 Versions, retries, and access | F06 | Not Run | | |
| HS-TC-N50-07 | HS-AC-N50-07 Reserved | F07 | Not Run | | |
| HS-TC-N50-08 | HS-AC-N50-08 Reserved | F08 | Not Run | | |
| HS-TC-N50-09 | HS-AC-N50-09 Evidence and truthful closure | F09 | Not Run | | |

Scripts for each case are the HS-TC steps in the HOLY-95 story. Reset fixture pack FX-WIKI-20261031 on isolated signed-in staging (WS-A Acme Health and WS-B Bolt Logistics). Sign in as the actor in the Given clause. Do not use production data for the fixture run.

F01 checks a permitted page becomes a private copy with new page and block ids and a recorded base revision. F02 checks base, original, and copy, and that a conflict is not applied until a choice is made. F03 checks the original draft version advances once and the publishing approval state does not change. F04 checks abandon and archive leave the original body and version alone. F05 and F06 are adverse cases: another member, a workspace administrator, search, export, history, and a lost edit right. F05 includes leak-oracle LO-1 (random UUID compared with the denied copy: status, body shape, headers, and median timing of 20 runs). No Passed is inferred from this repository's Vitest run.
