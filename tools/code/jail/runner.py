"""Runs one piece of code inside its jail (see ../src/jail.py, which starts it with bubblewrap).

It is the jail's first process after bubblewrap itself. It moves the chat's
files from the run's in folder into /sandbox, a tmpfs of fixed size, starts
the code there, and passes on what the code prints, up to its limit. It stops
the code when it runs too long, takes too much memory, starts too many
processes or prints too much. Then it stops whatever the code left running,
and copies the files the code made or changed to the run's out folder, with a
manifest of what changed.

The in and out folders are not in the jail: they come as open directories,
which the code does not get, and this process cannot be inspected through
/proc (it is not dumpable), so the code cannot reach them. The code sees only
/sandbox, /tmp, the chat's packages (read-only) and the system (read-only).

Usage: python3 -I -S runner.py <in folder fd> <out folder fd>; the in folder
holds config.json, the code, and the chat's files in files/.
"""

import ctypes
import hashlib
import json
import os
import resource
import selectors
import shutil
import signal
import subprocess
import sys
import time

SANDBOX = "/sandbox"
CODE_DIR = "/tmp/code"
MATPLOTLIB_CACHE = "/opt/jail/matplotlib"
# Folders whose files are a tool's cache, not results
SKIPPED_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
PR_SET_DUMPABLE = 4

MAIN_FILES = {"python": "main.py", "javascript": "main.js", "typescript": "main.ts", "shell": "main.sh"}


def not_dumpable():
    """So that the code cannot open this process's files (the in and out folders) through /proc, nor trace it."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE) failed")


def walk(root, skipped=SKIPPED_DIRS):
    """The regular files under `root`, as paths relative to it, without following links or entering the `skipped` folders."""
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in skipped and not os.path.islink(os.path.join(folder, d)))
        for name in sorted(files):
            full = os.path.join(folder, name)
            if os.path.isfile(full) and not os.path.islink(full):
                yield os.path.relpath(full, root).replace(os.sep, "/")


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def read_in(in_fd, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=in_fd)
    with open(fd, "rb") as f:
        return f.read()


def move_in(in_fd, target):
    """Moves the chat's files from the in folder into the sandbox, so that they are not kept twice.
    Returns their hashes. The paths came checked from the server."""
    hashes = {}
    files_fd = os.open("files", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=in_fd)
    try:
        for folder, _dirs, files, dir_fd in os.fwalk(".", dir_fd=files_fd, follow_symlinks=False):
            for name in files:
                rel = os.path.normpath(os.path.join(folder, name)).replace(os.sep, "/")
                dest = os.path.join(target, rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
                with open(fd, "rb") as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out, 1 << 20)
                os.unlink(name, dir_fd=dir_fd)
                hashes[rel] = digest(dest)
    finally:
        os.close(files_fd)
    return hashes


def processes():
    """The pids in the jail, other than bubblewrap (1) and this one."""
    mine = os.getpid()
    return [int(p) for p in os.listdir("/proc") if p.isdigit() and int(p) not in (1, mine)]


def usage(pids):
    """The memory (resident, in bytes) and the number of threads of the processes."""
    page = os.sysconf("SC_PAGE_SIZE")
    memory = threads = 0
    for pid in pids:
        try:
            with open(f"/proc/{pid}/statm") as f:
                memory += int(f.read().split()[1]) * page
            threads += len(os.listdir(f"/proc/{pid}/task"))
        except (OSError, ValueError, IndexError):
            continue  # it ended meanwhile
    return memory, threads


def stop_all():
    """Kills every process in the jail but this one, and waits until they are gone."""
    deadline = time.monotonic() + 5
    while processes() and time.monotonic() < deadline:
        try:
            os.kill(-1, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
        time.sleep(0.02)


def write_out(out_fd, rel, source):
    """Copies `source` to `rel` under the out folder, which is only reachable through `out_fd`."""
    parts = rel.split("/")
    dir_fd = os.dup(out_fd)
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o700, dir_fd=dir_fd)
            except FileExistsError:
                pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
            os.close(dir_fd)
            dir_fd = next_fd
        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
        with open(fd, "wb") as target, open(source, "rb") as src:
            shutil.copyfileobj(src, target, 1 << 20)
    finally:
        os.close(dir_fd)


def collect(before, out_fd, limits, root=SANDBOX, skipped_dirs=SKIPPED_DIRS):
    """Copies the new and changed files out, and says which those are, which were deleted and which were not kept."""
    changed, skipped, seen = [], [], set()
    for rel in walk(root, skipped_dirs):
        seen.add(rel)
        full = os.path.join(root, rel)
        if rel in before and digest(full) == before[rel]:
            continue
        if os.path.getsize(full) > limits["max_file_bytes"]:
            skipped.append({"path": rel, "reason": "larger than 20 MB"})
            continue
        if len(changed) >= limits["max_files"]:
            skipped.append({"path": rel, "reason": f"more than {limits['max_files']} files changed"})
            continue
        write_out(out_fd, rel, full)
        changed.append(rel)
    deleted = sorted(rel for rel in before if rel not in seen)
    return changed, deleted, skipped


def limit_child(limits, core):
    """Runs in the code's process before it starts: its limits, and its one CPU core."""

    def apply():
        os.setsid()
        # The user's processes in the jail also count bubblewrap and this runner
        nproc = limits["max_processes"] + 2
        resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (limits["seconds"] + 5, limits["seconds"] + 10))
        try:
            os.sched_setaffinity(0, {core})
        except OSError:
            pass

    return apply


