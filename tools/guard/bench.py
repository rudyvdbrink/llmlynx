"""Times the guard's model on this machine, to see whether it is fast enough.

Prints the time for one chunk of 512 tokens and for a page of 12,000
characters (what one tool result holds at most), and the memory the process
takes. On the server:

    docker compose run --rm --no-deps guard python /app/bench.py

The target on a Raspberry Pi 5 with the 22m model is under 2 seconds for the
page: the app waits at most 20 seconds for the scan of a tool result.

Usage: python bench.py [model directory]
"""

import resource
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from model import MODEL_DIR, Model  # noqa: E402
from scan import CHUNK_TOKENS, scan  # noqa: E402

RUNS = 5

SENTENCES = [
    "The museum opens at ten and closes at six, except on Mondays.",
    "Researchers measured the temperature of the lake every hour for a year.",
    "To install the package, download the archive and run the setup script.",
    "The committee will publish its report on public transport next spring.",
    "A recipe for bread needs flour, water, salt, yeast and some patience.",
    "The river runs through three countries before it reaches the sea.",
]


def text_of(characters: int) -> str:
    """Plain text of about `characters` characters."""
    out: list[str] = []
    size = 0
    index = 0
    while size < characters:
        sentence = f"{SENTENCES[index % len(SENTENCES)]} ({index})"
        out.append(sentence)
        size += len(sentence) + 1
        index += 1
    return " ".join(out)[:characters]


def timed(work) -> float:
    """The median time of `work` over RUNS runs, in milliseconds, after one run to warm up."""
    work()
    times = []
    for _ in range(RUNS):
        started = time.perf_counter()
        work()
        times.append((time.perf_counter() - started) * 1000)
    return statistics.median(times)


def main():
    directory = Path(sys.argv[1]) if len(sys.argv) > 1 else MODEL_DIR
    started = time.perf_counter()
    model = Model(directory)
    load_ms = (time.perf_counter() - started) * 1000

    chunk = model.encode(text_of(4000))[: CHUNK_TOKENS - 2]
    page = text_of(12_000)
    outcome = scan(page, encode=model.encode, score=model.score, threshold=0.5, model=model.name)

    print(f"model:             {model.name}")
    print(f"load:              {load_ms:.0f} ms")
    print(f"one chunk:         {timed(lambda: model.score([chunk])):.0f} ms ({len(chunk) + 2} tokens)")
    page_ms = timed(lambda: scan(page, encode=model.encode, score=model.score, threshold=0.5, model=model.name))
    print(f"12,000 characters: {page_ms:.0f} ms ({outcome['chunks']} chunks)")
    # ru_maxrss is in kilobytes on Linux
    print(f"memory (peak RSS): {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MB")


if __name__ == "__main__":
    main()
