#!/usr/bin/env python3
"""Fixed, disposable-only HOLY-127 Docker/PostgreSQL staging qualification.

This helper accepts no resource names, images, paths, commands, or capacity
arguments. It is intended to be hash-pinned behind a narrow operator wrapper.
"""
from __future__ import annotations

import json
import os
import selectors
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from collections.abc import Callable

from holy127_backup_orchestrator import run as run_backup
from hs_release_guard import ReleaseGuard

SOURCE = "f4f5a94fb16380021b501ab1da85e888994c0172"
OP = "holy127-q-f4f5a94-20261029a"
IMAGE = "postgres:18-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc"
NETWORK = OP + "-net"
CONTAINER = OP + "-db"
BASE = Path("/var/tmp") / OP
LOCK = Path("/run/lock/holy-sheet-release/release.lock")
HOST_BUDGET = 384 * 1024 * 1024
MEMORY_REQUIRED = 384 * 1024 * 1024
DUMP_LIMIT = 64 * 1024 * 1024
LIVE_COMPOSE = ("docker", "compose", "--env-file", "/opt/holy-sheet-staging/app/.env.staging", "-f", "/opt/holy-sheet-staging/app/compose.staging.json")
TERMINATED = False


class QualificationFailure(RuntimeError):
    pass


def interrupted(_signum: int, _frame: object) -> None:
    global TERMINATED
    TERMINATED = True
    raise InterruptedError("qualification terminated")


def bounded_result(command: tuple[str, ...], *, timeout: int = 30, limit: int = 1024 * 1024) -> tuple[int, bytes]:
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    output = bytearray()
    selector: selectors.BaseSelector | None = None
    deadline = time.monotonic() + timeout
    try:
        selector = selectors.DefaultSelector()
        assert process.stdout is not None and process.stderr is not None
        selector.register(process.stdout, selectors.EVENT_READ)
        selector.register(process.stderr, selectors.EVENT_READ)
        while selector.get_map():
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("fixed command timed out")
            for key, _ in selector.select(min(left, .25)):
                chunk = os.read(key.fileobj.fileno(), min(65536, limit - len(output) + 1))
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output.extend(chunk)
                if len(output) > limit:
                    raise QualificationFailure("bounded command output exceeded limit")
        code = process.wait(timeout=max(1, int(deadline - time.monotonic())))
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            try:
                process.kill()
            except OSError:
                pass
        process.wait()
        raise
    finally:
        if selector is not None:
            selector.close()
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()
    return code, bytes(output)


def checked_capture(command: tuple[str, ...], *, timeout: int = 30, limit: int = 1024 * 1024, allowed: tuple[int, ...] = (0,)) -> bytes:
    code, output = bounded_result(command, timeout=timeout, limit=limit)
    if code not in allowed:
        raise QualificationFailure("fixed command failed: " + command[1])
    return output


def docker_json(*arguments: str) -> object:
    raw = checked_capture(("docker", *arguments), limit=2 * 1024 * 1024)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise QualificationFailure("docker returned invalid JSON") from error


def inspect_state(kind: str, name: str) -> str:
    code, output = bounded_result(("docker", kind, "inspect", name), timeout=10, limit=65536)
    if code == 0:
        return "present"
    error = output.decode("utf-8", "replace")
    if code == 1 and ("No such" in error or "not found" in error.lower()):
        return "absent"
    raise QualificationFailure("resource absence could not be proven")


def absent(kind: str, name: str) -> bool:
    return inspect_state(kind, name) == "absent"


def claim_labeled(kind: str, name: str) -> bool:
    if inspect_state(kind, name) == "absent":
        return False
    data = docker_json(kind, "inspect", name)
    item = data[0]
    labels = (item.get("Config") or {}).get("Labels") if kind == "container" else item.get("Labels")
    if not isinstance(labels, dict) or labels.get("holy127.operation") != OP:
        raise QualificationFailure("created resource ownership could not be proven")
    return True


