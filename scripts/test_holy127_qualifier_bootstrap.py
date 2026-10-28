import importlib.util
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
BOOTSTRAP_PATH = ROOT / "holy127_qualifier_bootstrap.py"
ARCHIVE_PATH = REPO / "deployment/HOLY-127-BOOTSTRAP-PAYLOAD-d140c7f.tar"
SPEC = importlib.util.spec_from_file_location("holy127_bootstrap", BOOTSTRAP_PATH)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)

class Harness:
    def __init__(self, root):
        self.root = root; self.uid = os.getuid(); self.gid = os.getgid()
        self.incoming = root / "incoming"; self.incoming.mkdir(mode=0o700)
        self.archive = self.incoming / "holy127-payload-d140c7f.tar"
        shutil.copyfile(ARCHIVE_PATH, self.archive); self.archive.chmod(0o400)
        self.sbin = root / "sbin"; self.sbin.mkdir(mode=0o755)
        self.source_parent = root / "installer-root"

    def config(self):
        return mod.Config(incoming_parent=self.incoming, archive=self.archive, source_parent=self.source_parent, source_root=self.source_parent / "source", installer=self.sbin / "holy127-q-f4f5a94-install", expected_uid=self.uid, expected_gid=self.gid)

class FakeBootstrap(mod.Bootstrap):
    def invoke_installer(self):
        self.invoked = True

