"""Packages per chat, from PyPI and npm, for the chat's runs.

Installing and running are kept apart: an install reaches the internet but
runs no package code, a run executes package code but has no network.

- No package code during an install. Python packages are only installed
  ready-built (wheels), which pip unpacks without running anything; their
  bytecode is compiled here, which runs none of it either. npm packages are
  unpacked from their tarballs here, so their install scripts never run; the
  model is told which packages have one.
- Only PyPI and the npm registry. The resolvers (pip and npm, which only read
  metadata) and the downloads go through the egress proxy, which reaches
  pypi.org, files.pythonhosted.org and registry.npmjs.org and nothing else.
  Every file to install must come from those hosts, with the hash the index
  states.
- Scanned as they are installed. Every package file that is not in the cache
  yet is downloaded into a staging folder and checked against its hash. The
  packages are unpacked there, and clamd scans each of their files on its own,
  as a run will see it: ClamAV's limits for one scan (files in an archive,
  bytes unpacked) then hold for one file, not for a whole package, and what
  ClamAV unpacks is what the sandbox gets. A file clamd cannot scan whole
  (over 2 GB, or an archive in it past its limits) counts as not checked.
  Only when every file is clean is the bytecode compiled, from the scanned
  sources, and the folder swapped in for the chat's packages.
- Kept, but rebuildable. The shared cache keeps the downloads of the installs
  that passed, by their hash, so none is downloaded twice, and marks the files
  scanned clean, by their SHA-256, so none is scanned twice; no run sees it.
  A chat's packages are kept until the chat is deleted or did not use them for
  UNUSED_DAYS; the next run installs them again from the chat's lock.

Layout of PACKAGES_DIR (a volume of its own):
  chats/<chat>/python/            pip --target: what PYTHONPATH points to in a run
  chats/<chat>/node/node_modules/ mounted at /node_modules in a run
  chats/<chat>/<ecosystem>.lock   the SHA-256 of the lock the folder was installed from
  chats/<chat>/.used              touched by every run and install
  cache/pypi/<sha256>/<wheel>, cache/npm/<sha512 hex>.tgz
  cache/clean/<ab>/<sha256>       a file with this SHA-256 was scanned clean
  staging/                        downloads and installs in progress
"""

import asyncio
import base64
import csv
import hashlib
import json
import math
import os
import platform
import re
import shutil
import stat
import tarfile
import time
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import clamd

PACKAGES_DIR = Path(os.environ.get("CODE_PACKAGES_DIR", "/packages"))
CHATS = PACKAGES_DIR / "chats"
CACHE = PACKAGES_DIR / "cache"
CLEAN = CACHE / "clean"
STAGING = PACKAGES_DIR / "staging"
PROXY = os.environ.get("PACKAGES_PROXY", "")

PYPI_INDEX = "https://pypi.org/simple"
NPM_REGISTRY = "https://registry.npmjs.org/"
FILE_HOSTS = {"pypi": "files.pythonhosted.org", "npm": "registry.npmjs.org"}


def env_number(name: str, default: float) -> float:
    """A positive number from the environment (set in .env, see .env.example), or `default`."""
    try:
        value = float(os.environ.get(name) or default)
    except ValueError:
        return default
    return value if math.isfinite(value) and value > 0 else default


# Limits of an install
MAX_DOWNLOAD_GB = env_number("CODE_PACKAGES_DOWNLOAD_GB", 5)
MAX_INSTALLED_GB = env_number("CODE_PACKAGES_INSTALLED_GB", 10)
MAX_DOWNLOAD_BYTES = int(MAX_DOWNLOAD_GB * 1024**3)
MAX_INSTALLED_BYTES = int(MAX_INSTALLED_GB * 1024**3)
# For the downloads, their scans and unpacking on the Pi: 12 minutes per GB to download (as in src/server/sandbox/code.ts)
INSTALL_SECONDS = max(300, round(MAX_DOWNLOAD_GB * 720))
UNUSED_DAYS = env_number("CODE_PACKAGES_EXPIRE_DAYS", 7)
MAX_PACKAGES = 50  # asked for in one install
MAX_REPORT_CHARS = 20_000
SCAN_STREAMS = 3  # files clamd scans at once for an install
# Where a run sees the Python packages (see jail.py): the paths in their bytecode
RUN_PYTHON_PACKAGES = "/opt/packages/python"

