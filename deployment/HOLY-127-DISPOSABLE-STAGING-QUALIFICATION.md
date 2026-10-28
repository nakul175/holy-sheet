# HOLY-127 disposable staging qualification request

Status: **parked pending Product review, a serialized staging slot, and one fixed operator helper. Do not run through the existing `backup.sh`, `deploy.sh`, or a general root shell.**

## Frozen inputs

- Review source: `f4f5a94fb16380021b501ab1da85e888994c0172` (tree `e9b1e764b80ec416402ba8f12f18955e74cfaad0`).
- PostgreSQL image already declared by the application: `postgres:18-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc`.
- Backup orchestrator SHA-256: `f1f4655f0129167ae9a2c85e5165780674ad5272aacb59e457eaa8e81ee1d79c`.
- Bounded stream SHA-256: `8c874d97c9f6e86be0581ed82c4fff5ab1e539bf57b562c598c5c846040077e2`.
- Fixed disposable operation ID: `holy127-q-f4f5a94-20261029a`. A collision must fail closed; it must not reuse or delete a pre-existing resource.

## Exact isolated resource manifest

- Docker network: `holy127-q-f4f5a94-20261029a-net`.
- Docker container: `holy127-q-f4f5a94-20261029a-db`.
- PostgreSQL data: container tmpfs mounted at the image-declared volume root `/var/lib/postgresql`, hard limit 128 MiB; set `PGDATA=/var/lib/postgresql/18/docker` explicitly.
- Container scratch: tmpfs `/tmp`, hard limit 32 MiB.
- PostgreSQL socket directory: tmpfs `/var/run/postgresql`, hard limit 16 MiB.
- Host receipt directory: `/var/tmp/holy127-q-f4f5a94-20261029a`, created mode 0700 by the fixed operator account, maximum retained output 64 MiB.
- No named volume, bind mount, published port, Compose project, application container, current database, scanner, backup directory, environment file, secret, incoming image, or production resource is in scope.

The official PostgreSQL image source declares `PGDATA=/var/lib/postgresql/18/docker`, `VOLUME /var/lib/postgresql`, and entrypoint `docker-entrypoint.sh` for PostgreSQL 18. The fixed helper must also confirm those three values from the locally present pinned image before creation. Mounting tmpfs at the declared volume root prevents Docker from allocating the image's anonymous volume. Immediately after create and before seed, inspect `.Mounts` and require exactly the intended tmpfs mounts and no mount whose type is `volume` or `bind`.

The fixed helper may use only these Docker operations: exact-image `image inspect`; `network create/inspect/rm` for the named network; `run --pull=never`, `inspect --size`, `exec`, `top`, `stats --no-stream`, `stop`, and `rm` for the named container; and fixed live Compose `ps -aq` for an identity snapshot. It may measure only the named container and receipt directory. It must reject any resolved image ID that is not the pinned digest and must never pull. It must use the existing shared release lock `/run/lock/holy-sheet-release/release.lock` through `scripts/hs_release_guard.py`; no qualification-specific lock is acceptable.

## Capacity envelope

Before creation, require filesystem free bytes minus `2147483648` reserve to be at least `402653184` bytes (384 MiB). The combined memory-backed and filesystem envelope is:

| Item | Hard/operational bound |
| --- | ---: |
| PostgreSQL data + WAL tmpfs (memory-backed) | 134217728 B |
| PostgreSQL `/tmp` + socket tmpfs (memory-backed) | 50331648 B |
| bounded dump/receipts | 67108864 B |
| container writable layer ceiling | 67108864 B |
| Docker metadata/runtime margin | 100663296 B |
| **combined envelope** | **419430400 B** |

The image must already be present and is not counted as new allocation. Host filesystem qualification requires 128 MiB for the bounded dump/receipt/metadata portion above the 2 GiB reserve; the 256 MiB container memory limit separately contains the 176 MiB of tmpfs plus PostgreSQL runtime. Require both 384 MiB of available host headroom above reserve and 384 MiB of available memory before create. Capture free bytes, available memory and Docker usage before create, after seed, at cancellation peak, and after cleanup. Abort before creation if any image, reserve or memory test fails. Run the container with a read-only root filesystem and `--log-driver=none`, so there is no unbounded writable layer or Docker log; all intended writes are confined to the three capped tmpfs mounts and the capped private host receipt directory.

## Qualification sequence

1. Acquire the HOLY-127 staging serialization lock and record current application/database/scanner container IDs. Recheck those IDs after cleanup; they must be byte-for-byte unchanged.
2. Prove the exact PostgreSQL image exists locally with no pull. Record its repo digest and image ID.
3. Reject collisions for every manifest entry. Create only the named network and container, with no published ports, `--read-only`, `--log-driver=none`, tmpfs `/var/lib/postgresql:rw,size=128m`, `/tmp:rw,size=32m` and `/var/run/postgresql:rw,size=16m`, explicit `PGDATA=/var/lib/postgresql/18/docker`, `--memory=256m`, `--memory-swap=256m`, `--pids-limit=128`, `--security-opt=no-new-privileges`, and a generated operation-local password that is never printed or retained. The reviewed helper must preserve only the minimum image-entrypoint capabilities proven necessary for directory ownership and PostgreSQL startup; it must not guess `--cap-drop=ALL` before that proof. Before seed, require inspect to show no anonymous/named volume or bind mount and the resolved PGDATA beneath the capped tmpfs.
4. Wait for readiness and create a bounded synthetic fixture only: one database, one table, 100000 generated rows containing deterministic hashes, followed by `CHECKPOINT`. Record database size and reject it above 64 MiB.
5. Baseline: run the frozen orchestrator command surface against `docker exec` and complete one capped custom-format dump plus `pg_restore --list`; retain only sanitized byte count, digest, exit state, process IDs, timing, and capacity values.
6. Timeout test: hold an explicit PostgreSQL transaction lock that blocks `pg_dump`, start the same real `docker exec ... pg_dump`, let the orchestrator timeout, and require all of: nonzero/timeout result, no published dump, no host-side Docker CLI/process-group member, no container-side `pg_dump`, and no matching `pg_stat_activity` backend within 5 seconds. A surviving process/backend is a failed qualification, not a cleanup success.
7. SIGTERM test: repeat the blocked real dump, send SIGTERM to the orchestrator process, and require the same four absence checks plus no pending/final file.
8. If a failed assertion leaves a disposable `pg_dump`, terminate only that process inside the named disposable container, capture the failure receipt, and mark the gate failed.
9. Stop/remove only the named container and remove only the named network. Prove both are absent, current staging IDs are unchanged, and the 2 GiB reserve still holds before finalizing the sanitized receipt. The private host receipt directory is deliberately retained only for fixed-operator collection; after its receipt is copied off-host and verified, the operator removes that exact directory in a separately logged final step. Until then, the receipt must explicitly say the directory is retained and must not claim full manifest absence.

## Acceptance and disposition

Pass requires baseline success, timeout cancellation success, SIGTERM cancellation success, all capacity checkpoints, exact cleanup, and unchanged live staging resource IDs. The executable candidate is `scripts/holy127_disposable_staging_qualifier.py`; it still requires hash freeze and Product review before a slot can be granted. Any missing reviewed helper, operator permission, image, headroom, slot, or cancellation proof parks HOLY-127 with evidence; it does not authorize a broader helper, pruning, image pulls, or changes to live staging. No deployment switch and no production action are part of this qualification.
