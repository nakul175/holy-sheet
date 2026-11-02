import os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
import holy127_backup_orchestrator as b

class BackupOrchestratorTest(unittest.TestCase):
 def folder(self):
  t=tempfile.TemporaryDirectory();p=Path(t.name);os.chmod(p,0o700);return t,p
 def test_success_is_verified_private_and_no_prune(self):
  t,p=self.folder();old=p/'old.dump';old.write_bytes(b'old')
  with t:
   final,receipt=b.run(p,(sys.executable,'-c','import sys;sys.stdout.buffer.write(b"dump")'),(sys.executable,'-c','import sys;sys.stdin.buffer.read()'),64,5)
   self.assertEqual(final.read_bytes(),b'dump');self.assertTrue(receipt.exists());self.assertEqual(old.read_bytes(),b'old');self.assertEqual(final.stat().st_mode&0o777,0o600)
 def test_producer_failure_publishes_nothing(self):
  t,p=self.folder()
  with t:
   with self.assertRaisesRegex(RuntimeError,'producer failed'): b.run(p,(sys.executable,'-c','import sys;sys.stdout.write("x");sys.exit(4)'),(sys.executable,'-c','pass'),64,5)
   self.assertEqual(list(p.iterdir()),[])
 def test_limit_terminates_producer_and_publishes_nothing(self):
  t,p=self.folder()
  with t:
   with self.assertRaisesRegex(RuntimeError,'hard byte limit'): b.run(p,(sys.executable,'-c','import sys,time;sys.stdout.write("x"*1000);sys.stdout.flush();time.sleep(30)'),(sys.executable,'-c','pass'),8,5)
   self.assertEqual(list(p.iterdir()),[])
 def test_timeout_terminates_stalled_producer(self):
  t,p=self.folder()
  with t:
   with self.assertRaises(TimeoutError): b.run(p,(sys.executable,'-c','import time;time.sleep(30)'),(sys.executable,'-c','pass'),64,1)
   self.assertEqual(list(p.iterdir()),[])
 def test_verification_failure_publishes_nothing(self):
  t,p=self.folder()
  with t:
   with self.assertRaisesRegex(RuntimeError,'listing failed'): b.run(p,(sys.executable,'-c','print("dump",end="")'),(sys.executable,'-c','import sys;sys.exit(3)'),64,5)
   self.assertEqual(list(p.iterdir()),[])
 def test_existing_files_are_never_replaced(self):
  t,p=self.folder();existing=p/'fixed.dump';existing.write_bytes(b'keep');pending=p/'pending';fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(fd,b'x');inode=os.fstat(fd).st_ino;os.close(fd)
  with t:
   with self.assertRaises(FileExistsError): b.publish_no_replace(pending,existing,inode)
   self.assertEqual(existing.read_bytes(),b'keep');self.assertEqual(pending.read_bytes(),b'x')
 def test_short_writes_are_completed(self):
  read,write=os.pipe();real=os.write
  try:
   with patch.object(b.os,'write',side_effect=lambda fd,data:real(fd,bytes(data[:1]))): b.write_all(write,b'abcd')
   os.close(write);write=-1;self.assertEqual(os.read(read,4),b'abcd')
  finally:
   os.close(read)
   if write>=0:os.close(write)
 def test_fsync_failure_removes_pending(self):
  t,p=self.folder()
  with t:
   with patch.object(b.os,'fsync',side_effect=[OSError('disk full'),None]):
    with self.assertRaisesRegex(OSError,'disk full'): b.run(p,(sys.executable,'-c','print("dump",end="")'),(sys.executable,'-c','pass'),64,5)
   self.assertEqual(list(p.iterdir()),[])
 def test_post_link_directory_fsync_failure_leaves_no_final(self):
  t,p=self.folder();pending=p/'pending';pending.write_bytes(b'x');os.chmod(pending,0o600);inode=pending.stat().st_ino
  with t:
   with patch.object(b,'fsync_dir',side_effect=OSError('dir fsync')):
    with self.assertRaisesRegex(OSError,'dir fsync'): b.publish_no_replace(pending,p/'final.dump',inode)
   self.assertEqual(list(p.iterdir()),[])
 def test_receipt_write_failure_removes_published_dump(self):
  t,p=self.folder();real=b.write_all
  with t:
   with patch.object(b,'write_all',side_effect=lambda fd,data:(_ for _ in ()).throw(OSError('receipt full')) if bytes(data).startswith(b'{') else real(fd,data)):
    with self.assertRaisesRegex(OSError,'receipt full'): b.run(p,(sys.executable,'-c','print("dump",end="")'),(sys.executable,'-c','pass'),64,5)
   self.assertEqual(list(p.iterdir()),[])
 def test_whole_operation_pending_collision_stops_producer_and_preserves_file(self):
  t,p=self.folder();op='a'*32;collision=p/f'.holy127-{op}.pending';collision.write_bytes(b'keep');os.chmod(collision,0o600);started=time.monotonic()
  with t,patch.object(b.secrets,'token_hex',return_value=op):
   with self.assertRaises(FileExistsError): b.run(p,(sys.executable,'-c','import time;time.sleep(20)'),(sys.executable,'-c','pass'),64,5)
   self.assertLess(time.monotonic()-started,7);self.assertEqual(collision.read_bytes(),b'keep')
 def test_actual_sigterm_cleans_owned_pending_and_producer(self):
  t,p=self.folder()
  code='import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import holy127_backup_orchestrator as b;b.run(Path(sys.argv[2]),(sys.executable,"-c","import sys,time;sys.stdout.write(\\"x\\");sys.stdout.flush();time.sleep(20)"),(sys.executable,"-c","pass"),64,30)'
  with t:
   child=subprocess.Popen((sys.executable,'-c',code,str(Path(__file__).parent),str(p)),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   time.sleep(.5);child.terminate();child.wait(8)
   self.assertNotEqual(child.returncode,0);self.assertEqual(list(p.iterdir()),[])
 def test_actual_sigterm_during_verification_never_publishes(self):
  t,p=self.folder();marker=p/'verifying'
  code='import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import holy127_backup_orchestrator as b;b.run(Path(sys.argv[2]),(sys.executable,"-c","print(\\"dump\\",end=\\"\\")"),(sys.executable,"-c",f"from pathlib import Path;import time;Path({str(marker)!r}).write_text(\\"x\\");time.sleep(20)"),64,30)'
  with t:
   child=subprocess.Popen((sys.executable,'-c',code,str(Path(__file__).parent),str(p)),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   for _ in range(50):
    if marker.exists():break
    time.sleep(.05)
   child.terminate();child.wait(8)
   self.assertNotEqual(child.returncode,0);self.assertFalse(any(p.glob('*.dump')))
 def test_selector_setup_failure_cleans_pending_and_producer(self):
  t,p=self.folder()
  with t,patch.object(b.selectors.DefaultSelector,'register',side_effect=OSError('selector failed')):
   with self.assertRaisesRegex(OSError,'selector failed'):b.run(p,(sys.executable,'-c','import time;time.sleep(20)'),(sys.executable,'-c','pass'),64,5)
   self.assertEqual(list(p.iterdir()),[])
 def test_fstat_setup_failure_cleans_created_pending_and_producer(self):
  t,p=self.folder();real=b.os.fstat;calls=0
  def fail_first(fd):
   nonlocal calls;calls+=1
   if calls==1:raise OSError('fstat failed')
   return real(fd)
  with t,patch.object(b.os,'fstat',side_effect=fail_first):
   with self.assertRaisesRegex(OSError,'fstat failed'):b.run(p,(sys.executable,'-c','import time;time.sleep(20)'),(sys.executable,'-c','pass'),64,5)
   self.assertEqual(list(p.iterdir()),[])
 def test_exited_leader_does_not_leave_descendant(self):
  t,p=self.folder();pidfile=p/'child.pid'
  code='import subprocess,sys;child=subprocess.Popen((sys.executable,"-c","import time;time.sleep(20)"));open(sys.argv[1],"w").write(str(child.pid));print("dump",end="")'
  with t:
   final,_=b.run(p,(sys.executable,'-c',code,str(pidfile)),(sys.executable,'-c','pass'),64,5);pid=int(pidfile.read_text())
   with self.assertRaises(ProcessLookupError):os.kill(pid,0)
   self.assertTrue(final.exists())
if __name__=='__main__':unittest.main()
