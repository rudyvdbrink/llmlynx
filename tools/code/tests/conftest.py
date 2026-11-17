"""Shared by the code server's tests: its modules on the import path.

These tests need no containers and no network. The jails themselves are tested
against the running container, from the app: src/server/sandbox/live.test.ts.

    docker run --rm -v ./tools/code/tests:/tests:ro llmlynx-code python3 -m pytest -q -p no:cacheprovider /tests
"""

import sys
from pathlib import Path

sys.path.insert(0, "/opt/server/src")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
