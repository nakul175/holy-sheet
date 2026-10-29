# Standing engineering workflow

Authority: direct human instruction, 28 October 2026; reaffirmed directly by NJ on 29 October 2026. This file supersedes
older numerical allocations and workflow descriptions where they conflict.
NJ reaffirmed all seven rules verbatim in a subsequent direct message;
Product redistributed the reaffirmation to all five engineering chats.

1. Each engineer owns a new feature or bug fix end to end: implementation,
   all relevant unit, integration, security, permission, accessibility,
   browser, performance, failure/retry, migration/recovery and regression
   checks as applicable, staging acceptance, rollback verification,
   production deployment and post-deployment verification. CI alone is not
   acceptance; keep exact revisions, environments, counts, skips and evidence.
2. PAM, JIM, Deployment SHO and other obsolete named individuals in older
   BTF descriptions no longer exist. Do not wait for them or delegate their
   delivery obligations away. The engineer owns delivery; Product coordinates
   real dependencies, priorities and release windows.
3. Work on one story at a time. Finish it end to end before the next, except
   for the explicit dependency-queue exception below.
4. Before advancing, fully reconcile BTF and mapped Bug Off scenarios,
   cases, scripts, runs and results with actual evidence and links. A parked
   story remains unfinished; never mark it Done to clear a queue.
5. Product assigns a concrete goal containing the engineer's stories. The
   engineer records that goal with the goal tool and persists until achieved.
   Preserve an existing unfinished goal truthfully; do not falsely complete
   it to replace its objective. Report goal-tool scope limitations to Product.
6. Product checks actual prerequisites, existing interfaces, fixtures,
   release ownership and acceptance conditions before assignment. Select
   independent vertical slices, not consecutive issue numbers. Do not assign
   work that requires another engineer to finish a future story. Qualified
   existing shared code can be consumed with explicit provenance; an unbuilt
   feature cannot be treated as an available interface.
7. If a dependency emerges, checkpoint the current story, report it to
   Product, and move to the next Product-assigned eligible independent story.
   Product records owner, unfinished work, dependency owner, exact resolution
   evidence and resume trigger in DEPENDENCY-QUEUE.md. If no eligible next
   item exists, Product must audit and assign one; engineers do not guess a
   replacement or continue old ranges. Reassign/resume the parked story when
   its dependency resolves, at a safe story boundary.

Persist safely: a goal does not override explicit approvals, source freezes,
resource reservations, real access boundaries or instructions to preserve
resources. Report exact missing actions; prepare reviewable work before
requesting approval. Never fabricate tests, identities, acceptance or release.

The user requested dependency-resolution triggers in this policy. Product
records the exact condition and handles incoming owner-resolution events.
An initial hourly check was rejected under the earlier paused-schedules
preference. The human subsequently explicitly approved the hourly dependency
check. Automation `hs-dependency-follow-up` is now ACTIVE, hourly, attached
to Product. Unrelated previously paused schedules remain paused. It stays
quiet on unchanged state and sends an authorized engineer a bounded resume
assignment only after resolution evidence has been verified, at a safe story
boundary. It grants no new access, cleanup, publishing or deployment authority.
