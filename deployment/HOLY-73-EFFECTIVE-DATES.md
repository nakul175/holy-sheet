# HOLY-73 effective-dated information

Code and Vitest cover AC1–AC6 for selected scalar and reference fields. This change does not run Bug Off on staging, does not activate a schedule, does not migrate production data, and does not add a legal or payroll calculation.

Effective time is stored apart from the transaction time (`entered_at`). A proposal carries an IANA timezone and a half-open interval `[start, end)`. Overlapping occupied intervals are rejected. A start before the transaction time needs the separate `correct-effective` capability, an assignment flag, and a reason. Those grants do not add record access.

Scheduled values stay scheduled until someone activates them. Activation checks the field, reference target, and field rights again. A failed check is stored as `blocked` and does not replace the current value. As-of reads, the as-of download, and the `effective-value` calculation all identify the as-of instant. Cancelled intervals remain in history and drop out of as-of results.

Configuration (`manage-effective-dates`) and effective-date assignment do not grant collection, record, or field access. Search, preview, download, and history use the same tenant, record, and field permissions as the rest of Holy Sheet. Mutable field settings are versioned. Writes take an operation id; a retry with the same body returns the first result, and a retry with a different body does not overwrite it. Drafts stay on the server until they are discarded.

The screen uses labelled controls, 44px targets, and a single column below 720px. No staging Lighthouse or assistive-technology pass is claimed.
