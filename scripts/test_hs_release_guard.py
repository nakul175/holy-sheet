#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import multiprocessing
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from hs_release_guard import (
    DEFAULT_RESERVE_BYTES,
    GuardFailure,
    Measurement,
    ReleaseGuard,
    ReleaseLock,
    build_receipt,
    check_capacity,
    parse_positive_bytes,
    probe_lock,
    resolve_existing_path,
    write_receipt,
)

NOW = dt.datetime(2026, 10, 29, 0, 0, tzinfo=dt.timezone.utc)


def measured(available: int, *, observed: dt.datetime = NOW, device: int = 1):
    def probe(path: pathlib.Path, now: dt.datetime) -> Measurement:
        return Measurement(str(path), str(path), "/fixture", device, available, observed)
    return probe


def lock_and_crash(path: str) -> None:
    ReleaseLock(path, "staging", "crash-fixture", create=True, strict_install=False).__enter__()
    os._exit(17)


class CapacityTests(unittest.TestCase):
    def test_exact_threshold_passes_and_one_byte_less_fails(self):
        budget = 500
        self.assertEqual(len(check_capacity(["/fixture"], budget, probe=measured(DEFAULT_RESERVE_BYTES + budget), now=NOW)), 1)
        with self.assertRaisesRegex(GuardFailure, "insufficient capacity") as failure:
            check_capacity(["/fixture"], budget, probe=measured(DEFAULT_RESERVE_BYTES + budget - 1), now=NOW)
        self.assertEqual(failure.exception.code, "insufficient_capacity")

    def test_invalid_budgets_fail_closed(self):
        for value in ("", "0", "-1", "1.5", "secret bytes", str(2**63)):
            with self.subTest(value=value), self.assertRaises(GuardFailure):
                parse_positive_bytes(value, "peak budget")

    def test_stale_future_and_failed_measurements_reject(self):
        with self.assertRaisesRegex(GuardFailure, "stale"):
            check_capacity(["/fixture"], 1, probe=measured(10**12, observed=NOW - dt.timedelta(seconds=31)), now=NOW)
        with self.assertRaisesRegex(GuardFailure, "stale"):
            check_capacity(["/fixture"], 1, probe=measured(10**12, observed=NOW + dt.timedelta(seconds=2)), now=NOW)
        def broken(path: pathlib.Path, now: dt.datetime) -> Measurement:
            raise OSError("sensitive detail")
        with self.assertRaisesRegex(GuardFailure, "measurement failed") as failure:
            check_capacity(["/fixture"], 1, probe=broken, now=NOW)
        self.assertNotIn("sensitive", str(failure.exception))

    def test_paths_resolve_to_existing_ancestor_and_every_path_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            self.assertEqual(resolve_existing_path(base / "future" / "artifact"), base.resolve())
        calls: list[str] = []
        def probe(path: pathlib.Path, now: dt.datetime) -> Measurement:
            calls.append(str(path))
            return Measurement(str(path), str(path), "/same", 7, 10**12, now)
        result = check_capacity(["/a", "/b"], 1, probe=probe, now=NOW)
        self.assertEqual(calls, ["/a", "/b"])
        self.assertEqual(len(result), 2)

    def test_read_only_lock_probe_does_not_create_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "missing.lock"
            self.assertEqual(probe_lock(path, strict_install=False), {"state": "available", "filePresent": False})
            self.assertFalse(path.exists())

    def test_phase_gate_runs_before_mutation(self):
        mutated: list[bool] = []
        guard = ReleaseGuard(environment="staging", source="abc123", peak_budget_bytes=500, paths=["/fixture"], lock_path="/tmp/unused-holy-sheet-test.lock", probe=measured(DEFAULT_RESERVE_BYTES + 499), now=lambda: NOW)
        with tempfile.TemporaryDirectory() as directory:
            guard.lock_path = pathlib.Path(directory) / "guard.lock"
            guard.lock = ReleaseLock(guard.lock_path, guard.environment, guard.source, guard.now, create=True, strict_install=False)
            with self.assertRaises(GuardFailure):
                with guard:
                    guard.run_phase("build", lambda: mutated.append(True))
        self.assertEqual(mutated, [])