ECOSYSTEMS = ("pypi", "npm")
FOLDERS = {"pypi": "python", "npm": "node"}

CHAT_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# A requirement from PyPI: a name, extras, version specifiers and an environment marker; no URL, path or option
PYPI_NAME = r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
PYPI_REQUIREMENT = re.compile(
    rf"^\s*{PYPI_NAME}\s*(\[\s*{PYPI_NAME}(\s*,\s*{PYPI_NAME})*\s*\])?"
    r"\s*((===?|!=|<=|>=|<|>|~=)\s*[A-Za-z0-9.*+!_-]+\s*(,\s*(===?|!=|<=|>=|<|>|~=)\s*[A-Za-z0-9.*+!_-]+\s*)*)?"
    r"(;[A-Za-z0-9_.<>=!~'\" ()]*)?$"
)
# An npm package: a name (with its scope) and a version range or a tag; no URL, git, path or alias
NPM_NAME = re.compile(r"^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$")
NPM_RANGE = re.compile(r"^[0-9A-Za-z.^~<>=|*+\s-]*$")
NPM_TAG = re.compile(r"^[A-Za-z][A-Za-z0-9._-]*$")


# What pip and npm print when the package index cannot be reached, rather than when a package does not exist
UNREACHABLE = re.compile(r"NameResolutionError|ProxyError|ConnectTimeout|Tunnel connection failed|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT")


class InstallError(Exception):
    """Why an install did not happen, for the model. Nothing of that install was installed."""

    def __init__(self, message: str, report: str = "", scans: list | None = None):
        super().__init__(message)
        self.report = report
        self.scans = scans or []


@dataclass
class Item:
    """A file to install: a wheel, or an npm tarball at a place in node_modules (`path`)."""

    name: str
    version: str
    url: str
    hash: str  # pypi: SHA-256 in hex; npm: the integrity, "sha512-<base64>"
    requested: bool
    path: str = ""
    install_script: bool = False

    @property
    def filename(self) -> str:
        return urlparse(self.url).path.rsplit("/", 1)[-1]


@dataclass
class InstallResult:
    report: str
    lock: str
    packages: list[dict]
    scans: list[dict] = field(default_factory=list)
    downloaded_bytes: int = 0


def check_chat(chat: str) -> str:
    if not CHAT_ID.match(chat or ""):
        raise ValueError("chat must be a conversation id")
    return chat


def pypi_requirement(spec: str) -> str:
    """A requirement as pip takes it, or InstallError for one that names a URL, a path, a git address or an option."""
    spec = spec.strip()
    if not spec or not PYPI_REQUIREMENT.match(spec):
        raise InstallError(
            f"{spec or 'An empty requirement'} cannot be installed: only package names from PyPI, with versions "
            "such as pandas==2.2.3 or numpy>=2, are allowed; no URLs, paths, git addresses or options."
        )
    return spec


def npm_requirement(spec: str) -> tuple[str, str]:
    """(name, range) of an npm package such as "lodash@^4.17" or "@types/node", or InstallError."""
    spec = spec.strip()
    at = spec.rfind("@")
    name, wanted = (spec[:at], spec[at + 1 :]) if at > 0 else (spec, "latest")
    wanted = wanted.strip() or "latest"
    if not NPM_NAME.match(name) or not (NPM_TAG.match(wanted) or NPM_RANGE.match(wanted)) or ":" in wanted or "/" in wanted:
        raise InstallError(
            f"{spec or 'An empty package'} cannot be installed: only package names from the npm registry, with "
            "a version or range such as lodash@^4.17, are allowed; no URLs, paths, git addresses or aliases."
        )
    return name, wanted


def canonical(name: str) -> str:
    """A PyPI name as the index compares it."""
    return re.sub(r"[-_.]+", "-", name).lower()


