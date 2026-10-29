#!/usr/bin/python3
"""Atomically update the fixed HOLY-127 installed surfaces after a failed run."""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import signal
import stat
import sys
import tarfile
from collections.abc import Iterator

SOURCE_COMMIT = "5bc68a18a1004146e6300ae1e79e24228428ae42"
ARCHIVE = pathlib.Path("/root/holy127-transfer-inbox-cancel-v3/holy127-payload-5bc68a1.tar")
ARCHIVE_SHA256 = "de15ba0fe8714db6f0b2c55c8c67f7f69fca9fdd2f546f4814e603b995b674b3"
ARCHIVE_SIZE = 153600
LOCK = pathlib.Path("/run/holy-sheet-release/release.lock")
RECEIPT_DIRECTORY = pathlib.Path("/var/tmp/holy127-q-f4f5a94-20261029a")
OLD = {
    pathlib.Path("/opt/holy-sheet-qualification/holy127-4c1fdbda6becaf76/holy127_disposable_staging_qualifier.py"): "4db35d5e5018d39150574b88630437363f68e66c52229f66ef8c4cf5e514b604",
    pathlib.Path("/opt/holy-sheet-qualification/holy127-4c1fdbda6becaf76/holy127_backup_orchestrator.py"): "f1f4655f0129167ae9a2c85e5165780674ad5272aacb59e457eaa8e81ee1d79c",
    pathlib.Path("/opt/holy-sheet-qualification/holy127-4c1fdbda6becaf76/hs_release_guard.py"): "11f13274f4f2e9255bc6382cfebef607ff201c2aa27e6a758ffdd3e8d1ed7f98",
    pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94"): "4b6204c8058a071351ea76d66d886a7d9d6bd526dae86f32b99745402f237a46",
    pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94-receipt"): "c031f2e8f09caca22fd22bc74348a64e8295900a39b1b4882cc1486d157cf187",
    pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94-cleanup"): "ab2d1abfce156136cf94f40676f13e9434ecbb15e2a9cf40c015eb9a74716c8b",
    pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94-install"): "737e05787e93d585371e89734256a6745dc3595093b64ff9b4a85ffb852950a3",
}
UPDATES = {
    pathlib.Path("/opt/holy-sheet-qualification/holy127-4c1fdbda6becaf76/holy127_disposable_staging_qualifier.py"): ("scripts/holy127_disposable_staging_qualifier.py", "3a8b0e8f9e2d382b0ba00dc5a0fb5b5c2be3d366913a4ac14f4d05b46b4070fd", 0o444),
    pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94"): ("scripts/holy127_qualifier_entrypoint.sh", "ab5efb6d8ba83f1dba6ec93495e593659f9eeba0b9e104d23cf1ba34e69165f2", 0o555),
    pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94-receipt"): ("scripts/holy127_qualifier_receipt_collect.sh", "7f7e66316a1fa8adcf3b47f6a86dedc2e4c637fda470cf4deca930b7221326fd", 0o555),
    pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94-cleanup"): ("scripts/holy127_qualifier_receipt_cleanup.sh", "e2ead68983d9c0119515129125652eb8026557f16cdbef931adfb0ae8f1471e5", 0o555),
    pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94-install"): ("scripts/holy127_qualifier_installer.py", "84bb2fbf11e64e05fd963c537b7404f0a935a247bd2f1529822283ae276a1cb4", 0o555),
}
CAUGHT = {signal.SIGHUP, signal.SIGINT, signal.SIGTERM}
OWNER_UID = 0
OWNER_GID = 0

class UpdateFailure(RuntimeError):
    pass

@contextlib.contextmanager
def blocked() -> Iterator[None]:
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, CAUGHT)
    try: yield
    finally: signal.pthread_sigmask(signal.SIG_SETMASK, previous)

def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def verify_regular(path: pathlib.Path, expected: str, mode: int | None = None) -> None:
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != OWNER_UID or metadata.st_gid != OWNER_GID or (mode is not None and stat.S_IMODE(metadata.st_mode) != mode) or digest(path) != expected:
        raise UpdateFailure(f"installed identity mismatch: {path}")

