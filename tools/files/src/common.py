"""Shared by the file tools: limits, the files the app sends, and the files sent back.

Files travel as base64 in the tool calls. The server keeps nothing between
calls and never fetches anything from the network.
"""

import base64
import binascii
from urllib.parse import quote

from charset_normalizer import from_bytes
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import BlobResourceContents, EmbeddedResource, TextContent

# The app allows 20 MB per file; what the tools make may not be larger either
MAX_FILE_BYTES = 20 * 1024 * 1024

TEXT_EXTENSIONS = {
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
    "html", "htm", "css", "scss", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "ipynb", "go", "rs", "java", "kt",
    "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "swift", "sh", "bash", "zsh", "ps1", "bat", "sql", "r", "lua",
    "pl", "scala", "dart", "vue", "svelte", "tex", "bib", "srt", "vtt", "dockerfile", "makefile", "gitignore", "env",
}

MIME_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
    "md": "text/markdown",
    "markdown": "text/markdown",
    "csv": "text/csv",
    "tsv": "text/tab-separated-values",
    "json": "application/json",
    "html": "text/html",
    "htm": "text/html",
    "xml": "application/xml",
    "css": "text/css",
    "js": "text/javascript",
    "mjs": "text/javascript",
}


def extension(name: str) -> str:
    """'Report.Final.PDF' -> 'pdf'; a name without a dot is its own extension ('Dockerfile' -> 'dockerfile')."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    return (base.rsplit(".", 1)[-1] if "." in base else base).lower()


def mime_type(name: str) -> str:
    ext = extension(name)
    if ext in MIME_TYPES:
        return MIME_TYPES[ext]
    return "text/plain" if ext in TEXT_EXTENSIONS else "application/octet-stream"


def is_text(name: str) -> bool:
    return extension(name) in TEXT_EXTENSIONS


def decode_file(data: str) -> bytes:
    """The file the app sent, from base64."""
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise ToolError("The file is not valid base64.")
    if len(raw) > MAX_FILE_BYTES:
        raise ToolError("The file is larger than 20 MB.")
    if not raw:
        raise ToolError("The file is empty.")
    return raw


def decode_text(raw: bytes) -> str:
    """A text file's text: UTF-16 or UTF-8 (with or without BOM), else the encoding it most likely has."""
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="replace")
    if b"\x00" in raw[:8192]:
        raise ToolError("This is not a text file.")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    # Guessing needs some text to go on; short texts are most likely Windows-1252
    if len(raw) >= 1024:
        best = from_bytes(raw).best()
        if best is not None:
            return str(best)
    return raw.decode("cp1252", errors="replace")


def size_text(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{round(n / 1024)} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def file_result(name: str, data: bytes, summary: str) -> list:
    """A tool result with a file the app shows the user: the file as an embedded resource, named by its URI."""
    if len(data) > MAX_FILE_BYTES:
        raise ToolError("The file came out larger than 20 MB, which is too large.")
    return [
        TextContent(text=summary),
        EmbeddedResource(
            resource=BlobResourceContents(
                uri=f"file:///{quote(name)}",
                mime_type=mime_type(name),
                blob=base64.b64encode(data).decode("ascii"),
            )
        ),
    ]
