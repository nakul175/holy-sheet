# Product coordination checkpoint — 28 October 2026

## Completed cache-only approval

Direct human approval was limited to unused Docker build cache. The command
`/Users/athena/.local/aplyd-iso/bin/docker builder prune --force` completed with
3.867 GB reclaimed. Before/after comparison preserved all nine containers,
120 image entries and eleven volumes; backup paths were untouched.
Receipt: `artifacts/product/docker-cache-cleanup-receipt.json`.
No container/image/volume/system prune is authorized by this approval.
Engineer 3's separately denied disposable container/volume cleanup remains
pending its own human decision; do not route it through another actor.

## Independently checked PR gates

- HOLY-1 PR 116: head `221dc147db31e77c5a00ebd81bcf5bee33361a13`,
  all four checks successful in Actions 40725421231. Draft/open/unmerged.
  Engineer receipt: 1,060 passed, six scanner skips; all six HOLY-1 PostgreSQL
  tests executed. Historical local service results remain separate.
- HOLY-2 PR 120: head `f5b704cfdd7b67dbfc1093e0ba48b58db467f5dc`,
  all four checks successful in Actions 40725925346. Draft/open/unmerged.
  Engineer receipt: 1,042 passed, six scanner skips. Approved fourteen-file
  payload unchanged; old-head evidence remains separate.
- GitHub main has since advanced to
  `de68a4c826b3e3a2bee06b11983ef59568f6e24e`, merge of HOLY-12 PR 124.
  Refresh main and actual staging before future integration/release; the two
  PR CI heads above do not qualify a later combined tree.

## Staging coordination

Engineer 1's actual latest human message authorized cache-only cleanup,
then HOLY-12 deployment and acceptance on staging. His current report says
live acceptance is passing and rollback/roll-forward is in progress. This
is an occupied staging slot; Product has requested final source, image,
backup, rollback/roll-forward receipt and explicit slot release. Do not use
the older b588 stage receipt as a current staging assertion. Engineers 2,
3 and 4 have been told to hold deployments during this window.

## Approved HOLY-1 fixture scope

Actual human response in Engineer 3's chat: “Approve fixture setup only”.
Only two NEW empty staging realms and these memberships are covered:

| Realm | c9492fe8… | e0bbba6b… | 004bd7ee… |
| --- | --- | --- | --- |
| qa-holy1-isolated-w1-20261028 | Owner | Admin | Member |
| qa-holy1-isolated-w2-20261028 | Observer | Owner | Unmapped |

Existing workspaces remain untouched. Engineer 3 owns transactional setup,
before/after existing-membership verification and normal login qualification.
Human subsequently said to figure out the QA sign-ins independently; do not
repeat the same generic request for the user to perform routine logins.
Any concrete credential change still needs applicable authority and private
handling; never echo passwords or reuse primary-profile cookies.

This three-subject bootstrap is not the HOLY-2 five-user benchmark fixture.
Only these three synthetic HS subjects were identified in the supplied
historical metadata; SHO IDs are the same people. Two additional actual
synthetic subjects and five qualified normal OIDC sessions remain needed.
W1 Owner/Admin have full sets, so different benchmark permitted sets cannot
be inferred without a concrete additional role/grant plan. Engineer 4 owns
that proposal; no silent demotion or extra grants are approved.

## HOLY-44 acceptance correction

The 100/101 visible-target boundary is valid partial safety evidence, not
proof of large-data completion. The current evaluator rejects over 1,000
stored IDs and over 100 permitted targets. The runbook still requires
over 10,000 related records, progress/retry and an interrupted job; other
historical references mention 100,000 and pagination/asynchronous behavior.
Engineer 2 must retrieve authoritative BTF AC4 and Bug Off case 1917 text,
correct the matrix omission and reconcile the implementation requirement
before full F04 fixture/acceptance approval. Do not weaken assertions or
mark safe rejection as large-fanout completion.

Central structured-record tenant authority remains separate from native
page fixtures. Product requested Engineer 1's read-only live-state/operator
handoff; no new authority activation or record grants are requested.

Follow-up from Engineer 2: authoritative BTF AC4 explicitly requires large
rollups to remain paginated/asynchronous with safe failure. Bug Off 1917's
action uses over 10,000 related records, cycle, interrupted job and truthful
progress/retry; 100,000 is a broader catalogue fixture precondition. He
corrected both documents and posted BTF comment 10701. Product directed him
to implement the missing behavior within his existing HOLY-44 assignment,
starting with a bounded design/checkpoint; no new generic local-code approval
is needed. Existing publication/release/access boundaries and serialized
heavy-service hold continue. Keep the story In Progress and case Not Run
until actual applicable acceptance passes.

His read-only stage report now identifies de68a4c, image
`sha256:372f7c718fa7d932eda789357c2bc21b1ca74de8c2d1621b9c84ac56eb50b9fa`,
rollback b588a468. This is not a slot-release or full Product deployment
acceptance receipt. An unauthenticated POST returning 401 from Accounts
`/internal/tenant/status` establishes a protected route only, not enabled
native records authority, a verified subject/revision mapping, or grants.

## HOLY-63 boundary

Engineer 5 received `deployment/HOLY-2-PUBLICATION-SEARCH-CONTRACT.md`:
select the reader-visible revision before search match/rank/preview/paging,
including publication/source revocation and cursor behavior. This remains
Engineer 5's publishing integration; ordinary HOLY-2 can proceed independently.
The stable-block published comment anchor-coordinate P2 remains his local
review gate. No schedules or heartbeat automations were enabled.

## Subsequent review / dependency / QA updates