def read_packet() -> dict[str, bytes]:
    metadata = ARCHIVE.lstat()
    if ARCHIVE.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != OWNER_UID or metadata.st_gid != OWNER_GID or stat.S_IMODE(metadata.st_mode) != 0o400 or metadata.st_size != ARCHIVE_SIZE or digest(ARCHIVE) != ARCHIVE_SHA256:
        raise UpdateFailure("update archive identity mismatch")
    wanted = {relative: expected for relative, expected, _mode in UPDATES.values()}
    found: dict[str, bytes] = {}
    with tarfile.open(ARCHIVE, "r:") as packet:
        for member in packet.getmembers():
            if member.name not in wanted:
                continue
            if not member.isfile() or member.name in found:
                raise UpdateFailure("invalid update archive member")
            stream = packet.extractfile(member)
            if stream is None: raise UpdateFailure("unreadable update archive member")
            content = stream.read()
            if hashlib.sha256(content).hexdigest() != wanted[member.name]:
                raise UpdateFailure("update member hash mismatch")
            found[member.name] = content
    if set(found) != set(wanted): raise UpdateFailure("update member set mismatch")
    return found

def stage(path: pathlib.Path, content: bytes, mode: int) -> pathlib.Path:
    pending = path.with_name(path.name + ".holy127-update-5bc68a1.pending")
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, mode)
    try:
        view = memoryview(content)
        while view:
            count = os.write(descriptor, view)
            if count <= 0: raise OSError("short update write")
            view = view[count:]
        os.fsync(descriptor); os.fchown(descriptor, OWNER_UID, OWNER_GID); os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)
    return pending

def restore(target: pathlib.Path, content: bytes, mode: int) -> None:
    pending = target.with_name(target.name + ".holy127-rollback-5bc68a1.pending")
    created = stage(pending.with_name(target.name), content, mode)
    os.replace(created, target)

def run() -> dict[str, object]:
    if RECEIPT_DIRECTORY.exists():
        raise UpdateFailure("preserved failed receipt must be collected and cleaned before update")
    lock_metadata = LOCK.lstat()
    if LOCK.is_symlink() or not stat.S_ISREG(lock_metadata.st_mode) or lock_metadata.st_uid != OWNER_UID or stat.S_IMODE(lock_metadata.st_mode) != 0o660:
        raise UpdateFailure("shared lock identity mismatch")
    packet = read_packet()
    before: dict[pathlib.Path, bytes] = {}
    modes: dict[pathlib.Path, int] = {}
    for path, expected in OLD.items():
        verify_regular(path, expected)
        before[path] = path.read_bytes(); modes[path] = stat.S_IMODE(path.stat().st_mode)
    descriptor = os.open(LOCK, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
    replaced: list[pathlib.Path] = []
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        staged = {target: stage(target, packet[relative], mode) for target, (relative, _expected, mode) in UPDATES.items()}
        try:
            with blocked():
                for target, pending in staged.items():
                    os.replace(pending, target); replaced.append(target)
                for parent in {target.parent for target in replaced}:
                    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY); os.fsync(directory); os.close(directory)
        except BaseException:
            with blocked():
                for target in reversed(replaced): restore(target, before[target], modes[target])
            raise
    finally:
        os.close(descriptor)
    for target, (_relative, expected, mode) in UPDATES.items(): verify_regular(target, expected, mode)
    return {"source": SOURCE_COMMIT, "status": "updated", "updated": {str(path): expected for path, (_relative, expected, _mode) in UPDATES.items()}}

def main() -> int:
    if len(sys.argv) != 1: print("HOLY-127 updater accepts no arguments", file=sys.stderr); return 64
    if os.getuid() != 0: print("HOLY-127 updater requires bounded root console", file=sys.stderr); return 77
    def interrupted(signum: int, _frame: object) -> None: raise UpdateFailure(f"interrupted by signal {signum}")
    for signum in CAUGHT: signal.signal(signum, interrupted)
    try: result = run()
    except BaseException as error: print(f"HOLY-127 updater refused: {error}", file=sys.stderr); return 1
    print(json.dumps(result, sort_keys=True)); return 0

if __name__ == "__main__": raise SystemExit(main())
