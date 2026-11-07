#!/usr/bin/python3
"""Install and invoke the exact HOLY-127 qualifier installer from one packet."""
from __future__ import annotations

import dataclasses
import hashlib
import os
import pathlib
import signal
import stat
import subprocess
import sys
import tarfile
import time
from collections.abc import Iterator
from contextlib import contextmanager

PACKET_SOURCE_COMMIT = "86bfdfe313f55630a1589f58788d16fa1142e951"
ARCHIVE_SHA256 = "97399256fc32b2a7009f3615391cb61ad910ef7c2324faa531ffbbe9be99b3d7"
ARCHIVE_SIZE = 143360
INSTALLER_RELATIVE = "scripts/holy127_qualifier_installer.py"
INSTALLER_SHA256 = "737e05787e93d585371e89734256a6745dc3595093b64ff9b4a85ffb852950a3"
PAYLOAD_HASHES = {
    "scripts/holy127_disposable_staging_qualifier.py": "4db35d5e5018d39150574b88630437363f68e66c52229f66ef8c4cf5e514b604",
    "scripts/holy127_backup_orchestrator.py": "f1f4655f0129167ae9a2c85e5165780674ad5272aacb59e457eaa8e81ee1d79c",
    "scripts/hs_release_guard.py": "11f13274f4f2e9255bc6382cfebef607ff201c2aa27e6a758ffdd3e8d1ed7f98",
    "scripts/holy127_bounded_stream.py": "8c874d97c9f6e86be0581ed82c4fff5ab1e539bf57b562c598c5c846040077e2",
    "scripts/test_holy127_disposable_staging_qualifier.py": "a93f11d5d7455bc812a292ee41f135f0dbe6e42fb704d16b79714fe27492ac01",
    "scripts/test_holy127_qualifier_entrypoints.py": "976db013443a248f1657b7a5f315ebc2d96d388ab15842318a14166313473751",
    "scripts/test_holy127_backup_orchestrator.py": "8e56992b0d2f71292b3295f592f7a03766e374b9f659239abf8c8c9b73906724",
    "scripts/test_holy127_bounded_stream.py": "d05e29ea56a3b7fec91a1e9b0d0a97e954fb4c1770088231d3c8d4dc3d15af44",
    "scripts/test_hs_release_guard.py": "6a7d3a6544a1e1548b79abdaf55e260c0e2071e1b2409cbf88a382045ea80b40",
    "deployment/HOLY-127-DISPOSABLE-STAGING-QUALIFICATION.md": "d7c373322217ca0ede0eb57567028031d5630d5ae385d48344294a97cf04cc13",
    "deployment/HOLY-127-RELEASE-PACKET.md": "7aa0cd5fe1d9e5cdeacefc8ae617c01170f832c1e03b2a88936b4d07fe618633",
    "scripts/holy127_qualifier_entrypoint.sh": "4b6204c8058a071351ea76d66d886a7d9d6bd526dae86f32b99745402f237a46",
    "scripts/holy127_qualifier_receipt_collect.sh": "c031f2e8f09caca22fd22bc74348a64e8295900a39b1b4882cc1486d157cf187",
    "scripts/holy127_qualifier_receipt_cleanup.sh": "ab2d1abfce156136cf94f40676f13e9434ecbb15e2a9cf40c015eb9a74716c8b",
}
CAUGHT_SIGNALS = {signal.SIGHUP, signal.SIGINT, signal.SIGTERM}

class BootstrapFailure(RuntimeError):
    pass

class BootstrapInterrupted(BootstrapFailure):
    def __init__(self, signum: int):
        super().__init__(f"bootstrap interrupted by signal {signum}")
        self.signum = signum

@dataclasses.dataclass(frozen=True)
class Config:
    incoming_parent: pathlib.Path = pathlib.Path("/root/holy127-transfer-inbox-runpath-v2")
    archive: pathlib.Path = pathlib.Path("/root/holy127-transfer-inbox-runpath-v2/holy127-payload-86bfdfe.tar")
    source_parent: pathlib.Path = pathlib.Path("/var/tmp/holy127-installer-rootpath-v2")
    source_root: pathlib.Path = pathlib.Path("/var/tmp/holy127-installer-rootpath-v2/source")
    installer: pathlib.Path = pathlib.Path("/usr/local/sbin/holy127-q-f4f5a94-install")
    expected_uid: int = 0
    expected_gid: int = 0
    invoke_timeout: float = 60
    stop_timeout: float = 15

