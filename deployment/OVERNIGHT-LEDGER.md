# Sequential delivery ledger

User instruction: continue HOLY-3 through HOLY-17 in sequence; build, test, merge eligible work and deploy to `staging.holysheet.aplyd.org`. Staging deployment is now authorized. If blocked, preserve evidence and continue the next available story. Production changes and unrelated suite access changes are outside this instruction.

## Inventory

BTF All view currently lists HOLY-1 through HOLY-8. HOLY-9 returns Issue not found. HOLY-9 through HOLY-17 requirements have been requested from the user; do not invent or mark absent stories complete. Read-only backlog snapshots are retained outside the repository in the project output folder.

## Infrastructure

- Connected GitHub integration can access `nakul175/holy-sheet` with push rights; local gh CLI login remains invalid. Use the connector for publication.
- Existing deployment host is reachable through the configured deploy identity. There is no Holy Sheet service/tree currently discovered there.
- Deployment account lacks Docker daemon access and general sudo; only specific existing suite service commands and Caddy configuration/reload are allowed. Do not repurpose existing SHO services or bypass those boundaries.
- Requested staging domain did not resolve on the host during inspection. DNS/host deployment setup needs qualification before claiming availability.
- No deployment or production mutation has been performed in this run.
- Docker Compose configuration now validates locally using synthetic ignored credentials; this is configuration validation, not service/runtime qualification.
- A local container build from immutable source snapshot `65df4c6` succeeded (image digest `sha256:f44a9558e517c377aabe727abb35199e106dfac71f42f35ece0b6f8b995c36cd`); output is in ignored `artifacts/container-build.log`. It does not deploy a service.

## Merged foundations

- PR #1 (HOLY-3 foundation), merge `315ac9fc4d30d542c259bd399a2495bc2c23ea4a`.
- PR #2 (HOLY-4 foundation), merge `49cf51231a5cca30bcd78ac080f79dce478a934f`.
- PR #3 (HOLY-6 foundation), merge `65df4c6441dfb964962483a70cad9a7a70e67fe0`.
- PR #4 (HOLY-7 foundation), merge `a5b4ab866f66acba89edd1167ace4c1b734d96ab`.
- PR #5 (HOLY-8 private template foundation), merge `e541a2cd3f0e20a838b19ea8ed9d10446d5c5fc8`.
- PR #6 (private media/staging qualification), merge `8d4e8a99977f70f9ab56b0b7e07f4db265af3692`.

Each merge followed passing GitHub CI and exact source-tree verification. Local main was fast-forwarded to the same revision; current HOLY-7 work starts there. These merges are incremental, with production access still disabled. They do not mark any story Done or replace the documented acceptance gates.

## Story checkpoints

- HOLY-3: local rich-document checkpoint `cae877c`; 48 tests/typecheck/build passed there. Remaining editor and integrated acceptance work documented separately. Continuing bounded editor improvements.
- HOLY-4: inherited Viewer/Editor grants, owner-only review/apply/remove UI, current effective access, separate sharing versions/idempotency and append-only audit implemented. Local owner flow granted/revoked a synthetic viewer successfully. Candidate checks: 64 local tests, typecheck/build, and three separate real PostgreSQL tests passed. External suite/SHO and broader accessibility acceptance remain unqualified. Security review also hardened future-issued JWT rejection and link relationship/class validation. Fresh workspace entry no longer assumes a demo welcome page exists.
- HOLY-5: blocked on recorded sensitive legacy mapping and administration decisions, plus the actual suite adapter. Do not infer blanket access to private content or activate central writer. Proceeding to HOLY-6 while preserving this gate.
- HOLY-6: Commenter inheritance and content-write boundaries, discussion/anchor APIs, author edit/delete/restore, resolve/reopen, durable deduplicated notifications, responsive panel, mention picker, marker navigation and inbox implemented locally. Rehearsal confirmed draft retention, anchored post, keyboard self-mention/reply, edited label, Open/Resolved filtering, reopen, marker navigation and no inbox notification for a self-mention. Latest completed checks before final checkpoint: 85 local tests, typecheck/build and four real PostgreSQL integration tests. Full release gates remain in HOLY-6-REVIEW.md.
- HOLY-7: immutable attributed history, editor-only preview/compare, reviewed idempotent append-only restore, supersession-based 90-day retention, historical media protection and quarantine placeholders implemented. Local browser rehearsal restored synthetic page version 8 as version 10 with attribution/source link and earlier versions retained. Candidate passed 102 local tests, five real PostgreSQL tests, typecheck/build. See HOLY-7-REVIEW.md for remaining release gates. Not Done.
- HOLY-8: private template library, three starters, rich drafts, immutable private publication, Owner-only saved-page snapshots, independent copies, redacted provenance and archive implemented. Browser rehearsal created a starter copy and saved/published a private template. Candidate: 116 local tests, six real PostgreSQL tests, typecheck/build passed. Shared Space publication and attachment reuse remain blocked on explicit HOLY-5 policies; see HOLY-8-REVIEW.md. Not Done.
- HOLY-9–17: not listed in current backlog inventory; HOLY-9 and HOLY-17 direct URLs both return Issue not found. Requirements unresolved.

