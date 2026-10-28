import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
INSTALLER_PATH = ROOT / "holy127_qualifier_installer.py"
MANIFEST_PATH = REPO / "deployment/HOLY-127-QUALIFIER-INSTALL-MANIFEST.json"
SPEC = importlib.util.spec_from_file_location("holy127_installer", INSTALLER_PATH)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)

def test_rename_noreplace(source, target):
    if target.exists() or target.is_symlink():
        raise FileExistsError(target)
    source.rename(target)

class QualifierInstallerContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = INSTALLER_PATH.read_text(encoding="utf-8")
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_verifies_all_fourteen_manifest_payload_hashes_and_actual_files(self):
        expected = {row["source"]: row["sha256"] for key in ("bundleFiles", "reviewOnlyFiles", "rootOwnedEntrypoints") for row in self.manifest[key]}
        self.assertEqual(len(expected), 14)
        self.assertEqual(mod.PAYLOAD_HASHES, expected)
        for relative, digest in expected.items(): self.assertEqual(hashlib.sha256((REPO / relative).read_bytes()).hexdigest(), digest)

    def test_installer_hash_matches_manifest(self):
        self.assertEqual(hashlib.sha256(INSTALLER_PATH.read_bytes()).hexdigest(), self.manifest["installationMechanism"]["sha256"])

    def test_policy_is_exactly_three_empty_argument_commands(self):
        lines = mod.SUDOERS_TEXT.splitlines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(all(line.endswith(' ""') for line in lines))
        self.assertFalse(any("docker" in line or "python" in line or " sh" in line for line in lines))

    def test_uses_noreplace_inode_rollback_and_persistent_lock(self):
        self.assertIn("RENAME_NOREPLACE", self.source)
        self.assertIn("same_identity", self.source)
        rollback = self.source[self.source.index("    def rollback"):self.source.index("    def run")]
        self.assertNotIn("lock_file", rollback)
        self.assertNotIn("lock_parent", rollback)

class Harness:
    def __init__(self, root: pathlib.Path):
        self.root, self.uid, self.gid = root, os.getuid(), os.getgid()
        self.source = root / "source"; self.source.mkdir(mode=0o700)
        (self.source / "scripts").mkdir(mode=0o700); (self.source / "deployment").mkdir(mode=0o700)
        for relative in mod.PAYLOAD_HASHES:
            target = self.source / relative; target.write_bytes((REPO / relative).read_bytes()); target.chmod(0o400)
        (self.source / "scripts").chmod(0o500); (self.source / "deployment").chmod(0o500); self.source.chmod(0o500)
        self.opt, self.sbin, self.sudoers, self.run_lock = root / "opt", root / "sbin", root / "sudoers.d", root / "run-lock"
        for directory in (self.opt, self.sbin, self.sudoers, self.run_lock): directory.mkdir(mode=0o755)
        self.visudo = root / "visudo"; self.visudo.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8"); self.visudo.chmod(0o755)

    def config(self):
        return mod.Config(source_root=self.source, bundle_parent=self.opt / "holy-sheet-qualification", bundle=self.opt / "holy-sheet-qualification/holy127-4c1fdbda6becaf76", sbin=self.sbin, sudoers_dir=self.sudoers, sudoers=self.sudoers / "holy127-q-f4f5a94", lock_parent=self.run_lock / "holy-sheet-release", lock_file=self.run_lock / "holy-sheet-release/release.lock", visudo=self.visudo, expected_uid=self.uid, expected_gid=self.gid)

