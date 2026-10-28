import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class QualifierEntrypointContractTest(unittest.TestCase):
    def read(self, name: str) -> str:
        return (ROOT / name).read_text(encoding="utf-8")

    def test_run_entrypoint_uses_clean_local_docker_environment_and_immutable_ancestors(self):
        source = self.read("holy127_qualifier_entrypoint.sh")
        self.assertIn("/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DOCKER_HOST=unix:///var/run/docker.sock", source)
        self.assertIn("unset DOCKER_CONTEXT DOCKER_CONFIG PYTHONPATH PYTHONHOME", source)
        self.assertIn("for ancestor in /opt /opt/holy-sheet-staging /opt/holy-sheet-staging/qualification", source)
        self.assertIn("test $((0$mode & 0022)) -eq 0", source)
        self.assertIn("/usr/bin/python3 -I", source)

    def test_receipt_entrypoints_share_lock_and_cleanup_refuses_every_extra_entry_type(self):
        collect = self.read("holy127_qualifier_receipt_collect.sh")
        cleanup = self.read("holy127_qualifier_receipt_cleanup.sh")
        for source in (collect, cleanup):
            self.assertIn("/run/lock/holy-sheet-release/release.lock", source)
            self.assertIn("/usr/bin/flock -n 9", source)
            self.assertIn("unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG PYTHONPATH PYTHONHOME", source)
            self.assertIn('test "$(/usr/bin/stat -c %u:%g:%a /var/tmp)" = "0:0:1777"', source)
        self.assertIn("-mindepth 1 -maxdepth 1 -printf '%f\\n'", cleanup)
        self.assertNotIn("-type f", cleanup)
        self.assertLess(cleanup.index("/usr/bin/sha256sum"), cleanup.index("/usr/bin/rm --"))
        self.assertLess(cleanup.index("qualification.json\""), cleanup.index("/usr/bin/rm --"))

    def test_all_entrypoints_reject_arguments_and_verify_self_identity(self):
        for name in ("holy127_qualifier_entrypoint.sh", "holy127_qualifier_receipt_collect.sh", "holy127_qualifier_receipt_cleanup.sh"):
            source = self.read(name)
            self.assertIn('"$#" -ne 0', source) if name == "holy127_qualifier_entrypoint.sh" else self.assertIn('test "$#" -eq 0', source)
            self.assertIn('test ! -L "$0"', source)
            self.assertIn('"0:0:555"', source)


if __name__ == "__main__":
    unittest.main()