No story is marked Done by this ledger. Automated checks and manual BugOff execution remain distinct.

## Additional qualification

Five real ClamAV checks passed, including encrypted archive/signature detection and quarantine retry. A separate synthetic PostgreSQL restore matched all 26 tables and 38 authorized document reads. The immutable HOLY-8 package passed 13 disabled-access runtime checks with non-root/read-only verification. Full boundaries and exact revisions are in LOCAL-QUALIFICATION.md. The unavailable MinIO registry dependency has been removed from the deployment path in favor of a required qualified HTTPS private S3 endpoint. Staging DNS remained unresolved on recheck.

Additional HOLY-3 editor checkpoint: reviewed single-file paste/drop and replacement, reservation retry/cancellation handling, repeated-reference quota accounting, asynchronous language loading/large-code fallback and authorized dynamic find labels. Local browser rehearsal verified actual scanning, saved replacement and one-step Undo with original/replacement bytes unchanged. Combined checks: 150 local tests, seven real PostgreSQL tests, five real scanner tests, typecheck/build. See HOLY-3-EDITOR-REVIEW.md; pending recovery/import/transform and full release gates remain open.

That editor checkpoint merged as PR #7 at 3b8aaa2c57470783a449b99adde52c56702bc5f8 after CI passed.

Pending-upload recovery checkpoint: encrypted separate upload records, fresh authorized key unlock, stable placement identities, cross-tab Web Locks, original-file reselection, verified Ready reuse, renewable reservations and atomic Ready-to-recovery pinning. Browser rehearsal recovered selection details after reload, scanned and saved clean-two.txt, and cleared the pending record only after exact server save confirmation. Combined checks: 173 local tests, seven real PostgreSQL tests, six real ClamAV tests, typecheck and production build passed. Default-run 13 integration skips were executed separately against the real services. See HOLY-3-UPLOAD-RECOVERY-REVIEW.md; story remains In Progress, production disabled, staging unqualified.

User offered Grok for staging infrastructure creation. A concrete prompt was supplied covering DNS/TLS, dedicated deployment access, PostgreSQL/scanner/private HTTPS object storage, backups, actual identity integration and disabled feature flags. No staging deployment is claimed. GitHub CLI authentication now works as the repository owner.

Recovery PR #8 passed CI and merged as 11ec81c. BTF now contains HOLY-9 through HOLY-17. HOLY-9/10 require unresolved explicit management/recovery capability mapping from HOLY-5, so their mutations are deferred rather than assuming broad authority. HOLY-11 independently implements private favourites and Recents using existing read permission; combined candidate passed 180 local tests, eight real PostgreSQL tests, typecheck/build and the private-list browser rehearsal. See HOLY-11-REVIEW.md. Story and integrated staging acceptance remain open.

