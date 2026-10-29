import fcntl, importlib.util, json, os, pathlib, signal, subprocess, sys, tempfile, unittest
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

    def test_signals_remove_only_owned_partial_export_release_lock_and_allow_retry(self):
        for caught_signal in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            with self.subTest(signal=caught_signal), tempfile.TemporaryDirectory() as temporary:
                directory, source, export, lock = self.fixture(pathlib.Path(temporary))
                original = source.read_bytes(); original_mode = source.stat().st_mode & 0o777
                ready = pathlib.Path(temporary) / "ready"
                code = f"""
import importlib.util,os,pathlib,sys,time
spec=importlib.util.spec_from_file_location('export_under_signal',{str(ROOT / 'holy127_failed_receipt_export.py')!r})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.SOURCE=pathlib.Path({str(source)!r});m.EXPORT=pathlib.Path({str(export)!r});m.LOCK=pathlib.Path({str(lock)!r})
m.OWNER_UID=os.getuid();m.OWNER_GID=os.getgid();m.REQUIRED_EUID=os.getuid()
real_fsync=os.fsync
def wait_in_fsync(fd):
 pathlib.Path({str(ready)!r}).write_text('ready')
 time.sleep(30)
 return real_fsync(fd)
m.os.fsync=wait_in_fsync
previous={{s:m.signal.signal(s,lambda signum,frame: (_ for _ in ()).throw(m.ExportInterrupted(f'interrupted by signal {{signum}}'))) for s in m.CAUGHT_SIGNALS}}
try: raise SystemExit(m.main())
except Exception as error: print(error,file=sys.stderr);raise SystemExit(1)
finally:
 for s,h in previous.items():m.signal.signal(s,h)
"""
                process = subprocess.Popen([sys.executable, "-c", code])
                for _ in range(200):
                    if ready.exists(): break
                    if process.poll() is not None: self.fail("exporter exited before interruption point")
                    import time; time.sleep(0.01)
                self.assertTrue(ready.exists())
                process.send_signal(caught_signal); process.wait(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(source.read_bytes(), original); self.assertEqual(source.stat().st_mode & 0o777, original_mode)
                self.assertFalse(export.exists())
                descriptor = os.open(lock, os.O_RDWR)
                try: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally: os.close(descriptor)
                patches = self.patches(exporter,directory,source,export,lock)
                with patches[0],patches[1],patches[2],patches[3],patches[4],patches[5],mock.patch.object(sys,"argv",["exporter"]): self.assertEqual(exporter.main(),0)
                self.assertEqual(export.read_bytes(), original)

    def test_failed_write_does_not_remove_preexisting_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, source, export, lock = self.fixture(pathlib.Path(temporary)); export.write_bytes(b"unrelated"); export.chmod(0o444)
            patches = self.patches(exporter,directory,source,export,lock)
            with patches[0],patches[1],patches[2],patches[3],patches[4],patches[5],mock.patch.object(sys,"argv",["exporter"]),self.assertRaises(FileExistsError): exporter.main()
            self.assertEqual(export.read_bytes(), b"unrelated")

if __name__=="__main__": unittest.main()