class BootstrapTest(unittest.TestCase):
    def test_exact_packet_builds_fixed_source_and_invokes_only_installer(self):
        with tempfile.TemporaryDirectory() as temporary:
            harness = Harness(pathlib.Path(temporary)); subject = FakeBootstrap(harness.config()); subject.invoked = False
            subject.run()
            self.assertTrue(subject.invoked)
            self.assertEqual(subject.config.installer.read_bytes(), (REPO / mod.INSTALLER_RELATIVE).read_bytes())
            self.assertEqual(subject.config.installer.stat().st_mode & 0o777, 0o555)
            for relative, digest in mod.PAYLOAD_HASHES.items():
                self.assertEqual(__import__("hashlib").sha256((subject.config.source_root / relative).read_bytes()).hexdigest(), digest)

    def test_archive_hash_mismatch_refuses_before_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            harness = Harness(pathlib.Path(temporary)); harness.archive.chmod(0o600); harness.archive.write_bytes(b"wrong"); harness.archive.chmod(0o400)
            subject = FakeBootstrap(harness.config())
            with self.assertRaises(mod.BootstrapFailure): subject.run()
            self.assertFalse(harness.source_parent.exists()); self.assertFalse(subject.config.installer.exists())

    def test_collision_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            harness = Harness(pathlib.Path(temporary)); harness.source_parent.mkdir(); marker = harness.source_parent / "unrelated"; marker.write_text("keep")
            subject = FakeBootstrap(harness.config())
            with self.assertRaises(FileExistsError): subject.run()
            self.assertEqual(marker.read_text(), "keep")

    def test_partial_write_is_inode_tracked_and_fully_rolled_back(self):
        with tempfile.TemporaryDirectory() as temporary:
            harness = Harness(pathlib.Path(temporary)); subject = FakeBootstrap(harness.config())
            real_write = os.write; calls = 0
            def failing_write(descriptor, content):
                nonlocal calls
                calls += 1
                if calls == 1:
                    real_write(descriptor, content[:1]); raise OSError("injected write failure")
                return real_write(descriptor, content)
            with mock.patch.object(mod.os, "write", failing_write), self.assertRaises(OSError): subject.run()
            subject.rollback()
            self.assertFalse(harness.source_parent.exists()); self.assertFalse(subject.config.installer.exists())

    def test_transfer_surface_and_invocation_are_fixed(self):
        source = BOOTSTRAP_PATH.read_text()
        self.assertIn("/root/holy127-transfer-inbox/holy127-payload-d140c7f.tar", source)
        self.assertIn("/usr/local/sbin/holy127-q-f4f5a94-install", source)
        self.assertNotIn("shell=True", source)
        self.assertNotIn("deploy.sh", source)
        self.assertNotIn("backup.sh", source)
        self.assertIn('["/usr/bin/python3", "-I", self.config.installer]', source)
        self.assertIn('start_new_session=True', source)
        self.assertIn('os.killpg(process.pid, signal.SIGTERM)', source)

    def test_real_term_hup_int_stop_and_reap_installer_group(self):
        runner = textwrap.dedent(f"""
            import importlib.util,pathlib,signal,sys
            spec=importlib.util.spec_from_file_location('boot',{str(BOOTSTRAP_PATH)!r});m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
            def interrupted(signum,frame): raise m.BootstrapInterrupted(signum)
            for signum in m.CAUGHT_SIGNALS: signal.signal(signum,interrupted)
            c=m.Config(installer=pathlib.Path(sys.argv[1]),invoke_timeout=30,stop_timeout=2,expected_uid=0,expected_gid=0)
            b=m.Bootstrap(c)
            try:b.invoke_installer()
            except m.BootstrapInterrupted as e: raise SystemExit(128+e.signum)
        """)
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            with self.subTest(signal=signum), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary); status = root / "status"; installer = root / "installer.py"
                installer.write_text("import pathlib,subprocess,time\np=subprocess.Popen(['/bin/sleep','30'])\npathlib.Path(" + repr(str(status)) + ").write_text(str(p.pid))\ntime.sleep(30)\n")
                process = subprocess.Popen([sys.executable, "-c", runner, str(installer)])
                for _ in range(100):
                    if status.exists(): break
                    time.sleep(0.02)
                self.assertTrue(status.exists())
                child_pid = int(status.read_text()); process.send_signal(signum); process.wait(timeout=5)
                self.assertEqual(process.returncode, 128 + signum)
                with self.assertRaises(ProcessLookupError): os.kill(child_pid, 0)

    def test_timeout_stops_and_reaps_installer_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary); status = root / "status"; installer = root / "installer.py"
            installer.write_text("import pathlib,subprocess,time\np=subprocess.Popen(['/bin/sleep','30'])\npathlib.Path(" + repr(str(status)) + ").write_text(str(p.pid))\ntime.sleep(30)\n")
            config = mod.Config(installer=installer, invoke_timeout=0.2, stop_timeout=2, expected_uid=os.getuid(), expected_gid=os.getgid())
            subject = mod.Bootstrap(config)
            with self.assertRaises(subprocess.TimeoutExpired): subject.invoke_installer()
            self.assertTrue(status.exists()); child_pid = int(status.read_text())
            with self.assertRaises(ProcessLookupError): os.kill(child_pid, 0)

    def test_repeated_signal_during_cleanup_still_reaps_group(self):
        runner = textwrap.dedent(f"""
            import importlib.util,pathlib,signal,sys
            spec=importlib.util.spec_from_file_location('boot',{str(BOOTSTRAP_PATH)!r});m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
            def interrupted(signum,frame): raise m.BootstrapInterrupted(signum)
            for signum in m.CAUGHT_SIGNALS: signal.signal(signum,interrupted)
            b=m.Bootstrap(m.Config(installer=pathlib.Path(sys.argv[1]),invoke_timeout=30,stop_timeout=.3,expected_uid=0,expected_gid=0))
            try:b.invoke_installer()
            except m.BootstrapInterrupted as e: raise SystemExit(128+e.signum)
        """)
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary); status = root / "status"; installer = root / "installer.py"
            installer.write_text("import pathlib,signal,subprocess,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\np=subprocess.Popen(['/bin/sh','-c','trap \"\" TERM; sleep 30'])\npathlib.Path(" + repr(str(status)) + ").write_text(str(p.pid))\ntime.sleep(30)\n")
            process = subprocess.Popen([sys.executable, "-c", runner, str(installer)])
            for _ in range(100):
                if status.exists(): break
                time.sleep(0.02)
            self.assertTrue(status.exists()); child_pid = int(status.read_text())
            for _ in range(5):
                process.send_signal(signal.SIGTERM); time.sleep(0.03)
            process.wait(timeout=5); self.assertEqual(process.returncode, 128 + signal.SIGTERM)
            with self.assertRaises(ProcessLookupError): os.kill(child_pid, 0)

    def test_successful_child_marks_outputs_committed(self):
        with tempfile.TemporaryDirectory() as temporary:
            installer = pathlib.Path(temporary) / "installer.py"; installer.write_text("raise SystemExit(0)\n")
            subject = mod.Bootstrap(mod.Config(installer=installer, expected_uid=os.getuid(), expected_gid=os.getgid()))
            subject.invoke_installer(); self.assertTrue(subject.installer_succeeded)

if __name__ == "__main__":
    unittest.main()
