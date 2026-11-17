"""The git tool: git commands on the chat's repositories, each in a jail of its own (see ../jail/git_runner.py).

A repository is a folder of the chat's sandbox, its work tree, and its .git
folder, which the app keeps apart from the sandbox's files and sends with every
call, as a gzipped tar: runs of code never see it. The container keeps
neither; like a run, a call gets them and gives back what changed. git itself
is in /opt/git, which only these jails see: a run of code has no git.

git does not run other programs here. It takes only the commands of COMMANDS,
without the options that would make it run a program, write outside the
repository, or reach the network on its own (see parse). It runs in a jail
without network, with hooks, editors, pagers, fsmonitor and credential helpers
turned off by settings that a repository's config cannot change (FORCED).
After each command, the repository's config may only hold the keys git writes
for these commands, and nothing in it may point outside it; otherwise it is
not kept (see check_repo in ../jail/git_runner.py).

Only clone, fetch and pull reach the internet, and never with the model's own
command. First a jail with network, but with nothing of the chat in it,
downloads a bare copy of the remote repository, with a command built here
from the URL and the options that say what to download (download). Its git
can only reach code-egress's git port, which lets HTTPS through to public
addresses and nothing else, and only speaks HTTPS. Then the model's command
runs in the jail without network, against that copy, which stands in for the
URL (url.<copy>.insteadOf=<url>).
"""

import asyncio
import base64
import ipaddress
import json
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import jail
import packages

GIT = "/opt/git/libexec/git"
PROXY = os.environ.get("GIT_PROXY", "")
# On the volume, not in memory: a call holds the work tree, the .git folder and a download
RUNS_DIR = packages.STAGING
TREE = "/w/tree"
GIT_DIR = "/w/git"

# Limits of one call
GIT_SECONDS = 120
DOWNLOAD_SECONDS = 180
MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024
WORK_TMPFS_BYTES = 320 * 1024 * 1024
MAX_FILES = 5000
GRACE_SECONDS = 30

COMMANDS = {
    "status", "log", "show", "diff", "blame", "grep", "shortlog", "describe", "rev-parse", "rev-list", "ls-files",
    "ls-tree", "cat-file", "show-ref", "for-each-ref", "reflog", "merge-base", "name-rev", "range-diff", "cherry",
    "show-branch", "whatchanged", "count-objects", "fsck", "version",
    "init", "add", "rm", "mv", "restore", "reset", "commit", "checkout", "switch", "branch", "tag", "merge", "rebase",
    "stash", "cherry-pick", "revert", "clean", "apply", "am", "format-patch", "archive", "bisect", "gc", "config",
    "remote", "clone", "fetch", "pull",
}  # fmt: skip
NETWORK = ("clone", "fetch", "pull")

NOT_HERE = {
    "push": "git push is not available: the sandbox has no credentials for remote repositories. Give the user the "
    "changes instead, such as with git format-patch or git archive.",
    "submodule": "git submodule is not available: the sandbox only clones the repository itself.",
    "ls-remote": "git ls-remote is not available: clone the repository, or fetch, and look at its branches there.",
}

# Options that make git run another program, use other repositories, or reach the network on its own.
# Long options also count when abbreviated, as git takes them.
DENIED_ALL = (
    "--exec", "--upload-pack", "--receive-pack", "--ext-diff", "--recurse-submodules", "--recursive",
    "--separate-git-dir", "--template", "--reference", "--reference-if-able", "--filter", "--bundle-uri",
    "--open-files-in-pager", "--git-dir", "--work-tree", "--exec-path", "--config-env", "--super-prefix",
    "--remote-submodules", "--shallow-submodules", "--also-filter-submodules", "--submodule-prefix",
)  # fmt: skip
DENIED = {
    "clone": ("--bare", "--mirror", "--config", "--local", "--shared", "--no-hardlinks", "--sparse", "--server-option", "--revision"),
    "init": ("--bare",),
    "archive": ("--remote",),
    "fetch": ("--server-option",),
    "pull": ("--server-option",),
}
DENIED_SHORT = {"clone": "culs", "rebase": "x", "grep": "O", "fetch": "o", "pull": "o"}
# Options whose value is a path git writes to: it must stay in the work tree
PATH_OPTIONS = ("--output", "--output-directory", "--directory", "--build-fake-ancestor")
PATH_SHORT = {"format-patch": "o", "archive": "o"}

