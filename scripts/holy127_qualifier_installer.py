#!/usr/bin/python3
"""Install the frozen HOLY-127 qualifier through a fixed root surface."""
from __future__ import annotations

import contextlib
import ctypes
import dataclasses
import errno
import fcntl
import hashlib
import os
import pathlib
import signal
import stat
import subprocess
import sys
from collections.abc import Callable, Iterator

RENAME_NOREPLACE = 1
AT_FDCWD = -100
CAUGHT_SIGNALS = {signal.SIGHUP, signal.SIGINT, signal.SIGTERM}
PAYLOAD_HASHES = {
    "scripts/holy127_disposable_staging_qualifier.py": "3a8b0e8f9e2d382b0ba00dc5a0fb5b5c2be3d366913a4ac14f4d05b46b4070fd",
    "scripts/holy127_backup_orchestrator.py": "f1f4655f0129167ae9a2c85e5165780674ad5272aacb59e457eaa8e81ee1d79c",
    "scripts/hs_release_guard.py": "11f13274f4f2e9255bc6382cfebef607ff201c2aa27e6a758ffdd3e8d1ed7f98",
    "scripts/holy127_bounded_stream.py": "8c874d97c9f6e86be0581ed82c4fff5ab1e539bf57b562c598c5c846040077e2",
    "scripts/test_holy127_disposable_staging_qualifier.py": "004893b54f7cacdd708f3b67ca0a98fb9f5bc025f2a3b3715004c1cda7e8facc",
    "scripts/test_holy127_qualifier_entrypoints.py": "cfefb50406020ae23fbcb96dc8f01c69fb78d56c7573319dfe4dd94dbc2ec7e1",
    "scripts/test_holy127_backup_orchestrator.py": "8e56992b0d2f71292b3295f592f7a03766e374b9f659239abf8c8c9b73906724",
    "scripts/test_holy127_bounded_stream.py": "d05e29ea56a3b7fec91a1e9b0d0a97e954fb4c1770088231d3c8d4dc3d15af44",
    "scripts/test_hs_release_guard.py": "6a7d3a6544a1e1548b79abdaf55e260c0e2071e1b2409cbf88a382045ea80b40",
    "deployment/HOLY-127-DISPOSABLE-STAGING-QUALIFICATION.md": "71c5a1ea4f2571890d227ba071e5f3604b9e1d4d22c74cda38a5e8ae3aa3b7d2",
    "deployment/HOLY-127-RELEASE-PACKET.md": "6362e0a3847bc8b88b645124b29a73afada63d0a3d09ac4de243274a48b35c5f",
    "scripts/holy127_qualifier_entrypoint.sh": "ab5efb6d8ba83f1dba6ec93495e593659f9eeba0b9e104d23cf1ba34e69165f2",
    "scripts/holy127_qualifier_receipt_collect.sh": "7f7e66316a1fa8adcf3b47f6a86dedc2e4c637fda470cf4deca930b7221326fd",
    "scripts/holy127_qualifier_receipt_cleanup.sh": "e2ead68983d9c0119515129125652eb8026557f16cdbef931adfb0ae8f1471e5",
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
    lock_parent: pathlib.Path = pathlib.Path("/run/holy-sheet-release")
    lock_file: pathlib.Path = pathlib.Path("/run/holy-sheet-release/release.lock")
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

def same_path_inode(owned: OwnedPath) -> bool:
    try:
        metadata = owned.path.lstat()
    except FileNotFoundError:
        return False
    return metadata.st_dev == owned.device and metadata.st_ino == owned.inode and stat.S_ISDIR(metadata.st_mode) == owned.is_dir

def cleanup_owned_directory(owned: OwnedPath) -> None:
    if not same_path_inode(owned):
        return
    owned.path.chmod(0o700)
    for name, device, inode in reversed(owned.children):
        child = owned.path / name
        try:
            metadata = child.lstat()
        except FileNotFoundError:
            continue
        if metadata.st_dev == device and metadata.st_ino == inode and stat.S_ISREG(metadata.st_mode):
            child.unlink()
    try:
        owned.path.rmdir()
    except OSError as error:
        if error.errno != errno.ENOTEMPTY:
            raise

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

def write_all(descriptor: int, content: bytes, operation: Callable[[str], None]) -> None:
    remaining = memoryview(content)
    index = 0
    while remaining:
        written = os.write(descriptor, remaining)
        operation(f"write:{index}")
        if written == 0:
            raise OSError("short write while staging installer payload")
        remaining = remaining[written:]
        index += 1

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

    def operation(self, name: str) -> None:
        self.hook(f"io:{name}")

    def verify_inputs(self) -> None:
        c = self.config
        if c.expected_uid == 0:
            for ancestor in (pathlib.Path("/"), pathlib.Path("/usr"), pathlib.Path("/usr/local"), pathlib.Path("/etc"), pathlib.Path("/run"), pathlib.Path("/var"), pathlib.Path("/opt")):
                verify_directory(ancestor, 0, 0)
            temporary = pathlib.Path("/var/tmp").lstat()
            if not stat.S_ISDIR(temporary.st_mode) or temporary.st_uid != 0 or temporary.st_gid != 0 or stat.S_IMODE(temporary.st_mode) != 0o1777:
                raise InstallFailure("unsafe directory: /var/tmp")
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
            metadata = os.fstat(descriptor)
            owned = OwnedPath(path, metadata.st_dev, metadata.st_ino, False)
            self.staged.append(owned)
            try:
                write_all(descriptor, content, lambda step: self.operation(f"{path.name}:{step}"))
                os.fsync(descriptor); self.operation(f"{path.name}:fsync")
                os.fchown(descriptor, self.config.expected_uid, self.config.expected_gid); self.operation(f"{path.name}:fchown")
                os.fchmod(descriptor, mode); self.operation(f"{path.name}:fchmod")
                metadata = os.fstat(descriptor)
            except BaseException:
                os.close(descriptor)
                if same_identity(owned):
                    path.unlink()
                self.staged.remove(owned)
                raise
            finally:
                if descriptor >= 0:
                    try: os.close(descriptor)
                    except OSError: pass
        self.phase(f"stage:{path.parent.name}/{path.name}")
        return owned

    def create_bundle_stage(self, path: pathlib.Path) -> OwnedPath:
        with blocked_signals():
            path.mkdir(mode=0o700)
            owned = identity(path, children=True); self.staged.append(owned)
            try:
                os.chown(path, self.config.expected_uid, self.config.expected_gid); self.operation(f"{path.name}:chown")
                os.chmod(path, 0o700); self.operation(f"{path.name}:chmod-staging")
                for installed_name, relative in BUNDLE_FILES.items():
                    self.operation(f"{path.name}:iteration:{installed_name}:begin")
                    target = path / installed_name
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o444)
                    metadata = os.fstat(descriptor)
                    expected_children = tuple(sorted((*owned.children, (installed_name, metadata.st_dev, metadata.st_ino))))
                    owned = dataclasses.replace(owned, children=expected_children)
                    self.staged[-1] = owned
                    try:
                        write_all(descriptor, (self.config.source_root / relative).read_bytes(), lambda step: self.operation(f"{installed_name}:{step}"))
                        os.fsync(descriptor); self.operation(f"{installed_name}:fsync")
                        os.fchown(descriptor, self.config.expected_uid, self.config.expected_gid); self.operation(f"{installed_name}:fchown")
                        os.fchmod(descriptor, 0o444); self.operation(f"{installed_name}:fchmod")
                    finally:
                        os.close(descriptor)
                    self.operation(f"{path.name}:iteration:{installed_name}:end")
                os.chmod(path, 0o555); self.operation(f"{path.name}:chmod-final")
            except BaseException:
                cleanup_owned_directory(owned)
                self.staged.remove(owned)
                raise
        self.phase(f"stage:{path.parent.name}/{path.name}")
        return owned

    def commit(self, owned: OwnedPath, target: pathlib.Path) -> None:
        planned = dataclasses.replace(owned, path=target)
        with blocked_signals():
            self.renamer(owned.path, target)
            self.staged.remove(owned); self.committed.append(planned)
        self.phase(f"commit:{target.parent.name}/{target.name}")

    def validate_sudoers(self, path: pathlib.Path) -> None:
        subprocess.run([self.config.visudo, "-cf", path], check=True, stdout=subprocess.DEVNULL, timeout=10)

    def rollback(self) -> None:
        failures = []
        with blocked_signals():
            for owned in reversed([*self.committed, *self.staged]):
                try:
                    if owned.is_dir:
                        cleanup_owned_directory(owned)
                    elif same_identity(owned):
                        owned.path.unlink()
                except BaseException as error:
                    failures.append(f"{owned.path}: {error}")
            try:
                if self.created_bundle_parent and same_identity(self.created_bundle_parent):
                    self.created_bundle_parent.path.rmdir()
            except BaseException as error:
                failures.append(f"{self.created_bundle_parent.path}: {error}")
        if failures:
            raise InstallFailure("rollback failures: " + "; ".join(failures))

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
    except InstallInterrupted as error:
        try: subject.rollback()
        except BaseException as rollback_error: print(f"HOLY-127 rollback also failed: {rollback_error}", file=sys.stderr)
        print(str(error), file=sys.stderr); return 128 + error.signum
    except BaseException as error:
        try: subject.rollback()
        except BaseException as rollback_error: print(f"HOLY-127 rollback also failed: {rollback_error}", file=sys.stderr)
        print(f"HOLY-127 installer refused: {error}", file=sys.stderr); return 1
    finally: subject.close()
    print("HOLY-127 fixed qualifier surfaces installed; qualification not executed"); return 0

if __name__ == "__main__": raise SystemExit(main())