def chat_dir(chat: str) -> Path:
    return CHATS / check_chat(chat)


def mounts(chat: str) -> dict[str, Path]:
    """The chat's package folders that exist, for the jail: {"python": ..., "node": ...}."""
    base = chat_dir(chat)
    found = {}
    if (base / "python").is_dir():
        found["python"] = base / "python"
    if (base / "node" / "node_modules").is_dir():
        found["node"] = base / "node" / "node_modules"
    return found


def touch(chat: str):
    base = chat_dir(chat)
    base.mkdir(parents=True, exist_ok=True)
    (base / ".used").touch()


def lock_hash(lock: str) -> str:
    return hashlib.sha256(lock.encode("utf-8")).hexdigest()


def installed_from(chat: str, ecosystem: str) -> str | None:
    marker = chat_dir(chat) / f"{ecosystem}.lock"
    return marker.read_text().strip() if marker.exists() else None


def folder_size(path: Path) -> int:
    total = 0
    for folder, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(folder, name)).st_size
            except OSError:
                pass
    return total


async def run(command: list[str], cwd: Path, env: dict) -> tuple[int, str]:
    """Runs a resolver; returns its exit code and what it printed."""
    process = await asyncio.create_subprocess_exec(
        *command, cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        output, _ = await process.communicate()
    except asyncio.CancelledError:
        process.kill()
        await process.wait()
        raise
    return process.returncode, output.decode("utf-8", "replace")


def tool_env(work: Path) -> dict:
    """The environment of pip and npm: none of the server's, with a home of their own."""
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(work), "LANG": "C.UTF-8", "PIP_CONFIG_FILE": os.devnull}


# --- Resolving: which files make up the packages


def tidy_pip_report(output: str, work: Path) -> str:
    """What pip printed, without the staging paths, and with the packages the image has built in on one line."""
    built_in = []
    lines = []
    for line in output.splitlines():
        line = re.sub(r"\s*\(from -r \S+ \(line \d+\)\)", "", line)
        line = re.sub(r" \(from [^)]*\)", "", line)
        found = re.match(r"Requirement already satisfied: (\S+?)[<>=!~;\s].* \(([^)]+)\)$", line)
        if found:
            built_in.append(f"{re.split(r'[<>=!~]', found.group(1))[0]} {found.group(2)}")
            continue
        lines.append(line.replace(str(work) + "/", ""))
    if built_in:
        lines.insert(0, "Already built in: " + ", ".join(dict.fromkeys(built_in)))
    return "\n".join(lines)


async def resolve_pypi(requirements: list[str], work: Path, pinned: bool) -> tuple[list[Item], str]:
    """The wheels pip picks for `requirements`, without the packages the image has built in. With `pinned`
    (a rebuild from a lock), exactly the pinned ones, without resolving dependencies again."""
    venv = work / "venv"
    code, output = await run(["python3", "-m", "venv", "--system-site-packages", "--without-pip", str(venv)], work, tool_env(work))
    if code != 0:
        raise RuntimeError(f"venv failed: {output}")
    (work / "requirements.txt").write_text("\n".join(requirements) + "\n")
    command = [
        "python3", "-m", "pip", "--python", str(venv / "bin" / "python"), "install",
        "--dry-run", "--report", str(work / "report.json"),
        "--only-binary=:all:", "--index-url", PYPI_INDEX, "--proxy", PROXY,
        "--isolated", "--no-input", "--no-cache-dir", "--disable-pip-version-check", "--progress-bar", "off",
        "-r", str(work / "requirements.txt"),
    ]
    if pinned:
        command.append("--no-deps")
    code, output = await run(command, work, tool_env(work))
    output = tidy_pip_report(output, work)
    if code != 0:
        if UNREACHABLE.search(output):
            raise InstallError("PyPI could not be reached; try again later.", report=output)
        hint = (
            " Only packages with a ready-built wheel for this system can be installed: building one from source "
            "would run its own setup code."
            if "satisfies the requirement" in output or "wheel" in output.lower()
            else ""
        )
        raise InstallError(f"pip could not install these packages.{hint}", report=output)
    report = json.loads((work / "report.json").read_text())
    items = []
    for entry in report.get("install", []):
        info = entry.get("download_info", {})
        hashes = info.get("archive_info", {}).get("hashes", {})
        if entry.get("is_direct") or "sha256" not in hashes:
            raise InstallError("A package would come from a URL rather than from PyPI, which is not allowed.", report=output)
        items.append(
            Item(
                name=entry["metadata"]["name"],
                version=entry["metadata"]["version"],
                url=info["url"],
                hash=hashes["sha256"],
                requested=bool(entry.get("requested")),
            )
        )
    return items, output


