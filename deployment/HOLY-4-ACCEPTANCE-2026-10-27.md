# HOLY-4 implementation and qualification

Base: 29953c8f6e15a00840be5713585dbf4368cf0100. Follow-up to the core sharing implementation in PR #2.

## Changes

- Open documents check authenticated effective access without an edit, every second while visible and on focus, online, visibility and local/cross-tab sharing notifications. Checks never overlap; a five-second timeout pauses editing/saving when the authority cannot be reached. Server authorization remains mandatory for every operation. Polling is bounded detection, not instantaneous remote push.
- Revocation clears document/recovery UI and fences late saves, draft-key responses and history/recovery actions. Downgrades fetch the current read-only document. Identity changes clear the old account document. Permission outages pause editing and resume only after confirmation.
- Ancestor permission checks no longer silently stop at 100 levels. Canonical access/sharing retain cycle detection; favourites and backlinks use deduplicated recursive reachability so malformed cycles terminate.
- Generic workspace grants now appear as access sources; removing a weaker direct grant explains retained effective access. A new review clears the prior success notice.

## Evidence

Automated tests cover existing/future descendants, hidden ancestors/siblings, forbidden recipients and non-owner management, role precedence and source removal, inactive membership, duplicate operations/audit, deep/cyclic trees, passive revocation, downgrade, identity changes, late save responses, paused/recovered access, hung checks, minimal no-store access responses, and uncertain sharing retry with the same operation ID.

Real PostgreSQL acceptance includes ten checks, notably a save paused before commit while inherited revocation waits on its lock; subsequent descendant reads and writes are denied. Local browser rehearsal used only synthetic preview data: Viewer grant, Editor upgrade, direct removal, explicit review and retained-access explanation; keyboard Enter confirmation at 390×844 succeeded. This is not a signed-in staging or screen-reader acceptance run.

## Release gates still open

Do not mark HOLY-4 Done solely from this patch. The nine mapped Bug Off manual scripts require isolated signed-in staging fixtures; their local/backend evidence does not satisfy that precondition. Actual SHO attachment/delegated identity acceptance (AC10/16), suite entitlement/native space-role mapping with HOLY-5, and assistive-technology qualification remain separate gates. No live membership, production permission or staging deployment was changed. No feature or identity gate was bypassed. See the BTF HOLY-4 activity and linked Bug Off run for exact candidate revision and outcomes.