@dataclasses.dataclass(frozen=True)
class Owned:
    path: pathlib.Path
    device: int
    inode: int
    is_dir: bool

def owned(path: pathlib.Path) -> Owned:
    metadata = path.lstat()
    return Owned(path, metadata.st_dev, metadata.st_ino, stat.S_ISDIR(metadata.st_mode))

def matches(item: Owned) -> bool:
    try:
        metadata = item.path.lstat()
    except FileNotFoundError:
        return False
    return metadata.st_dev == item.device and metadata.st_ino == item.inode and stat.S_ISDIR(metadata.st_mode) == item.is_dir

@contextmanager
def blocked_signals() -> Iterator[None]:
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, CAUGHT_SIGNALS)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)

def write_all(descriptor: int, content: bytes) -> None:
    remaining = memoryview(content)
    while remaining:
        count = os.write(descriptor, remaining)
        if count == 0:
            raise OSError("short packet write")
        remaining = remaining[count:]

def verify_directory(path: pathlib.Path, uid: int, gid: int, mode: int | None = None) -> None:
    metadata = path.lstat()
    actual = stat.S_IMODE(metadata.st_mode)
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink() or metadata.st_uid != uid or metadata.st_gid != gid or actual & 0o022 or (mode is not None and actual != mode):
        raise BootstrapFailure(f"unsafe directory: {path}")

