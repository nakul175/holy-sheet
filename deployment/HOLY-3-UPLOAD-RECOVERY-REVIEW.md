# HOLY-3 pending upload recovery checkpoint

Production remains disabled. This is an incremental implementation, not HOLY-3 acceptance or staging qualification.

## Behavior

Upload details and retry identity are encrypted in a separate IndexedDB store using a nonextractable AES-GCM key, account/page/draft/type binding and a fresh authorized server key unlock. Source file bytes are not persisted. The existing encrypted text store migrates without rewriting its ciphertext. An unrelated text save cannot clear pending uploads.

The editor checkpoints selection details, reservation identity, confirmed media ID and placement. Uploading requires a confirmed recovery checkpoint; storage/key failures explain that recovery is unavailable. Closing retains details. Explicit discard requires confirmation and serializes cleanup behind outstanding checkpoints. Web Locks coordinate recovery use, acknowledgement and discard across tabs. Unsupported coordination fails visibly.

After reload, the page offers Review/resume, an explicit new destination, copy details and discard. Read-only users can inspect/copy/discard their own authorized details but cannot upload, attach or renew. Logout clears decrypted panel state and closes the upload dialog. An original destination is checked against its captured content hash; a changed destination requires an explicit placement choice. Large anchor content is represented by its digest rather than copied into every pending record.

Incomplete uploads require reselecting the original filename/size and, when captured, matching SHA-256. Ready uploads require fresh page/uploader/object checks and explicit review before attachment without reselected bytes. Stable intent IDs make an acknowledged insertion/replacement retry idempotent. Recovery clears only after a fresh server document contains the exact intended block, media and title or image description/caption.

Migration 007 adds renewable reservation expiry and owned recovery-key binding. Expired active reservations cannot be revived. Active transfers are protected from abandoned-object maintenance. Verified Ready objects are pinned to a still-valid owned recovery lease in the same transaction before acknowledgement; renewal preserves that pin even when a client missed the response. Unsafe files are never pinned or served. This does not extend expired recovery keys or persist unuploaded source bytes.

## Evidence

- Browser rehearsal: select clean-two.txt, Close and keep recovery, reload, recover details, reselect original file, actual scan, attach, Saved, pending record acknowledged and removed. Screenshot: outputs/holy-sheet/overnight-20261026/HOLY-3-pending-upload-resumed-saved.png in the surrounding project workspace.
- Crypto tests cover ciphertext/account/page/type isolation, nonextractable keys, v1 migration preservation, expiry and storage failure.
- Client authorization tests cover fresh existing-key unlock, denied unlock retention, exact-save acknowledgement and another-tab lock contention.
- Server tests cover ownership, discard, immutable binding, expiry/renewal, quota release, Ready pin preservation and active-transfer maintenance protection.
- Real scanner lost-ack coverage verifies atomic Ready recovery lease binding.

Exact completed run counts are recorded in OVERNIGHT-LEDGER.md. Logs are retained under ignored artifacts/.

## Remaining gates

Expired local records are reported, but a dedicated expired-record cleanup control remains to be implemented. Browser coverage does not yet qualify simultaneous cross-tab crash/restart races, all network interruption points, mobile/browser matrix, accessibility, long-session performance, storage exhaustion or every HOLY-3 acceptance case. The coordinator and crypto have focused automated coverage, not full device acceptance.

HOLY-3 still needs the remaining import/transform behavior and full security, recovery, accessibility and performance gates from its final specification. Actual suite identity, private staging object storage, DNS/TLS, SHO embed and integrated staging acceptance remain unresolved. Do not enable the rich editor or mark the story Done based on this checkpoint.
