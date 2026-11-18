"""MCP server (stateless Streamable HTTP on POST /mcp) that runs code, installs packages and runs git for llmlynx's chats.

Each run gets a jail of its own (see jail.py) with a copy of its chat's files,
in a new, empty folder, and sends back the files it made, changed or deleted:
the container keeps none of a chat's files between runs. Only the chats'
installed packages are kept, on a volume of their own (see packages.py). git
runs the same way, on a repository's files and its .git folder (see gitrepo.py).

One run, install or git command at a time per chat, and CODE_MAX_CONCURRENCY on the whole
container; more wait their turn. Each run is pinned to a CPU core of its own.
Every /mcp request needs the bearer token from MCP_AUTH_TOKEN. GET /health
answers without one. The container has no network of its own but to the egress
proxy (for installs, and for git's downloads) and clamd (to scan what installs
download).
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from typing import Annotated
from urllib.parse import quote

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import BlobResourceContents, EmbeddedResource, TextContent
from pydantic import BaseModel, Field

import gitrepo
import jail
import packages

PORT = int(os.environ.get("PORT", "8080"))
# Read once and taken out of the environment, so that nothing this server starts gets it
TOKEN = os.environ.pop("MCP_AUTH_TOKEN", "")
MAX_CONCURRENCY = max(1, int(os.environ.get("CODE_MAX_CONCURRENCY") or "2"))
# A sandbox of 100 MB is about 135 MB as base64, with the code and the JSON around it; or a
# repository's files and its .git folder, which the app keeps to 140 MB together (see src/server/sandbox/git.ts)
MAX_BODY_BYTES = 200 * 1024 * 1024
MAX_CODE_CHARS = 200_000
SWEEP_SECONDS = 6 * 3600

log = logging.getLogger("llmlynx-code")

if not TOKEN:
    print("MCP_AUTH_TOKEN is not set; not starting without a token.", file=sys.stderr)
    sys.exit(1)

# Compares hashes, so the comparison takes as long whatever the token's length
_digest = lambda s: hashlib.sha256(s).digest()  # noqa: E731
TOKEN_DIGEST = _digest(f"Bearer {TOKEN}".encode())

CORES = sorted(os.sched_getaffinity(0))
# The places on the server: each holds a CPU core for the run that takes it
_places: asyncio.Queue | None = None
_chat_locks: dict[str, asyncio.Lock] = {}


def places() -> asyncio.Queue:
    global _places
    if _places is None:
        _places = asyncio.Queue()
        for index in range(MAX_CONCURRENCY):
            _places.put_nowait(CORES[index % len(CORES)])
    return _places


@asynccontextmanager
async def turn(chat: str):
    """One run, install or git command at a time per chat, and MAX_CONCURRENCY at once; yields the CPU core to use."""
    lock = _chat_locks.setdefault(chat, asyncio.Lock())
    async with lock:
        core = await places().get()
        try:
            yield core
        finally:
            places().put_nowait(core)


class FileIn(BaseModel):
    path: str
    data: str  # base64


class LockIn(BaseModel):
    requested: list[str] = []
    lock: str


def decode_files(files: list[FileIn]) -> list[tuple[str, bytes]]:
    """The chat's files from the request, by checked path; a path twice (without case) is refused."""
    decoded, seen = [], set()
    for f in files:
        path = jail.safe_path(f.path)
        if path is None or path.lower() in seen:
            raise ToolError(f"Not a valid file path: {f.path}")
        seen.add(path.lower())
        decoded.append((path, base64.b64decode(f.data, validate=True)))
    return decoded


server = MCPServer(name="llmlynx-code", version="1.0.0")


