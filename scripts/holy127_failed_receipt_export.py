#!/usr/bin/python3
"""Export the one preserved HOLY-127 failed receipt for byte-exact SSH capture."""
import fcntl, hashlib, json, os, pathlib, stat, sys

SOURCE = pathlib.Path("/var/tmp/holy127-q-f4f5a94-20261029a/qualification.json")
EXPORT = pathlib.Path("/var/tmp/holy127-failed-receipt-export-20261029a.json")
LOCK = pathlib.Path("/run/holy-sheet-release/release.lock")
OWNER_UID = 0
OWNER_GID = 0
REQUIRED_EUID = 0

def regular(path, uid, mode):
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != uid or metadata.st_gid != OWNER_GID or stat.S_IMODE(metadata.st_mode) != mode:
        raise RuntimeError(f"unsafe identity: {path}")

def main():
    if len(sys.argv) != 1 or os.getuid() != REQUIRED_EUID: return 64
    regular(LOCK, OWNER_UID, 0o660); descriptor = os.open(LOCK, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        regular(SOURCE, OWNER_UID, 0o600); content = SOURCE.read_bytes()
        if not content or len(content) > 65536: raise RuntimeError("invalid receipt size")
        parsed = json.loads(content)
        if parsed.get("operation") != "holy127-q-f4f5a94-20261029a" or parsed.get("status") != "failed": raise RuntimeError("unexpected receipt identity")
        output = os.open(EXPORT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o444)
        try:
            view = memoryview(content)
            while view:
                count = os.write(output, view)
                if count <= 0: raise OSError("short export write")
                view = view[count:]
            os.fsync(output); os.fchown(output, OWNER_UID, OWNER_GID); os.fchmod(output, 0o444)
        except BaseException:
            os.close(output)
            try: EXPORT.unlink()
            except FileNotFoundError: pass
            raise
        finally:
            try: os.close(output)
            except OSError: pass
        print(json.dumps({"bytes": len(content), "export": str(EXPORT), "sha256": hashlib.sha256(content).hexdigest(), "status": "exported"}, sort_keys=True))
        return 0
    finally: os.close(descriptor)

if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exception as error: print(f"HOLY-127 receipt export refused: {error}", file=sys.stderr); raise SystemExit(1)