def supervise(command, cwd, env, limits, core, started):
    """Runs `command`, passes on what it prints up to the limit, and stops it at a limit. Returns its exit
    code, why it was stopped (None, or "timeout", "memory", "processes" or "output") and how much it printed.
    What it left running is still running: see stop_all."""
    child = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        preexec_fn=limit_child(limits, core),
        close_fds=True,
    )
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    os.set_blocking(child.stdout.fileno(), False)

    printed = 0
    reason = None
    ended = None
    while True:
        for _key, _events in selector.select(timeout=0.1):
            chunk = child.stdout.read(65536)
            if not chunk:
                selector.unregister(child.stdout)
                continue
            room = limits["max_output_bytes"] - printed
            if room > 0:
                sys.stdout.buffer.write(chunk[:room])
                sys.stdout.buffer.flush()
            printed += len(chunk)
            if printed > limits["max_output_bytes"]:
                reason = "output"
        now = time.monotonic()
        if reason is None:
            if now - started > limits["seconds"]:
                reason = "timeout"
            else:
                memory, threads = usage(processes())
                if memory > limits["memory_bytes"]:
                    reason = "memory"
                elif threads >= limits["max_processes"]:
                    reason = "processes"
        if reason is not None:
            break
        if child.poll() is not None:
            # What is left in the pipe comes right away; processes the code left behind do not keep the run going
            ended = ended or now
            if not selector.get_map() or now - ended > 0.2:
                break

    exit_code = child.poll()
    if exit_code is None:
        exit_code = -signal.SIGKILL
    return exit_code, reason, printed


def run(config, in_fd, out_fd):
    limits = config["limits"]
    started = time.monotonic()
    before = move_in(in_fd, SANDBOX)

    # matplotlib's font list, made when the image was built, so that a chart does not wait for it
    home = config["env"].get("HOME", "/tmp/home")
    os.makedirs(home, exist_ok=True)
    if os.path.isdir(MATPLOTLIB_CACHE):
        shutil.copytree(MATPLOTLIB_CACHE, config["env"].get("MPLCONFIGDIR", os.path.join(home, ".matplotlib")))

    os.makedirs(CODE_DIR, exist_ok=True)
    main = os.path.join(CODE_DIR, MAIN_FILES[config["language"]])
    with open(main, "wb") as f:
        f.write(read_in(in_fd, "code"))
    os.close(in_fd)
    command = {
        "python": ["/usr/local/bin/python3", main],
        "javascript": ["/usr/local/bin/node", main],
        "typescript": ["/usr/local/bin/node", "--disable-warning=ExperimentalWarning", main],
        "shell": ["/bin/bash", main],
    }[config["language"]]

    exit_code, reason, printed = supervise(command, SANDBOX, config["env"], limits, config["core"], started)
    stop_all()
    changed, deleted, skipped = collect(before, out_fd, limits)
    manifest = {
        "exit_code": exit_code,
        "reason": reason,
        "printed_bytes": printed,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "changed": changed,
        "deleted": deleted,
        "skipped": skipped,
    }
    fd = os.open("manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=out_fd)
    with open(fd, "w") as f:
        json.dump(manifest, f)


def main():
    not_dumpable()
    in_fd, out_fd = int(sys.argv[1]), int(sys.argv[2])
    for fd in (in_fd, out_fd):
        os.set_inheritable(fd, False)
    config = json.loads(read_in(in_fd, "config.json"))
    run(config, in_fd, out_fd)


if __name__ == "__main__":
    main()
