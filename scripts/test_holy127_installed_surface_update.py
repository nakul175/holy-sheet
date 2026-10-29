import hashlib
import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
UPDATE_PATH = ROOT / "holy127_installed_surface_update.py"
ARCHIVE_PATH = REPO / "deployment/HOLY-127-UPDATE-PAYLOAD-5bc68a1.tar"
SPEC = importlib.util.spec_from_file_location("holy127_update", UPDATE_PATH)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name] = mod; SPEC.loader.exec_module(mod)

def sha(content): return hashlib.sha256(content).hexdigest()

class UpdateTest(unittest.TestCase):
    def harness(self, root):
        first = root / "bundle.py"; second = root / "entrypoint"
        first.write_bytes(b"old-one"); second.write_bytes(b"old-two"); first.chmod(0o444); second.chmod(0o555)
        archive = root / "payload.tar"; archive.write_bytes(ARCHIVE_PATH.read_bytes()); archive.chmod(0o400)
        lock = root / "release.lock"; lock.write_bytes(b""); lock.chmod(0o660)
        updates = {
            first: ("scripts/holy127_disposable_staging_qualifier.py", "3a8b0e8f9e2d382b0ba00dc5a0fb5b5c2be3d366913a4ac14f4d05b46b4070fd", 0o444),
            second: ("scripts/holy127_qualifier_receipt_collect.sh", "7f7e66316a1fa8adcf3b47f6a86dedc2e4c637fda470cf4deca930b7221326fd", 0o555),
        }
        patches = (
            mock.patch.object(mod, "ARCHIVE", archive), mock.patch.object(mod, "LOCK", lock),
            mock.patch.object(mod, "RECEIPT_DIRECTORY", root / "receipt"),
            mock.patch.object(mod, "OLD", {first: sha(b"old-one"), second: sha(b"old-two")}),
            mock.patch.object(mod, "UPDATES", updates), mock.patch.object(mod, "OWNER_UID", os.getuid()), mock.patch.object(mod, "OWNER_GID", os.getgid()),
        )
        return first, second, patches

    def test_exact_update_replaces_only_verified_targets(self):
        with tempfile.TemporaryDirectory() as temporary:
            first, second, patches = self.harness(pathlib.Path(temporary))
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]: result = mod.run()
            self.assertEqual(result["status"], "updated")
            self.assertEqual(sha(first.read_bytes()), "3a8b0e8f9e2d382b0ba00dc5a0fb5b5c2be3d366913a4ac14f4d05b46b4070fd")
            self.assertEqual(sha(second.read_bytes()), "7f7e66316a1fa8adcf3b47f6a86dedc2e4c637fda470cf4deca930b7221326fd")

    def test_preserved_receipt_blocks_update(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary); _first, _second, patches = self.harness(root); (root / "receipt").mkdir()
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], self.assertRaisesRegex(mod.UpdateFailure, "receipt"):
                mod.run()

    def test_mid_commit_failure_restores_old_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            first, second, patches = self.harness(pathlib.Path(temporary)); real_replace = os.replace; calls = 0
            def replace(source, target):
                nonlocal calls
                calls += 1
                if calls == 2: raise OSError("injected replacement failure")
                return real_replace(source, target)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], mock.patch.object(mod.os, "replace", replace), self.assertRaises(OSError):
                mod.run()
            self.assertEqual(first.read_bytes(), b"old-one"); self.assertEqual(second.read_bytes(), b"old-two")

if __name__ == "__main__": unittest.main()
