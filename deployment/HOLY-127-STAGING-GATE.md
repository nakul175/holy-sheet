# HOLY-127 staging coordination

Exact PR130 head87325c286b287a7260bd3eeb71b8cceeb4cfcf08 merged as eecb3ee9e366c2e3bd7d7c62d7529f8d68f00923. PR attached to Product. Product independently rechecked resulting merge Actions40757625558: all four checks now SUCCESS. Engineer reports main JUnit1056total=1050passed+6skipped, zero failures/errors. PR-head CI and local service skips remain separately identified.

Selected method: import exact main-CI archive, no host source build. Reported artifact12845859335 ZIP116,141,678B/digest4cbf869d...; archive117,155,417B/SHA7c183283...; uncompressed tar317,839,872B; qualified image sha256:1b1cfc4c3d4e0fd518434989a2f0b3a0d649975f34be50f780ec039d161e38bc, reported310,238,422B. These artifact sizes/hashes remain engineer receipts pending final artifact inspection.

Budget correction: largest-layer-only load scratch150,512,128B is not independently proven conservative. Product requires potential full uncompressed-tar scratch317,839,872B absent exact-method proof. Archive+image+fullscratch+16MiB metadata =762,010,927B. Against fresh reported margin937,697,280B, backup output PLUS its temporary peak must fit175,686,353B (~167.5MiB). Recheck actual capacity immediately before phases; no claim a streamed input eliminates Docker scratch. Exact normal backup helper verified in live sudo list: sudo -n -u hs-staging /opt/holy-sheet-staging/backup.sh, no invented arguments. Read-only helper/source inspection approval pending; no backup/transfer started.

Fresh constrained status:
- Current source073175bfcb034d207916b13ca6d9e07fb81cde4d.
- Current image sha256:e40ca5bfa0525decfebb851bb8ab0752ae1f0d4d0cbd7915e9623eff63d52b5d.
- Previous source8be0dd3d91d58dbde6752b9457d56f984b5cd4f6. Exact previous image not yet captured.
- App running; no Docker health check configured. Actual HTTP readiness remains a separate check.
- Database and scanner healthy.
- OIDC1, rich editor1, local preview0; origin staging.holysheet.aplyd.org.
- Free3,085,443,072 bytes on shared root filesystem; reserve2,147,483,648; incremental margin937,959,424 bytes.
- No matching heavy release/build/dump/restore/seed process in filtered process check.

Engineer1 explicitly confirmed no owned HS staging slot, active acceptance measurement or stage/auth mutation; window free. Product initially reserved next window to Engineer4/HOLY127, then RELEASED the reservation after read-only inspection proved the current helper incompatible with the selected safe method. No eligible live write is waiting solely on slot ownership. Eng4 continues offhost review-only capped-backup/exact-image-operation preparation; fresh slot must be explicitly reserved after packet approval. Engineers3/5 have no live slot.

Outstanding gates: exact-artifact verification; capped no-prune backup and supported exact-image import method; fresh capacity preflight; exact current073175bf/imagee40c rollback receipt and fresh DB backup. Inspection-only human approval completed: helper has no size bound and prunes old backups; deploy helper rebuilds rather than importing image. See HOLY-127-BACKUP-INSPECTION.md. Backup/transfer/deployment remain NOT authorized under inspection approval. No cleanup or root wrapper modification authorized by this coordination.
