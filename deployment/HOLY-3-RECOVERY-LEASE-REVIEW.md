# Recovery lease/checkpoint candidate

Controlled tests reproduced four client expiry failures and one warning-state
failure before these changes. Text checkpoint storage accepted expired or invalid
lease metadata, including a lease expiring during encryption. A successful server
lease renewal also cleared the local storage-failure warning after a failed write.

Text and upload checkpoints now validate finite, unexpired leases before and
after encryption and immediately before the IndexedDB write. A rejected late text
checkpoint preserves the previous ciphertext. A server renewal never clears a
storage warning by itself; only a confirmed local checkpoint clears that warning.
That local success does not mark dirty text as server-Saved.

Twenty-five focused client recovery/upload/session tests pass. The cases use real
WebCrypto and isolated IndexedDB fixtures for expiry and preserved ciphertext,
plus the real session hook with controlled storage failure and renewal. These
are local automated proofs, not browser-account-switch or staging acceptance.

The shared local editor contains this client, so the artifact is versioned as
0.1.0-holy3.3. Package integrity/provenance and combined CI must be recorded for
each consuming candidate. No staging deployment, retention extension, server-key
policy change or permission grant is included. Grok's live tests continue on the
unchanged staging revision.
