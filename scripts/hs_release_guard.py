#!/usr/bin/env python3
"""Fail-closed capacity and serialization guard for Holy Sheet releases.

Release wrappers import :class:`ReleaseGuard`, acquire one shared host lock for
the complete operation, and call ``check_capacity`` immediately before every
material phase.  The CLI is intentionally read-only: it can measure capacity
and probe lock availability, but it cannot run arbitrary commands.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import fcntl
import json
import os
import pathlib
import re
import stat
import tempfile
from collections.abc import Callable, Iterable
from typing import Any, Protocol, TypeVar

DEFAULT_RESERVE_BYTES = 2_147_483_648
DEFAULT_MAX_AGE_SECONDS = 30
SAFE_VALUE = re.compile(r"^[A-Za-z0-9_.:@/+\-]{1,160}$")
T = TypeVar("T")


class GuardFailure(RuntimeError):
    """A sanitized, operator-actionable release gate failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclasses.dataclass(frozen=True)
class Measurement:
    path: str
    resolved_path: str
    filesystem: str
    device: int
    available_bytes: int
    observed_at: dt.datetime


class CapacityProbe(Protocol):
    def __call__(self, path: pathlib.Path, now: dt.datetime) -> Measurement: ...


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _safe(value: str, label: str) -> str:
    if not SAFE_VALUE.fullmatch(value):
        raise GuardFailure("invalid_input", f"{label} is missing or invalid")
    return value


def parse_positive_bytes(value: str | int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise GuardFailure("invalid_input", f"{label} must be a positive integer byte count")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise GuardFailure("invalid_input", f"{label} must be a positive integer byte count") from error
    if parsed <= 0 or parsed > 2**63 - 1:
        raise GuardFailure("invalid_input", f"{label} must be a positive integer byte count")
    return parsed


def validate_reserve_bytes(value: str | int) -> int:
    """Return a valid reserve without allowing callers to weaken the floor."""

    reserve = parse_positive_bytes(value, "reserve")
    if reserve < DEFAULT_RESERVE_BYTES:
        raise GuardFailure(
            "invalid_input",
            f"reserve must be at least {DEFAULT_RESERVE_BYTES} bytes",
        )
    return reserve


def resolve_existing_path(path: pathlib.Path) -> pathlib.Path:
    candidate = path.expanduser()
    if not candidate.is_absolute():
        raise GuardFailure("invalid_input", "release paths must be absolute")
    while not candidate.exists():
        parent = candidate.parent
        if parent == candidate:
            raise GuardFailure("measurement_failed", "no existing ancestor for release path")
        candidate = parent
    try:
        return candidate.resolve(strict=True)
    except OSError as error:
        raise GuardFailure("measurement_failed", "release path could not be resolved") from error


def _mountpoint_for(path: pathlib.Path) -> str:
    best = "/"
    try:
        for line in pathlib.Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
            fields = line.split()
            if len(fields) < 5:
                continue
            mount = fields[4].replace("\\040", " ")
            if path == pathlib.Path(mount) or pathlib.Path(mount) in path.parents:
                if len(mount) > len(best):
                    best = mount
    except OSError:
        pass
    return best


def filesystem_probe(path: pathlib.Path, now: dt.datetime) -> Measurement:
    resolved = resolve_existing_path(path)
    try:
        stats = os.stat(resolved)
        space = os.statvfs(resolved)
    except OSError as error:
        raise GuardFailure("measurement_failed", "filesystem capacity measurement failed") from error
    available = space.f_bavail * space.f_frsize
    if available < 0:
        raise GuardFailure("measurement_failed", "filesystem returned invalid available capacity")
    return Measurement(
        path=str(path),
        resolved_path=str(resolved),
        filesystem=_mountpoint_for(resolved),
        device=stats.st_dev,
        available_bytes=available,
        observed_at=now,
    )


def check_capacity(
    paths: Iterable[str | pathlib.Path],
    peak_budget_bytes: int,
    *,
    reserve_bytes: int = DEFAULT_RESERVE_BYTES,
    max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS,
    probe: CapacityProbe = filesystem_probe,
    now: dt.datetime | None = None,
) -> list[Measurement]:
    budget = parse_positive_bytes(peak_budget_bytes, "peak budget")
    reserve = validate_reserve_bytes(reserve_bytes)
    if max_age_seconds <= 0:
        raise GuardFailure("invalid_input", "measurement maximum age must be positive")
    checked_at = now or utc_now()
    requested = [pathlib.Path(path) for path in paths]
    if not requested:
        raise GuardFailure("invalid_input", "at least one affected path is required")
    measurements: list[Measurement] = []
    for path in requested:
        try:
            measured = probe(path, checked_at)
        except GuardFailure:
            raise
        except Exception as error:
            raise GuardFailure("measurement_failed", "filesystem capacity measurement failed") from error
        age = (checked_at - measured.observed_at).total_seconds()
        if age < -1 or age > max_age_seconds:
            raise GuardFailure("stale_measurement", "filesystem capacity measurement is stale")
        measurements.append(measured)
    for measured in measurements:
        required = budget + reserve
        if measured.available_bytes < required:
            raise GuardFailure(
                "insufficient_capacity",
                f"insufficient capacity on {measured.filesystem}: "
                f"available={measured.available_bytes} required={required} "
                f"(peak={budget} reserve={reserve})",
            )
    return measurements


def _process_start_ticks(pid: int) -> str | None:
    try:
        # Field 2 may contain spaces/parentheses, so split after the final ')'.
        fields = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()
        return fields[19]
    except (OSError, IndexError):
        return None


def _open_lock_file(path: pathlib.Path, *, create: bool, writable: bool, strict_install: bool):
    if strict_install:
        try:
            parent = path.parent.lstat()
        except OSError as error:
            raise GuardFailure("release_lock_invalid", "Holy Sheet release lock directory is unavailable") from error
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or stat.S_IMODE(parent.st_mode) & 0o022:
            raise GuardFailure("release_lock_invalid", "Holy Sheet release lock directory has unsafe ownership or mode")
    flags = os.O_CLOEXEC | os.O_NOFOLLOW | (os.O_RDWR if writable else os.O_RDONLY)
    if create:
        flags |= os.O_CREAT
    try:
        descriptor = os.open(path, flags, 0o660)
    except FileNotFoundError as error:
        raise GuardFailure("release_lock_missing", "preinstalled Holy Sheet release lock is missing") from error
    except OSError as error:
        raise GuardFailure("release_lock_invalid", "Holy Sheet release lock could not be opened safely") from error
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor)
        raise GuardFailure("release_lock_invalid", "Holy Sheet release lock is not a regular file")
    if strict_install and (metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o660):
        os.close(descriptor)
        raise GuardFailure("release_lock_invalid", "Holy Sheet release lock has unsafe ownership or mode")
    return os.fdopen(descriptor, "r+" if writable else "r", encoding="utf-8")


