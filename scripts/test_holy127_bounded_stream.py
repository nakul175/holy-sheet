import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from holy127_bounded_stream import copy_bounded


class BoundedStreamTest(unittest.TestCase):
    def run_copy(self, payload: bytes, limit: int, target: Path):
        stdin = type("Input", (), {"buffer": io.BytesIO(payload)})()
        with patch.object(sys, "stdin", stdin):
            return copy_bounded(target, limit)

    def test_writes_exact_limit_once_with_private_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "backup.pending"
            receipt = self.run_copy(b"abcd", 4, target)
            self.assertEqual(receipt["bytes"], 4)
            self.assertEqual(target.read_bytes(), b"abcd")
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)

    def test_over_limit_removes_pending_file(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "backup.pending"
            with self.assertRaisesRegex(RuntimeError, "hard byte limit"):
                self.run_copy(b"abcde", 4, target)
            self.assertFalse(target.exists())

    def test_refuses_collision_without_changing_existing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "backup.pending"
            target.write_bytes(b"preserve")
            with self.assertRaises(FileExistsError):
                self.run_copy(b"new", 4, target)
            self.assertEqual(target.read_bytes(), b"preserve")

    def test_invalid_limit_creates_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "backup.pending"
            with self.assertRaises(ValueError):
                self.run_copy(b"x", 0, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
