"""Runs code in a jail of its own, made with bubblewrap: one per run.

The jail has its own user, PID, network, IPC and UTS namespaces. It runs as an
unprivileged user without capabilities and sees the system read-only, its own
folder with its chat's files (/sandbox, a tmpfs of fixed size), a /tmp of its
own, its chat's packages read-only, and only its own processes. Its network
namespace is empty: no internet, no LAN, not the app and not the other
containers. It gets no environment of the server's, so not its token either.
The runner (../jail/runner.py) starts the code inside and enforces the limits
of a run; this module prepares the run's folder, starts bubblewrap, and reads
back what the code printed and the files it made, changed or deleted.
"""

import asyncio
import base64
import functools
import json
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

RUNS_DIR = Path(os.environ.get("CODE_RUNS_DIR", "/tmp/runs"))
RUNNER = "/opt/jail/runner.py"

LANGUAGES = ("python", "javascript", "typescript", "shell")


def memory_mb() -> int:
    """The memory of one run, in MB: CODE_RUN_MEMORY_MB (set in .env, see .env.example), or 2048."""
    try:
        value = int(float(os.environ.get("CODE_RUN_MEMORY_MB") or 2048))
    except (ValueError, OverflowError):
        return 2048
    return value if value > 0 else 2048


# Limits of one run
RUN_SECONDS = 120
MEMORY_BYTES = memory_mb() * 1024 * 1024
MAX_PROCESSES = 128
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_FILE_BYTES = 20 * 1024 * 1024
# The app keeps a sandbox to 100 MB; the jail's folder has room for a run to go over, which the app then refuses
SANDBOX_TMPFS_BYTES = 160 * 1024 * 1024
TMP_TMPFS_BYTES = 64 * 1024 * 1024
SHM_TMPFS_BYTES = 16 * 1024 * 1024
MAX_CHANGED_FILES = 1000
# Past the run's own limit: copying the files in and out, and starting up
GRACE_SECONDS = 30

# The environment of the code: nothing of the server's
BASE_ENV = {
    "PATH": "/opt/packages/python/bin:/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    "HOME": "/tmp/home",
    "LANG": "C.UTF-8",
    "TZ": "UTC",
    "TERM": "dumb",
    "PYTHONUNBUFFERED": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
    "MPLBACKEND": "Agg",
    "MPLCONFIGDIR": "/tmp/home/.matplotlib",
    "npm_config_cache": "/tmp/home/.npm",
    "npm_config_update_notifier": "false",
    "npm_config_fund": "false",
    "npm_config_audit": "false",
    "NO_COLOR": "1",
}


# The end of every jail's mounts. The jail's root and /dev are tmpfs that bubblewrap makes without a size,
# so they are read-only, and /dev/shm gets a tmpfs of fixed size instead. The code may not make user
# namespaces of its own: in one it would have every capability, and could mount.
SEAL = [
    "--size", str(SHM_TMPFS_BYTES), "--tmpfs", "/dev/shm",
    "--remount-ro", "/dev",
    "--remount-ro", "/",
    "--unshare-user", "--disable-userns",
]  # fmt: skip


class JailError(Exception):
    """The jail could not be made or did not finish: not something the code did."""


@dataclass
class RunResult:
    status: str  # "ok" | "error" | "timeout" | "stopped"
    exit_code: int | None
    reason: str | None  # why it was stopped: "timeout", "memory", "processes" or "output"
    output: str
    printed_bytes: int
    duration_ms: int
    changed: list[tuple[str, bytes]] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)


def safe_path(path: str) -> str | None:
    """A relative path inside the sandbox, with "/" between its parts, or None."""
    parts = [p for p in path.replace("\\", "/").split("/") if p and p != "."]
    if not parts or any(p == ".." or "\x00" in p for p in parts):
        return None
    return "/".join(parts)


def bwrap_command(packages: dict[str, Path], in_fd: int, out_fd: int) -> list[str]:
    """The bubblewrap command line of a run. `packages` are the chat's package folders that exist; the
    run's in and out folders come as the open directories `in_fd` and `out_fd` (see ../jail/runner.py)."""
    command = [
        "bwrap",
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/sbin", "/sbin",
        "--ro-bind", "/etc", "/etc",
        "--ro-bind", "/opt/jail", "/opt/jail",
        "--dev", "/dev",
        "--proc", "/proc",
        "--size", str(TMP_TMPFS_BYTES), "--tmpfs", "/tmp",
        "--size", str(SANDBOX_TMPFS_BYTES), "--tmpfs", "/sandbox",
    ]
    if Path("/usr/lib64").exists():
        command += ["--symlink", "usr/lib64", "/lib64"]
    if "python" in packages:
        command += ["--ro-bind", str(packages["python"]), "/opt/packages/python"]
    if "node" in packages:
        command += ["--ro-bind", str(packages["node"]), "/node_modules"]
    command += [
        *SEAL,
        "--uid", "1000",
        "--gid", "1000",
        "--chdir", "/sandbox",
        "/usr/local/bin/python3", "-I", "-S", RUNNER, str(in_fd), str(out_fd),
    ]
    return command


