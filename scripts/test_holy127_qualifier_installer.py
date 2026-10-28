import hashlib
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
INSTALLER = ROOT / "holy127_qualifier_installer.sh"
MANIFEST = REPO / "deployment/HOLY-127-QUALIFIER-INSTALL-MANIFEST.json"


class QualifierInstallerContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = INSTALLER.read_text(encoding="utf-8")
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    def test_verifies_all_fourteen_manifest_payload_hashes(self):
        expected = {
            row["source"]: row["sha256"]
            for key in ("bundleFiles", "reviewOnlyFiles", "rootOwnedEntrypoints")
            for row in self.manifest[key]
        }
        frozen = dict(
            re.findall(
                r"^verify_regular_source ([^ ]+) ([0-9a-f]{64})$",
                self.source,
                re.MULTILINE,
            )
        )
        self.assertEqual(len(expected), 14)
        self.assertEqual(frozen, expected)
        for relative, digest in expected.items():
            self.assertEqual(hashlib.sha256((REPO / relative).read_bytes()).hexdigest(), digest)

    def test_installer_hash_matches_manifest(self):
        expected = self.manifest["installationMechanism"]["sha256"]
        self.assertEqual(hashlib.sha256(INSTALLER.read_bytes()).hexdigest(), expected)

    def test_refuses_unsafe_live_ancestors_and_incompatible_lock(self):
        self.assertIn("/ /opt /usr /usr/local", self.source)
        self.assertIn("bundle_parent=/opt/holy-sheet-qualification", self.source)
        self.assertNotIn("bundle_parent=/opt/holy-sheet-staging", self.source)
        self.assertIn('test "$(/usr/bin/stat -c %u:%g:%a:%F "$lock_file")" = "0:0:660:regular file"', self.source)
        self.assertNotIn("chown -R", self.source)
        self.assertNotIn("chmod -R", self.source)

    def test_sudo_policy_is_three_fixed_no_argument_commands(self):
        rules = re.findall(r"echo 'deploy ALL=\(root\) NOPASSWD: ([^']+)'", self.source)
        self.assertEqual(
            rules,
            [
                "/usr/local/sbin/holy127-q-f4f5a94",
                "/usr/local/sbin/holy127-q-f4f5a94-receipt",
                "/usr/local/sbin/holy127-q-f4f5a94-cleanup",
            ],
        )
        self.assertNotIn("/usr/bin/docker", "\n".join(rules))
        self.assertIn("/usr/sbin/visudo -cf \"$sudoers_stage\"", self.source)
        self.assertIn("/usr/sbin/visudo -cf /etc/sudoers", self.source)

    def test_commits_only_after_validation_and_has_bounded_rollback(self):
        validate = self.source.index('/usr/sbin/visudo -cf "$sudoers_stage"')
        first_commit = self.source.index('/usr/bin/mv -T -- "$bundle_stage"')
        self.assertLess(validate, first_commit)
        for marker in (
            "committed_bundle",
            "committed_entrypoint",
            "committed_receipt_entrypoint",
            "committed_cleanup_entrypoint",
            "committed_sudoers",
            "created_lock_file",
            "created_lock_parent",
            "created_bundle_parent",
            "staged_bundle",
            "staged_entrypoint",
            "staged_receipt_entrypoint",
            "staged_cleanup_entrypoint",
            "staged_sudoers",
        ):
            self.assertIn(marker, self.source)
        self.assertNotIn("/usr/bin/sudo", self.source)
        self.assertNotIn(" sudo -", self.source)

    def test_cleanup_never_removes_unowned_collision_paths(self):
        self.assertIn('[ "$staged_bundle" -eq 0 ] || /usr/bin/rm -rf -- "$bundle_stage"', self.source)
        self.assertIn('[ "$staged_sudoers" -eq 0 ] || /usr/bin/rm -f -- "$sudoers_stage"', self.source)
        self.assertLess(self.source.index('verify_absent "$target"'), self.source.index('staged_bundle=1'))


if __name__ == "__main__":
    unittest.main()
