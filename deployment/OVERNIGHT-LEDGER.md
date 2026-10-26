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
