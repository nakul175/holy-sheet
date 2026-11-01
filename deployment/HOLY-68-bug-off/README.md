# HOLY-68 — Linked multilingual document variants

Bug Off folder for HS-TC-N30-01 through HS-TC-N30-10. Each case is Not Run. Do not mark a case Passed from local Vitest. Record the candidate SHA, environment, IST time, and sanitized evidence when the case is executed on isolated staging.

| Case | Acceptance criterion | Status | Environment | Evidence |
|---|---|---|---|---|
| HS-TC-N30-01 | HS-AC-N30-01 Link variants | Not Run | | |
| HS-TC-N30-02 | HS-AC-N30-02 Reader language preference | Not Run | | |
| HS-TC-N30-03 | HS-AC-N30-03 Stale variant detection | Not Run | | |
| HS-TC-N30-04 | HS-AC-N30-04 Mark as synced | Not Run | | |
| HS-TC-N30-05 | HS-AC-N30-05 Search by language | Not Run | | |
| HS-TC-N30-06 | HS-AC-N30-06 Switcher hides unreadable variants | Not Run | | |
| HS-TC-N30-07 | HS-AC-N30-07 Revoke mid-flight | Not Run | | |
| HS-TC-N30-08 | HS-AC-N30-08 Trashed variant | Not Run | | |
| HS-TC-N30-09 | HS-AC-N30-09 Cross-tenant link attempt | Not Run | | |
| HS-TC-N30-10 | HS-AC-N30-10 Evidence and truthful closure | Not Run | | |

Scripts for each case are the HS-TC steps in the HOLY-68 story. Adverse cases (06–09) must run signed-in on FX-WIKI-20261031 with LO-1 and RV-1, not only locally. Local Vitest covers the domain rules and does not close those gates.