# Options that take their value as the next argument, where the positional arguments matter
VALUES = {
    "clone": {"--depth", "--shallow-since", "--shallow-exclude", "--branch", "-b", "--origin", "-o", "--jobs", "-j"},
    "fetch": {"--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--jobs", "-j", "--refmap", "--negotiation-tip"},
    "pull": {"--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--jobs", "-j", "--strategy", "-s",
             "--strategy-option", "-X", "--refmap", "--negotiation-tip"},
    "init": {"--initial-branch", "-b", "--object-format", "--ref-format"},
    "remote add": {"-t", "--track", "-m", "--master"},
    "remote set-url": set(),
}  # fmt: skip

URL = re.compile(
    r"^https://(?P<host>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)"
    r"(?::(?P<port>\d{1,5}))?(?P<path>/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$"
)
REF = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._/+-]{0,199}$")
DATE = re.compile(r"^[A-Za-z0-9 :.,+_-]{1,60}$")

CONFIG_READ = {"--list", "-l", "--get", "--get-all", "--get-regexp"}
CONFIG_FLAGS = CONFIG_READ | {"--unset", "--local", "--null", "-z", "--name-only", "--show-origin", "--show-scope"}
CONFIG_SETTABLE = ("user.name", "user.email")
BISECT = {"start", "bad", "good", "new", "old", "skip", "reset", "log", "replay", "terms", "visualize", "view"}
REMOTE = {"add", "rename", "remove", "rm", "set-url", "get-url", "set-head", "set-branches"}

# Settings no repository's config can change, as git takes those of its command line over the config
FORCED = {
    "core.hooksPath": "/opt/git/hooks",  # an empty folder: no hook runs
    "core.fsmonitor": "false",
    "core.pager": "cat",
    "core.editor": "true",
    "sequence.editor": "true",
    "credential.helper": "",
    # The sandbox keeps files, not links or modes
    "core.symlinks": "false",
    "core.fileMode": "false",
    "gc.autoDetach": "false",
    "maintenance.auto": "false",
    "submodule.recurse": "false",
    "fetch.recurseSubmodules": "false",
    "color.ui": "false",
    "protocol.allow": "never",
}
LOCAL_FORCED = {**FORCED, "protocol.file.allow": "always"}
DOWNLOAD_FORCED = {
    **FORCED,
    "protocol.https.allow": "always",
    "http.proxy": PROXY,
    "http.lowSpeedLimit": "1000",
    "http.lowSpeedTime": "30",
    "transfer.fsckObjects": "true",
}


class GitError(Exception):
    """Why a git command was not run, for the model."""


@dataclass
class Command:
    """A git command as the git tool takes it. `argv` is what git gets in the jail without network."""

    name: str
    argv: list[str]
    fresh: bool = False  # clone and init: they make the repository
    url: str | None = None  # clone: what to download
    download: list[str] = field(default_factory=list)  # the options of the bare copy
    repository: str | None = None  # fetch and pull: the remote or URL they name
    all_remotes: bool = False


@dataclass
class GitResult:
    status: str  # "ok" | "error" | "timeout" | "stopped"
    exit_code: int | None
    reason: str | None
    output: str
    duration_ms: int
    changed: list[tuple[str, bytes]] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    repo: str = "none"  # "none" | "new" | "changed" | "same"
    git: bytes | None = None  # the .git folder as a gzipped tar, when it is new or changed


