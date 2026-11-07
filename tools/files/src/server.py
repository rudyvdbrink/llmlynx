"""MCP server (stateless Streamable HTTP on POST /mcp) for llmlynx's file tools.

Files come in and go out as base64 in the calls (see common.py): the server
keeps nothing and fetches nothing. Every /mcp request needs the bearer token
from MCP_AUTH_TOKEN. GET /health answers without one.
"""

import hashlib
import hmac
import json
import logging
import os
import sys
import threading
from typing import Annotated

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field

from common import decode_file
from convert import convert, prepare_image, render_pdf
from create import create_document, create_spreadsheet, create_text
from edit import edit_file

PORT = int(os.environ.get("PORT", "8080"))
TOKEN = os.environ.get("MCP_AUTH_TOKEN", "")
# A 20 MB file is about 27 MB as base64
MAX_BODY_BYTES = 40 * 1024 * 1024
# Converting large files takes memory: one at a time per CPU, as the server may be a Raspberry Pi
WORKERS = threading.BoundedSemaphore(int(os.environ.get("FILES_MAX_CONCURRENCY", "2")))

log = logging.getLogger("llmlynx-files")

if not TOKEN:
    print("MCP_AUTH_TOKEN is not set; not starting without a token.", file=sys.stderr)
    sys.exit(1)

# Compares hashes, so the comparison takes as long whatever the token's length
_digest = lambda s: hashlib.sha256(s).digest()  # noqa: E731
TOKEN_DIGEST = _digest(f"Bearer {TOKEN}".encode())


def run(name: str, work):
    """Runs a tool's work. Errors meant for the model become its result; anything else is logged and kept vague."""
    with WORKERS:
        try:
            return work()
        except ToolError:
            raise
        except Exception:
            log.exception("%s failed", name)
            raise ToolError("The file could not be handled.")


FileName = Annotated[str, Field(description="The file's name, with its extension")]
FileData = Annotated[str, Field(description="The file, base64")]


class Edit(BaseModel):
    find: str
    replace: str
    all: bool = False


class Cell(BaseModel):
    cell: str
    value: str | int | float | bool | None = None


class Sheet(BaseModel):
    name: str
    rows: list[list[str | int | float | bool | None]]


server = MCPServer(name="llmlynx-files", version="1.0.0")


@server.tool(
    description="Reads a file as markdown. Returns JSON: { markdown, pages?, textless_pages? } (PDF pages from 1).",
    structured_output=False,
)
def files_convert(name: FileName, data: FileData) -> str:
    return run("files_convert", lambda: json.dumps(convert(name, decode_file(data))))


@server.tool(description="Renders pages of a PDF (from 1) as JPEG images.", structured_output=False)
def files_render_pdf(name: FileName, data: FileData, pages: list[int]) -> list:
    return run("files_render_pdf", lambda: render_pdf(decode_file(data), pages[:10]))


@server.tool(
    description="Makes a photo ready for a model: 'unchanged', or a smaller JPEG or PNG.",
    structured_output=False,
)
def files_prepare_image(name: FileName, data: FileData) -> list:
    return run("files_prepare_image", lambda: prepare_image(decode_file(data)))


@server.tool(description="Creates a text or code file.", structured_output=False)
def files_create_text(name: FileName, content: str) -> list:
    return run("files_create_text", lambda: create_text(name, content))


@server.tool(description="Creates a Word document, PDF or PowerPoint presentation from markdown.", structured_output=False)
def files_create_document(name: FileName, markdown: str) -> list:
    return run("files_create_document", lambda: create_document(name, markdown))


@server.tool(description="Creates an Excel workbook from rows of cells.", structured_output=False)
def files_create_spreadsheet(name: FileName, sheets: list[Sheet]) -> list:
    return run("files_create_spreadsheet", lambda: create_spreadsheet(name, [s.model_dump() for s in sheets]))


@server.tool(
    description="Edits a text, Word, PowerPoint or Excel file in place, keeping its formatting; returns the new version.",
    structured_output=False,
)
def files_edit(
    name: FileName,
    data: FileData,
    edits: list[Edit] = [],  # noqa: B006
    cells: list[Cell] = [],  # noqa: B006
    new_name: str | None = None,
) -> list:
    return run(
        "files_edit",
        lambda: edit_file(
            name,
            decode_file(data),
            [e.model_dump() for e in edits],
            [c.model_dump() for c in cells],
            new_name,
        ),
    )


async def _respond(send, status: int, body: dict):
    payload = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": payload})


class Guard:
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
    json_response=True,
    max_request_body_size=MAX_BODY_BYTES,
    # The bearer token already keeps out what DNS rebinding could send; the
    # Host header the app sends depends on the published port
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    host="0.0.0.0",
)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    print(f"llmlynx-files listening on :{PORT}", flush=True)
    uvicorn.run(Guard(app), host="0.0.0.0", port=PORT, log_level="warning")
