import importlib.util, json, os, pathlib, sys, tempfile, unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py")); module = importlib.util.module_from_spec(spec); sys.modules[name] = module; spec.loader.exec_module(module); return module
exporter = load("holy127_failed_receipt_export")
cleaner = load("holy127_failed_receipt_cleanup")

class ReceiptTransferTest(unittest.TestCase):
    def fixture(self, root):
        directory = root / "receipt"; directory.mkdir(mode=0o700)
        source = directory / "qualification.json"
        source.write_text(json.dumps({"operation":"holy127-q-f4f5a94-20261029a","status":"failed","error":"test"}) + "\n"); source.chmod(0o600)
        export = root / "export.json"; lock = root / "release.lock"; lock.write_bytes(b""); lock.chmod(0o660)
        return directory, source, export, lock
    def patches(self, module, directory, source, export, lock):
        values = [mock.patch.object(module,"SOURCE",source),mock.patch.object(module,"EXPORT",export),mock.patch.object(module,"LOCK",lock),mock.patch.object(module,"OWNER_UID",os.getuid()),mock.patch.object(module,"OWNER_GID",os.getgid()),mock.patch.object(module,"REQUIRED_EUID",os.getuid())]
        if hasattr(module,"DIRECTORY"): values.append(mock.patch.object(module,"DIRECTORY",directory))
        return values
    def test_export_then_byte_matched_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, source, export, lock = self.fixture(pathlib.Path(temporary)); patches = self.patches(exporter,directory,source,export,lock)
            with patches[0],patches[1],patches[2],patches[3],patches[4],patches[5],mock.patch.object(sys,"argv",["exporter"]): self.assertEqual(exporter.main(),0)
            self.assertEqual(export.read_bytes(),source.read_bytes()); self.assertEqual(export.stat().st_mode & 0o777,0o444)
            patches = self.patches(cleaner,directory,source,export,lock)
            with patches[0],patches[1],patches[2],patches[3],patches[4],patches[5],patches[6],mock.patch.object(sys,"argv",["cleaner"]): self.assertEqual(cleaner.main(),0)
            self.assertFalse(directory.exists()); self.assertFalse(export.exists())
    def test_mismatched_export_refuses_cleanup_and_preserves_both(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, source, export, lock = self.fixture(pathlib.Path(temporary)); export.write_text("different"); export.chmod(0o444); patches = self.patches(cleaner,directory,source,export,lock)
            with patches[0],patches[1],patches[2],patches[3],patches[4],patches[5],patches[6],mock.patch.object(sys,"argv",["cleaner"]),self.assertRaises(RuntimeError): cleaner.main()
            self.assertTrue(source.exists()); self.assertTrue(export.exists())

if __name__=="__main__": unittest.main()
