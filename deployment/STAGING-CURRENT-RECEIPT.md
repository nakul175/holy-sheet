# Latest verified shared staging handoff

Recorded28 October2026; refresh live status before any switch or acceptance window.

Product verified the direct human instruction in Engineer2's chat: merge PR119 thenPR121 into current main, requalify the resulting merge revision, and deploy that revision to staging. That authorization excludes production.

- PR119 merge: `b4302fc880464236d41c48132564283e403efe20`.
- PR121/current staging merge: `b588a468961713a3c3dc9eeee9c30950248191a2`.
- Image: `sha256:feba10b66ddbd946910d69611b3439dce2a03ba7ecc9b70d5a59cfb39588d4ef`.
- Previous/rollback: `ec678a7da35c17140d04e21bc4b98849b99dd034`.
- Pre-switch database backup SHA-256: `4562ebb16c7443a221c4ee131cacf470f3d4737b57545154386af6c74a441b20`.
- Exact-merge CI40721997955: all four checks passed; reported1,024 passes/six scanner skips,39 actual PostgreSQL cases, backup/restore, typecheck/build.
- Wrapper receipt: running application, healthy PostgreSQL/scanner; root/UI200, anonymous session/protected rollup API401.

Detailed release/acceptance evidence: `outputs/HOLY-44-ACCEPTANCE-MATRIX.md`.

This is the last verified staging receipt, not a guarantee that another authorized release cannot advance it. Anonymous probes do not qualify signed-in feature behavior. HOLY-44 AC1–6/Bug Off1914–1919 remain open pending tenant-authority and exact role fixtures. No production change was authorized by this sequence; read back the current production baseline separately before a future release.

Future candidate owners must preserve this combined baseline, refresh status, integrate current-main changes and qualify the exact candidate before a reserved staging switch. No further staging slot, identity/role grant, credential change or production deployment is authorized by this document.