def reconcile_labeled(kind: str, name: str) -> bool:
    last: BaseException | None = None
    for _ in range(3):
        try:
            return claim_labeled(kind, name)
        except Exception as error:
            last = error
            time.sleep(.2)
    raise QualificationFailure("created resource ownership remained unknown") from last


def require_image() -> str:
    data = docker_json("image", "inspect", IMAGE)
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        raise QualificationFailure("pinned image inspection was not singular")
    item = data[0]
    config = item.get("Config") or {}
    env = config.get("Env") or []
    volumes = config.get("Volumes") or {}
    entrypoint = config.get("Entrypoint") or []
    digests = item.get("RepoDigests") or []
    expected_digest = IMAGE.split("@", 1)[1]
    if not any(str(value).endswith("@" + expected_digest) for value in digests):
        raise QualificationFailure("local image digest does not match pinned digest")
    if "PGDATA=/var/lib/postgresql/18/docker" not in env:
        raise QualificationFailure("pinned image PGDATA changed")
    if set(volumes) != {"/var/lib/postgresql"}:
        raise QualificationFailure("pinned image volume declaration changed")
    if entrypoint != ["docker-entrypoint.sh"]:
        raise QualificationFailure("pinned image entrypoint changed")
    image_id = item.get("Id")
    if not isinstance(image_id, str) or not image_id.startswith("sha256:"):
        raise QualificationFailure("pinned image ID is invalid")
    return image_id


def memory_available() -> int:
    values: dict[str, int] = {}
    for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
        key, value, *_ = line.replace(":", "").split()
        values[key] = int(value) * 1024
    return values.get("MemAvailable", 0)


def live_ids() -> list[str]:
    raw = checked_capture((*LIVE_COMPOSE, "ps", "-aq"), limit=65536)
    return sorted(value for value in raw.decode("ascii").splitlines() if value)


def create_private_base() -> None:
    BASE.mkdir(mode=0o700, parents=False, exist_ok=False)
    if BASE.is_symlink() or BASE.stat().st_uid != os.geteuid() or BASE.stat().st_mode & 0o077:
        raise QualificationFailure("receipt directory is not private and owned")


def create_resources(password: str, owned: dict[str, bool]) -> None:
    if not absent("network", NETWORK) or not absent("container", CONTAINER) or BASE.exists():
        raise QualificationFailure("disposable resource collision")
    create_private_base()
    owned["base"] = True
    owned["network_attempted"] = True
    try:
        checked_capture(("docker", "network", "create", "--internal", "--label", f"holy127.operation={OP}", NETWORK))
    finally:
        owned["network"] = reconcile_labeled("network", NETWORK)
    owned["container_attempted"] = True
    try:
        checked_capture((
            "docker", "run", "-d", "--pull=never", "--name", CONTAINER,
            "--network", NETWORK, "--label", f"holy127.operation={OP}",
            "--read-only", "--log-driver=none",
            "--tmpfs", "/var/lib/postgresql:rw,size=128m",
            "--tmpfs", "/tmp:rw,size=32m",
            "--tmpfs", "/var/run/postgresql:rw,size=16m",
            "--memory=256m", "--memory-swap=256m", "--pids-limit=128",
            "--security-opt=no-new-privileges",
            "--env", "PGDATA=/var/lib/postgresql/18/docker",
            "--env", "POSTGRES_DB=holy127_fixture",
            "--env", "POSTGRES_USER=holy127",
            "--env", "POSTGRES_PASSWORD=" + password,
            IMAGE,
        ), timeout=60)
    finally:
        owned["container"] = reconcile_labeled("container", CONTAINER)


