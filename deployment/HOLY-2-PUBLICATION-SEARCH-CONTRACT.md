# HOLY-2 / HOLY-63 search integration contract

Engineer 4 owns the ordinary saved-page search/index. Engineer 5 owns publication visibility and must qualify the publication adapter before activating governed pages. This contract does not add publication behavior to the current fourteen-file HOLY-2 payload or block independent ordinary-page acceptance.

The current ordinary-page index contains saved title/body and literal word chunks. Candidate matching, ranking and snapshots use that text under current native workspace/page permissions. Returned results recheck native page access and matching; opening a result rechecks again. The index itself carries no copied access grants. It is a current saved-document projection, not a publication entitlement or safe index for a different visible revision.

For governed pages, HOLY-63 must supply the reader's exact currently visible revision before candidate matching, rank, preview and pagination. Raw current-draft text cannot substitute for a viewer's published revision. Filtering only after a raw-draft query is insufficient: it can omit published matches or leak draft-match existence through pagination. Title, snippets, locations, next-cursor presence and counts must derive from the same authorised revision; current revocation/withdrawal must override stored candidates. Publication activation must not grant page access.

Cross-feature qualification owned by HOLY-63, with Engineer 4 reviewing index changes:

1. Approved V1 plus confidential draft V2: Viewer finds V1-only tokens, cannot find/infer V2-only tokens/title through any result or cursor; Editor sees only the explicitly selected permitted authoring context.
2. No active publication, withdrawal, source/parent revocation and cross-workspace collisions: no hidden title/path/snippet/count/cursor leakage; direct open independently denies unavailable content.
3. Published source pins and transitive provenance: search uses exactly the per-reader permitted projection; a publication elsewhere cannot expose a draft or revoked source.
4. Concurrent publish/withdraw/edit during initial search and Load more: revision-consistent permitted results, no stale entitlement, preserved ordinary-page behavior and bounded resource use.

Use dedicated synthetic accounts and immutable candidate evidence. Local or ordinary-page CI is not live publication acceptance. Do not activate governed-page indexing until this contract and negative cases pass against the actual combined implementation.