class LockTests(unittest.TestCase):
    def test_competing_release_fails_without_stealing_live_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "release.lock"
            with ReleaseLock(path, "staging", "one", create=True, strict_install=False):
                self.assertEqual(probe_lock(path, strict_install=False), {"state": "held", "environment": "staging"})
                with self.assertRaises(GuardFailure) as failure:
                    with ReleaseLock(path, "production", "two", strict_install=False):
                        pass
                self.assertEqual(failure.exception.code, "release_lock_busy")
                self.assertEqual(probe_lock(path, strict_install=False)["environment"], "staging")
            self.assertEqual(probe_lock(path, strict_install=False), {"state": "available"})

    def test_stale_metadata_does_not_block_and_crash_releases_kernel_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "release.lock"
            path.write_text('{"pid":999999,"environment":"stale"}\n', encoding="utf-8")
            with ReleaseLock(path, "production", "fresh", strict_install=False):
                self.assertEqual(probe_lock(path, strict_install=False)["environment"], "production")
            process = multiprocessing.Process(target=lock_and_crash, args=(str(path),))
            process.start()
            deadline = time.time() + 5
            while time.time() < deadline and probe_lock(path, strict_install=False)["state"] != "held":
                time.sleep(0.01)
            process.join(5)
            self.assertEqual(process.exitcode, 17)
            self.assertEqual(probe_lock(path, strict_install=False), {"state": "available"})

    def test_signal_termination_releases_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "release.lock"
            code = "from hs_release_guard import ReleaseLock;import sys,time;\nwith ReleaseLock(sys.argv[1],'staging','signal',create=True,strict_install=False): time.sleep(30)"
            process = subprocess.Popen([sys.executable, "-c", code, str(path)], cwd=pathlib.Path(__file__).parent, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.time() + 5
            while time.time() < deadline and probe_lock(path, strict_install=False)["state"] != "held":
                time.sleep(0.01)
            self.assertEqual(probe_lock(path, strict_install=False)["state"], "held")
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=5)
            self.assertEqual(probe_lock(path, strict_install=False), {"state": "available"})

    def test_missing_and_symlink_lock_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "missing.lock"
            with self.assertRaises(GuardFailure) as missing:
                with ReleaseLock(path, "staging", "source", strict_install=False):
                    pass
            self.assertEqual(missing.exception.code, "release_lock_missing")
            target = pathlib.Path(directory) / "target"
            target.write_text("", encoding="utf-8")
            path.symlink_to(target)
            with self.assertRaises(GuardFailure) as unsafe:
                with ReleaseLock(path, "staging", "source", strict_install=False):
                    pass
            self.assertEqual(unsafe.exception.code, "release_lock_invalid")


class ReceiptTests(unittest.TestCase):
    def test_receipt_is_sanitized_exact_and_private(self):
        item = Measurement("/var/lib/data", "/var/lib/data", "/", 1, 9_000_000_000, NOW)
        receipt = build_receipt(environment="production", source="a" * 40, phase="backup", peak_budget_bytes=123, reserve_bytes=DEFAULT_RESERVE_BYTES, measurements=[item], lock_state={"state": "held", "environment": "production"}, dry_run=False, now=NOW)
        self.assertEqual(receipt["filesystems"][0]["availableBytes"], 9_000_000_000)
        self.assertEqual(receipt["peakBudgetBytes"], 123)
        self.assertEqual(receipt["reserveBytes"], DEFAULT_RESERVE_BYTES)
        self.assertNotIn("secret", json.dumps(receipt).lower())
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "receipt.json"
            write_receipt(path, receipt)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["gate"], "passed")


if __name__ == "__main__":
    unittest.main()