NPM_ARCH = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower(), platform.machine())


def fits_platform(entry: dict) -> bool:
    """Whether an npm package with os and cpu fields is for this system (linux, and this CPU)."""
    for key, value in (("os", "linux"), ("cpu", NPM_ARCH)):
        wanted = entry.get(key)
        if not wanted:
            continue
        allowed = [w for w in wanted if not w.startswith("!")]
        denied = [w[1:] for w in wanted if w.startswith("!")]
        if value in denied or (allowed and value not in allowed):
            return False
    return True


def npm_items(lock: dict, requested: set[str]) -> list[Item]:
    """The tarballs a package-lock.json names, for this system, each with where it goes in node_modules."""
    items = []
    for path, entry in lock.get("packages", {}).items():
        if not path:
            continue
        if entry.get("link") or not path.startswith("node_modules/") or "/../" in f"/{path}/":
            raise InstallError("A package would come from a local path, which is not allowed.")
        resolved, integrity = entry.get("resolved", ""), entry.get("integrity", "")
        if not resolved.startswith(NPM_REGISTRY) or not integrity.startswith("sha512-"):
            raise InstallError(f"{path} would come from {resolved or 'somewhere else'} rather than from the npm registry, which is not allowed.")
        if not fits_platform(entry):
            continue
        name = path.rsplit("node_modules/", 1)[-1]
        items.append(
            Item(
                name=name,
                version=str(entry.get("version", "")),
                url=resolved,
                hash=integrity,
                requested=path == f"node_modules/{name}" and name in requested,
                path=path,
                install_script=bool(entry.get("hasInstallScript")),
            )
        )
    return items


async def resolve_npm(packages: dict[str, str], work: Path) -> tuple[dict, str]:
    """The package-lock.json npm makes for `packages`, from the registry's metadata only: nothing is downloaded or run."""
    project = work / "node"
    project.mkdir()
    (project / "package.json").write_text(json.dumps({"name": "chat-packages", "version": "1.0.0", "private": True, "dependencies": packages}))
    (work / ".npmrc").write_text("")
    command = [
        "npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier",
        "--registry", NPM_REGISTRY, "--proxy", PROXY, "--https-proxy", PROXY,
        "--cache", str(work / "npm-cache"), "--userconfig", str(work / ".npmrc"), "--loglevel", "warn",
    ]
    code, output = await run(command, project, tool_env(work))
    if code != 0:
        if UNREACHABLE.search(output):
            raise InstallError("The npm registry could not be reached; try again later.", report=output)
        raise InstallError("npm could not resolve these packages.", report=output)
    return json.loads((project / "package-lock.json").read_text()), output


# --- Fetching: the package files, from the cache or downloaded and checked against their hash


def cache_path(ecosystem: str, item: Item) -> Path:
    if ecosystem == "pypi":
        return CACHE / "pypi" / item.hash / item.filename
    digest = base64.b64decode(item.hash.removeprefix("sha512-")).hex()
    return CACHE / "npm" / f"{digest}.tgz"


