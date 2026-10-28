#!/usr/bin/python3
"""Install the frozen HOLY-127 qualifier through a fixed root surface."""
from __future__ import annotations

import contextlib
import ctypes
import dataclasses
import fcntl
import hashlib
import os
import pathlib
import shutil
import signal
import stat
import subprocess
import sys
from collections.abc import Callable, Iterator

RENAME_NOREPLACE = 1
AT_FDCWD = -100
CAUGHT_SIGNALS = {signal.SIGHUP, signal.SIGINT, signal.SIGTERM}
PAYLOAD_HASHES = {
    "scripts/holy127_disposable_staging_qualifier.py": "4c1fdbda6becaf76b7ca33698737074b50af5d0884d845f1a1c52ff3c0fa8b86",
    "scripts/holy127_backup_orchestrator.py": "f1f4655f0129167ae9a2c85e5165780674ad5272aacb59e457eaa8e81ee1d79c",
    "scripts/hs_release_guard.py": "2732a41da67239772b5232c4a616638f22d5de947763e142f1a95a32644c8495",
    "scripts/holy127_bounded_stream.py": "8c874d97c9f6e86be0581ed82c4fff5ab1e539bf57b562c598c5c846040077e2",
    "scripts/test_holy127_disposable_staging_qualifier.py": "a93f11d5d7455bc812a292ee41f135f0dbe6e42fb704d16b79714fe27492ac01",
    "scripts/test_holy127_qualifier_entrypoints.py": "c723c84148b958238ff8c629fd57eb7f217a6deee8a6f29633bbc0a8adf3d925",
    "scripts/test_holy127_backup_orchestrator.py": "8e56992b0d2f71292b3295f592f7a03766e374b9f659239abf8c8c9b73906724",
    "scripts/test_holy127_bounded_stream.py": "d05e29ea56a3b7fec91a1e9b0d0a97e954fb4c1770088231d3c8d4dc3d15af44",
    "scripts/test_hs_release_guard.py": "6a7d3a6544a1e1548b79abdaf55e260c0e2071e1b2409cbf88a382045ea80b40",
    "deployment/HOLY-127-DISPOSABLE-STAGING-QUALIFICATION.md": "2286b1e4d04e69553bdeaefc84b3563ce591b970aa33b0bce545ccd1c726dc5f",
    "deployment/HOLY-127-RELEASE-PACKET.md": "62f7e290a0ddab55772988e83ff8f437e53f99bd7b956a6697b4bfd62b46920f",
    "scripts/holy127_qualifier_entrypoint.sh": "b8a7c8162e8167b7cd35abde7189c7308a0fba15fe9af79ff9add056b1ed1fa7",
    "scripts/holy127_qualifier_receipt_collect.sh": "64b4f1311029bb64b265824c40a541c806ae3955bfe0b1558eff4e7dd6a8b695",
    "scripts/holy127_qualifier_receipt_cleanup.sh": "349297d0f11330568dffaf8c3486ff4e21af962237ba982324020ac76646910a",
}
BUNDLE_FILES = {
    "holy127_disposable_staging_qualifier.py": "scripts/holy127_disposable_staging_qualifier.py",
    "holy127_backup_orchestrator.py": "scripts/holy127_backup_orchestrator.py",
    "hs_release_guard.py": "scripts/hs_release_guard.py",
}
ENTRYPOINT_FILES = {
    "holy127-q-f4f5a94": "scripts/holy127_qualifier_entrypoint.sh",
    "holy127-q-f4f5a94-receipt": "scripts/holy127_qualifier_receipt_collect.sh",
    "holy127-q-f4f5a94-cleanup": "scripts/holy127_qualifier_receipt_cleanup.sh",
}
SUDOERS_TEXT = """deploy ALL=(root) NOPASSWD: /usr/local/sbin/holy127-q-f4f5a94 \"\"
deploy ALL=(root) NOPASSWD: /usr/local/sbin/holy127-q-f4f5a94-receipt \"\"
deploy ALL=(root) NOPASSWD: /usr/local/sbin/holy127-q-f4f5a94-cleanup \"\"
"""

class InstallFailure(RuntimeError):
    pass

class InstallInterrupted(InstallFailure):
    def __init__(self, signum: int):
        super().__init__(f"installation interrupted by signal {signum}")
        self.signum = signum

@dataclasses.dataclass(frozen=True)
class Config:
    source_root: pathlib.Path = pathlib.Path("/var/tmp/holy127-installer-rootpath-v2/source")
    bundle_parent: pathlib.Path = pathlib.Path("/opt/holy-sheet-qualification")
    bundle: pathlib.Path = pathlib.Path("/opt/holy-sheet-qualification/holy127-4c1fdbda6becaf76")
    sbin: pathlib.Path = pathlib.Path("/usr/local/sbin")
    sudoers_dir: pathlib.Path = pathlib.Path("/etc/sudoers.d")
    sudoers: pathlib.Path = pathlib.Path("/etc/sudoers.d/holy127-q-f4f5a94")
    lock_parent: pathlib.Path = pathlib.Path("/run/lock/holy-sheet-release")
    lock_file: pathlib.Path = pathlib.Path("/run/lock/holy-sheet-release/release.lock")
    visudo: pathlib.Path = pathlib.Path("/usr/sbin/visudo")
    expected_uid: int = 0
    expected_gid: int = 0