def check_url(url: str) -> str:
    """`url` when it is an https:// URL of a public host, without a user, a query or a port other than 443."""
    found = URL.match(url or "") if len(url or "") <= 400 else None
    if not found or found.group("port") not in (None, "443"):
        raise GitError(
            f"{url or 'An empty URL'} cannot be used: only https:// URLs of public hosts, such as "
            "https://github.com/user/repo, without a user name, password or query."
        )
    try:
        if not ipaddress.ip_address(found.group("host")).is_global:
            raise GitError(f"{url} is not a public address.")
    except ValueError:
        pass  # a host name: code-egress checks the address it resolves to
    return url


def check_path(value: str, option: str) -> str:
    parts = value.replace("\\", "/").split("/")
    if not value or value.startswith(("/", "~")) or any(p in ("..",) or p.lower() == ".git" for p in parts):
        raise GitError(f"{option} must name a place in the repository's folder, without .. or .git.")
    return value


def _denied(sub: str, name: str) -> bool:
    """Whether the long option `name` is, or abbreviates, a denied one."""
    return any(d == name or (len(name) > 3 and d.startswith(name)) for d in (*DENIED_ALL, *DENIED.get(sub, ())))


def check_options(sub: str, args: list[str]):
    """Refuses the options of DENIED and checks the paths of PATH_OPTIONS, up to "--"."""
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            break
        if arg.startswith("--"):
            name, eq, value = arg.partition("=")
            if _denied(sub, name):
                raise GitError(f"{name} is not allowed here: it would run another program or reach outside the repository.")
            if any(p == name or (len(name) > 4 and p.startswith(name)) for p in PATH_OPTIONS):
                if not eq:
                    i += 1
                    value = args[i] if i < len(args) else ""
                check_path(value, name)
        elif arg.startswith("-") and len(arg) > 1:
            if any(ch in DENIED_SHORT.get(sub, "") for ch in arg[1:]):
                raise GitError(f"{arg} is not allowed with git {sub} here: it would run another program or reach outside the repository.")
            if arg[1] in PATH_SHORT.get(sub, ""):
                value = arg[2:]
                if not value:
                    i += 1
                    value = args[i] if i < len(args) else ""
                check_path(value, f"-{arg[1]}")
        i += 1


def split_args(args: list[str], values: set[str]) -> tuple[list[list[str]], list[str]]:
    """The options (each with its value, when it takes the next argument) and the positional arguments."""
    options, positional, i = [], [], 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            positional += args[i + 1 :]
            break
        if arg.startswith("-") and len(arg) > 1:
            if "=" not in arg and arg in values and i + 1 < len(args):
                options.append([arg, args[i + 1]])
                i += 2
                continue
            options.append([arg])
        else:
            positional.append(arg)
        i += 1
    return options, positional


def option_value(options: list[list[str]], *names: str) -> str | None:
    """The value of the last of `names` among `options` ("--depth 1", "--depth=1", "-b main", "-bmain")."""
    found = None
    for option in options:
        name, eq, attached = option[0].partition("=")
        if name in names:
            found = option[1] if len(option) > 1 else attached if eq else found
        elif len(name) > 2 and not name.startswith("--") and name[:2] in names:
            found = name[2:]
    return found


def download_options(options: list[list[str]], clone: bool) -> list[str]:
    """The options of the bare copy, from those of a clone, fetch or pull: how much history, which branch, tags."""
    flags = {o[0].partition("=")[0] for o in options}
    result = []
    depth = option_value(options, "--depth")
    if depth is not None and "--unshallow" not in flags and "--deepen" not in flags:
        if not depth.isdigit() or not 0 < int(depth) <= 1_000_000:
            raise GitError("--depth must be a whole number from 1.")
        result.append(f"--depth={int(depth)}")
    for name in ("--shallow-since", "--shallow-exclude"):
        value = option_value(options, name)
        if value is not None:
            if not (DATE if name == "--shallow-since" else REF).match(value):
                raise GitError(f"{name} has a value that cannot be used: {value}")
            result.append(f"{name}={value}")
    if clone:
        branch = option_value(options, "--branch", "-b")
        if branch is not None:
            if not REF.match(branch):
                raise GitError(f"{branch} is not a branch or tag name.")
            result.append(f"--branch={branch}")
        result += [flag for flag in ("--single-branch", "--no-single-branch") if flag in flags]
    else:
        result.append("--no-single-branch")
    if "--no-tags" in flags:
        result.append("--no-tags")
    return result


