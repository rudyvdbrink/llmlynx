"""A small client for clamd, the stack's virus scanner (the clamav service): it
sends a file over TCP with the INSTREAM command and reads the verdict. The
code container reaches it on an internal network of their own.
"""

import asyncio
import os
import struct

HOST = os.environ.get("CLAMAV_HOST", "clamav")
PORT = int(os.environ.get("CLAMAV_PORT", "3310"))
CHUNK_BYTES = 64 * 1024
# The largest file clamd takes, its StreamMaxLength (see tools/clamav/clamd.conf): 2 GB, the most ClamAV can scan
MAX_STREAM_BYTES = 2000 * 1024 * 1024
# Such a file on the Pi: a little longer than clamd's own MaxScanTime, so that its verdict comes first
TIMEOUT_SECONDS = 1260

# What clamd reports, with AlertExceedsMax (see tools/clamav/clamd.conf), for a file it could not scan whole
LIMIT_EXCEEDED = "Heuristics.Limits.Exceeded."
LIMITS = {
    "MaxFiles": "it is an archive with more files than the virus scanner checks",
    "MaxScanSize": "it unpacks to more data than the virus scanner checks",
    "MaxFileSize": "it holds a file larger than the virus scanner checks",
    "MaxRecursion": "it nests archives deeper than the virus scanner checks",
    "MaxScanTime": "scanning it takes longer than the virus scanner allows",
}


class ScanError(Exception):
    """clamd could not be reached, reported an error, or did not answer in time."""


def parse_answer(answer: bytes) -> str | None:
    """None for "stream: OK", the signature for "stream: <signature> FOUND". Anything else is an error."""
    line = answer.split(b"\0")[0].decode("utf-8", "replace").strip()
    if line == "stream: OK":
        return None
    if line.startswith("stream: ") and line.endswith(" FOUND"):
        return line[len("stream: ") : -len(" FOUND")]
    raise ScanError(f"clamd answered: {line or 'nothing'}")


def limit_exceeded(signature: str) -> str | None:
    """Why clamd could not scan a file whole, when `signature` says it could not; None for a detection."""
    if not signature.startswith(LIMIT_EXCEEDED):
        return None
    return LIMITS.get(signature.removeprefix(LIMIT_EXCEEDED), f"it goes past a limit of the virus scanner ({signature})")


async def scan_file(path: str) -> str | None:
    """Scans the file at `path`. Returns None when it is clean, or the signature clamd found. Raises ScanError."""

    async def scan():
        reader, writer = await asyncio.open_connection(HOST, PORT)
        try:
            writer.write(b"zINSTREAM\0")
            with open(path, "rb") as f:
                while chunk := f.read(CHUNK_BYTES):
                    writer.write(struct.pack(">I", len(chunk)) + chunk)
                    await writer.drain()
            writer.write(struct.pack(">I", 0))
            await writer.drain()
            answer = b""
            while b"\0" not in answer:
                part = await reader.read(4096)
                if not part:
                    break
                answer += part
            return parse_answer(answer)
        finally:
            writer.close()

    try:
        return await asyncio.wait_for(scan(), TIMEOUT_SECONDS)
    except ScanError:
        raise
    except (OSError, asyncio.TimeoutError) as err:
        raise ScanError(f"clamd cannot be reached or did not answer: {err}") from err