@dataclasses.dataclass(frozen=True)
class OwnedPath:
    path: pathlib.Path
    device: int
    inode: int
    is_dir: bool
    children: tuple[tuple[str, int, int], ...] = ()

def identity(path: pathlib.Path, *, children: bool = False) -> OwnedPath:
    metadata = path.lstat()
    child_ids = tuple(sorted((child.name, child.lstat().st_dev, child.lstat().st_ino) for child in path.iterdir())) if children else ()
    return OwnedPath(path, metadata.st_dev, metadata.st_ino, stat.S_ISDIR(metadata.st_mode), child_ids)

def same_identity(owned: OwnedPath) -> bool:
    try:
        current = identity(owned.path, children=owned.is_dir)
    except FileNotFoundError:
        return False
    return current.device == owned.device and current.inode == owned.inode and current.is_dir == owned.is_dir and (not owned.is_dir or current.children == owned.children)

@contextlib.contextmanager
def blocked_signals() -> Iterator[None]:
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, CAUGHT_SIGNALS)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)

def rename_noreplace(source: pathlib.Path, target: pathlib.Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    function = libc.renameat2
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(AT_FDCWD, os.fsencode(source), AT_FDCWD, os.fsencode(target), RENAME_NOREPLACE) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))

def write_all(descriptor: int, content: bytes) -> None:
    remaining = memoryview(content)
    while remaining:
        written = os.write(descriptor, remaining)
        if written == 0:
            raise OSError("short write while staging installer payload")
        remaining = remaining[written:]

def verify_directory(path: pathlib.Path, uid: int, gid: int, *, exact_mode: int | None = None) -> None:
    metadata = path.lstat()
    mode = stat.S_IMODE(metadata.st_mode)
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink() or metadata.st_uid != uid or metadata.st_gid != gid or mode & 0o022 or (exact_mode is not None and mode != exact_mode):
        raise InstallFailure(f"unsafe directory: {path}")

def verify_source(path: pathlib.Path, digest: str, uid: int, gid: int) -> None:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink() or metadata.st_uid != uid or metadata.st_gid != gid or stat.S_IMODE(metadata.st_mode) & 0o022:
        raise InstallFailure(f"unsafe source: {path}")
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise InstallFailure(f"source hash mismatch: {path}")

