# History acceptance continuation

A lost restore response now keeps the reviewed source and original operation ID, labels the result unconfirmed, and disables choosing a different source until the existing restore is reconciled. A retry cannot silently become a second restore. Closing an unconfirmed request requires acknowledging that the local retry handle will be lost; saved history remains the authoritative recovery path.

The dialog explains loading, empty history and the first saved version. Successful restore acknowledgement is separate from a later history-list refresh failure, so a failed list request cannot misreport a confirmed restore as uncommitted. Permission denial on restore removes the historical preview and list.

Focused validation covers the lost-response/retry identity and first-version explanation, plus the existing server history/retention/integrity/restore and diff tests. This does not assert the physical-device/screen-reader or paired-host live acceptance matrix has run. No history retention or attachment policy is changed.