def parse(argv: list[str]) -> Command:
    """The git command `argv` (without "git") as the git tool runs it, or GitError with why it is not run."""
    if not argv:
        raise GitError("Name a git command, such as status, log or clone <url>.")
    if any("\0" in a for a in argv):
        raise GitError("The command has a null character.")
    sub, args = argv[0], argv[1:]
    if sub in NOT_HERE:
        raise GitError(NOT_HERE[sub])
    if sub not in COMMANDS:
        if sub.startswith("-"):
            raise GitError(f"Options before the command, such as {sub}, are not allowed: start with the command, such as status.")
        raise GitError(f"git {sub} is not available here. Available: {', '.join(sorted(COMMANDS))}.")
    check_options(sub, args)

    if sub == "config":
        _check_config(args)
    elif sub == "remote":
        _check_remote(args)
    elif sub == "bisect" and args and args[0] not in BISECT:
        raise GitError("git bisect run would run a program: mark commits with git bisect good and bad instead." if args[0] == "run" else f"git bisect {args[0]} is not available here.")

    if sub == "clone":
        options, positional = split_args(args, VALUES["clone"])
        if not positional:
            raise GitError("Name the repository's URL: git clone https://github.com/user/repo")
        if len(positional) > 2:
            raise GitError("git clone takes a URL and a folder.")
        url = check_url(positional[0])
        flat = [part for option in options for part in option]
        return Command("clone", ["clone", *flat, "--", url, TREE], fresh=True, url=url, download=download_options(options, True))
    if sub == "init":
        options, positional = split_args(args, VALUES["init"])
        return Command("init", ["init", *[part for option in options for part in option], TREE], fresh=True)
    if sub in ("fetch", "pull"):
        options, positional = split_args(args, VALUES[sub])
        flags = {o[0].partition("=")[0] for o in options}
        if "--multiple" in flags:
            raise GitError("--multiple is not available here: fetch one remote, or all of them with --all.")
        return Command(
            sub,
            argv,
            download=download_options(options, False),
            repository=positional[0] if positional else None,
            all_remotes="--all" in flags,
        )
    return Command(sub, argv)


def _check_config(args: list[str]):
    options = [a for a in args if a.startswith("-")]
    positional = [a for a in args if not a.startswith("-")]
    unknown = [o for o in options if o not in CONFIG_FLAGS]
    if unknown:
        raise GitError(f"{unknown[0]} is not available with git config here: it reads settings, and sets user.name and user.email.")
    if CONFIG_READ & set(options) or (len(positional) == 1 and "--unset" not in options):
        return
    if not positional or positional[0].lower() not in CONFIG_SETTABLE or len(positional) > 2:
        raise GitError("git config can only set user.name and user.email here.")


def _check_remote(args: list[str]):
    if not args or args[0] in ("-v", "--verbose"):
        return
    sub, rest = args[0], args[1:]
    if sub in ("show", "prune", "update"):
        raise GitError(f"git remote {sub} needs the network, which only git clone, fetch and pull reach here.")
    if sub not in REMOTE:
        raise GitError(f"git remote {sub} is not available here.")
    options, positional = split_args(rest, VALUES.get(f"remote {sub}", set()))
    flags = {o[0].partition("=")[0] for o in options}
    if sub == "add":
        if flags & {"-f", "--fetch", "--mirror"}:
            raise GitError("git remote add cannot fetch here: add the remote, then git fetch it.")
        if len(positional) != 2:
            raise GitError("git remote add takes a name and a URL.")
        check_url(positional[1])
    elif sub == "set-url" and "--delete" not in flags and len(positional) >= 2:
        check_url(positional[1])
    elif sub == "set-head" and flags & {"-a", "--auto"}:
        raise GitError("git remote set-head --auto needs the network: name the branch instead.")


