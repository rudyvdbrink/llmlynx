"""Shared by the guard's tests: the server's modules on the import path, and stand-ins for the model.

The tests run without the real model, which is a download of 300 MB: a
stand-in tokenizer that takes each word as a token, and a stand-in scorer that
knows one injection phrase. Tests that need the real model are in test_real_model.py.

    pip install -r requirements-dev.txt && pytest
"""

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

PHRASE = "ignore previous instructions"


class Words:
    """A tokenizer that gives every word (in lower case) an id of its own."""

    def __init__(self):
        self.ids: dict[str, int] = {}

    def encode(self, text: str) -> list[int]:
        return [self.ids.setdefault(word, len(self.ids)) for word in text.lower().split()]

    def offsets(self, text: str) -> list[tuple[int, int]]:
        return [match.span() for match in re.finditer(r"\S+", text)]


class PhraseScorer:
    """Scores a chunk 0.99 when it holds PHRASE, word for word, else 0.01. Keeps the size of each batch it gets."""

    def __init__(self, words: Words):
        self.phrase = words.encode(PHRASE)
        self.batch_sizes: list[int] = []
        self.chunk_sizes: list[int] = []

    def __call__(self, chunks: list[list[int]]) -> list[float]:
        self.batch_sizes.append(len(chunks))
        self.chunk_sizes.extend(len(chunk) for chunk in chunks)
        n = len(self.phrase)
        return [0.99 if any(chunk[i : i + n] == self.phrase for i in range(len(chunk))) else 0.01 for chunk in chunks]


@pytest.fixture
def words() -> Words:
    return Words()


@pytest.fixture
def scorer(words: Words) -> PhraseScorer:
    return PhraseScorer(words)
