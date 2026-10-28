import importlib.util
import os
import pathlib
import shutil
import sys
import tempfile
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
        self.assertIn("/var/tmp/holy127-bootstrap-rootpath-v2/holy127-payload-d140c7f.tar", source)
        self.assertIn("/usr/local/sbin/holy127-q-f4f5a94-install", source)
        self.assertNotIn("shell=True", source)
        self.assertNotIn("deploy.sh", source)
        self.assertNotIn("backup.sh", source)

if __name__ == "__main__":
    unittest.main()