HOLY-11 PR #9 passed CI and merged as 5cff4a1555fec7fd7db346ea4a62dbfd0ea73cb4. Its BTF In Progress status is verified. HOLY-12 adds current authorised reference labels, same-workspace ordinary-save validation and transactional permission-filtered backlinks, deduplicated occurrence counts and 20-source keyset pages. Review also corrected personal-list inheritance traversal to match canonical 100-node authorization. Candidate: 187 local tests, nine real PostgreSQL tests, typecheck/build and actual browser insert/save/follow/backlink rehearsal passed. See HOLY-12-REVIEW.md; all full release gates remain open.

HOLY-12 PR #10 passed CI and merged as b745eb6. Stories through HOLY-17 were read in sequence; unresolved capability/runtime/adapter/convergence gates are recorded in HOLY-9-17-GATES.md. HOLY-16 now has a scoped private-POST search contract, actor/query/filter/workspace-bound opaque cursors, five-minute snapshots, fresh permission/metadata reads, bounded rate accounting and content-free correlation. Combined candidate: 197 local tests, ten real PostgreSQL tests, typecheck/build passed. See HOLY-16-REVIEW.md. Staging DNS still returned no A record on recheck.

HOLY-16 PR #11 passed CI and merged as c71d771. Returned to independently implementable HOLY-3 editor gaps: reviewed safe transforms with marker/child-lift disclosure, stale/read-only guards, sibling preservation and one-step Undo. Matrix checks also exposed and fixed null Tiptap ordered-list/link defaults rejected by strict saves. Candidate: 269 local tests, ten real PostgreSQL tests, typecheck/build passed; browser Cancel/confirmed-save/Undo checked-state rehearsal passed. See HOLY-3-TRANSFORMS-REVIEW.md. No full story/AC25 acceptance is claimed.

Safe transforms PR #12 passed CI and merged. Added reviewed table paste: exact occupied-cell replacement scope, constrained expansion, row splitting, merged/nested/mixed-source disclosure, complete literal fallback and no-autolink/no-mark manual literal input. Source expansion and sparse padding are bounded before allocation. Candidate: 283 local tests, ten real PostgreSQL tests, six real ClamAV tests, typecheck/build passed. Browser TSV/merged HTML/Cancel/confirmed-save/Undo and literal URL/tabs/newline rehearsals passed. See HOLY-3-TABLE-PASTE-REVIEW.md; representative source/browser/mobile and full release gates remain open.

PR #12 merge: 2177b97. Table paste PR #13 passed CI and merged as e311efdb9f2b3e8ab21bb29f3cca34334cfe28a6. Its exact git-archive source built immutable image sha256:0ae40d72a925ee28767f3fee4382c58ef5d6a12c992e8fa1bb1338827ae3233f, which passed 17 runtime boundary checks as UID 1001 with read-only root, all capabilities dropped, no-new-privileges and loopback-only access. A new backup/restore matched all 33 tables and 50 sampled authorised page reads while preserving the earlier backup/restore. Full logs/reports remain ignored under artifacts/. BTF HOLY-3 and HOLY-12 In Progress states were verified. Staging DNS still had no A record after qualification; server-specific Grok prompt retained outside the public repository in a private local handoff.

Evidence-only PR #14 passed CI and merged. Its first attempted push was rejected by automatic review because a server/DNS handoff was included for a public repository. That unpublished commit was replaced: the handoff is retained only outside Git in the local project, and the published branch contains code/evidence only. No infrastructure details from that private prompt were pushed. HOLY-16 In Progress is verified.

Added explicit own-device expired upload recovery cleanup (25 per confirmation) with lock/reread protection and no key/server/file mutation. Explicit operator maintenance removes at most 50 expired server keys under workspace locks without changing valid protection. Candidate passed 291 local tests, ten real PostgreSQL checks, six real scanner checks and typecheck/build. Automated DOM confirmation/logout/error tests are distinguished from a real seven-day device rehearsal. See HOLY-3-EXPIRED-RECOVERY-REVIEW.md.

