import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
import holy127_disposable_staging_qualifier as q


class DisposableQualifierTest(unittest.TestCase):
    def owned(self):
        return {"base": False, "network": False, "container": False, "network_attempted": False, "container_attempted": False}

    def image(self):
        return [{
            "Id": "sha256:" + "a" * 64,
            "RepoDigests": ["postgres@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc"],
            "Config": {
                "Env": ["PGDATA=/var/lib/postgresql/18/docker"],
                "Volumes": {"/var/lib/postgresql": {}},
                "Entrypoint": ["docker-entrypoint.sh"],
            },
        }]

    def test_image_contract_requires_digest_pgdata_volume_and_entrypoint(self):
        with patch.object(q, "docker_json", return_value=self.image()):
            self.assertEqual(q.require_image(), "sha256:" + "a" * 64)
        for field, value in (("Env", []), ("Volumes", {}), ("Entrypoint", ["other"])):
            changed = self.image()
            changed[0]["Config"][field] = value
            with self.subTest(field=field), patch.object(q, "docker_json", return_value=changed):
                with self.assertRaises(q.QualificationFailure):
                    q.require_image()

    def test_operator_environment_is_fixed_and_hostile_overrides_fail(self):
        safe = {"PATH": q.FIXED_PATH, "DOCKER_HOST": q.DOCKER_SOCKET}
        socket = SimpleNamespace(st_mode=stat.S_IFSOCK | 0o660, st_uid=0)
        with patch.dict(q.os.environ, safe, clear=True), patch.object(q.os, "lstat", return_value=socket), patch.object(q, "checked_capture", return_value=b'"18"'):
            q.require_isolated_environment()
        hostile = (
            {"PATH": "/tmp", "DOCKER_HOST": q.DOCKER_SOCKET},
            {"PATH": q.FIXED_PATH, "DOCKER_HOST": "tcp://attacker"},
            {"PATH": q.FIXED_PATH, "DOCKER_HOST": q.DOCKER_SOCKET, "DOCKER_CONTEXT": "remote"},
            {"PATH": q.FIXED_PATH, "DOCKER_HOST": q.DOCKER_SOCKET, "PYTHONPATH": "/tmp"},
        )
        for environment in hostile:
            with self.subTest(environment=environment), patch.dict(q.os.environ, environment, clear=True):
                with self.assertRaises(q.QualificationFailure):
                    q.require_isolated_environment()

    def test_local_docker_socket_must_be_root_owned_socket_not_symlink(self):
        safe = {"PATH": q.FIXED_PATH, "DOCKER_HOST": q.DOCKER_SOCKET}
        unsafe = (
            SimpleNamespace(st_mode=stat.S_IFREG | 0o660, st_uid=0),
            SimpleNamespace(st_mode=stat.S_IFSOCK | 0o660, st_uid=501),
            SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0),
        )
        for details in unsafe:
            with patch.dict(q.os.environ, safe, clear=True), patch.object(q.os, "lstat", return_value=details):
                with self.assertRaisesRegex(q.QualificationFailure, "socket identity"):
                    q.require_isolated_environment()

    def test_container_contract_rejects_volume_or_bind_and_requires_all_tmpfs(self):
        item = {"Image": "sha256:x", "Mounts": [], "HostConfig": {"Tmpfs": {"/var/lib/postgresql": "rw,size=128m", "/tmp": "rw,size=32m", "/var/run/postgresql": "rw,size=16m"}}, "Config": {"Env": ["PGDATA=/var/lib/postgresql/18/docker"]}}
        with patch.object(q, "docker_json", return_value=[item]):
            q.require_mounts_and_image("sha256:x")
        for mount_type in ("volume", "bind"):
            changed = dict(item, Mounts=[{"Type": mount_type}])
            with patch.object(q, "docker_json", return_value=[changed]):
                with self.assertRaisesRegex(q.QualificationFailure, "volume or bind"):
                    q.require_mounts_and_image("sha256:x")

    def test_create_command_is_pull_never_read_only_logless_and_capped(self):
        owned = self.owned()
        commands = []
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(q, "BASE", Path(folder) / q.OP), \
             patch.object(q, "absent", return_value=True), \
             patch.object(q, "reconcile_labeled", side_effect=[True, True]), \
             patch.object(q, "checked_capture", side_effect=lambda command, **_: commands.append(command) or b"x"):
            q.create_resources("secret", owned)
            run = commands[1]
            joined = " ".join(run)
            self.assertIn("--pull=never", joined)
            self.assertIn("--read-only", run)
            self.assertIn("--log-driver=none", run)
            self.assertIn("/var/lib/postgresql:rw,size=128m", run)
            self.assertIn("/var/run/postgresql:rw,size=16m", run)
            self.assertNotIn("-v", run)
            self.assertEqual(owned, {"base": True, "network": True, "container": True, "network_attempted": True, "container_attempted": True})

    def test_partial_create_tracks_only_owned_resources(self):
        owned = self.owned()
        calls = 0
        def fail_second(_command, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise q.QualificationFailure("run failed")
            return b"x"
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(q, "BASE", Path(folder) / q.OP), \
             patch.object(q, "absent", return_value=True), \
             patch.object(q, "reconcile_labeled", side_effect=[True, False]), \
             patch.object(q, "checked_capture", side_effect=fail_second):
            with self.assertRaises(q.QualificationFailure):
                q.create_resources("secret", owned)
            self.assertEqual(owned, {"base": True, "network": True, "container": False, "network_attempted": True, "container_attempted": True})

    def test_client_error_after_daemon_create_is_reconciled_as_owned(self):
        for failure in (TimeoutError("client timed out"), InterruptedError("client signalled")):
            owned = self.owned()
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as folder, \
                 patch.object(q, "BASE", Path(folder) / q.OP), \
                 patch.object(q, "absent", return_value=True), \
                 patch.object(q, "reconcile_labeled", return_value=True), \
                 patch.object(q, "checked_capture", side_effect=failure):
                with self.assertRaises(type(failure)):
                    q.create_resources("secret", owned)
            self.assertEqual(owned, {"base": True, "network": True, "container": False, "network_attempted": True, "container_attempted": False})

    def test_container_client_error_after_daemon_create_is_owned(self):
        for failure in (TimeoutError("run client timed out"), InterruptedError("run client signalled")):
            owned = self.owned()
            calls = 0
            def fail_run(_command, **_kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise failure
                return b"x"
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as folder, \
                 patch.object(q, "BASE", Path(folder) / q.OP), \
                 patch.object(q, "absent", return_value=True), \
                 patch.object(q, "reconcile_labeled", side_effect=[True, True]), \
                 patch.object(q, "checked_capture", side_effect=fail_run):
                with self.assertRaises(type(failure)):
                    q.create_resources("secret", owned)
            self.assertEqual(owned, {"base": True, "network": True, "container": True, "network_attempted": True, "container_attempted": True})

    def test_inspect_permission_failure_is_not_absence(self):
        with patch.object(q, "bounded_result", return_value=(1, b"permission denied")):
            with self.assertRaisesRegex(q.QualificationFailure, "absence could not be proven"):
                q.absent("container", q.CONTAINER)

    def test_cleanup_never_targets_unowned_resource(self):
        commands = []
        fake = subprocess.CompletedProcess([], 0)
        with patch.object(q.subprocess, "run", side_effect=lambda command, **_: commands.append(command) or fake):
            q.cleanup({"base": False, "network": True, "container": False}, preserve_receipt=True)
        self.assertEqual(commands, [(q.DOCKER, "network", "rm", q.NETWORK)])

    def test_cleanup_attempts_network_after_container_timeout(self):
        commands = []
        def run(command, **_kwargs):
            commands.append(command)
            if command[1:4] == ("container", "rm", "-f"):
                raise subprocess.TimeoutExpired(command, 30)
            return subprocess.CompletedProcess(command, 0)
        with patch.object(q.subprocess, "run", side_effect=run):
            with self.assertRaisesRegex(q.QualificationFailure, "cleanup command failed"):
                q.cleanup({"base": False, "network": True, "container": True}, preserve_receipt=True)
        self.assertEqual(commands[-1], (q.DOCKER, "network", "rm", q.NETWORK))

    def test_backend_cancellation_reports_natural_absence(self):
        with patch.object(q, "backend_count", side_effect=[1, 0]), patch.object(q.time, "sleep", return_value=None), patch.object(q, "terminate_backend") as terminate:
            self.assertFalse(q.require_cancelled("owned-disposable"))
        terminate.assert_not_called()

    def test_backend_cancellation_explicitly_terminates_only_named_disposable_backend(self):
        with patch.object(q.time, "monotonic", side_effect=[0, 2, 2, 3]), patch.object(q, "backend_count", return_value=0), patch.object(q, "terminate_backend") as terminate:
            self.assertTrue(q.require_cancelled("owned-disposable"))
        terminate.assert_called_once_with("owned-disposable")

    def test_failed_cleanup_removes_only_known_operation_files(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder) / q.OP
            base.mkdir()
            (base / ".holy127-a.pending").write_bytes(b"x")
            (base / "holy-sheet-a.dump").write_bytes(b"x")
            with patch.object(q, "BASE", base):
                q.cleanup({"base": True, "network": False, "container": False}, preserve_receipt=False)
            self.assertFalse(base.exists())

    def test_unexpected_file_blocks_directory_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder) / q.OP
            base.mkdir()
            (base / "foreign").write_bytes(b"x")
            with patch.object(q, "BASE", base):
                with self.assertRaisesRegex(q.QualificationFailure, "unexpected file"):
                    q.cleanup({"base": True, "network": False, "container": False}, preserve_receipt=False)
            self.assertTrue((base / "foreign").exists())

    def test_output_cap_and_command_failure_are_sanitized(self):
        with self.assertRaisesRegex(q.QualificationFailure, "output exceeded"):
            q.checked_capture((sys.executable, "-c", "print('xxxxx',end='')"), limit=4)
        with self.assertRaisesRegex(q.QualificationFailure, "fixed command failed: -c"):
            q.checked_capture((sys.executable, "-c", "raise SystemExit(2)"))

    def test_selector_registration_failure_kills_command_and_closes_pipes(self):
        created = []
        real = subprocess.Popen
        def spawn(*args, **kwargs):
            process = real(*args, **kwargs)
            created.append(process)
            return process
        with patch.object(q.subprocess, "Popen", side_effect=spawn), \
             patch.object(q.selectors.DefaultSelector, "register", side_effect=OSError("register failed")):
            with self.assertRaisesRegex(OSError, "register failed"):
                q.checked_capture((sys.executable, "-c", "import time;time.sleep(30)"))
        self.assertIsNotNone(created[0].poll())
        self.assertTrue(created[0].stdout.closed)
        self.assertTrue(created[0].stderr.closed)

    def test_signal_during_selector_setup_kills_command(self):
        created = []
        real = subprocess.Popen
        def spawn(*args, **kwargs):
            process = real(*args, **kwargs)
            created.append(process)
            return process
        q.TERMINATED = False
        with patch.object(q.subprocess, "Popen", side_effect=spawn), \
             patch.object(q.selectors.DefaultSelector, "register", side_effect=lambda *_: q.interrupted(signal.SIGTERM, None)):
            with self.assertRaises(InterruptedError):
                q.checked_capture((sys.executable, "-c", "import time;time.sleep(30)"))
        self.assertIsNotNone(created[0].poll())


if __name__ == "__main__":
    unittest.main()
