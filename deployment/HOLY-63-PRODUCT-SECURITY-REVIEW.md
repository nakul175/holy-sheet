# HOLY-63 Product security review — 28 October 2026

Reviewed code commit: `5bffd7ac91e0dd227a8f288b82799dcc74e7ed57` in Engineer 5's isolated worktree. Branch base: `dccc981fbeb0d2a53947f5aca03105d0465bba25`. The three-file PR 119 dependency at `28e43fdc62977cbd0f5f4425a2fa4d7feece8fcf` was applied separately for qualification and excluded from the HOLY-63 branch. Proposed combined qualification tree: `c1802ffa02b17126a9585d25b3b2c511bc307145`.

Product performed read-only review with separate core and surface reviewers. No tests, publishing, live access or deployment changes were performed by these reviewers. The 23-file implementation is **not approved for publishing/release** pending the following findings.

## Required privacy fixes

1. **P1 — Unpublished source pins.** `lib/document-publishing.ts:51–59` lets source editors pin a numeric current draft revision, while `projectSnapshot` around line169 lets a source reader see that pin whenever the source has any active publication. A source's approved V1 does not authorize its viewer to see confidential V2 copied through another publication. Enforce the exact pin's publication/reader provenance or safely reject/redact unsupported draft pins.
2. **P1 — Transitive block provenance.** `lib/document-publishing.ts:64–68` can select a paragraph already resolved from another source T in publication S, but records only S in the new manifest. A downstream reader may receive T's content despite T denial/revocation. Preserve bounded transitive authority, or reject binding into already resolved external-source content in this release.
3. **P1 — Draft discussion anchors.** Existing `lib/discussions.ts:18–23` uses raw page access and returns stored anchors, including `Anchor.quote` copied from an unpublished draft. Reader projection must match the currently permitted publication view.
4. **P1 — Exported linked draft titles.** `lib/page-exports.ts:25` resolves linked-page metadata through raw access and copies the draft title into exports. Resolve labels through the same publication-aware view and handle a configured source with no publication safely.
5. **P1 — Notification draft titles.** Existing `lib/notifications.ts:26` returns current draft titles after raw access. Notification/inbox presentation must respect publishing visibility and withdrawal.

These are static findings requiring targeted negative regressions, fixes, and independent re-review. Existing ungoverned-page behavior should remain intact. They do not authorize broad changes to other stories, new grants, or unrelated delivery features.

## Evidence limits / next gate

Engineer 5 reports final host-only 1,005 passes, 45 explicit service skips, successful typecheck/build and 16 browser checks for the reviewed source. Those results do not cover the privacy fixes now required. Historical PostgreSQL/scanner/restore evidence remains historical; heavy local DB work is paused for the VM capacity incident.

The historical old-image guard rehearsal supports only its pinned local image. The selected operational fallback, traffic switch, maintenance configuration and content-bearing surfaces need exact acceptance before any rollout. Additive migrations alone do not make an older draft-reading image safe.

Automatic approval review rejected GitHub publishing and the latest BTF update. Prepared messages remain local. Do not retry through another agent/tool as a workaround. After code review is closed and final gates/manifest are concrete, obtain the required direct approval for the exact repository/tracker actions. All six mapped Bug Off cases2028–2033 remain Not Run until deployed authenticated acceptance.

## Local follow-up7e04daa

Product verified that the human subsequently approved initial source publication/BTF retry in Engineer5's chat. Draft PR123 was published at5bffd7a before the security findings arrived; it remains unmerged/undeployed. A separate human approval authorized sending the fix checkpoint to Product for re-review. That message approval is not merge/deploy authority.

Independent read-only re-review of local7e04daaa890d3b57f25a7f588f3baff5982a326e found the original five P1 boundaries addressed. One P2 remains: a draft save remaps globally shared anchor coordinates, so comments/notifications on an unchanged publication can disappear when the same block ID has unpublished text inserted before its anchored quote. Preserve publication-bound anchor coordinates separately from draft remapping and add that stable-ID regression before a final freeze. Historical host gates do not cover the future correction.

Indexed workspace search belongs to Engineer4/HOLY-2. Engineer3 owns workspace factory/Observer changes. HOLY-63 must integrate its publication-visibility contract with the newer index before release, with separate combined-main evidence; it must not silently take over another engineer's feature work.

## Anchor correction review — 149ec0ef