class Installer:
    def __init__(self, config: Config, hook: Callable[[str], None] | None = None, renamer: Callable[[pathlib.Path, pathlib.Path], None] = rename_noreplace):
        self.config = config
        self.hook = hook or (lambda _phase: None)
        self.renamer = renamer
        self.staged: list[OwnedPath] = []
        self.committed: list[OwnedPath] = []
        self.created_bundle_parent: OwnedPath | None = None
        self.lock_descriptor: int | None = None

    def phase(self, name: str) -> None:
        self.hook(name)

    def verify_inputs(self) -> None:
        c = self.config
        verify_directory(c.source_root.parent, c.expected_uid, c.expected_gid, exact_mode=0o700)
        verify_directory(c.source_root, c.expected_uid, c.expected_gid, exact_mode=0o500)
        verify_directory(c.source_root / "scripts", c.expected_uid, c.expected_gid)
        verify_directory(c.source_root / "deployment", c.expected_uid, c.expected_gid)
        for relative, digest in PAYLOAD_HASHES.items():
            verify_source(c.source_root / relative, digest, c.expected_uid, c.expected_gid)
        for ancestor in (c.bundle_parent.parent, c.sbin, c.sudoers_dir, c.lock_parent.parent):
            verify_directory(ancestor, c.expected_uid, c.expected_gid)

    def provision_persistent_lock(self) -> None:
        c = self.config
        # Persistent shared infrastructure is deliberately retained on every
        # later failure; unlinking it could split flock authority by inode.
        with blocked_signals():
            if not c.lock_parent.exists():
                c.lock_parent.mkdir(mode=0o755)
                os.chown(c.lock_parent, c.expected_uid, c.expected_gid)
                os.chmod(c.lock_parent, 0o755)
            verify_directory(c.lock_parent, c.expected_uid, c.expected_gid, exact_mode=0o755)
            created = False
            try:
                descriptor = os.open(c.lock_file, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o660)
                created = True
            except FileExistsError:
                descriptor = os.open(c.lock_file, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
            if created:
                os.fchown(descriptor, c.expected_uid, c.expected_gid)
                os.fchmod(descriptor, 0o660)
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != c.expected_uid or metadata.st_gid != c.expected_gid or stat.S_IMODE(metadata.st_mode) != 0o660:
                os.close(descriptor)
                raise InstallFailure("release lock has incompatible identity")
            self.lock_descriptor = descriptor
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.phase("persistent-lock-ready")

    def ensure_bundle_parent(self) -> None:
        c = self.config
        with blocked_signals():
            if not c.bundle_parent.exists():
                c.bundle_parent.mkdir(mode=0o755)
                os.chown(c.bundle_parent, c.expected_uid, c.expected_gid)
                os.chmod(c.bundle_parent, 0o755)
                self.created_bundle_parent = identity(c.bundle_parent, children=True)
            verify_directory(c.bundle_parent, c.expected_uid, c.expected_gid, exact_mode=0o755)
        self.phase("bundle-parent-ready")

    def create_stage_file(self, path: pathlib.Path, content: bytes, mode: int) -> OwnedPath:
        with blocked_signals():
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, mode)
            try:
                write_all(descriptor, content); os.fsync(descriptor); os.fchown(descriptor, self.config.expected_uid, self.config.expected_gid); os.fchmod(descriptor, mode)
                metadata = os.fstat(descriptor)
            finally:
                os.close(descriptor)
            owned = OwnedPath(path, metadata.st_dev, metadata.st_ino, False)
            self.staged.append(owned)
        self.phase(f"stage:{path.parent.name}/{path.name}")
        return owned

    def create_bundle_stage(self, path: pathlib.Path) -> OwnedPath:
        with blocked_signals():
            path.mkdir(mode=0o700); os.chown(path, self.config.expected_uid, self.config.expected_gid); os.chmod(path, 0o700)
            for installed_name, relative in BUNDLE_FILES.items():
                target = path / installed_name
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o444)
                try:
                    write_all(descriptor, (self.config.source_root / relative).read_bytes()); os.fsync(descriptor); os.fchown(descriptor, self.config.expected_uid, self.config.expected_gid); os.fchmod(descriptor, 0o444)
                finally:
                    os.close(descriptor)
            os.chmod(path, 0o555)
            owned = identity(path, children=True); self.staged.append(owned)
        self.phase(f"stage:{path.parent.name}/{path.name}")
        return owned

    def commit(self, owned: OwnedPath, target: pathlib.Path) -> None:
        planned = dataclasses.replace(owned, path=target)
        with blocked_signals():
            self.renamer(owned.path, target)
            self.staged.remove(owned); self.committed.append(planned)
        self.phase(f"commit:{target.parent.name}/{target.name}")

    def validate_sudoers(self, path: pathlib.Path) -> None:
        subprocess.run([self.config.visudo, "-cf", path], check=True, stdout=subprocess.DEVNULL)

    def rollback(self) -> None:
        for owned in reversed([*self.committed, *self.staged]):
            if same_identity(owned):
                if owned.is_dir:
                    owned.path.chmod(0o700)
                    shutil.rmtree(owned.path)
                else:
                    owned.path.unlink()
        if self.created_bundle_parent and same_identity(self.created_bundle_parent):
            self.created_bundle_parent.path.rmdir()

    def run(self) -> None:
        c = self.config
        self.verify_inputs(); self.provision_persistent_lock(); self.ensure_bundle_parent()
        suffix = ".holy127-install-rootpath-v2.pending"
        bundle_stage = self.create_bundle_stage(c.bundle.with_name(c.bundle.name + suffix))
        entry_stages = []
        for installed_name, relative in ENTRYPOINT_FILES.items():
            target = c.sbin / installed_name
            entry_stages.append((self.create_stage_file(target.with_name(target.name + suffix), (c.source_root / relative).read_bytes(), 0o555), target))
        sudoers_stage = self.create_stage_file(c.sudoers.with_name(c.sudoers.name + suffix), SUDOERS_TEXT.encode(), 0o440)
        self.validate_sudoers(sudoers_stage.path); self.phase("sudoers-stage-valid")
        self.commit(bundle_stage, c.bundle)
        for staged, target in entry_stages: self.commit(staged, target)
        self.commit(sudoers_stage, c.sudoers)
        self.validate_sudoers(pathlib.Path("/etc/sudoers") if c.expected_uid == 0 else c.sudoers)
        self.phase("installation-validated")

    def close(self) -> None:
        if self.lock_descriptor is not None: os.close(self.lock_descriptor); self.lock_descriptor = None

def install_signal_handlers() -> None:
    def interrupted(signum: int, _frame: object) -> None: raise InstallInterrupted(signum)
    for signum in CAUGHT_SIGNALS: signal.signal(signum, interrupted)

def main() -> int:
    if len(sys.argv) != 1: print("HOLY-127 installer accepts no arguments", file=sys.stderr); return 64
    if os.getuid() != 0: print("HOLY-127 installer requires the fixed root operator surface", file=sys.stderr); return 77
    subject = Installer(Config()); install_signal_handlers()
    try: subject.run()
    except InstallInterrupted as error: subject.rollback(); print(str(error), file=sys.stderr); return 128 + error.signum
    except BaseException as error: subject.rollback(); print(f"HOLY-127 installer refused: {error}", file=sys.stderr); return 1
    finally: subject.close()
    print("HOLY-127 fixed qualifier surfaces installed; qualification not executed"); return 0

if __name__ == "__main__": raise SystemExit(main())