class ReleaseLock:
    """Kernel-backed, non-stealable shared HS release lock."""

    def __init__(self, path: str | pathlib.Path, environment: str, source: str, now: Callable[[], dt.datetime] = utc_now, *, create: bool = False, strict_install: bool = True):
        self.path = pathlib.Path(path)
        self.environment = _safe(environment, "environment")
        self.source = _safe(source, "source")
        self.now = now
        self.create = create
        self.strict_install = strict_install
        self._file: Any | None = None

    def __enter__(self) -> "ReleaseLock":
        if self._file is not None:
            raise GuardFailure("release_lock_invalid", "Holy Sheet release lock is already owned by this guard")
        if self.create:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        handle = _open_lock_file(self.path, create=self.create, writable=True, strict_install=self.strict_install)
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            handle.seek(0)
            metadata = _read_metadata(handle.read())
            handle.close()
            owner = metadata.get("environment", "unknown")
            raise GuardFailure("release_lock_busy", f"Holy Sheet release lock is held by {owner}") from error
        metadata = {
            "pid": os.getpid(),
            "processStartTicks": _process_start_ticks(os.getpid()),
            "environment": self.environment,
            "source": self.source,
            "acquiredAt": self.now().isoformat(),
        }
        handle.seek(0)
        handle.truncate()
        json.dump(metadata, handle, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        self._file = handle
        return self

    @property
    def is_owned(self) -> bool:
        return self._file is not None and not self._file.closed

    def __exit__(self, *_: object) -> None:
        if self._file is None:
            return
        try:
            self._file.seek(0)
            self._file.truncate()
            self._file.flush()
            os.fsync(self._file.fileno())
            fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        finally:
            self._file.close()
            self._file = None


def _read_metadata(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def probe_lock(path: str | pathlib.Path, *, strict_install: bool = True) -> dict[str, Any]:
    lock_path = pathlib.Path(path)
    if not lock_path.exists():
        return {"state": "available", "filePresent": False}
    try:
        handle = _open_lock_file(lock_path, create=False, writable=False, strict_install=strict_install)
    except GuardFailure:
        raise
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.seek(0)
            metadata = _read_metadata(handle.read())
            return {"state": "held", "environment": metadata.get("environment", "unknown")}
        return {"state": "available"}
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def build_receipt(
    *,
    environment: str,
    source: str,
    phase: str,
    peak_budget_bytes: int,
    reserve_bytes: int,
    measurements: Iterable[Measurement],
    lock_state: dict[str, Any],
    dry_run: bool,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "environment": _safe(environment, "environment"),
        "source": _safe(source, "source"),
        "phase": _safe(phase, "phase"),
        "timestamp": (now or utc_now()).isoformat(),
        "peakBudgetBytes": parse_positive_bytes(peak_budget_bytes, "peak budget"),
        "reserveBytes": validate_reserve_bytes(reserve_bytes),
        "filesystems": [
            {
                "path": item.path,
                "resolvedPath": item.resolved_path,
                "filesystem": item.filesystem,
                "availableBytes": item.available_bytes,
                "observedAt": item.observed_at.isoformat(),
            }
            for item in measurements
        ],
        "lock": lock_state,
        "gate": "passed",
        "dryRun": dry_run,
    }


def write_receipt(path: str | pathlib.Path, receipt: dict[str, Any]) -> None:
    destination = pathlib.Path(path)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(receipt, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


class ReleaseGuard:
    def __init__(
        self,
        *,
        environment: str,
        source: str,
        peak_budget_bytes: int,
        paths: Iterable[str | pathlib.Path],
        lock_path: str | pathlib.Path = "/run/holy-sheet-release/release.lock",
        create_lock: bool = False,
        strict_lock_install: bool = True,
        reserve_bytes: int = DEFAULT_RESERVE_BYTES,
        probe: CapacityProbe = filesystem_probe,
        now: Callable[[], dt.datetime] = utc_now,
    ):
        self.environment = _safe(environment, "environment")
        self.source = _safe(source, "source")
        self.peak_budget_bytes = parse_positive_bytes(peak_budget_bytes, "peak budget")
        self.reserve_bytes = validate_reserve_bytes(reserve_bytes)
        self.paths = list(paths)
        self.lock_path = pathlib.Path(lock_path)
        self.probe = probe
        self.now = now
        self.lock = ReleaseLock(self.lock_path, self.environment, self.source, now, create=create_lock, strict_install=strict_lock_install)

    def __enter__(self) -> "ReleaseGuard":
        if self.lock.is_owned:
            raise GuardFailure("release_lock_invalid", "Holy Sheet release guard is already active")
        self.lock.__enter__()
        try:
            self.check("preflight")
        except Exception:
            self.lock.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *details: object) -> None:
        self.lock.__exit__(*details)

    def check(self, phase: str) -> dict[str, Any]:
        if not self.lock.is_owned:
            raise GuardFailure("release_lock_required", "Holy Sheet release lock must be owned before a phase check")
        checked_at = self.now()
        measurements = check_capacity(
            self.paths,
            self.peak_budget_bytes,
            reserve_bytes=self.reserve_bytes,
            probe=self.probe,
            now=checked_at,
        )
        return build_receipt(
            environment=self.environment,
            source=self.source,
            phase=phase,
            peak_budget_bytes=self.peak_budget_bytes,
            reserve_bytes=self.reserve_bytes,
            measurements=measurements,
            lock_state={"state": "held", "environment": self.environment},
            dry_run=False,
            now=checked_at,
        )

    def run_phase(self, phase: str, operation: Callable[[], T]) -> T:
        self.check(phase)
        return operation()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only Holy Sheet release capacity preflight")
    parser.add_argument("--environment", required=True, choices=("staging", "production"))
    parser.add_argument("--source", required=True)
    parser.add_argument("--phase", default="preflight")
    parser.add_argument("--peak-budget-bytes", required=True)
    parser.add_argument("--reserve-bytes", default=str(DEFAULT_RESERVE_BYTES))
    parser.add_argument("--path", action="append", required=True)
    parser.add_argument("--lock-file", default="/run/holy-sheet-release/release.lock")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        checked_at = utc_now()
        budget = parse_positive_bytes(args.peak_budget_bytes, "peak budget")
        reserve = validate_reserve_bytes(args.reserve_bytes)
        lock_state = probe_lock(args.lock_file)
        if lock_state.get("filePresent") is False:
            raise GuardFailure("release_lock_missing", "preinstalled Holy Sheet release lock is missing")
        if lock_state.get("state") == "held":
            owner = lock_state.get("environment", "unknown")
            raise GuardFailure("release_lock_busy", f"Holy Sheet release lock is held by {owner}")
        measurements = check_capacity(args.path, budget, reserve_bytes=reserve, now=checked_at)
        receipt = build_receipt(
            environment=args.environment,
            source=args.source,
            phase=args.phase,
            peak_budget_bytes=budget,
            reserve_bytes=reserve,
            measurements=measurements,
            lock_state=lock_state,
            dry_run=True,
            now=checked_at,
        )
        print(json.dumps(receipt, sort_keys=True))
        return 0
    except GuardFailure as error:
        print(json.dumps({"gate": "rejected", "code": error.code, "reason": str(error)}, sort_keys=True), file=os.sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
