# Remaining story gates assessed in sequence

The BTF stories HOLY-9 through HOLY-17 are now present. Source snapshots are retained in the surrounding project at outputs/holy-sheet/overnight-20261026. This records implementation limits, not acceptance results.

| Story | Current decision / remaining gate |
| --- | --- |
| HOLY-9 organisation | Move/reorder/subtree mutation needs explicit source/destination management capability and reviewed inherited-access delta. HOLY-5 has not supplied that authority mapping. No move mutation is exposed by assuming content ownership alone. |
| HOLY-10 Trash | Delete/restore batch needs management/recovery and destination-create authority, present-entitlement preview and retention policy integration. No destructive or broad recovery shortcut is exposed. |
| HOLY-11 favourites/Recents | Foundation merged in PR #9, 5cff4a1555fec7fd7db346ea4a62dbfd0ea73cb4; BTF In Progress verified. Full paired SHO and release gates remain in HOLY-11-REVIEW.md. |
| HOLY-12 backlinks | Foundation merged in PR #10, b745eb6. Full reference policy across template/import/history paths and release gates remain in HOLY-12-REVIEW.md. |
| HOLY-13 import | Specification sets 20 MiB compressed, 100 MiB expanded, 10,000 blocks, isolated parsing, conversion preview, asset omission review, 24-hour source expiry and destination-create authority. An isolated parser runtime and destination capability/policy need to be established and qualified. Do not attach arbitrary Word parsing to the application process or treat ordinary attachment upload as an import implementation. |
| HOLY-14 export | Requires explicit export capability/workspace policy in addition to read, pinned current snapshot and requester-bound 15-minute download jobs. No export privilege is inferred from Viewer or suite login. PDF layout/private asset handling and job lifecycle remain implementation work. |
| HOLY-15 SHO checklist task | Requires the real delegated-user SHO project/assignee/create adapter and idempotent task-created/source-pending saga. No task is created via a fabricated service account or an unchecked destination. |
| HOLY-16 connected search | Scoped contract foundation implemented using existing HS read checks; actual SHO delegation/identity and release qualification remain open. See HOLY-16-REVIEW.md. |
| HOLY-17 live collaboration | Existing optimistic save/conservative merge is not CRDT/OT collaboration. Needs a selected convergence protocol, authenticated operation/session transport, revision/history integration, presence expiry, reconnect/revocation tests and explicit performance/backpressure budgets. Do not claim the current conflict dialog satisfies convergence. |

Actual staging DNS still has no A record on the last check. The user was given a Grok infrastructure prompt. Suite identity, private object storage and actual SHO embed integration remain unqualified. All foundations retain the disabled production feature flag. No schedules were enabled, no story was marked Done and no unexecuted BugOff case was marked passed.