def require_mounts_and_image(image_id: str) -> None:
    data = docker_json("container", "inspect", CONTAINER)
    item = data[0]
    if item.get("Image") != image_id:
        raise QualificationFailure("container image identity changed")
    mounts = item.get("Mounts") or []
    if any(value.get("Type") in {"volume", "bind"} for value in mounts):
        raise QualificationFailure("container acquired a volume or bind mount")
    host_config = item.get("HostConfig") or {}
    tmpfs = host_config.get("Tmpfs") or {}
    if set(tmpfs) != {"/var/lib/postgresql", "/tmp", "/var/run/postgresql"}:
        raise QualificationFailure("container tmpfs set changed")
    config_env = item.get("Config", {}).get("Env") or []
    if "PGDATA=/var/lib/postgresql/18/docker" not in config_env:
        raise QualificationFailure("container PGDATA changed")


def sql(statement: str, *, database: str = "holy127_fixture", timeout: int = 30) -> str:
    raw = checked_capture(("docker", "exec", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "holy127", "-d", database, "-Atc", statement), timeout=timeout)
    return raw.decode("utf-8").strip()


def wait_ready() -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = subprocess.run(("docker", "exec", CONTAINER, "pg_isready", "-U", "holy127", "-d", "holy127_fixture"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        if result.returncode == 0:
            return
        time.sleep(.25)
    raise QualificationFailure("disposable PostgreSQL did not become ready")


def seed() -> int:
    sql("CREATE TABLE holy127_fixture(id integer PRIMARY KEY, payload text NOT NULL); INSERT INTO holy127_fixture SELECT i, md5(i::text) FROM generate_series(1,100000) AS i; CHECKPOINT;")
    size = int(sql("SELECT pg_database_size(current_database())"))
    if size > 64 * 1024 * 1024:
        raise QualificationFailure("synthetic database exceeded 64 MiB")
    return size


def producer(app_name: str) -> tuple[str, ...]:
    return ("docker", "exec", "-e", "PGAPPNAME=" + app_name, CONTAINER, "pg_dump", "-U", "holy127", "-d", "holy127_fixture", "-Fc")


def verifier() -> tuple[str, ...]:
    return ("docker", "exec", "-i", CONTAINER, "pg_restore", "--list")


def backend_count(app_name: str) -> int:
    return int(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='" + app_name + "'"))


def terminate_backend(app_name: str) -> None:
    sql("SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name='" + app_name + "'")


def lock_table() -> subprocess.Popen[bytes]:
    command = ("docker", "exec", "-e", "PGAPPNAME=holy127-locker", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "holy127", "-d", "holy127_fixture", "-Atc", "BEGIN; LOCK TABLE holy127_fixture IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(120)")
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        granted = sql("SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='holy127-locker' AND l.relation='holy127_fixture'::regclass AND l.mode='AccessExclusiveLock' AND l.granted")
        if granted == "1":
            return process
        time.sleep(.1)
    process.terminate()
    raise QualificationFailure("fixture lock was not acquired")


def require_cancelled(app_name: str) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if backend_count(app_name) == 0:
            return
        time.sleep(.1)
    terminate_backend(app_name)
    raise QualificationFailure("Docker exec cancellation left a PostgreSQL backend")


def dump_is_waiting(app_name: str) -> bool:
    return sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='" + app_name + "' AND wait_event_type='Lock'") == "1"


def host_command_count(app_name: str) -> int:
    raw = checked_capture(("pgrep", "-f", "PGAPPNAME=" + app_name), timeout=5, limit=65536, allowed=(0, 1))
    return len([line for line in raw.decode("ascii").splitlines() if line])


def container_pg_dump_count() -> int:
    raw = checked_capture(("docker", "top", CONTAINER, "-eo", "args"), timeout=10, limit=65536)
    return sum(1 for line in raw.decode("utf-8", "replace").splitlines()[1:] if "pg_dump" in line)


def resource_snapshot() -> dict[str, object]:
    inspected = docker_json("container", "inspect", "--size", CONTAINER)[0]
    raw = checked_capture(("docker", "stats", "--no-stream", "--format", "{{json .}}", CONTAINER), timeout=10, limit=65536)
    try:
        stats = json.loads(raw)
    except json.JSONDecodeError as error:
        raise QualificationFailure("docker stats returned invalid JSON") from error
    return {"sizeRwBytes": inspected.get("SizeRw"), "memory": stats.get("MemUsage"), "pids": stats.get("PIDs"), "blockIO": stats.get("BlockIO")}


def backup_child(app_name: str, timeout: int) -> subprocess.Popen[bytes]:
    code = (
        "import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);"
        "import holy127_backup_orchestrator as b;"
        "b.run(Path(sys.argv[2]),tuple(json.loads(sys.argv[3])),tuple(json.loads(sys.argv[4])),int(sys.argv[5]),int(sys.argv[6]))"
    )
    return subprocess.Popen((sys.executable, "-c", code, str(Path(__file__).parent), str(BASE), json.dumps(producer(app_name)), json.dumps(verifier()), str(DUMP_LIMIT), str(timeout)), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def wait_for_blocked_dump(app_name: str, child: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise QualificationFailure("pg_dump exited before lock wait proof")
        if backend_count(app_name) == 1 and dump_is_waiting(app_name):
            return
        time.sleep(.1)
    raise QualificationFailure("pg_dump lock wait was not proven")


def require_host_absent(app_name: str) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if host_command_count(app_name) == 0:
            return
        time.sleep(.1)
    raise QualificationFailure("host Docker exec process survived cancellation")


def require_container_absent() -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if container_pg_dump_count() == 0:
            return
        time.sleep(.1)
    raise QualificationFailure("container pg_dump process survived cancellation")


def timeout_probe(on_blocked: Callable[[], None] | None = None) -> None:
    app_name = "holy127-dump-timeout"
    locker = lock_table()
    child = backup_child(app_name, 2)
    try:
        wait_for_blocked_dump(app_name, child)
        if on_blocked is not None:
            on_blocked()
        child.wait(timeout=10)
        if child.returncode == 0:
            raise QualificationFailure("blocked pg_dump did not time out")
        require_cancelled(app_name)
        require_host_absent(app_name)
        require_container_absent()
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        terminate_backend("holy127-locker")
        locker.wait(timeout=10)


def sigterm_probe(on_blocked: Callable[[], None] | None = None) -> None:
    app_name = "holy127-dump-sigterm"
    locker = lock_table()
    child = backup_child(app_name, 30)
    try:
        wait_for_blocked_dump(app_name, child)
        if on_blocked is not None:
            on_blocked()
        child.send_signal(signal.SIGTERM)
        child.wait(timeout=10)
        if child.returncode == 0:
            raise QualificationFailure("SIGTERM probe unexpectedly succeeded")
        require_cancelled(app_name)
        require_host_absent(app_name)
        require_container_absent()
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        terminate_backend("holy127-locker")
        locker.wait(timeout=10)


def cleanup(owned: dict[str, bool], *, preserve_receipt: bool) -> None:
    failure: BaseException | None = None
    if owned["container"]:
        try:
            subprocess.run(("docker", "container", "rm", "-f", CONTAINER), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
        except BaseException as error:
            failure = error
    if owned["network"]:
        try:
            subprocess.run(("docker", "network", "rm", NETWORK), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
        except BaseException as error:
            failure = error
    if owned["base"] and not preserve_receipt:
        for name in ("qualification.json",):
            try:
                (BASE / name).unlink()
            except FileNotFoundError:
                pass
        for path in BASE.iterdir():
            if path.name.startswith(".holy127-") or path.name.startswith("holy-sheet-"):
                path.unlink()
            else:
                raise QualificationFailure("unexpected file prevented receipt cleanup")
        BASE.rmdir()
    if failure is not None:
        raise QualificationFailure("disposable cleanup command failed") from failure


def write_receipt(data: dict[str, object]) -> None:
    encoded = (json.dumps(data, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(encoded) > 65536:
        raise QualificationFailure("receipt exceeded 64 KiB")
    path = BASE / "qualification.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(encoded)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("receipt write made no progress")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def run() -> dict[str, object]:
    global TERMINATED
    TERMINATED = False
    if memory_available() < MEMORY_REQUIRED:
        raise QualificationFailure("available memory is below 384 MiB")
    before = live_ids()
    image_id = require_image()
    password = secrets.token_urlsafe(32)
    old_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        with ReleaseGuard(environment="staging", source=SOURCE, peak_budget_bytes=HOST_BUDGET, paths=[BASE], lock_path=LOCK) as guard:
            owned = {"base": False, "network": False, "container": False, "network_attempted": False, "container_attempted": False}
            evidence: list[dict[str, object]] = []
            failure: BaseException | None = None
            database_bytes = 0
            baseline_bytes = 0
            try:
                evidence.append({"capacity": guard.check("disposable-create"), "memoryAvailableBytes": memory_available()})
                create_resources(password, owned)
                require_mounts_and_image(image_id)
                wait_ready()
                database_bytes = seed()
                evidence.append({"capacity": guard.check("after-seed"), "memoryAvailableBytes": memory_available()})
                final, receipt = run_backup(BASE, producer("holy127-dump-baseline"), verifier(), DUMP_LIMIT, 30)
                baseline_bytes = final.stat().st_size
                final.unlink()
                receipt.unlink()
                evidence.append({"capacity": guard.check("before-timeout"), "memoryAvailableBytes": memory_available()})
                timeout_probe(lambda: evidence.append({"capacity": guard.check("timeout-peak"), "memoryAvailableBytes": memory_available(), "container": resource_snapshot(), "lockWaitProven": True}))
                evidence.append({"phase": "timeout", "backendAbsent": backend_count("holy127-dump-timeout") == 0, "hostCommandAbsent": host_command_count("holy127-dump-timeout") == 0, "containerPgDumpAbsent": container_pg_dump_count() == 0})
                evidence.append({"capacity": guard.check("before-sigterm"), "memoryAvailableBytes": memory_available()})
                sigterm_probe(lambda: evidence.append({"capacity": guard.check("sigterm-peak"), "memoryAvailableBytes": memory_available(), "container": resource_snapshot(), "lockWaitProven": True}))
                evidence.append({"phase": "sigterm", "backendAbsent": backend_count("holy127-dump-sigterm") == 0, "hostCommandAbsent": host_command_count("holy127-dump-sigterm") == 0, "containerPgDumpAbsent": container_pg_dump_count() == 0})
            except BaseException as error:
                failure = error
            finally:
                cleanup_signal = signal.signal(signal.SIGTERM, signal.SIG_IGN)
                try:
                    cleanup(owned, preserve_receipt=True)
                    container_absent = not owned["container_attempted"] or absent("container", CONTAINER)
                    network_absent = not owned["network_attempted"] or absent("network", NETWORK)
                    live_unchanged = live_ids() == before
                    evidence.append({"capacity": guard.check("post-cleanup"), "memoryAvailableBytes": memory_available(), "containerAbsent": container_absent, "networkAbsent": network_absent, "liveIdsUnchanged": live_unchanged})
                    if not container_absent or not network_absent or not live_unchanged:
                        raise QualificationFailure("post-cleanup resource proof failed")
                except BaseException as cleanup_error:
                    failure = cleanup_error
                finally:
                    signal.signal(signal.SIGTERM, cleanup_signal)
            result = {"operation": OP, "source": SOURCE, "imageId": image_id, "databaseBytes": database_bytes, "baselineBytes": baseline_bytes, "evidence": evidence, "receiptDirectoryRetained": True, "retentionPurpose": "operator-collection-before-fixed-directory-removal", "status": "failed" if failure else "passed"}
            if failure is not None:
                result["error"] = str(failure)
            if owned["base"]:
                write_receipt(result)
            if failure is not None:
                raise failure
            return result
    finally:
        signal.signal(signal.SIGTERM, old_term)


if __name__ == "__main__":
    try:
        print(json.dumps(run(), sort_keys=True))
    except Exception as error:
        print(json.dumps({"operation": OP, "status": "failed", "error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
