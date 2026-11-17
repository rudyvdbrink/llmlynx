"""Packages per chat, from PyPI and npm, for the chat's runs.

Installing and running are kept apart: an install reaches the internet but
runs no package code, a run executes package code but has no network.

- No package code during an install. Python packages are only installed
  ready-built (wheels), which pip unpacks without running anything. npm
  packages are unpacked from their tarballs here, so their install scripts
  never run; the model is told which packages have one.
- Only PyPI and the npm registry. The resolvers (pip and npm, which only read
  metadata) and the downloads go through the egress proxy, which reaches
  pypi.org, files.pythonhosted.org and registry.npmjs.org and nothing else.
  Every file to install must come from those hosts, with the hash the index
  states.
- Scanned first. Every file that is not in the cache yet is downloaded into a
  staging folder, checked against its hash and scanned by clamd. Only when all
  of them are clean is anything installed: into a staging folder, which then
  replaces the chat's packages. ClamAV scans inside the archives.
- Kept, but rebuildable. The shared cache keeps the files that passed, by
  their hash, so a file is not downloaded and scanned twice; no run sees it.
  A chat's packages are kept until the chat is deleted or did not use them for
  UNUSED_DAYS; the next run installs them again from the chat's lock.

Layout of PACKAGES_DIR (a volume of its own):
  chats/<chat>/python/            pip --target: what PYTHONPATH points to in a run
  chats/<chat>/node/node_modules/ mounted at /node_modules in a run
  chats/<chat>/<ecosystem>.lock   the SHA-256 of the lock the folder was installed from
  chats/<chat>/.used              touched by every run and install
  cache/pypi/<sha256>/<wheel>, cache/npm/<sha512 hex>.tgz
  staging/                        downloads and installs in progress
"""

import asyncio
import base64
import hashlib
import json
import os
import platform
import re
import shutil
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
STAGING = PACKAGES_DIR / "staging"
PROXY = os.environ.get("PACKAGES_PROXY", "")

PYPI_INDEX = "https://pypi.org/simple"
NPM_REGISTRY = "https://registry.npmjs.org/"
FILE_HOSTS = {"pypi": "files.pythonhosted.org", "npm": "registry.npmjs.org"}

# Limits of an install
MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024
INSTALL_SECONDS = 300
MAX_INSTALLED_BYTES = 1024 * 1024 * 1024
UNUSED_DAYS = 30
MAX_PACKAGES = 50  # asked for in one install
MAX_REPORT_CHARS = 20_000

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


# --- Fetching: the files, from the cache or downloaded, checked and scanned


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
                    raise InstallError(f"The packages are larger than {MAX_DOWNLOAD_BYTES // 1024 // 1024} MB to download.")
                sha256.update(chunk)
                sha512.update(chunk)
                f.write(chunk)
    found = sha256.hexdigest() if ecosystem == "pypi" else "sha512-" + base64.b64encode(sha512.digest()).decode()
    return size, found


async def fetch(ecosystem: str, items: list[Item], work: Path) -> tuple[dict[str, Path], list[dict], int]:
    """Each item's file in the cache: downloaded, checked against its hash and scanned first when it is not
    there yet. Returns the paths by item, what was scanned, and how many bytes were downloaded."""
    paths, scans, downloaded = {}, [], 0
    for item in items:
        if urlparse(item.url).hostname != FILE_HOSTS[ecosystem]:
            raise InstallError(f"{item.name} would come from {urlparse(item.url).hostname}, which is not allowed.")
        cached = cache_path(ecosystem, item)
        if cached.exists():
            paths[item.path or item.name] = cached
            continue
        temp = work / f"download-{uuid.uuid4().hex}"
        size, found = await asyncio.to_thread(download, ecosystem, item, temp, MAX_DOWNLOAD_BYTES - downloaded)
        downloaded += size
        if found != item.hash:
            raise InstallError(f"{item.filename} does not match the hash the index states, so it was not installed.", scans=scans)
        started = time.monotonic()
        try:
            signature = await clamd.scan_file(str(temp))
        except clamd.ScanError as err:
            scans.append({"file": item.filename, "hash": item.hash, "status": "unchecked", "ms": round((time.monotonic() - started) * 1000)})
            raise InstallError(f"{item.filename} could not be checked for viruses ({err}), so nothing was installed.", scans=scans)
        ms = round((time.monotonic() - started) * 1000)
        if signature:
            scans.append({"file": item.filename, "hash": item.hash, "status": "virus", "signature": signature, "ms": ms})
            raise InstallError(f"{item.filename} was flagged as malware ({signature}), so nothing was installed.", scans=scans)
        scans.append({"file": item.filename, "hash": item.hash, "status": "clean", "ms": ms})
        cached.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temp, cached)
        paths[item.path or item.name] = cached
    return paths, scans, downloaded


# --- Installing: unpacking into a staging folder, which then replaces the chat's packages


async def unpack_pypi(items: list[Item], paths: dict[str, Path], target: Path, work: Path):
    """pip unpacks the wheels into `target`; installing a wheel runs none of its code."""
    if not items:
        target.mkdir(parents=True)
        return
    command = [
        "python3", "-m", "pip", "install", "--no-index", "--no-deps", "--only-binary=:all:", "--target", str(target),
        "--isolated", "--disable-pip-version-check", "--no-warn-script-location", "--progress-bar", "off",
        *[str(paths[item.name]) for item in items],
    ]
    code, output = await run(command, work, tool_env(work))
    if code != 0:
        raise InstallError("pip could not unpack the packages.", report=output)


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
        paths, scans, downloaded = await fetch("pypi", items, work)
        await unpack_pypi(items, paths, staged, work)
        new_lock = "\n".join(sorted(f"{i.name}=={i.version}" for i in items))
    else:
        wanted = dict(npm_requirement(s) for s in requested)
        if lock:
            lock_data, report = json.loads(lock), ""
        else:
            lock_data, report = await resolve_npm(wanted, work)
        items = npm_items(lock_data, set(wanted))
        paths, scans, downloaded = await fetch("npm", items, work)
        await asyncio.to_thread(unpack_npm, items, paths, lock_data, wanted, staged)
        new_lock = json.dumps(lock_data)
        scripted = sorted({i.name for i in items if i.install_script})
        if scripted:
            warnings.append(
                "These packages have install scripts, which did not run, so they may not work: " + ", ".join(scripted) + "."
            )
    size = folder_size(staged) + other_size(chat, ecosystem)
    if size > MAX_INSTALLED_BYTES:
        raise InstallError(f"The chat's packages would take more than {MAX_INSTALLED_BYTES // 1024 // 1024} MB; nothing was installed.", scans=scans)
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
            if now - work.stat().st_mtime > 3600:
                shutil.rmtree(work, ignore_errors=True)
