# HOLY-92 Bug Off acceptance map

Authoritative scope: `HS-SF-N47-r1-20261104`. The mapped cases belong in the
Holy Sheet Bug Off repository folder
`HOLY-92 — Spaces directory, archive and migrate`. A local passing test is
local evidence only; it is not a signed-in staging or production result.

The production source lineage already contains PR #211 (`541e40c76`) and the
PR #212 hardening merge (`f0c5fc93c`). Current main and staging candidate
`0509f275f3d5e3e6f6c4a4adec86b863a8d572dc` also contain both changes.

## F01 — Directory (AC1)

**Bug Off:** `HS-TC-N47-01 — Directory` (case 2160).

**Scenario:** As U-VI in WS-A, list open spaces and member-private spaces,
offer Request access for discoverable spaces, and omit all private space ids,
names, counts and actions for spaces U-VI does not belong to.

**Script:** Reset `FX-WIKI-20261031` on isolated staging, sign in as U-VI,
open `/workspaces/WS-A/spaces`, inspect the directory response, join SP-OPEN,
request SP-DISC, and repeat the response check.

**Automated evidence:** `lib/space-directory.test.ts`, case “lists open spaces
and memberships, offers request access, and hides private spaces”.

**Current result:** Blocked / Not Run on staging. The admin directory is live,
but the required U-VI signed-in session and isolated fixture bindings are not
available to this run.

## F02 — Archive space (AC2)

**Bug Off:** `HS-TC-N47-02 — Archive space` (case 2161).

**Scenario:** Archive SP-ARCH, verify the banner and server-side write denial,
default search exclusion, Include archived behavior, and reversible unarchive.

**Script:** Reset the isolated staging pack, sign in as U-ADM, archive SP-ARCH,
attempt a direct save as a member, search with and without Include archived,
unarchive, and repeat the save and search.

**Automated evidence:** `lib/space-directory.test.ts`, case “archives a space
read-only, drops it from search, and restores it”.

**Current result:** Blocked / Not Run on staging. No production mutation is
permitted for this fixture test.

## F03 — Migrate page tree (AC3)

**Bug Off:** `HS-TC-N47-03 — Migrate page tree` (case 2162).

**Scenario:** Preview P-100 moving to SP-OPEN, including page and trashed counts,
gains, losses, broken references and redirects; execute in resumable steps and
verify old native and published URLs redirect.

**Script:** Reset the isolated staging pack, sign in as U-ADM, preview P-100,
record the digest and counts, start the job, step/resume to completion, and open
the old page and published URLs.

**Automated evidence:** `lib/space-directory.test.ts`, case “previews access
changes and moves a page tree with redirects, keeping trash trashed”.

**Current result:** Blocked / Not Run on staging. The signed-in admin UI is
present, but the named disposable fixture tree is not provisioned.

## F04 — Private space existence hidden (AC4)

**Bug Off:** `HS-TC-N47-04 — Private space existence hidden` (case 2163).

**Scenario:** U-VI cannot distinguish SP-SECRET from a non-existent space by
directory data or `/s/:slug` response.

**Script:** With U-VI's own staging session, request the directory, `/s/secret`,
and a random non-existent slug. Compare status, body shape and safe headers.
Run each slug 20 times and record median timing; retain sanitized responses and
the timing table, never cookies.

**Automated evidence:** `lib/space-directory.test.ts` compares the hidden and
missing response shape and proves neither the private id nor name is serialized.

**Current result:** Blocked / Not Run on staging. Local response-shape coverage
does not substitute for the required 20-run live leak oracle.

## F05 — Revoke during migration (AC5)

**Bug Off:** `HS-TC-N47-05 — Revoke during migration` (case 2164).

**Scenario:** Remove the initiating admin role after the first migration step;
the next step halts with `authority_revoked`, reports moved and remaining ids,
and can resume only after current authority is restored.

**Script:** Reset the isolated pack, start a multi-page migration as U-ADM,
complete one step, revoke U-ADM through a separately authorized owner session,
step again, inspect partial state, restore authority, and explicitly resume.

**Automated evidence:** `lib/space-directory.test.ts`, case “halts a running
migration when admin authority is removed and can resume later”. PR #212 also
binds a job to its initiating admin and halts on concurrent tree/space changes.

**Current result:** Blocked / Not Run on staging. A separately authorized owner
session is required for a genuine mid-flight revocation.

## F06 — Archived and trashed pages in migration (AC6)

**Bug Off:** `HS-TC-N47-06 — Archived and trashed pages in migration` (case
2165).

**Scenario:** A trashed descendant moves with its tree but remains trashed;
archiving either migration space halts before another page is moved.

**Script:** Reset the isolated pack, trash a child under P-100, migrate the tree,
query/open Trash to prove the child remains trashed, then repeat a fresh job with
the destination archived between start and step.

**Automated evidence:** `lib/space-directory.test.ts`, migration/trash case and
“halts before moving pages when a migration space is archived”.

**Current result:** Blocked / Not Run on staging.

## F07 — Cross-tenant migration (AC7)

**Bug Off:** `HS-TC-N47-07 — Cross-tenant migration` (case 2540).

**Scenario:** A WS-A admin cannot preview or start a migration into WS-B and
cannot distinguish the foreign destination from a missing destination.

**Script:** Capture a legitimate WS-A preview request, replay it with the same
actor's own session using SP-BOLT and a random missing target, then compare
status, body shape, safe headers and median timing across 20 runs.

**Automated evidence:** `lib/space-directory.test.ts`, case “rejects a
cross-tenant destination with the same response as an unknown space”.

**Current result:** Blocked / Not Run on staging. WS-B and the adverse actor must
be bound to isolated staging identities first.

## F08 — Evidence and truthful closure (AC8)

**Bug Off:** `HS-TC-N47-08 — Evidence and truthful closure` (to be created).

**Scenario:** AC01–AC08 map one-to-one to F01–F08, with exact revision,
environment, executor, IST timestamp and sanitized evidence for every result.

**Script:** Reconcile this file, Bug Off and BTF after the signed-in staging
run. Keep the story In Progress while any required live case is Blocked or Not
Run. After a production release containing the implementation, perform
read-only production smoke and record the exact deployed revision separately;
never run the destructive fixture matrix against production.

**Current result:** In Progress. BTF is correctly reopened and the first seven
Bug Off definitions are reconciled. F08 creation, isolated staging identity
bindings, live adverse execution and final production signed-in verification
remain open.

## Local and CI evidence

- PR #211 and PR #212 completed all four required CI checks before merge.
- On current main `0509f275f3d5e3e6f6c4a4adec86b863a8d572dc`, the focused
  space-directory, home UI and workspace-search run passes 13 tests across
  three files.
- The current-main full regression previously passed 2,199 tests in 372 files,
  with 59 tests / 5 files explicitly skipped by their existing opt-in gates.
- A signed-in staging admin session renders the Spaces directory and migration
  wizard. That observation proves deployment/UI presence only, not the U-VI,
  revocation, cross-tenant or leak-oracle cases above.
- Anonymous staging and production endpoints respond through Caddy without a
  503. Anonymous health is not signed-in acceptance and is recorded only as a
  service-availability observation.