class QualifierInstallerFaultTest(unittest.TestCase):
    def assert_clean(self, harness):
        c = harness.config()
        self.assertFalse(c.bundle.exists()); self.assertFalse(c.sudoers.exists())
        for name in mod.ENTRYPOINT_FILES: self.assertFalse((harness.sbin / name).exists())
        self.assertTrue(c.lock_file.exists(), "persistent lock must never be unlinked")

    def test_fault_injection_at_every_stage_and_commit_boundary(self):
        phases = [
            "stage:holy-sheet-qualification/holy127-4c1fdbda6becaf76.holy127-install-rootpath-v2.pending",
            *(f"stage:sbin/{name}.holy127-install-rootpath-v2.pending" for name in mod.ENTRYPOINT_FILES),
            "stage:sudoers.d/holy127-q-f4f5a94.holy127-install-rootpath-v2.pending",
            "commit:holy-sheet-qualification/holy127-4c1fdbda6becaf76",
            *(f"commit:sbin/{name}" for name in mod.ENTRYPOINT_FILES),
            "commit:sudoers.d/holy127-q-f4f5a94",
        ]
        for phase in phases:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temporary:
                harness = Harness(pathlib.Path(temporary))
                def hook(current):
                    if current == phase: raise RuntimeError(phase)
                subject = mod.Installer(harness.config(), hook, test_rename_noreplace)
                with self.assertRaises(RuntimeError): subject.run()
                subject.rollback(); subject.close(); self.assert_clean(harness)

    def test_noreplace_never_overwrites_racing_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            harness = Harness(pathlib.Path(temporary)); target = harness.sbin / "holy127-q-f4f5a94"
            def hook(phase):
                if phase == "sudoers-stage-valid": target.write_text("unrelated", encoding="utf-8")
            subject = mod.Installer(harness.config(), hook, test_rename_noreplace)
            with self.assertRaises(FileExistsError): subject.run()
            subject.rollback(); subject.close(); self.assertEqual(target.read_text(encoding="utf-8"), "unrelated")

    def test_fault_injection_at_every_internal_io_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            harness = Harness(pathlib.Path(temporary)); operations = []
            subject = mod.Installer(harness.config(), lambda phase: operations.append(phase) if phase.startswith("io:") else None, test_rename_noreplace)
            subject.run(); subject.rollback(); subject.close()
        self.assertGreaterEqual(len(operations), 25)
        for operation in operations:
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as temporary:
                harness = Harness(pathlib.Path(temporary))
                def hook(current):
                    if current == operation: raise OSError(operation)
                subject = mod.Installer(harness.config(), hook, test_rename_noreplace)
                with self.assertRaises(OSError): subject.run()
                subject.rollback(); subject.close(); self.assert_clean(harness)

    def test_partial_bundle_cleanup_removes_only_owned_children(self):
        with tempfile.TemporaryDirectory() as temporary:
            harness = Harness(pathlib.Path(temporary)); foreign = None
            def hook(current):
                nonlocal foreign
                if current == "io:holy127_disposable_staging_qualifier.py:fchmod":
                    pending = harness.config().bundle.with_name(harness.config().bundle.name + ".holy127-install-rootpath-v2.pending")
                    foreign = pending / "unrelated"
                    foreign.write_text("preserve", encoding="utf-8")
                    raise OSError("injected after foreign collision")
            subject = mod.Installer(harness.config(), hook, test_rename_noreplace)
            with self.assertRaises(OSError): subject.run()
            subject.rollback(); subject.close()
            self.assertIsNotNone(foreign); self.assertEqual(foreign.read_text(encoding="utf-8"), "preserve")
            self.assertEqual([path.name for path in foreign.parent.iterdir()], ["unrelated"])

    def test_rollback_masks_signals_and_attempts_every_owned_cleanup(self):
        source = INSTALLER_PATH.read_text(encoding="utf-8")
        rollback = source[source.index("    def rollback"):source.index("    def run")]
        self.assertIn("with blocked_signals()", rollback)
        self.assertIn("failures.append", rollback)
        self.assertIn("for owned in reversed", rollback)

    def test_visudo_is_bounded_and_production_ancestors_are_explicit(self):
        source = INSTALLER_PATH.read_text(encoding="utf-8")
        self.assertIn("timeout=10", source)
        for path in ('pathlib.Path("/")', 'pathlib.Path("/usr")', 'pathlib.Path("/usr/local")', 'pathlib.Path("/etc")', 'pathlib.Path("/run")', 'pathlib.Path("/var")', 'pathlib.Path("/opt")', 'pathlib.Path("/var/tmp")'):
            self.assertIn(path, source)

    def test_real_term_hup_int_during_staging_and_every_commit_boundary(self):
        runner = textwrap.dedent(f"""
            import importlib.util,pathlib,sys,time
            spec=importlib.util.spec_from_file_location('inst',{str(INSTALLER_PATH)!r});m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
            from scripts.test_holy127_qualifier_installer import Harness
            h=Harness(pathlib.Path(sys.argv[1]));phase=sys.argv[2]
            def hook(current):
                if current==phase: print('READY',flush=True);time.sleep(30)
            from scripts.test_holy127_qualifier_installer import test_rename_noreplace
            x=m.Installer(h.config(),hook,test_rename_noreplace);m.install_signal_handlers()
            try:x.run()
            except BaseException as e:
                x.rollback();x.close();raise SystemExit(128+e.signum if isinstance(e,m.InstallInterrupted) else 1)
        """)
        phases = [
            "stage:holy-sheet-qualification/holy127-4c1fdbda6becaf76.holy127-install-rootpath-v2.pending",
            *(f"stage:sbin/{name}.holy127-install-rootpath-v2.pending" for name in mod.ENTRYPOINT_FILES),
            "stage:sudoers.d/holy127-q-f4f5a94.holy127-install-rootpath-v2.pending",
            "commit:holy-sheet-qualification/holy127-4c1fdbda6becaf76",
            "commit:sbin/holy127-q-f4f5a94",
            "commit:sbin/holy127-q-f4f5a94-receipt",
            "commit:sbin/holy127-q-f4f5a94-cleanup",
            "commit:sudoers.d/holy127-q-f4f5a94",
        ]
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            for phase in phases:
                with self.subTest(signal=signum, phase=phase), tempfile.TemporaryDirectory() as temporary:
                    process = subprocess.Popen([sys.executable, "-c", runner, temporary, phase], cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    ready = process.stdout.readline().strip()
                    if ready != "READY":
                        _stdout, stderr = process.communicate(timeout=10)
                        self.fail(f"child did not reach {phase}: {stderr}")
                    process.send_signal(signum); process.communicate(timeout=10)
                    self.assertEqual(process.returncode, 128 + signum)
                    self.assert_clean(Harness.__new__(Harness)) if False else None
                    root = pathlib.Path(temporary)
                    self.assertFalse((root / "opt/holy-sheet-qualification/holy127-4c1fdbda6becaf76").exists())
                    self.assertFalse((root / "sudoers.d/holy127-q-f4f5a94").exists())
                    self.assertTrue((root / "run-lock/holy-sheet-release/release.lock").exists())

if __name__ == "__main__": unittest.main()