HOLY-63 P2 closed by independent delta review at
`149ec0ef1c9e6409fe6c32c39d103f8d6de84749`, no new actionable findings.
Full detail is in `HOLY-63-PRODUCT-SECURITY-REVIEW.md`. Product verified
the exact 527-entry qualification manifest, 1,022 JUnit passes / 45 service
skips / zero failures and sixteen browser passes. Changed fixes remain
unpublished; main/search/service/release gates remain open.

HOLY-2 PR120 subsequently integrated current main de68a4c at
`06eb9be73e85cbc065fab2788309f7776078b40d`. Product verified all fourteen
remote Git blob hashes against the frozen approved manifest, 14/14 equal.
PR is draft/open/unmerged. Exact new-head CI40728510101 is running at
this checkpoint; prior f5 CI must not be reused as this head's result.
Engineer5 was told this is the exact approved search dependency for his
qualification-only overlay, with his adapter provenance kept separate.

Engineer4's detailed fixture sharing was initially rejected by automatic
review. He obtained direct human permission for that specific sharing and
successfully sent the proposal; no alternate route bypassed the denial.
That sharing permission does not authorize execution. His proposed NEW
`qa-holy2-search-w1-20261028`/W2 namespaces preserve HOLY-1's matrix and
require two additional actual synthetic subjects plus the three existing
ones. Expected formula counts remain planning values; actual current ACL,
inheritance and lifecycle projections must be qualified before measuring.
Saved fifteen-user diagnostic remains fifteen distinct authenticated
principals unless authoritative criteria explicitly define virtual clients;
fifteen clients over five principals may only be labeled supplementary.
No additional accounts are authorized by this checkpoint.

Engineer3 privately completed the existing Editor's ordinary login through
Aplyd/SHO in an isolated Incognito session. HS then returned
`application_access_required`; this is a central application-entitlement
blocker, not evidence of missing credentials or a qualified HS subject.
Product requested concrete read-only central app/client/tenant/role checks
for all three existing subjects and the two proposed synthetic labels,
with one minimal reviewable remediation proposal. No credential reset,
global app grant, central record-authority activation or new role was
authorized. The approved empty HOLY-1 fixture SQL passed local guards and
is privately uploaded, but live execution still awaits the brief stage
transaction slot after Engineer1's rollback window. Do not mark prepared
SQL or an uploaded file as an executed fixture.

Latest: exact HOLY-2 head06eb9be CI40728510101 all four checks SUCCESS,
independently verified by Product. Mapped Bug Off run10 contains eleven
Pending/Untested cases, not acceptance results. HOLY-44 new frozen large-job
candidate7b06848 has two P1 review findings (cached/terminal response
revocation bypass and missing expiry enforcement); see
`HOLY-44-LARGE-ROLLUP-PRODUCT-REVIEW.md`. Engineer2 may address these and
missing tests locally; heavy-service hold remains.

Product read Engineer1's actual terminal HOLY-12 production receipt and
human approvals: production source de68a4c, rollback rehearsal passed;
current activity is HOLY-13 host regression. Therefore the BRIEF approved
HOLY-1 empty native fixture transaction slot has now been released to
Engineer3. Engineer1 was notified to hold staging restore/rollback/deploy/
native-membership mutations until that transaction receipt. This releases
only the exact hash-pinned staging fixture SQL/operator, with short timeouts,
before-state guards, exact five new membership rows, outsider unmapped and
all existing memberships unchanged. It does not release a feature deployment,
content seed, central grant, cleanup or heavy test slot. Await actual
transaction receipt before claiming fixture execution or releasing the hold.

## Current continuation state

- HOLY-1 native fixture transaction completed and postcommit readback was
  verified: exact five approved active memberships, two empty access-model2
  realms, zero spaces/pages, outsider unmapped, pre-existing digests match.
  Brief stage transaction hold RELEASED; Engineer1 notified. This establishes
  native fixtures only, not current HS sessions/central app eligibility.
- Read-only central full-DATABASES config expression was rejected by auto
  review because it could expose credentials. A safer allowed path-only AST
  reader failed closed on dynamic SQLite path. Product instructed a normal
  owner/app-runtime exact-three-subject read-only report alternative without
  printing settings/environment/path/credentials; same review boundary,
  no rerouting or grant changes. Actual Directory rows remain unknown.
- Engineer3 is preparing a standalone current-main Observer authority hotfix
  from his existing reviewed owned patch, excluding workspace creation.
  New standalone publication/release is not approved yet.
- HOLY-2 exact06eb9be CI all4 PASS. Separate scanner6/6, no skips/failures,
  actual PONG before/after, Product verified JUnit/process receipt; scanner
  window RELEASED. CI skips remain unchanged historical counts. Inherited
  Unicode Number price² candidate-superset defect found; Engineer4 owns a
  LOCAL bounded fix, tests and new freeze before any changed PR upload.
- HOLY-63 current adapter72404a2 has two introduced findings: Observer owner
  draft exposure and unbounded within-page pin projection. Eng5 may fix
  these on a new local ref, preserving frozen03ae23e8. Eng4's read-only
  contract review reported no other introduced index finding. Full scope,
  thirteen-exact-plus-one-owned-merged-UI provenance correction and evidence
  are in `HOLY-63-PRODUCT-SECURITY-REVIEW.md`.
- HOLY-44 final correction f80149f/treefc772c6b closes the replay/expiry and
  COUNT-metadata findings in focused re-review. Product verified twelve
  freeze hashes and nineteen focused passes. ONE EXCLUSIVE LOCAL REAL-PG
  slot is now Engineer2's, fresh free4,095,036KiB/reserve2GiB, for bounded
  synthetic COUNT/SUM/fault/revocation acceptance then stable required gates.
  Actual PostgreSQL results remain UNRUN at this checkpoint. Other engineers'
  local data-heavy hold remains. No cleanup, publishing, live grants or
  deployment authority is included; await terminal result and SLOT RELEASE.
