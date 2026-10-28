#!/usr/bin/env python3
"""Copy stdin to one exclusive pending file with a strict byte ceiling."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

CHUNK = 1024 * 1024


def copy_bounded(destination: Path, limit: int) -> dict[str, object]:
    if limit <= 0:
        raise ValueError("limit must be positive")
    digest = hashlib.sha256()
    written = 0
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=True) as output:
            while chunk := sys.stdin.buffer.read(min(CHUNK, limit - written + 1)):
                if written + len(chunk) > limit:
                    raise RuntimeError("backup exceeded the hard byte limit")
                output.write(chunk)
                digest.update(chunk)
                written += len(chunk)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return {"bytes": written, "sha256": digest.hexdigest()}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: holy127_bounded_stream.py LIMIT_BYTES PENDING_PATH", file=sys.stderr)
        return 2
    try:
        receipt = copy_bounded(Path(argv[2]), int(argv[1]))
    except (OSError, RuntimeError, ValueError) as error:
        print(f"bounded stream failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
