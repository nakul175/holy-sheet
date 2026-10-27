# HOLY-17 protocol experiment

This isolated package evaluates a candidate; it is not imported by Holy Sheet, is excluded from the Docker context, and does not enable collaboration or change the application lockfile. Install with `npm ci --ignore-scripts --prefix experiments/collaboration`; run with `npm test --prefix experiments/collaboration`.

Candidate: Loro 1.17.1, pinned with registry integrity. Its movable tree can keep a stable container while a block moves, and nested rich text can merge text/marks separately from structure. That is a useful fit to investigate for HOLY-17 move-versus-edit requirements. This remains a candidate, not an approved production protocol. A direct Tiptap binding using Yjs is another option; its transaction/initialization/schema caveats also need qualification before selection.

Primary references consulted 27 October 2026:

- [Loro movable-tree documentation](https://loro.dev/docs/tutorial/tree)
- [Loro JavaScript API](https://www.loro.dev/docs/api/js)
- [y-prosemirror binding caveats](https://github.com/yjs/y-prosemirror/blob/master/CAVEATS.md)

Local result: 12 positive protocol checks and one unsafe-behavior characterization passed. Synthetic same-position and disjoint text edits, move/edit, opposite-parent moves, delete/edit, rich marks, checklist state/text, independent table cells, table-subtree delete/edit, malformed binary rejection, causal dependency reordering and 64 deterministic three-peer insertion samples were exercised. Convergence cases replay six delivery orders, duplicate updates, replica reconciliation and snapshot reload. Equality checks include text deltas/marks and tree identities, not just plain text. Results are separate from the 309 application tests. Full output is retained under ignored artifacts/collaboration-convergence.log.

**Release-blocking counterexample:** a raw movable-tree deletion concurrent with moving that same block can converge by bringing the block back under its new parent. The thirteenth test intentionally characterizes that behavior; its green result is evidence of an unsafe candidate outcome, not an HS acceptance pass. Raw Loro tree projection is therefore rejected for HOLY-17's no-resurrection requirement. A proposed adapter needs an independently enforced deletion/tombstone and epoch policy with server-authorized explicit restoration, then repeat all move/delete/descendant/copy/restore cases. No such adapter is implemented here. Do not select or enable this raw candidate based on convergence alone.

## What this does not prove

There is no Tiptap-to-tree mapping, valid-document projector, server authority or authorization in this package. Generic CRDT convergence does not enforce Holy Sheet schema or permission policy. A raw update must never be accepted directly into the canonical page merely because the binary decoder accepts it. Application block IDs here are synthetic metadata; authenticated writers could duplicate or alter them without an enforcing adapter.

The implementation gate remains: transaction-to-operation mapping for every supported rich block, schema-safe deterministic projection, immutable block identity, concurrent insertion/deletion/move semantics, limits before allocation, page/epoch binding, authenticated operation attribution and deduplication, transactional persistence before acknowledgement, permission recheck under the canonical page lock, revocation/Trash termination, relative cursors, presence expiry, reconnect recovery, local Undo, history and encrypted draft integration. Delete-versus-move and concurrent table shape/merge/split transforms still need explicit product semantics and proofs. Existing plain snapshot save must not race the collaboration authority.

Before choosing this candidate, build a representative Tiptap adapter behind a disabled experiment flag and test all schema transformations across multiple clients. Measure document/update size, memory and CPU on the constrained deployment host, and select explicit budgets. Add server restart/failed persistence, current permission revocation, session expiry, malformed/oversized operation, multi-page isolation and actual browser accessibility/mobile cases. Do not mark HOLY-17 or BugOff acceptance passed based on these library-level checks.