def pick_urls(command: Command, info: dict) -> list[str]:
    """What a fetch or pull downloads: the URL or remote it names, every remote with --all, or else the
    upstream remote of the branch, or origin. `info` is what the runner's inspect found."""
    remotes: dict[str, str] = info.get("remotes") or {}
    if command.repository:
        if command.repository.startswith("https://"):
            return [check_url(command.repository)]
        if command.repository not in remotes:
            raise GitError(f"There is no remote named {command.repository}. The remotes are: {', '.join(remotes) or 'none'}.")
        return [check_url(remotes[command.repository])]
    if command.all_remotes:
        return [check_url(url) for url in dict.fromkeys(remotes.values())]
    name = info.get("upstream") or "origin"
    if name not in remotes:
        raise GitError("This repository has no remote to fetch from: add one with git remote add origin <url>.")
    return [check_url(remotes[name])]


def git_env(forced: dict[str, str], repo: bool) -> dict[str, str]:
    """The environment of git in a jail: none of the server's, the FORCED settings, and with `repo`, the
    repository in /w/git with its work tree in /w/tree."""
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/tmp/home",
        "LANG": "C.UTF-8",
        "TZ": "UTC",
        "GIT_EXEC_PATH": "/opt/git/libexec",
        "GIT_TEMPLATE_DIR": "/opt/git/templates",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/opt/git/gitconfig",
        "GIT_TERMINAL_PROMPT": "0",
        # Reading commands, such as status, leave the repository as it was
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_PAGER": "cat",
        "PAGER": "cat",
        "GIT_EDITOR": "true",
        "GIT_SEQUENCE_EDITOR": "true",
        "GIT_CONFIG_COUNT": str(len(forced)),
    }
    for i, (key, value) in enumerate(forced.items()):
        env[f"GIT_CONFIG_KEY_{i}"] = key
        env[f"GIT_CONFIG_VALUE_{i}"] = value
    if repo:
        env |= {"GIT_DIR": GIT_DIR, "GIT_WORK_TREE": TREE}
    return env


def system_mounts() -> list[str]:
    """The system, read-only, and git, as the git jails see them."""
    mounts = [
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/sbin", "/sbin",
        "--ro-bind", "/etc", "/etc",
        "--ro-bind", "/opt/git", "/opt/git",
        "--dev", "/dev",
        "--proc", "/proc",
        "--size", str(jail.TMP_TMPFS_BYTES), "--tmpfs", "/tmp",
    ]  # fmt: skip
    if Path("/usr/lib64").exists():
        mounts += ["--symlink", "usr/lib64", "/lib64"]
    return mounts


def local_command(copies: Path | None, in_fd: int, out_fd: int) -> list[str]:
    """The jail of the model's command: no network, its own tmpfs for the repository, the downloaded copies
    read-only. The run's in and out folders come as open directories (see ../jail/git_runner.py)."""
    command = [
        "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
        "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
        *system_mounts(),
        "--ro-bind", "/opt/jail", "/opt/jail",
        "--size", str(WORK_TMPFS_BYTES), "--tmpfs", "/w",
    ]  # fmt: skip
    if copies is not None:
        command += ["--ro-bind", str(copies), "/net"]
    return command + [
        "--uid", "1000", "--gid", "1000", "--chdir", "/w",
        "/usr/local/bin/python3", "-I", "-S", "/opt/jail/git_runner.py", str(in_fd), str(out_fd),
    ]  # fmt: skip


