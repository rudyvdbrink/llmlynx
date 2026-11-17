"""Runs one git command of the git tool inside its jail (see ../src/gitrepo.py, which starts it with bubblewrap).

It works as runner.py, whose parts it uses: it is the jail's first process
after bubblewrap, cannot be inspected, and gets its input and gives its output
through open directories that git does not get. It puts the repository's work
tree (the files of its folder in the chat's sandbox) in /w/tree and its .git
folder in /w/git, both on the jail's own tmpfs, and runs git there. Then it
copies out the files of the work tree that git made or changed, says which it
deleted, and copies out the .git folder as a gzipped tar when it changed.
Before that it checks that the .git folder holds nothing that would make a
later git command run another program (see check_repo): such a repository is
not kept.

Usage: python3 -I -S git_runner.py <in folder fd> <out folder fd>; the in
folder holds config.json, the work tree in files/, and the .git folder as
git.tar.gz when the repository exists.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import time

sys.path.insert(0, "/opt/jail")
from runner import collect, move_in, not_dumpable, read_in, stop_all, supervise  # noqa: E402

TREE = "/w/tree"
GIT_DIR = "/w/git"
GIT = "/opt/git/libexec/git"

# The keys a repository's config may hold: those git writes itself for the commands the git tool takes
CONFIG_KEYS = re.compile(
    r"^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)"
    r"|extensions\.objectformat"
    r"|user\.(name|email)"
    r"|remote\..+\.(url|pushurl|fetch|tagopt|mirror|prune|prunetags|skipdefaultupdate|skipfetchall)"
    r"|branch\..+\.(remote|pushremote|merge|rebase|description))$"
)
# What git keeps for other repositories or work trees, which the git tool does not make
FOREIGN = ("modules", "worktrees", "commondir", "config.worktree", "objects/info/alternates", "objects/info/http-alternates")


def git(env, *args):
    """Runs a git command of this runner's own, and returns what it printed; it never fails the run."""
    try:
        done = subprocess.run([GIT, *args], env=env, cwd=TREE, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.decode("utf-8", "replace") if done.returncode == 0 else None


def check_repo(env):
    """Why the repository in GIT_DIR may not be kept, or None. Its config may only hold the keys of CONFIG_KEYS,
    and it may not point to other repositories: so no setting can make a later command run a program."""
    for name in FOREIGN:
        if os.path.lexists(os.path.join(GIT_DIR, name)):
            return f"it has {name}"
    for folder, dirs, files in os.walk(GIT_DIR):
        for name in dirs + files:
            path = os.path.join(folder, name)
            if os.path.islink(path) or not (os.path.isdir(path) or os.path.isfile(path)):
                return f"it has a link or a special file ({os.path.relpath(path, GIT_DIR)})"
    listing = git(env, "config", "--file", f"{GIT_DIR}/config", "--list", "--null")
    if listing is None:
        return "its config cannot be read"
    for entry in filter(None, listing.split("\0")):
        key = entry.split("\n", 1)[0]
        if not CONFIG_KEYS.match(key):
            return f"its config has {key}"
    return None


def digest_dir(root):
    """A hash of every file under `root`, with its path."""
    h = hashlib.sha256()
    for folder, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(folder, name)
            h.update(os.path.relpath(path, root).encode() + b"\0")
            with open(path, "rb") as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
    return h.hexdigest()


def extract(in_fd):
    """The .git folder from the in folder into GIT_DIR. False when the call brought none."""
    try:
        fd = os.open("git.tar.gz", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=in_fd)
    except FileNotFoundError:
        return False
    with open(fd, "rb") as f, tarfile.open(fileobj=f, mode="r:gz") as archive:
        archive.extractall(GIT_DIR, filter="data")
    return True


def write_git(out_fd):
    """The .git folder as a gzipped tar in the out folder: its folders and regular files only."""
    fd = os.open("git.tar.gz", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=out_fd)
    with open(fd, "wb") as f, tarfile.open(fileobj=f, mode="w:gz", compresslevel=1) as archive:
        for folder, dirs, files in os.walk(GIT_DIR):
            dirs.sort()
            for name in sorted(dirs + files):
                path = os.path.join(folder, name)
                archive.add(path, arcname=os.path.relpath(path, GIT_DIR), recursive=False)


def inspect(env):
    """The repository's remotes and the upstream of its branch, for a fetch or a pull to know what to download."""
    remotes = {}
    for entry in filter(None, (git(env, "config", "--null", "--get-regexp", r"^remote\..*\.url$") or "").split("\0")):
        key, _, url = entry.partition("\n")
        remotes[key[len("remote.") : -len(".url")]] = url
    branch = (git(env, "symbolic-ref", "-q", "--short", "HEAD") or "").strip()
    upstream = (git(env, "config", "--get", f"branch.{branch}.remote") or "").strip() if branch else ""
    return {"remotes": remotes, "branch": branch or None, "upstream": upstream or None}


def write_manifest(out_fd, manifest):
    fd = os.open("manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=out_fd)
    with open(fd, "w") as f:
        json.dump(manifest, f)


def run(config, in_fd, out_fd):
    limits, env = config["limits"], config["env"]
    started = time.monotonic()
    os.makedirs(TREE)
    os.makedirs(env["HOME"], exist_ok=True)
    before = move_in(in_fd, TREE)
    existed = extract(in_fd)
    os.close(in_fd)

    # Checked before git reads it as well, so that not even a .git folder changed outside the git tool can run anything
    plain = {k: v for k, v in env.items() if k not in ("GIT_DIR", "GIT_WORK_TREE")}
    problem = check_repo(plain) if existed else None
    if problem:
        write_manifest(out_fd, {"problem": problem})
        return
    if config["mode"] == "inspect":
        write_manifest(out_fd, {"info": inspect(env)})
        return

    old = digest_dir(GIT_DIR) if existed else None
    exit_code, reason, printed = supervise([GIT, *config["argv"]], TREE, env, limits, config["core"], started)
    stop_all()
    # clone and init make the repository in the work tree; it is kept apart from it
    made = os.path.join(TREE, ".git")
    if config["fresh"] and os.path.isdir(made) and not os.path.islink(made):
        os.rename(made, GIT_DIR)

    state = "none"
    if os.path.isdir(GIT_DIR) and (existed or exit_code == 0):
        problem = check_repo(plain)
        new = digest_dir(GIT_DIR)
        state = "same" if new == old else "new" if old is None else "changed"
    # A .git folder anywhere in the work tree is never a file of the sandbox
    changed, deleted, skipped = collect(before, out_fd, limits, root=TREE, skipped_dirs={".git"})
    if state in ("new", "changed") and not problem:
        write_git(out_fd)
    write_manifest(
        out_fd,
        {
            "exit_code": exit_code,
            "reason": reason,
            "printed_bytes": printed,
            "duration_ms": round((time.monotonic() - started) * 1000),
            "changed": changed,
            "deleted": deleted,
            "skipped": skipped,
            "repo": state,
            "problem": problem,
        },
    )


def main():
    not_dumpable()
    in_fd, out_fd = int(sys.argv[1]), int(sys.argv[2])
    for fd in (in_fd, out_fd):
        os.set_inheritable(fd, False)
    config = json.loads(read_in(in_fd, "config.json"))
    run(config, in_fd, out_fd)


if __name__ == "__main__":
    main()