Independent read-only review closes the P2 at
`149ec0ef1c9e6409fe6c32c39d103f8d6de84749`. Immutable publication/thread
bindings preserve approved anchor coordinates separately from editor draft
remapping. Discussion reads, notifications, mutations and exact retries
check the binding against the currently authorized publication projection.
Composite foreign keys bind page, publication and thread. Source redaction,
withdrawal and grant revocation still deny visibility; legacy unbound
anchored threads fail closed. No new actionable findings in this delta.

Product verified a clean worktree and that all 527 manifest entries match
qualification tree `7e04d955732933b243bf4e6a03bd15ec7d259d10` exactly. Its
only differences from the code commit are the three separately stated
PR119 dependency files. JUnit independently counted 1,022 passed, 45 service
skips, zero failed; logs show 16 browser checks passed. The original failed
red regression and sandbox-port failure remain preserved separately.

The original manifest SHA-256
`42800be2da096acf77999f69e301a02761979153d84db957d5d7a5b470eff7c7`
is preserved. Replacement metadata-only manifest
`manifest-provenance-corrected.json` SHA-256
`f585b626e777a01a59b39a9513c1779ecfd982f908cf0a8deb4581c0818dbf27`
corrects search ownership to Engineer4/HOLY2 and workspace/Observer ownership
to Engineer3/HOLY1. Product verified the file manifest/code/tree unchanged.

This closes the reported finding, not service or combined-main acceptance.
PR123 remains at historical head 5bffd7a, draft/open/unmerged. Changed fixes
are unpushed. Next: clean current-main integration, publishing adapter for
the ordinary search index with per-reader revision selection before
matching/pagination, fresh applicable qualification and frozen reviewable
publication payload. No merge, deployment, access/config change or new
publication approval follows from this review.

## Current-main/search adapter checkpoint — 72404a20

Reviewed owned adapter `72404a20df70468c7ffdb8c42625acae73e5bd90` on
main de68a4c, combined tree `03ae23e8eaa454d5323a28a6993f72e5276d5fa2`.
Product verified all 539 manifest entries, 1,047 JUnit passes / 48 service
skips / zero failures and sixteen browser passes. Manifest SHA-256
`a4dcb29cb19ae055999046c6f13de34a9d239e97316bd2fee113be068a1fee74`.
PR120 dependency06eb9be later passed all four CI jobs separately.

Provenance correction: qualification commit dd2712a contains thirteen exact
PR120 source blobs and one HOLY63-owned merged UI file,
`components/holy-sheet-app.tsx`, retaining PublishingDialog/state/UI. It is
not fourteen identical dependency blobs. Original evidence is unchanged;
receipt `merged-ui-provenance-correction.json` SHA-256
`1ef62cf3afdac3a9dc610ef9c54320318011fe56127eb8c8782eb3b52d014043`
records this explicitly. Eventual publication must exclude qualification-only
history and refreeze against actual merged upstream source.

Independent privacy review found:

1. **P1: Observer owner draft exposure.** publication-search.ts line16
   treats raw page ownership as authoring, while Repository.get line50
   trusts the old access predicate that checks ownership before Observer.
   Publish V1, save confidential V2, demote its owner to Observer, search
   V2-only text: this combined tree admits the draft. Clamp the publishing
   authoring predicate independently and use the same current decision for
   draft block fetch. Engineer3 separately owns the global Observer authority
   fix; its unmerged status cannot be silently treated as a dependency pass.
2. **P2: within-page projection not bounded by scan deadline.**
   publication-search.ts line29 awaits a full Repository.get before checking
   time at line33. Up to 500 pins may repeatedly fetch/hash large source
   publications before the check. Per-SQL statement_timeout does not bound
   this combined work. Propagate deadline/cancellation and bound/cache exact
   source projection work; test the expensive permitted case.

Engineer4's complementary frozen-tree index review established no other
introduced search contract defect statically: governed matching is projected
before rank/paging and ordinary/governed ordering is deterministic. It found
an inherited HOLY2 Unicode Number classifier defect: price² matches the JS
kernel but [:alnum:] indexing may drop superscript2 and exclude the candidate.
Engineer4 owns that bounded ordinary-index fix and parity qualification;
Engineer5 must not take it over or call it a publishing defect.

Engineer5 may fix the two introduced findings on a separate local ref while
preserving this frozen review tree. Combine findings before stable full
qualification; wait for the exact corrected ordinary-search dependency before
claiming a final combined release. Real PostgreSQL/concurrency/workload and
rollback/live acceptance remain unrun. No new publication, merge, deploy,
access/config or heavy-service authority follows from this review.
