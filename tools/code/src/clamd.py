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
# A package file of up to 300 MB (the download limit of an install) on the Pi
TIMEOUT_SECONDS = 180


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


async def scan_file(path: str) -> str | None:
    """Scans the file at `path`. Returns None when it is clean, or the virus's signature. Raises ScanError."""

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