def prepare(run_dir: Path, language: str, code: str, files: list[tuple[str, bytes]], core: int, packages: dict, cwd: str = ""):
    """Writes the run's input: the chat's files, the code, and the runner's config. `cwd` is the folder of the
    sandbox the code runs in, a path checked with safe_path ("" for the sandbox folder itself)."""
    files_dir = run_dir / "in" / "files"
    files_dir.mkdir(parents=True)
    for path, data in files:
        target = files_dir / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (run_dir / "in" / "code").write_text(code, encoding="utf-8")
    env = dict(BASE_ENV)
    if "python" in packages:
        env["PYTHONPATH"] = "/opt/packages/python"
    config = {
        "language": language,
        "cwd": cwd,
        "env": env,
        "core": core,
        "limits": {
            "seconds": RUN_SECONDS,
            "memory_bytes": MEMORY_BYTES,
            "max_processes": MAX_PROCESSES,
            "max_output_bytes": MAX_OUTPUT_BYTES,
            "max_file_bytes": MAX_FILE_BYTES,
            "max_files": MAX_CHANGED_FILES,
        },
    }
    (run_dir / "in" / "config.json").write_text(json.dumps(config), encoding="utf-8")


def read_out(out_dir: Path, manifest: dict) -> list[tuple[str, bytes]]:
    """The files the runner copied out, by the paths its manifest names."""
    files = []
    for rel in manifest.get("changed", []):
        path = safe_path(rel)
        if path is None:
            continue
        fd = os.open(out_dir / path, os.O_RDONLY | os.O_NOFOLLOW)
        with open(fd, "rb") as f:
            files.append((path, f.read(MAX_FILE_BYTES + 1)))
    return files


async def run_jail(command, run_dir: Path, seconds: float) -> tuple[dict, bytes]:
    """Starts a jail with `command(in_fd, out_fd)`, the bubblewrap command line for the run's in and out
    folders (`run_dir`/in and /out) as open directories, and waits for it, at most `seconds`. Returns the
    manifest its runner wrote and what it printed (up to MAX_OUTPUT_BYTES). Raises JailError when it wrote none."""
    out_dir = run_dir / "out"
    in_fd = os.open(run_dir / "in", os.O_RDONLY | os.O_DIRECTORY)
    out_fd = os.open(out_dir, os.O_RDONLY | os.O_DIRECTORY)
    try:
        process = await asyncio.create_subprocess_exec(
            *command(in_fd, out_fd),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            pass_fds=(in_fd, out_fd),
            env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
            start_new_session=True,
        )
    finally:
        os.close(in_fd)
        os.close(out_fd)

    async def read(stream, limit: int) -> bytes:
        data = bytearray()
        while chunk := await stream.read(65536):
            # Past the limit (the runner passes on no more than that) it is only drained
            data += chunk[: max(0, limit - len(data))]
        return bytes(data)

    async def read_all():
        output, errors = await asyncio.gather(read(process.stdout, MAX_OUTPUT_BYTES), read(process.stderr, 64 * 1024))
        await process.wait()
        return output, errors

    try:
        output, errors = await asyncio.wait_for(read_all(), seconds)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        process.kill()
        await process.wait()
        raise
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        detail = errors.decode("utf-8", "replace").strip()[:500]
        raise JailError(f"The jail did not finish ({detail or f'exit code {process.returncode}'}).")
    return json.loads(manifest_path.read_text()), output


async def run_code(
    language: str,
    code: str,
    files: list[tuple[str, bytes]],
    core: int,
    packages: dict[str, Path],
    cwd: str = "",
) -> RunResult:
    """Runs `code` in a new jail with `files` in its sandbox folder, on CPU core `core`, in its folder `cwd`."""
    if language not in LANGUAGES:
        raise ValueError(f"language must be one of {', '.join(LANGUAGES)}")
    run_dir = RUNS_DIR / uuid.uuid4().hex
    out_dir = run_dir / "out"
    started = time.monotonic()
    try:
        out_dir.mkdir(parents=True, mode=0o700)
        prepare(run_dir, language, code, files, core, packages, cwd)
        manifest, output = await run_jail(functools.partial(bwrap_command, packages), run_dir, RUN_SECONDS + GRACE_SECONDS)
        reason = manifest.get("reason")
        exit_code = manifest.get("exit_code")
        status = "ok" if exit_code == 0 and not reason else "timeout" if reason == "timeout" else "stopped" if reason else "error"
        return RunResult(
            status=status,
            exit_code=exit_code,
            reason=reason,
            output=output[:MAX_OUTPUT_BYTES].decode("utf-8", "replace"),
            printed_bytes=int(manifest.get("printed_bytes", len(output))),
            duration_ms=round((time.monotonic() - started) * 1000),
            changed=read_out(out_dir, manifest),
            deleted=[p for p in (safe_path(d) for d in manifest.get("deleted", [])) if p],
            skipped=manifest.get("skipped", []),
        )
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


async def self_test() -> str | None:
    """Starts an empty jail once, so that a host that cannot make one says so in the log. None when it works."""
    command = [
        "bwrap", "--unshare-all", "--die-with-parent", "--clearenv",
        "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
        "--dev", "/dev", "--proc", "/proc", "--size", "1048576", "--tmpfs", "/tmp",
    ]
    if Path("/usr/lib64").exists():
        command += ["--symlink", "usr/lib64", "/lib64"]
    command += [*SEAL, "--uid", "1000", "--gid", "1000", "/usr/bin/true"]
    process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, errors = await process.communicate()
    return None if process.returncode == 0 else errors.decode("utf-8", "replace").strip() or f"exit code {process.returncode}"


def encode_file(path: str, data: bytes) -> dict:
    return {"path": path, "data": base64.b64encode(data).decode("ascii")}