@server.tool(
    description=(
        "Runs code in a new jail with the chat's files in its folder, in its folder `cwd` of those files when given. "
        "Returns JSON: { status, exit_code, reason, "
        "output, printed_bytes, duration_ms, changed, deleted, skipped, reinstalled }, and the changed files as "
        "embedded resources (file:///<path>)."
    ),
    structured_output=False,
)
async def code_run(
    chat: Annotated[str, Field(description="The conversation's id")],
    language: Annotated[str, Field(description="python, javascript, typescript or shell")],
    code: str,
    files: list[FileIn] = [],  # noqa: B006
    locks: dict[str, LockIn] = {},  # noqa: B006
    cwd: Annotated[str, Field(description="A folder of the chat's files to run in; empty for the sandbox folder")] = "",
) -> list:
    try:
        packages.check_chat(chat)
    except ValueError as err:
        raise ToolError(str(err))
    folder = jail.safe_path(cwd) if cwd.strip() else ""
    if folder is None:
        raise ToolError(f"Not a valid folder: {cwd}")
    if language not in jail.LANGUAGES:
        raise ToolError(f"language must be one of: {', '.join(jail.LANGUAGES)}")
    if len(code) > MAX_CODE_CHARS:
        raise ToolError("The code is too long.")
    chat_files = decode_files(files)
    async with turn(chat) as core:
        reinstalled = []
        try:
            reinstalled = await packages.ensure(chat, {k: v.model_dump() for k, v in locks.items()})
        except packages.InstallError as err:
            raise ToolError(f"The chat's packages could not be installed again: {err}")
        packages.touch(chat)
        try:
            result = await jail.run_code(language, code, chat_files, core, packages.mounts(chat), folder)
        except jail.JailError as err:
            log.error("A run failed: %s", err)
            raise ToolError("The sandbox could not run the code.")
    summary = {
        "status": result.status,
        "exit_code": result.exit_code,
        "reason": result.reason,
        "output": result.output,
        "printed_bytes": result.printed_bytes,
        "duration_ms": result.duration_ms,
        "changed": [path for path, _ in result.changed],
        "deleted": result.deleted,
        "skipped": result.skipped,
        "reinstalled": reinstalled,
    }
    content: list = [TextContent(text=json.dumps(summary))]
    for path, data in result.changed:
        content.append(
            EmbeddedResource(
                resource=BlobResourceContents(
                    uri=f"file:///{quote(path)}",
                    mime_type="application/octet-stream",
                    blob=jail.encode_file(path, data)["data"],
                )
            )
        )
    return content


