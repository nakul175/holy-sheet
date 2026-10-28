# HOLY-30 delivery checkpoint — engineer 2

User scope confirmed 28 October 2026: HOLY-30 includes children HOLY-38–42. Finish the current story through build, tests, staging acceptance and production verification before advancing. HOLY-31–37 have not been started. Update BTF after every build. Schedules remain paused.

## Current increment: HOLY-38 template workflow

Added `app/api/v1/workspaces/[id]/tenants/[tenantId]/record-templates/route.ts` and the tenant collection page at `app/workspaces/[id]/tenants/[tenantId]/collections/[collection]/templates/page.tsx`. GET exposes a permission-filtered catalogue/form or template; POST saves configuration, previews exact selection or instantiates a reviewed selection. The client provides keyboard/phone-accessible catalogue, manager editor, field defaults, exact preview, explicit confirmation, cancel, stale-session cleanup and uncertain-response operation reuse. Verified suite-session tenant authority supplies the actor. URL tenant/workspace scope is rechecked by the native transaction. Same-origin mutation checks, strict discriminated input, 128 KB body limit, existing native permission/version/idempotency checks and private no-store responses apply. Unexpected errors return generic 503 responses. Reference/attachment defaults continue requiring the existing qualified value-authority adapter; none is fabricated here.

Source base: 81060a0. Route SHA-256 b36f1aefdf02ff9b0deee70fa77fc1e99465d53c4c6ae83eb5e70e407ea11d19; test SHA-256 efaa10b687d4a91c34bff29e7e175cd234ae8147e28f5d6531a8acf7c6bcc76d.

## Evidence

Candidate isolated in `/tmp/holy30-candidate` using a Git archive of that base plus only this route and its tests. Other engineers are actively editing the shared checkout; their unrelated modifications were excluded from this candidate.

- Route boundary + native template service: 20 tests passed.
- `npm run build -- --webpack`: passed, including Next.js type validation and route generation.
- Full local regression: 114 files passed, 2 skipped; 952 tests passed, 44 skipped. Skipped service cases are not PostgreSQL/scanner acceptance.
- Current shared-worktree regression after the UI addition: 118 files passed, 2 skipped; 973 tests passed, 44 skipped. `npm run build -- --webpack` passed and generated both the API route and collection template page.
- Default isolated Turbopack build failed because its workspace-root rule excludes external symlinked dependencies. The successful webpack build is reported separately.
- Shared-workspace `tsc` exhausted its default heap; an 8 GB retry was interrupted in favor of isolated build validation. The unrelated `node_modules.external` symlink is present, but its causal role is unproven.

Logs: ignored `artifacts/holy30/`. BTF HOLY-38 contains build checkpoints; no Done transition, staging result or production result is claimed.

## Work still required

HOLY-38: native catalogue/manager/instantiation UI, recoverable scoped drafts, exact document-section copying and ordinary permission checks, reviewed live authority/value adapters and tenant/capability mappings, distinct-account API/UI/concurrency/fault/mobile/keyboard acceptance against deployed staging. Then production rollout and verification. HOLY-39–42 still have their documented UI/integration/acceptance gaps; HOLY-30 acceptance rolls up all 30 cases.

The historical deployment handoff was found at the surrounding Codex project `outputs/holy-sheet/next50-20261027/CHECKPOINT-BEFORE-FINAL-ROLLOUT.md`; it identifies a constrained staging wrapper and historical production process. Its old revisions/fixtures do not establish current authority activation or a qualified shared-record QA tenant. A direct staging route probe returned 404, confirming this candidate is not deployed. The documented wrapper status check was attempted over the authorized SSH key but returned permission denied for the deploy user. The repository `.git` index is also read-only in this managed checkout, so an immutable deployment revision cannot be created from the dirty worktree without the release owner’s wrapper/checkout. No staging or production deployment is claimed.

## Ownership reconciliation

The user explicitly clarified Engineer 1's scope ends at HOLY-27. Engineer 2 retains HOLY-30–37 and HOLY-30's children HOLY-38–42. Product - Holy Sheet was informed and acknowledged Engineer 2's ownership; its response incorrectly restated Engineer 1's cutoff as 29, and a correction to 27 was sent. No new scope was inferred for HOLY-28/29. Product has not yet supplied the requested release/QA authority handoff.