def download_command(url: str, options: list[str], folder: Path) -> list[str]:
    """The jail that downloads a bare copy of `url` into `folder`/repo.git: with the container's network
    (only code-egress), and with nothing of the chat in it. The git command is built here, not the model's."""
    command = [
        "bwrap", "--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--clearenv",
        *system_mounts(),
        "--bind", str(folder), "/net",
        "--uid", "1000", "--gid", "1000", "--chdir", "/net",
    ]  # fmt: skip
    for key, value in (git_env(DOWNLOAD_FORCED, repo=False) | {"HOME": "/tmp"}).items():
        command += ["--setenv", key, value]
    return command + [GIT, "clone", "--bare", "--quiet", *options, "--", url, "/net/repo.git"]


# What git says when a download fails, and what it means here
DOWNLOAD_HINTS = (
    ("could not read Username", "The repository does not exist, or it is private: only public repositories can be downloaded, without a login."),
    ("CONNECT tunnel failed, response 403", "Only public addresses can be reached, over HTTPS."),
    ("CONNECT tunnel failed, response 503", "The host could not be found or reached."),
)


async def download(url: str, options: list[str], folder: Path) -> tuple[bool, str]:
    """Downloads a bare copy of `url` into `folder`/repo.git. Returns whether it worked, and what git said."""
    folder.mkdir(parents=True)
    process = await asyncio.create_subprocess_exec(
        *download_command(url, options, folder),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
        start_new_session=True,
    )

    async def read() -> bytes:
        data = bytearray()
        while chunk := await process.stdout.read(65536):
            data += chunk[: max(0, 64 * 1024 - len(data))]
        return bytes(data)

    reader = asyncio.ensure_future(read())
    started, problem = time.monotonic(), None
    try:
        while process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), 0.5)
            except asyncio.TimeoutError:
                pass
            if process.returncode is not None:
                break
            if time.monotonic() - started > DOWNLOAD_SECONDS:
                problem = f"The download took longer than {DOWNLOAD_SECONDS // 60} minutes and was stopped."
            elif await asyncio.to_thread(packages.folder_size, folder) > MAX_DOWNLOAD_BYTES:
                problem = (
                    f"The repository is larger than {MAX_DOWNLOAD_BYTES // 1024 // 1024} MB to download, so it was "
                    "stopped. Download less of it, such as with --depth 1 or --single-branch."
                )
            if problem:
                process.kill()
                await process.wait()
    except asyncio.CancelledError:
        process.kill()
        await process.wait()
        raise
    output = (await reader).decode("utf-8", "replace").strip()
    if problem:
        return False, problem
    hints = [hint for said, hint in DOWNLOAD_HINTS if said in output]
    return process.returncode == 0, "\n".join([output, *hints])


def prepare(run_dir: Path, mode: str, command: Command | None, files, git: bytes | None, core: int, mirrors: dict[str, str]):
    """Writes the input of a call's jail: the work tree, the .git folder, and the runner's config."""
    files_dir = run_dir / "in" / "files"
    files_dir.mkdir(parents=True)
    for path, data in files:
        target = files_dir / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    if git is not None:
        (run_dir / "in" / "git.tar.gz").write_bytes(git)
    forced = dict(LOCAL_FORCED)
    for url, copy in mirrors.items():
        forced[f"url.{copy}.insteadOf"] = url
    config = {
        "mode": mode,
        "argv": command.argv if command else [],
        "fresh": bool(command and command.fresh),
        "env": git_env(forced, repo=not (command and command.fresh)),
        "core": core,
        "limits": {
            "seconds": GIT_SECONDS,
            "memory_bytes": jail.MEMORY_BYTES,
            "max_processes": jail.MAX_PROCESSES,
            "max_output_bytes": jail.MAX_OUTPUT_BYTES,
            "max_file_bytes": jail.MAX_FILE_BYTES,
            "max_files": MAX_FILES,
        },
    }
    (run_dir / "in" / "config.json").write_text(json.dumps(config), encoding="utf-8")


