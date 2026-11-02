#!/usr/bin/python3
"""Remove only a byte-matched exported and original HOLY-127 failed receipt."""
import fcntl, hashlib, json, os, pathlib, stat, sys

DIRECTORY = pathlib.Path("/var/tmp/holy127-q-f4f5a94-20261029a")
SOURCE = DIRECTORY / "qualification.json"
EXPORT = pathlib.Path("/var/tmp/holy127-failed-receipt-export-20261029a.json")
LOCK = pathlib.Path("/run/holy-sheet-release/release.lock")
OWNER_UID = 0
OWNER_GID = 0
REQUIRED_EUID = 0

def regular(path, mode):
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != OWNER_UID or metadata.st_gid != OWNER_GID or stat.S_IMODE(metadata.st_mode) != mode:
        raise RuntimeError(f"unsafe identity: {path}")

def main():
    if len(sys.argv) != 1 or os.getuid() != REQUIRED_EUID: return 64
    regular(LOCK, 0o660); descriptor = os.open(LOCK, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        regular(SOURCE, 0o600); regular(EXPORT, 0o444)
        source = SOURCE.read_bytes(); exported = EXPORT.read_bytes()
        parsed = json.loads(source)
        if not source or source != exported or parsed.get("operation") != "holy127-q-f4f5a94-20261029a" or parsed.get("status") != "failed": raise RuntimeError("receipt/export mismatch")
        names = [path.name for path in DIRECTORY.iterdir()]
        if names != ["qualification.json"]: raise RuntimeError("unexpected receipt directory entry")
        digest = hashlib.sha256(source).hexdigest()
        EXPORT.unlink(); SOURCE.unlink(); DIRECTORY.rmdir()
        print(json.dumps({"bytes": len(source), "sha256": digest, "status": "cleaned"}, sort_keys=True))
        return 0
    finally: os.close(descriptor)

if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exception as error: print(f"HOLY-127 receipt cleanup refused: {error}", file=sys.stderr); raise SystemExit(1)