def download(ecosystem: str, item: Item, target: Path, budget: int) -> tuple[int, str]:
    """Downloads `item` through the egress proxy; returns its size and its hash in the form of `item.hash`."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": PROXY, "http": PROXY}))
    sha256, sha512 = hashlib.sha256(), hashlib.sha512()
    size = 0
    with opener.open(urllib.request.Request(item.url, headers={"User-Agent": "llmlynx-code"}), timeout=60) as response:
        if urlparse(response.geturl()).hostname not in FILE_HOSTS.values():
            raise InstallError(f"{item.name} was redirected away from the package index.")
        with open(target, "wb") as f:
            while chunk := response.read(1 << 20):
                size += len(chunk)
                if size > budget:
                    raise InstallError(f"The packages are larger than {MAX_DOWNLOAD_GB:g} GB to download.")
                sha256.update(chunk)
                sha512.update(chunk)
                f.write(chunk)
    found = sha256.hexdigest() if ecosystem == "pypi" else "sha512-" + base64.b64encode(sha512.digest()).decode()
    return size, found


async def fetch(ecosystem: str, items: list[Item], work: Path) -> tuple[dict[str, Path], dict[Path, Path], int]:
    """Each item's file: from the cache, or downloaded into `work` and checked against its hash. Returns the
    paths by item, the downloads by their place in the cache (see keep), and how many bytes were downloaded."""
    paths, downloads, downloaded = {}, {}, 0
    for item in items:
        if urlparse(item.url).hostname != FILE_HOSTS[ecosystem]:
            raise InstallError(f"{item.name} would come from {urlparse(item.url).hostname}, which is not allowed.")
        cached = cache_path(ecosystem, item)
        if cached.exists() or cached in downloads:
            paths[item.path or item.name] = downloads.get(cached, cached)
            continue
        # Under its own name, which pip goes by
        temp = work / "downloads" / uuid.uuid4().hex / item.filename
        temp.parent.mkdir(parents=True)
        size, found = await asyncio.to_thread(download, ecosystem, item, temp, MAX_DOWNLOAD_BYTES - downloaded)
        downloaded += size
        if found != item.hash:
            raise InstallError(f"{item.filename} does not match the hash the index states, so it was not installed.")
        downloads[cached] = temp
        paths[item.path or item.name] = temp
    return paths, downloads, downloaded


def keep(downloads: dict[Path, Path]):
    """The downloads of an install whose files all passed the scan go into the cache."""
    for cached, temp in downloads.items():
        cached.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temp, cached)


# --- Installing: unpacking into a staging folder, which then replaces the chat's packages


async def unpack_pypi(items: list[Item], paths: dict[str, Path], target: Path, work: Path):
    """pip unpacks the wheels into `target`; installing a wheel runs none of its code. Without bytecode, which
    compile_bytecode makes once the files passed the scan."""
    if not items:
        target.mkdir(parents=True)
        return
    command = [
        "python3", "-m", "pip", "install", "--no-index", "--no-deps", "--only-binary=:all:", "--target", str(target),
        "--no-compile", "--isolated", "--disable-pip-version-check", "--no-warn-script-location", "--progress-bar", "off",
        *[str(paths[item.name]) for item in items],
    ]
    code, output = await run(command, work, tool_env(work))
    if code != 0:
        raise InstallError("pip could not unpack the packages.", report=output)


async def compile_bytecode(target: Path, work: Path):
    """The bytecode of the Python files in `target`, as pip would make it, with the paths a run sees.
    Compiling runs none of their code; a file that does not compile is left as it is, as pip does."""
    command = [
        "python3", "-m", "compileall", "-qq", "-j", "2", "-s", str(target), "-p", RUN_PYTHON_PACKAGES, str(target),
    ]
    await run(command, work, tool_env(work))


def unpack_tarball(tarball: Path, target: Path):
    """An npm tarball's files into `target`, without its top folder ("package/"); links and devices are left out."""
    with tarfile.open(tarball, "r:gz") as archive:
        for member in archive.getmembers():
            parts = member.name.split("/", 1)
            if len(parts) < 2 or not parts[1] or not (member.isfile() or member.isdir()):
                continue
            member.name = parts[1]
            archive.extract(member, target, filter="data")