async def in_jail(mode: str, command: Command | None, files, git: bytes | None, core: int, mirrors: dict[str, str], copies: Path | None):
    """Runs the runner in a jail without network. Returns its manifest, what it printed, the work tree's files
    it made or changed, and the .git folder as a gzipped tar when it is new or changed."""
    run_dir = RUNS_DIR / f"git-{uuid.uuid4().hex}"
    (run_dir / "out").mkdir(parents=True, mode=0o700)
    try:
        prepare(run_dir, mode, command, files, git, core, mirrors)
        manifest, output = await jail.run_jail(
            lambda in_fd, out_fd: local_command(copies, in_fd, out_fd), run_dir, GIT_SECONDS + GRACE_SECONDS
        )
        out_dir = run_dir / "out"
        changed = jail.read_out(out_dir, manifest) if mode == "command" else []
        tar = out_dir / "git.tar.gz"
        return manifest, output, changed, tar.read_bytes() if tar.exists() else None
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


def tidy(text: str, folder: str, mirrors: dict[str, str]) -> str:
    """What git printed, with the repository's folder and URLs in place of the jail's paths."""
    for url, copy in mirrors.items():
        text = text.replace(copy, url)
    return text.replace(GIT_DIR, ".git").replace(f"{TREE}/", "").replace(TREE, folder or ".")


def check_kept(manifest: dict):
    """GitError when the runner found something in the .git folder that the git tool does not allow."""
    if manifest.get("problem"):
        raise GitError(f"The repository cannot be used: {manifest['problem']}, which the git tool does not allow. Nothing was kept.")


async def run(command: Command, files: list[tuple[str, bytes]], git: bytes | None, core: int, folder: str) -> GitResult:
    """Runs `command` on the repository whose work tree is `files` and whose .git folder is `git` (a gzipped
    tar; None for clone and init). `folder` is the repository's folder in the sandbox, for what git prints."""
    if command.fresh and git is not None:
        raise GitError(f"{folder or 'The sandbox'} is a repository already.")
    if not command.fresh and git is None:
        raise GitError("There is no repository here: clone one with git clone <url>, or make one with git init.")
    started = time.monotonic()
    work = RUNS_DIR / f"git-{uuid.uuid4().hex}"
    try:
        urls = []
        if command.name == "clone":
            urls = [command.url]
        elif command.name in ("fetch", "pull"):
            manifest, _, _, _ = await in_jail("inspect", None, [], git, core, {}, None)
            check_kept(manifest)
            urls = pick_urls(command, manifest.get("info") or {})
        mirrors: dict[str, str] = {}
        for i, url in enumerate(urls):
            ok, said = await download(url, command.download, work / str(i))
            if not ok:
                return GitResult(
                    status="error",
                    exit_code=128,
                    reason=None,
                    output=f"{url} could not be downloaded.\n{tidy(said, folder, {})}".strip(),
                    duration_ms=round((time.monotonic() - started) * 1000),
                )
            mirrors[url] = f"file:///net/{i}/repo.git"
        manifest, output, changed, tar = await in_jail("command", command, files, git, core, mirrors, work if urls else None)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    check_kept(manifest)
    reason = manifest.get("reason")
    exit_code = manifest.get("exit_code")
    return GitResult(
        status="ok" if exit_code == 0 and not reason else "timeout" if reason == "timeout" else "stopped" if reason else "error",
        exit_code=exit_code,
        reason=reason,
        output=tidy(output[: jail.MAX_OUTPUT_BYTES].decode("utf-8", "replace"), folder, mirrors),
        duration_ms=round((time.monotonic() - started) * 1000),
        changed=changed,
        deleted=[p for p in (jail.safe_path(d) for d in manifest.get("deleted", [])) if p],
        skipped=manifest.get("skipped", []),
        repo=manifest.get("repo", "none"),
        git=tar,
    )


def encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")
