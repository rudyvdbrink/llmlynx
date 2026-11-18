"""Times runs and installs in the code container on this machine.

Prints how long a run takes for each language (a jail is made, the code runs,
and the files go back), a run that makes a chart with pandas and matplotlib,
and an install from PyPI and from npm, once downloaded and scanned, once from
the cache. Run it while the rest of the stack (the guard, ClamAV, the browser)
runs too, as it does when a reply uses them. On the server:

    docker compose exec code /opt/server/venv/bin/python /opt/server/bench.py

It installs into a chat id of its own and removes it again. A download
(web_fetch) is timed from the app, where its scans run: see
src/server/sandbox/live.test.ts.
"""

import asyncio
import statistics
import sys
import time
import uuid

sys.path.insert(0, "/opt/server/src")

import jail  # noqa: E402
import packages  # noqa: E402

RUNS = 3

CHART = """
import pandas as pd, matplotlib.pyplot as plt
df = pd.DataFrame({"x": range(100), "y": [i * i for i in range(100)]})
df.plot(x="x", y="y")
plt.savefig("chart.png")
print(df.describe())
"""

CASES = [
    ("python", "print('hello')"),
    ("javascript", "console.log('hello')"),
    ("typescript", "const n: number = 1; console.log(n)"),
    ("shell", "echo hello"),
    ("python", CHART),
]


async def timed(work) -> float:
    started = time.monotonic()
    await work()
    return time.monotonic() - started


async def main():
    files = [("data.csv", b"a,b\n" + b"1,2\n" * 10_000)]
    for language, code in CASES:
        times = [await timed(lambda: jail.run_code(language, code, files, 0, {})) for _ in range(RUNS)]
        what = f"{language} {'chart' if code is CHART else 'hello'}"
        print(f"run {what:<18} median {statistics.median(times):.2f} s (of {RUNS})")

    chat = str(uuid.uuid4())
    try:
        for ecosystem, requested in (("pypi", ["tabulate==0.9.0", "seaborn==0.13.2"]), ("npm", ["lodash@4.17.21"])):
            first = time.monotonic()
            result = await packages.install(chat, ecosystem, requested)
            took = time.monotonic() - first
            downloaded = result.downloaded_bytes / 1024
            scanned = sum(scan.get("files", 0) for scan in result.scans)
            print(f"install {ecosystem:<5} {took:6.2f} s, downloaded {downloaded:.0f} KB, scanned {scanned} file(s)")
            packages.forget([chat])
            again = await timed(lambda: packages.install(chat, ecosystem, requested))
            print(f"install {ecosystem:<5} {again:6.2f} s again, from the cache")
    finally:
        packages.forget([chat])


if __name__ == "__main__":
    asyncio.run(main())