def link_bins(node_modules: Path):
    """node_modules/.bin, as npm makes it, for the packages at the top of node_modules."""
    bins = node_modules / ".bin"
    for manifest in sorted(node_modules.glob("*/package.json")) + sorted(node_modules.glob("@*/*/package.json")):
        package = manifest.parent
        try:
            info = json.loads(manifest.read_text())
        except (OSError, ValueError):
            continue
        entries = info.get("bin")
        if isinstance(entries, str):
            entries = {str(info.get("name", package.name)).split("/")[-1]: entries}
        if not isinstance(entries, dict):
            continue
        for name, rel in entries.items():
            if not isinstance(rel, str) or "/" in name or name.startswith("."):
                continue
            script = (package / rel).resolve()
            if not script.is_file() or node_modules.resolve() not in script.parents:
                continue
            bins.mkdir(exist_ok=True)
            script.chmod(0o755)
            link = bins / name
            if not link.exists():
                link.symlink_to(os.path.relpath(script, bins))


def unpack_npm(items: list[Item], paths: dict[str, Path], lock: dict, packages: dict[str, str], target: Path):
    node_modules = target / "node_modules"
    node_modules.mkdir(parents=True)
    for item in sorted(items, key=lambda i: i.path.count("node_modules/")):
        unpack_tarball(paths[item.path], target / item.path)
    link_bins(node_modules)
    (target / "package.json").write_text(json.dumps({"name": "chat-packages", "private": True, "dependencies": packages}))
    (target / "package-lock.json").write_text(json.dumps(lock))


# --- Scanning: each file of the unpacked packages on its own, as a run will see it


@dataclass
class Scanned:
    """What clamd said of one file."""

    path: str  # in the staged folder
    hash: str  # SHA-256
    status: str  # clean, virus or unchecked
    ms: int
    signature: str = ""
    why: str = ""  # why it is not checked


def clean_mark(digest: str) -> Path:
    return CLEAN / digest[:2] / digest


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def unscanned(folder: Path) -> list[tuple[str, Path, int, str]]:
    """The files in `folder` that were not scanned clean before: (path in it, path, size, SHA-256). Links (to
    files in it: see link_bins) and empty files are left out."""
    found = []
    for parent, _dirs, names in os.walk(folder):
        for name in names:
            path = Path(parent, name)
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
                continue
            digest = sha256_of(path)
            if not clean_mark(digest).exists():
                found.append((path.relative_to(folder).as_posix(), path, info.st_size, digest))
    return found


async def scan_one(rel: str, path: Path, size: int, digest: str) -> Scanned:
    """Scans one file; one that is clean is marked so, by its hash, for the next install."""
    started = time.monotonic()
    if size > clamd.MAX_STREAM_BYTES:
        return Scanned(rel, digest, "unchecked", 0, why=f"it is larger than the {clamd.MAX_STREAM_BYTES / 1e9:.0f} GB the virus scanner takes")
    try:
        signature = await clamd.scan_file(str(path))
    except clamd.ScanError as err:
        return Scanned(rel, digest, "unchecked", round((time.monotonic() - started) * 1000), why=str(err))
    ms = round((time.monotonic() - started) * 1000)
    if signature is None:
        mark = clean_mark(digest)
        mark.parent.mkdir(parents=True, exist_ok=True)
        mark.touch()
        return Scanned(rel, digest, "clean", ms)
    limit = clamd.limit_exceeded(signature)
    if limit:
        return Scanned(rel, digest, "unchecked", ms, signature=signature, why=limit)
    return Scanned(rel, digest, "virus", ms, signature=signature)


def pypi_owners(target: Path, items: list[Item]) -> dict[str, Item]:
    """The wheel each installed file came from, by the RECORD pip wrote for it. For the log only: every file
    is scanned all the same."""
    by_dist = {(canonical(i.name), i.version): i for i in items}
    owners = {}
    for record in target.glob("*.dist-info/RECORD"):
        name, _, version = record.parent.name.removesuffix(".dist-info").rpartition("-")
        item = by_dist.get((canonical(name), version))
        if not item:
            continue
        for row in csv.reader(record.read_text(errors="replace").splitlines()):
            if not row:
                continue
            path = os.path.normpath(row[0])
            # Scripts, which pip puts in bin/ of the target: "../../bin/<name>"
            owners[f"bin/{os.path.basename(path)}" if path.startswith("../") else path] = item
    return owners


