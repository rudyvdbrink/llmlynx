"""MCP server (stateless Streamable HTTP on POST /mcp) that scans text for prompt injections.

llmlynx calls it for text that reaches a model from outside: web pages, search
results and attached files (see src/server/security in the app). It is not a
tool of the models. The classifier is Llama Prompt Guard 2, which runs here on
the CPU: no text leaves the server, the server keeps nothing and fetches
nothing. Every /mcp request needs the bearer token from MCP_AUTH_TOKEN.
GET /health answers without one.
"""

import hashlib
import hmac
import json
import logging
import os
import sys

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings

from model import Model
from scan import TooLong, Turns, scan

PORT = int(os.environ.get("PORT", "8080"))
TOKEN = os.environ.get("MCP_AUTH_TOKEN", "")
# A text is flagged when the probability that it is malicious is at least this
THRESHOLD = float(os.environ.get("GUARD_THRESHOLD") or "0.5")
# The text of a 20 MB file, as JSON
MAX_BODY_BYTES = 40 * 1024 * 1024
# One batch of chunks at a time: the server may be a Raspberry Pi
TURNS = Turns(int(os.environ.get("GUARD_MAX_CONCURRENCY") or "1"))

log = logging.getLogger("llmlynx-guard")

if not TOKEN:
    print("MCP_AUTH_TOKEN is not set; not starting without a token.", file=sys.stderr)
    sys.exit(1)

# Compares hashes, so the comparison takes as long whatever the token's length
_digest = lambda s: hashlib.sha256(s).digest()  # noqa: E731
TOKEN_DIGEST = _digest(f"Bearer {TOKEN}".encode())

# Loaded once, before the first request
MODEL = Model()

server = MCPServer(name="llmlynx-guard", version="1.0.0")


@server.tool(
    description=(
        "Scores a text for prompt injections. Returns JSON: { score, flagged, chunks, ms, model }, and for a "
        "flagged text { chunk }: the text of the chunk with the highest score."
    ),
    structured_output=False,
)
def guard_scan_text(text: str) -> str:
    try:
        result = scan(
            text,
            encode=MODEL.encode,
            score=MODEL.score,
            offsets=MODEL.offsets,
            threshold=THRESHOLD,
            model=MODEL.name,
            turns=TURNS,
        )
    except TooLong:
        raise ToolError("The text is too long to scan in time.")
    except Exception:
        # Without the text: the log must not hold what was scanned
        log.exception("guard_scan_text failed")
        raise ToolError("The text could not be scanned.")
    return json.dumps(result)


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
            return await _respond(send, 200, {"status": "ok", "model": MODEL.name})
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
    print(f"llmlynx-guard listening on :{PORT} with {MODEL.name}, threshold {THRESHOLD}", flush=True)
    uvicorn.run(Gate(app), host="0.0.0.0", port=PORT, log_level="warning")