class Bootstrap:
    def __init__(self, config: Config):
        self.config = config
        self.created: list[Owned] = []
        self.installer_succeeded = False

    def verify_transfer(self) -> None:
        c = self.config
        if c.expected_uid == 0:
            for path in (pathlib.Path("/"), pathlib.Path("/root"), pathlib.Path("/usr"), pathlib.Path("/usr/local"), pathlib.Path("/var")):
                verify_directory(path, 0, 0)
            temporary = pathlib.Path("/var/tmp").lstat()
            if temporary.st_uid != 0 or temporary.st_gid != 0 or stat.S_IMODE(temporary.st_mode) != 0o1777 or not stat.S_ISDIR(temporary.st_mode):
                raise BootstrapFailure("unsafe directory: /var/tmp")
        verify_directory(c.incoming_parent, c.expected_uid, c.expected_gid, 0o700)
        metadata = c.archive.lstat()
        if not stat.S_ISREG(metadata.st_mode) or c.archive.is_symlink() or metadata.st_uid != c.expected_uid or metadata.st_gid != c.expected_gid or stat.S_IMODE(metadata.st_mode) != 0o400 or metadata.st_size != ARCHIVE_SIZE:
            raise BootstrapFailure("unsafe incoming archive")
        if hashlib.sha256(c.archive.read_bytes()).hexdigest() != ARCHIVE_SHA256:
            raise BootstrapFailure("incoming archive hash mismatch")
        verify_directory(c.installer.parent, c.expected_uid, c.expected_gid)

    def read_packet(self) -> dict[str, bytes]:
        expected = {**PAYLOAD_HASHES, INSTALLER_RELATIVE: INSTALLER_SHA256}
        files: dict[str, bytes] = {}
        with tarfile.open(self.config.archive, "r:") as archive:
            for member in archive.getmembers():
                path = pathlib.PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts:
                    raise BootstrapFailure("unsafe archive member")
                if member.isdir():
                    if member.name.rstrip("/") not in {"deployment", "scripts"}:
                        raise BootstrapFailure(f"unexpected archive directory: {member.name}")
                    continue
                if not member.isfile() or member.name not in expected or member.name in files:
                    raise BootstrapFailure(f"unexpected archive member: {member.name}")
                stream = archive.extractfile(member)
                if stream is None:
                    raise BootstrapFailure(f"unreadable archive member: {member.name}")
                content = stream.read()
                if hashlib.sha256(content).hexdigest() != expected[member.name]:
                    raise BootstrapFailure(f"payload hash mismatch: {member.name}")
                files[member.name] = content
        if set(files) != set(expected):
            raise BootstrapFailure("archive payload set mismatch")
        return files

    def create_directory(self, path: pathlib.Path, mode: int) -> Owned:
        path.mkdir(mode=mode)
        item = owned(path); self.created.append(item)
        os.chown(path, self.config.expected_uid, self.config.expected_gid); os.chmod(path, mode)
        return item

    def create_file(self, path: pathlib.Path, content: bytes, mode: int) -> Owned:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, mode)
        metadata = os.fstat(descriptor); item = Owned(path, metadata.st_dev, metadata.st_ino, False); self.created.append(item)
        try:
            write_all(descriptor, content); os.fsync(descriptor)
            os.fchown(descriptor, self.config.expected_uid, self.config.expected_gid); os.fchmod(descriptor, mode)
        finally:
            os.close(descriptor)
        return item

    def rollback(self) -> None:
        failures = []
        with blocked_signals():
            for item in self.created:
                if item.is_dir and matches(item):
                    try: item.path.chmod(0o700)
                    except BaseException as error: failures.append(f"{item.path}: {error}")
            for item in reversed(self.created):
                try:
                    if not matches(item):
                        continue
                    if item.is_dir:
                        item.path.rmdir()
                    else:
                        item.path.unlink()
                except BaseException as error:
                    failures.append(f"{item.path}: {error}")
        if failures:
            raise BootstrapFailure("bootstrap rollback failures: " + "; ".join(failures))

    def invoke_installer(self) -> None:
        process = subprocess.Popen(
            ["/usr/bin/python3", "-I", self.config.installer],
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
            start_new_session=True,
        )
        try:
            return_code = process.wait(timeout=self.config.invoke_timeout)
        except BaseException:
            with blocked_signals():
                group_was_alive = self.stop_process_group(process)
                if process.poll() == 0 and not group_was_alive: self.installer_succeeded = True
            raise
        group_was_alive = self.stop_process_group(process)
        if return_code != 0:
            raise BootstrapFailure(f"installer exited {return_code}")
        if group_was_alive:
            raise BootstrapFailure("installer leader exited with a surviving process group")
        with blocked_signals():
            self.installer_succeeded = True

    def stop_process_group(self, process: subprocess.Popen) -> bool:
        with blocked_signals():
            leader_was_running = process.poll() is None
            if leader_was_running:
                group_was_alive = True
            else:
                try:
                    os.killpg(process.pid, 0)
                    group_was_alive = True
                except (ProcessLookupError, PermissionError):
                    group_was_alive = False
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            if leader_was_running:
                try: process.wait(timeout=self.config.stop_timeout)
                except subprocess.TimeoutExpired: pass
            deadline = time.monotonic() + self.config.stop_timeout
            group_remains = False
            while time.monotonic() < deadline:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                except PermissionError:
                    break
                group_remains = True
                time.sleep(0.02)
            if group_remains:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            if process.poll() is None:
                try: process.wait(timeout=self.config.stop_timeout)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
            return group_was_alive

    def run(self) -> None:
        self.verify_transfer()
        packet = self.read_packet()
        c = self.config
        with blocked_signals():
            self.create_directory(c.source_parent, 0o700)
            self.create_directory(c.source_root, 0o700)
            self.create_directory(c.source_root / "scripts", 0o700)
            self.create_directory(c.source_root / "deployment", 0o700)
            for relative, digest in PAYLOAD_HASHES.items():
                content = packet[relative]
                if hashlib.sha256(content).hexdigest() != digest:
                    raise BootstrapFailure(f"payload changed after validation: {relative}")
                self.create_file(c.source_root / relative, content, 0o400)
            os.chmod(c.source_root / "scripts", 0o500)
            os.chmod(c.source_root / "deployment", 0o500)
            os.chmod(c.source_root, 0o500)
            self.create_file(c.installer, packet[INSTALLER_RELATIVE], 0o555)
        self.invoke_installer()

def main() -> int:
    if len(sys.argv) != 1:
        print("HOLY-127 bootstrap accepts no arguments", file=sys.stderr); return 64
    if os.getuid() != 0:
        print("HOLY-127 bootstrap requires the bounded root console", file=sys.stderr); return 77
    def interrupted(signum: int, _frame: object) -> None:
        raise BootstrapInterrupted(signum)
    for signum in CAUGHT_SIGNALS:
        signal.signal(signum, interrupted)
    subject = Bootstrap(Config())
    try:
        subject.run()
    except BaseException as error:
        if not subject.installer_succeeded:
            try: subject.rollback()
            except BaseException as rollback_error: print(f"HOLY-127 bootstrap rollback also failed: {rollback_error}", file=sys.stderr)
        else:
            print("HOLY-127 installer completed; committed installer outputs and bootstrap inputs are preserved", file=sys.stderr)
        print(f"HOLY-127 bootstrap refused: {error}", file=sys.stderr); return 1
    print(f"HOLY-127 installer invoked from packet source {PACKET_SOURCE_COMMIT}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