def npm_owner(items: list[Item]):
    """The tarball each unpacked file came from: the innermost package folder it is in."""
    by_path = {i.path: i for i in items}

    def owner(rel: str) -> Item | None:
        parts = rel.split("/")
        for end in range(len(parts) - 1, 0, -1):
            item = by_path.get("/".join(parts[:end]))
            if item:
                return item
        return None

    return owner


def scan_log(results: list[Scanned], owner) -> list[dict]:
    """What was scanned, for the app's audit log: one entry per package file with how its files fared; a
    file of no package (one pip or this code wrote) only when it is not clean."""
    rank = {"clean": 0, "unchecked": 1, "virus": 2}
    entries: dict[str, dict] = {}
    for result in results:
        item = owner(result.path)
        if item is None and result.status == "clean":
            continue
        key = item.filename if item else result.path
        entry = entries.setdefault(key, {"file": key, "hash": item.hash if item else result.hash, "status": "clean", "ms": 0, "files": 0})
        entry["ms"] += result.ms
        entry["files"] += 1
        if rank[result.status] > rank[entry["status"]]:
            entry["status"] = result.status
            if result.signature:
                entry["signature"] = result.signature
    return list(entries.values())


async def scan_folder(folder: Path, owner) -> list[dict]:
    """Scans each file in `folder` that was not scanned clean before, SCAN_STREAMS at a time. Returns the log
    of the scans (scan_log); raises InstallError when a file is not clean, and then scans no more."""
    pending = list(reversed(await asyncio.to_thread(unscanned, folder)))
    results: list[Scanned] = []
    failed: list[Scanned] = []

    async def worker():
        while pending and not failed:
            result = await scan_one(*pending.pop())
            results.append(result)
            if result.status != "clean":
                failed.append(result)

    await asyncio.gather(*(worker() for _ in range(SCAN_STREAMS)))
    scans = scan_log(results, owner)
    if failed:
        bad = failed[0]
        item = owner(bad.path)
        where = f"{bad.path} (from {item.filename})" if item else bad.path
        if bad.status == "virus":
            raise InstallError(f"{where} was flagged as malware ({bad.signature}), so nothing was installed.", scans=scans)
        raise InstallError(f"{where} could not be checked for viruses ({bad.why}), so nothing was installed.", scans=scans)
    return scans


def swap_in(chat: str, ecosystem: str, staged: Path, lock: str):
    """The staged folder becomes the chat's packages of `ecosystem`, in one rename."""
    base = chat_dir(chat)
    base.mkdir(parents=True, exist_ok=True)
    final = base / FOLDERS[ecosystem]
    old = base / f".old-{uuid.uuid4().hex}"
    if final.exists():
        os.replace(final, old)
    os.replace(staged, final)
    (base / f"{ecosystem}.lock").write_text(lock_hash(lock))
    shutil.rmtree(old, ignore_errors=True)


def other_size(chat: str, ecosystem: str) -> int:
    other = chat_dir(chat) / FOLDERS["npm" if ecosystem == "pypi" else "pypi"]
    return folder_size(other) if other.exists() else 0


def check_size(chat: str, ecosystem: str, staged: Path, scans: list[dict]):
    if folder_size(staged) + other_size(chat, ecosystem) > MAX_INSTALLED_BYTES:
        raise InstallError(f"The chat's packages would take more than {MAX_INSTALLED_GB:g} GB; nothing was installed.", scans=scans)


