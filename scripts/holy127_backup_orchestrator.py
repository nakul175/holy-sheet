#!/usr/bin/env python3
"""Review candidate: fixed, capped, no-prune Holy Sheet staging backup."""
from __future__ import annotations
import hashlib,json,os,secrets,selectors,signal,stat,subprocess,sys,threading,time
from pathlib import Path

APP=Path('/opt/holy-sheet-staging/app'); BACKUPS=Path('/opt/holy-sheet-staging/backups')
LIMIT=160*1024*1024; TIMEOUT=900
COMPOSE=('docker','compose','--env-file',str(APP/'.env.staging'),'-f',str(APP/'compose.staging.json'))
PRODUCER=COMPOSE+('exec','-T','database','pg_dump','-U','holy_sheet','-d','holy_sheet','-Fc')
VERIFY=COMPOSE+('exec','-T','database','pg_restore','--list')
TERMINATED=False

def private_dir(path:Path):
 st=os.lstat(path)
 if not path.is_absolute() or not path.is_dir() or os.path.islink(path) or st.st_uid!=os.geteuid() or st.st_mode&0o077: raise RuntimeError('backup directory is not private and owned')
def fsync_dir(path:Path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try: os.fsync(fd)
 finally: os.close(fd)
def owned_unlink(path:Path,inode:int|None):
 try:
  if inode is not None and os.lstat(path).st_ino==inode and not os.path.islink(path): path.unlink()
 except FileNotFoundError: pass
def stop(proc:subprocess.Popen):
 try: os.killpg(proc.pid,signal.SIGTERM)
 except OSError: pass
 try: proc.wait(5)
 except subprocess.TimeoutExpired:
  try: os.killpg(proc.pid,signal.SIGKILL)
  except OSError: pass
  proc.wait()
def write_all(fd:int,data:bytes):
 view=memoryview(data)
 while view:
  count=os.write(fd,view)
  if count<=0: raise OSError('short write made no progress')
  view=view[count:]
def interrupted(_signum,_frame):
 global TERMINATED
 TERMINATED=True
def check_terminated():
 if TERMINATED: raise InterruptedError('operation terminated')
def copy_process(proc:subprocess.Popen,pending:Path,limit:int,timeout:int):
 fd=None;inode=None;created=False;sel=None;size=0;digest=hashlib.sha256();deadline=time.monotonic()+timeout
 try:
  fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);created=True;inode=os.fstat(fd).st_ino;sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ)
  while True:
   check_terminated()
   left=deadline-time.monotonic()
   if left<=0: raise TimeoutError('backup producer timed out')
   if not sel.select(min(left,1)):
    if proc.poll() is not None: break
    continue
   chunk=os.read(proc.stdout.fileno(),min(1024*1024,limit-size+1))
   if not chunk: break
   if size+len(chunk)>limit: raise RuntimeError('backup exceeded hard byte limit')
   write_all(fd,chunk);digest.update(chunk);size+=len(chunk)
  os.fsync(fd)
  if not size: raise RuntimeError('backup was empty')
  code=proc.wait(timeout=max(1,int(deadline-time.monotonic())))
  if code: raise RuntimeError('backup producer failed')
  stop(proc)
  return inode,size,digest.hexdigest()
 except BaseException:
  stop(proc)
  if inode is not None: owned_unlink(pending,inode)
  elif created:
   try:
    st=os.lstat(pending)
    if stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and not os.path.islink(pending): pending.unlink()
   except FileNotFoundError: pass
  raise
 finally:
  if sel is not None: sel.close()
  if fd is not None: os.close(fd)
def publish_no_replace(pending:Path,final:Path,inode:int):
 linked=False
 try:
  os.link(pending,final,follow_symlinks=False);linked=True
  if os.lstat(final).st_ino!=inode: raise RuntimeError('publication inode changed')
  pending.unlink();fsync_dir(final.parent)
 except BaseException:
  if linked: owned_unlink(final,inode)
  raise
def verified_fd(path:Path,inode:int):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW);st=os.fstat(fd)
 if st.st_ino!=inode or not stat.S_ISREG(st.st_mode) or st.st_uid!=os.geteuid() or st.st_mode&0o077:
  os.close(fd);raise RuntimeError('pending backup identity changed')
 return fd
def verify_toc(command:tuple[str,...],pending:Path,inode:int,timeout:int):
 fd=verified_fd(pending,inode);proc=None
 try:
  proc=subprocess.Popen(command,stdin=fd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  deadline=time.monotonic()+timeout
  while proc.poll() is None:
   check_terminated()
   if time.monotonic()>=deadline: stop(proc);raise TimeoutError('pg_restore listing timed out')
   time.sleep(.05)
  code=proc.returncode
  if code: raise RuntimeError('pg_restore listing failed')
 finally:
  os.close(fd)
  if proc is not None: stop(proc)
def run(base:Path=BACKUPS,producer=PRODUCER,verify=VERIFY,limit:int=LIMIT,timeout:int=TIMEOUT):
 global TERMINATED
 TERMINATED=False
 private_dir(base);op=secrets.token_hex(16);pending=base/f'.holy127-{op}.pending';final=base/f'holy-sheet-{op}.dump';receipt=base/f'holy-sheet-{op}.receipt.json';rinode=None;finode=None
 proc=subprocess.Popen(producer,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
 prior=None
 try:
  if threading.current_thread() is threading.main_thread():
   prior=signal.getsignal(signal.SIGTERM);signal.signal(signal.SIGTERM,interrupted)
  inode,size,digest=copy_process(proc,pending,limit,timeout)
  check_terminated()
  verify_toc(verify,pending,inode,timeout)
  check_terminated()
  publish_no_replace(pending,final,inode);finode=inode
  check_terminated()
  data=json.dumps({'bytes':size,'operation':op,'sha256':digest,'status':'toc-listed'},sort_keys=True,separators=(',',':')).encode()+b'\n'
  rfd=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);rinode=os.fstat(rfd).st_ino
  try: write_all(rfd,data);os.fsync(rfd)
  finally: os.close(rfd)
  check_terminated();fsync_dir(base);check_terminated();return final,receipt
 except BaseException:
  stop(proc);owned_unlink(pending,locals().get('inode'));owned_unlink(final,finode);owned_unlink(receipt,rinode);fsync_dir(base);raise
 finally:
  stop(proc)
  if proc.stdout: proc.stdout.close()
  if prior is not None: signal.signal(signal.SIGTERM,prior)
if __name__=='__main__':
 try:
  final,receipt=run();print(json.dumps({'backup':final.name,'receipt':receipt.name,'status':'toc-listed'}))
 except Exception as error:
  print(f'backup failed: {error}',file=sys.stderr);raise SystemExit(1)