Expired recovery PR #15 passed CI and merged. Guarded paragraph/heading/list/checklist/quote keyboard conversions and table checklist toggling now reuse the reviewed transform planner. Candidate: 309 local tests, typecheck/build passed; server paths are unchanged from the ten-PostgreSQL/six-scanner cleanup gate. Native browser Cmd+Shift+9 warning/Cancel, cell-toggle warning/Cancel and Cmd+Alt+1 code-conversion refusal passed. See HOLY-3-TRANSFORM-SHORTCUTS-REVIEW.md. No full acceptance or staging claim.

PR #16 passed CI and merged as bbee762955ac0c0d9d1da6c0720128a0d6660e46. Final combined main passed ten PostgreSQL and six scanner checks again. Its immutable package passed 17 disabled-access checks. Newly live staging independently passed HTTPS/HSTS and the same 17 unauthenticated boundaries, with the configured-maintenance 401 expectation. Accounts public discovery/JWKS are reachable. The deployment wrapper builds but lacks revision update/reporting; no latest-main deployment, authenticated session, staging product acceptance or BugOff pass is claimed. See LOCAL-QUALIFICATION.md.

Qualification PR #17 passed CI and merged. HOLY-17 now has an isolated pinned-library candidate experiment: 12 checks passed, with six update-delivery orders, duplicate delivery, snapshot reload, rich marks, stable tree identities and 64 three-peer insertion samples. It is excluded from the Docker context and adds no app dependency or collaboration endpoint. Editor/schema, server authority, durable acknowledgement, session/revocation/presence, history/draft integration and performance acceptance remain unbuilt. See experiments/collaboration/README.md; no HOLY-17 acceptance claim.

A thirteenth characterization exposes a release blocker: concurrent raw tree delete/move can revive a block. This test's green result records the unsafe library outcome, not HS success. Raw candidate projection is rejected; an enforcing no-resurrection adapter/policy and full qualification are still needed.

Resumed HOLY-3 independent work while staging is repaired: fixed section preference initialization for existing/inserted/late-identified nodes, correct toggle accessibility state and read-only temporary-navigation restoration. Eleven focused DOM/actual-editor cases and 318 combined local tests passed; typecheck/build passed. Native browser default-open, collapse/reload, hidden find/reveal/close restoration and unchanged saved version were verified. See HOLY-3-SECTION-NAVIGATION-REVIEW.md. No staging or BugOff acceptance claimed.

Section fixes passed CI and merged in PR20 as f28e5db. Added explicit table Escape-to-tools and Cmd/Ctrl+Enter/visible continuation, guarded read-only helpers and isolated structural Undo. Nine focused editor tests and 325 combined local tests passed; typecheck/build passed. Native browser row/column moves, individual Undo, keyboard continuation and below-limit row append passed; fixture changes were undone. Automated 100-row coverage is distinct from native browser evidence. See HOLY-3-TABLE-KEYBOARD-REVIEW.md. Drag controls and full device/integration acceptance remain open.

Table fixes passed CI and merged in PR21 as 9cc9ee2. Formatting controls now show current selection/typing marks and explicit mixed states; highlight no longer keeps a stale UI value. Six focused cases, 331 combined local tests, typecheck/build and native mixed-italic/highlight/plain-selection rehearsal passed. Synthetic style changes were undone. See HOLY-3-FORMAT-STATE-REVIEW.md; full acceptance remains open.

Formatting fixes passed CI and merged in PR22 as 993465f. The constrained wrapper deployed that exact commit to staging; app, PostgreSQL and scanner were running/healthy, preview/editor remained off, and 17 unauthenticated boundaries passed. Operator-supplied confidential accounts contract enabled the next local batch: disabled code/S256 bridge, nonce/state/signature checks, host-bound cookies, local/RP logout, cross-tab locks and session expiry/account-change checks. Candidate: 365 local tests, typecheck/build and 37 focused identity cases passed. Real accounts registration/login, suite-wide logout propagation, bootstrap provisioning and full acceptance remain open. See HOLY-3-IDENTITY-BRIDGE-REVIEW.md.
