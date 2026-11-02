# HOLY-94 — Export and compliance pack

Bug Off folder: `HOLY-94 — Export and compliance pack  (HS N49)`.

Cases HS-TC-N49-01 through HS-TC-N49-09 map one-to-one to HS-AC-N49-01 through HS-AC-N49-09 and to Bug Off F01 through F09. Each case is **Not Run**. Do not mark a case Passed from local Vitest. Record the candidate SHA, environment (isolated staging or production), executor, IST time, and sanitized evidence when the case is executed. Local tests are not a Passed result. Open live gates keep this story out of Done.

| Case | Acceptance criterion | Bug Off | Status | Environment | Evidence |
| --- | --- | --- | --- | --- | --- |
| HS-TC-N49-01 | HS-AC-N49-01 Choose scope and format | F01 | Not Run | | |
| HS-TC-N49-02 | HS-AC-N49-02 Pack contents | F02 | Not Run | | |
| HS-TC-N49-03 | HS-AC-N49-03 Export policy respected | F03 | Not Run | | |
| HS-TC-N49-04 | HS-AC-N49-04 Audit of exports | F04 | Not Run | | |
| HS-TC-N49-05 | HS-AC-N49-05 Exporter sees only what they can | F05 | Not Run | | |
| HS-TC-N49-06 | HS-AC-N49-06 Revoke mid-export | F06 | Not Run | | |
| HS-TC-N49-07 | HS-AC-N49-07 Trashed content | F07 | Not Run | | |
| HS-TC-N49-08 | HS-AC-N49-08 Cross-tenant download | F08 | Not Run | | |
| HS-TC-N49-09 | HS-AC-N49-09 Evidence and truthful closure | F09 | Not Run | | |

Scripts for each case are the HS-TC steps in the HOLY-94 story. Reset fixture pack FX-WIKI-20261031 on isolated signed-in staging (WS-A Acme Health and WS-B Bolt Logistics). Sign in as the actor in the Given clause. Do not use production data for the fixture run.

Adverse cases F05–F08 must run signed-in on that fixture pack. F05, F06, and F07 include leak-oracle LO-1 (random UUID compared with the denied target: status, body shape, headers, and median timing of 20 runs). F06 also uses revoke window RV-1. F08 replays the download with the other workspace's own session. No Passed is inferred from this repository's Vitest run.
