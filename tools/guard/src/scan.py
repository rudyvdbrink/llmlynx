"""Scans a text for prompt injections: normalizes it, cuts it into chunks the model takes, and scores them.

The model reads at most 512 tokens at a time, so a longer text is scored in
overlapping chunks, and its score is the highest of its chunks. This module
knows nothing about the model itself: it gets a function that turns text into
token ids and one that scores chunks of them (see model.py), so the tests run
it with stand-ins.
"""

import re
import threading
import time
import unicodedata
from collections import deque
from collections.abc import Callable, Iterable, Iterator

# The model's context, with the two special tokens that go around each chunk
CHUNK_TOKENS = 512
# How far apart chunks start. Less than a chunk, so they overlap and nothing hides on a chunk boundary
STRIDE = 448
# Chunks scored in one run of the model
BATCH_SIZE = 8
# Longest scan: the app waits 180 seconds for the scan of an attached file (UPLOAD_GUARD_TIMEOUT_MS)
MAX_SCAN_SECONDS = 170
# The text is tokenized in pieces of about this many characters, so a long text does not take memory all at once
PIECE_CHARS = 20_000

# Zero-width characters, bidirectional controls and Unicode tag characters: a reader does not see
# them, and they are used to hide a prompt in a text or to split a phrase a filter looks for
_INVISIBLE = re.compile(
    "[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿\U000e0000-\U000e007f]"
)


class TooLong(Exception):
    """The text takes longer to scan than MAX_SCAN_SECONDS."""


def normalize(text: str) -> str:
    """The text as it is scored: NFKC (so look-alike forms of a letter become the letter), without invisible characters."""
    return _INVISIBLE.sub("", unicodedata.normalize("NFKC", text))


def pieces(text: str, size: int = PIECE_CHARS) -> Iterator[str]:
    """The text in pieces of at most `size` characters, cut at white space where there is any."""
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            cut = max(text.rfind(" ", start, end), text.rfind("\n", start, end))
            if cut > start:
                end = cut
        yield text[start:end]
        start = end


def token_ids(text: str, encode: Callable[[str], list[int]]) -> Iterator[int]:
    """The token ids of the text, without special tokens, piece by piece."""
    for piece in pieces(text):
        yield from encode(piece)


def windows(ids: Iterable[int], size: int = CHUNK_TOKENS - 2, stride: int = STRIDE) -> Iterator[list[int]]:
    """Chunks of at most `size` ids, each starting `stride` ids after the one before; the last one ends with the ids."""
    window: list[int] = []
    fresh = 0  # ids in the window that no chunk holds yet
    for token in ids:
        window.append(token)
        fresh += 1
        if len(window) == size:
            yield window
            window = window[stride:]
            fresh = 0
    if fresh:
        yield window


def batches(chunks: Iterable[list[int]], size: int = BATCH_SIZE) -> Iterator[list[list[int]]]:
    """The chunks in lists of at most `size`."""
    batch: list[list[int]] = []
    for chunk in chunks:
        batch.append(chunk)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


class Turns:
    """Lets `slots` callers run at once; the others wait their turn, first come, first served.

    A scan takes a turn for each batch, not for the whole text, so a short
    scan (a web page) does not wait until a long one (a book) is done.
    """

    def __init__(self, slots: int = 1):
        self._lock = threading.Lock()
        self._free = slots
        self._waiting: deque[threading.Event] = deque()

    def __enter__(self):
        with self._lock:
            if self._free and not self._waiting:
                self._free -= 1
                return self
            mine = threading.Event()
            self._waiting.append(mine)
        mine.wait()
        return self

    def __exit__(self, *exc):
        with self._lock:
            if self._waiting:
                # The next in line takes this turn over
                self._waiting.popleft().set()
            else:
                self._free += 1
        return False


def scan(
    text: str,
    *,
    encode: Callable[[str], list[int]],
    score: Callable[[list[list[int]]], list[float]],
    threshold: float,
    model: str,
    turns: Turns | None = None,
    max_seconds: float = MAX_SCAN_SECONDS,
) -> dict:
    """Scores `text`. Returns { score, flagged, chunks, ms, model }, and never the text.

    `encode` gives the token ids of a text, and `score` the probability that
    each chunk of a batch is malicious. `score` in the result is the highest
    of the chunks, `flagged` whether it is at or above `threshold`, and
    `chunks` how many were scored. Raises TooLong when it takes more than
    `max_seconds`.
    """
    started = time.monotonic()
    turns = turns or Turns()
    highest = 0.0
    count = 0
    for batch in batches(windows(token_ids(normalize(text), encode))):
        if time.monotonic() - started > max_seconds:
            raise TooLong()
        with turns:
            scores = score(batch)
        highest = max(highest, *scores)
        count += len(batch)
    return {
        "score": round(float(highest), 4),
        "flagged": bool(highest >= threshold),
        "chunks": count,
        "ms": round((time.monotonic() - started) * 1000),
        "model": model,
    }