@server.tool(
    description=(
        "Installs the chat's packages of one ecosystem (pypi or npm): all of `requested`, or exactly those of "
        "`lock`. Returns JSON: { ok, error?, report, lock, packages: [{ name, version, requested }], scans, "
        "downloaded_bytes, duration_ms }."
    ),
    structured_output=False,
)
async def code_install(
    chat: Annotated[str, Field(description="The conversation's id")],
    ecosystem: Annotated[str, Field(description="pypi or npm")],
    requested: list[str],
    lock: str | None = None,
) -> str:
    try:
        packages.check_chat(chat)
    except ValueError as err:
        raise ToolError(str(err))
    if ecosystem not in packages.ECOSYSTEMS:
        raise ToolError("ecosystem must be pypi or npm")
    started = time.monotonic()
    async with turn(chat):
        try:
            result = await packages.install(chat, ecosystem, requested, lock)
        except packages.InstallError as err:
            return json.dumps(
                {"ok": False, "error": str(err), "report": err.report[-packages.MAX_REPORT_CHARS :], "scans": err.scans,
                 "duration_ms": round((time.monotonic() - started) * 1000)}
            )
        except Exception:
            log.exception("An install failed")
            raise ToolError("The packages could not be installed.")
    return json.dumps(
        {
            "ok": True,
            "report": result.report,
            "lock": result.lock,
            "packages": result.packages,
            "scans": result.scans,
            "downloaded_bytes": result.downloaded_bytes,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
    )


@server.tool(
    description=(
        "Runs a git command on one of the chat's repositories: `argv` without \"git\", `files` its work tree, `git` its "
        ".git folder as a gzipped tar (none for clone and init), `folder` its folder in the sandbox. Returns JSON: "
        "{ status, exit_code, reason, output, duration_ms, changed, deleted, skipped, repo }, the changed files as "
        "embedded resources (file:///<path>), and the .git folder when it is new or changed (git:///repo.tar.gz)."
    ),
    structured_output=False,
)
async def code_git(
    chat: Annotated[str, Field(description="The conversation's id")],
    argv: list[str],
    files: list[FileIn] = [],  # noqa: B006
    git: str | None = None,
    folder: str = "",
) -> list:
    try:
        packages.check_chat(chat)
        command = gitrepo.parse(argv)
    except (ValueError, gitrepo.GitError) as err:
        raise ToolError(str(err))
    work_tree = decode_files(files)
    if any(part.lower() == ".git" for path, _ in work_tree for part in path.split("/")):
        raise ToolError("A file of the work tree is in a .git folder.")
    repo = base64.b64decode(git, validate=True) if git else None
    async with turn(chat) as core:
        try:
            result = await gitrepo.run(command, work_tree, repo, core, folder)
        except gitrepo.GitError as err:
            raise ToolError(str(err))
        except jail.JailError as err:
            log.error("A git command failed: %s", err)
            raise ToolError("The sandbox could not run git.")
    summary = {
        "status": result.status,
        "exit_code": result.exit_code,
        "reason": result.reason,
        "output": result.output,
        "duration_ms": result.duration_ms,
        "changed": [path for path, _ in result.changed],
        "deleted": result.deleted,
        "skipped": result.skipped,
        "repo": result.repo,
    }
    content: list = [TextContent(text=json.dumps(summary))]
    for path, data in result.changed:
        content.append(
            EmbeddedResource(
                resource=BlobResourceContents(uri=f"file:///{quote(path)}", mime_type="application/octet-stream", blob=gitrepo.encode(data))
            )
        )
    if result.git is not None:
        content.append(
            EmbeddedResource(
                resource=BlobResourceContents(uri="git:///repo.tar.gz", mime_type="application/gzip", blob=gitrepo.encode(result.git))
            )
        )
    return content


@server.tool(description="Removes the installed packages of deleted chats.", structured_output=False)
async def code_forget(chats: list[str]) -> str:
    await asyncio.to_thread(packages.forget, chats)
    return "Removed."


async def _respond(send, status: int, body: dict):
    payload = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": payload})


class Gate:
    """Answers /health, and lets only requests with the token, of at most MAX_BODY_BYTES, through to /mcp."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        if path == "/health" and scope["method"] == "GET":
            return await _respond(send, 200, {"status": "ok"})
        if path != "/mcp":
            return await _respond(send, 404, {"error": "Not found"})
        headers = dict(scope["headers"])
        if not hmac.compare_digest(_digest(headers.get(b"authorization", b"")), TOKEN_DIGEST):
            return await _respond(send, 401, {"jsonrpc": "2.0", "error": {"code": -32000, "message": "Unauthorized"}, "id": None})
        return await self.app(scope, receive, send)


app = server.streamable_http_app(
    stateless_http=True,
    # Each answer as a stream (SSE) that starts at once and carries a ping every 15 seconds
    # (sse-starlette) until the result: an install may take an hour, and the app's fetch gives
    # up on an answer that has not started within 5 minutes, code-egress on a connection that
    # stays silent for 15
    json_response=False,
    max_request_body_size=MAX_BODY_BYTES,
    # The bearer token already keeps out what DNS rebinding could send; the
    # Host header the app sends depends on the published port
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    host="0.0.0.0",
)


def sweeper():
    """Removes the packages of chats that did not use them for CODE_PACKAGES_EXPIRE_DAYS, now and then."""
    while True:
        try:
            packages.sweep()
        except Exception:
            log.exception("Removing unused packages failed")
        time.sleep(SWEEP_SECONDS)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    problem = asyncio.run(jail.self_test())
    if problem:
        log.error(
            "bubblewrap cannot make a jail here, so no code can run: %s. The container needs the seccomp profile "
            "of tools/code (user namespaces and mounts in them), systempaths=unconfined (a /proc of its own), and "
            "a host without an AppArmor profile that forbids mounts.",
            problem,
        )
    threading.Thread(target=sweeper, daemon=True).start()
    print(f"llmlynx-code listening on :{PORT}, {MAX_CONCURRENCY} at once", flush=True)
    uvicorn.run(Gate(app), host="0.0.0.0", port=PORT, log_level="warning")