async def install(chat: str, ecosystem: str, requested: list[str], lock: str | None = None) -> InstallResult:
    """Installs the chat's packages of `ecosystem`: all of `requested` (everything the chat asked for so far),
    resolved again, or with `lock`, exactly the packages of that lock (a rebuild). Within INSTALL_SECONDS."""
    check_chat(chat)
    if ecosystem not in ECOSYSTEMS:
        raise ValueError("ecosystem must be pypi or npm")
    if len(requested) > MAX_PACKAGES * 4:
        raise InstallError("Too many packages at once.")
    STAGING.mkdir(parents=True, exist_ok=True)
    work = STAGING / uuid.uuid4().hex
    work.mkdir()
    try:
        return await asyncio.wait_for(_install(chat, ecosystem, requested, lock, work), INSTALL_SECONDS)
    except asyncio.TimeoutError:
        raise InstallError(f"The install took longer than {INSTALL_SECONDS // 60} minutes and was stopped; nothing was installed.")
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def _install(chat: str, ecosystem: str, requested: list[str], lock: str | None, work: Path) -> InstallResult:
    staged = work / "staged"
    warnings = []
    if ecosystem == "pypi":
        specs = [pypi_requirement(s) for s in (lock.splitlines() if lock else requested) if s.strip()]
        items, report = await resolve_pypi(specs, work, pinned=lock is not None)
        paths, downloads, downloaded = await fetch("pypi", items, work)
        await unpack_pypi(items, paths, staged, work)
        check_size(chat, ecosystem, staged, [])
        scans = await scan_folder(staged, pypi_owners(staged, items).get)
        await compile_bytecode(staged, work)
        new_lock = "\n".join(sorted(f"{i.name}=={i.version}" for i in items))
    else:
        wanted = dict(npm_requirement(s) for s in requested)
        if lock:
            lock_data, report = json.loads(lock), ""
        else:
            lock_data, report = await resolve_npm(wanted, work)
        items = npm_items(lock_data, set(wanted))
        paths, downloads, downloaded = await fetch("npm", items, work)
        await asyncio.to_thread(unpack_npm, items, paths, lock_data, wanted, staged)
        check_size(chat, ecosystem, staged, [])
        scans = await scan_folder(staged, npm_owner(items))
        new_lock = json.dumps(lock_data)
        scripted = sorted({i.name for i in items if i.install_script})
        if scripted:
            warnings.append(
                "These packages have install scripts, which did not run, so they may not work: " + ", ".join(scripted) + "."
            )
    # With the bytecode
    check_size(chat, ecosystem, staged, scans)
    keep(downloads)
    swap_in(chat, ecosystem, staged, new_lock)
    touch(chat)
    packages = [{"name": i.name, "version": i.version, "requested": i.requested} for i in items]
    text = "\n".join(filter(None, [report.strip()[-MAX_REPORT_CHARS:], *warnings]))
    return InstallResult(report=text, lock=new_lock, packages=packages, scans=scans, downloaded_bytes=downloaded)


async def ensure(chat: str, locks: dict[str, dict]) -> list[str]:
    """Installs the chat's packages again where they are missing or differ from the chat's locks
    ({ecosystem: {"requested": [...], "lock": ...}}). Returns the ecosystems it installed."""
    reinstalled = []
    for ecosystem, entry in locks.items():
        if ecosystem not in ECOSYSTEMS or not entry.get("lock"):
            continue
        if installed_from(chat, ecosystem) == lock_hash(entry["lock"]) and (chat_dir(chat) / FOLDERS[ecosystem]).exists():
            continue
        await install(chat, ecosystem, list(entry.get("requested", [])), lock=entry["lock"])
        reinstalled.append(ecosystem)
    return reinstalled


def forget(chats: list[str]):
    """Removes the packages of deleted chats."""
    for chat in chats:
        if CHAT_ID.match(chat or ""):
            shutil.rmtree(CHATS / chat, ignore_errors=True)


def sweep(now: float | None = None):
    """Removes the packages of chats that did not use them for UNUSED_DAYS, and staging left by a restart."""
    now = now or time.time()
    if CHATS.exists():
        for base in CHATS.iterdir():
            used = base / ".used"
            last = used.stat().st_mtime if used.exists() else base.stat().st_mtime
            if now - last > UNUSED_DAYS * 86400:
                shutil.rmtree(base, ignore_errors=True)
    if STAGING.exists():
        for work in STAGING.iterdir():
            # Never one of an install that may still run
            if now - work.stat().st_mtime > INSTALL_SECONDS + 600:
                shutil.rmtree(work, ignore_errors=True)
