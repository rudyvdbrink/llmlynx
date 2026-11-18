"""Tests of what an install takes: only names from PyPI and npm, files from their own hosts, for this system,
and every file of them scanned on its own."""

import asyncio
import marshal
from unittest.mock import ANY

import pytest

import clamd
import packages
from packages import InstallError, Item, fits_platform, npm_items, npm_requirement, pypi_requirement, tidy_pip_report


@pytest.mark.parametrize("spec", ["pandas", "pandas==2.2.3", "numpy>=2,<3", "requests[socks]~=2.31", "tomli; python_version < '3.11'"])
def test_pypi_names_with_versions_are_taken(spec):
    assert pypi_requirement(spec) == spec


@pytest.mark.parametrize(
    "spec",
    ["requests @ https://evil.example/r.whl", "git+https://github.com/a/b", "./local", "-e .", "--index-url=https://x", "", "a b"],
)
def test_pypi_urls_paths_git_and_options_are_refused(spec):
    with pytest.raises(InstallError):
        pypi_requirement(spec)


@pytest.mark.parametrize("spec,expected", [("lodash", ("lodash", "latest")), ("lodash@^4.17", ("lodash", "^4.17")), ("@types/node@20", ("@types/node", "20"))])
def test_npm_names_with_ranges_are_taken(spec, expected):
    assert npm_requirement(spec) == expected


@pytest.mark.parametrize(
    "spec", ["git+https://github.com/a/b.git", "a@github:a/b", "a@file:../a", "a@npm:b@1", "a@https://x.example/a.tgz", "../a"]
)
def test_npm_urls_paths_git_and_aliases_are_refused(spec):
    with pytest.raises(InstallError):
        npm_requirement(spec)


def lock(entries):
    return {"packages": {"": {"name": "chat-packages"}, **entries}}


def entry(name, **more):
    return {
        "version": "1.0.0",
        "resolved": f"https://registry.npmjs.org/{name}/-/{name.split('/')[-1]}-1.0.0.tgz",
        "integrity": "sha512-" + "A" * 86 + "==",
        **more,
    }


def test_a_lock_gives_each_package_with_its_place_in_node_modules():
    items = npm_items(lock({"node_modules/a": entry("a"), "node_modules/a/node_modules/b": entry("b", hasInstallScript=True)}), {"a"})
    assert [(i.name, i.path, i.requested, i.install_script) for i in items] == [
        ("a", "node_modules/a", True, False),
        ("b", "node_modules/a/node_modules/b", False, True),
    ]


@pytest.mark.parametrize(
    "bad",
    [
        {"node_modules/a": {**entry("a"), "resolved": "https://evil.example/a.tgz"}},
        {"node_modules/a": {**entry("a"), "resolved": "git+ssh://git@github.com/a/a.git"}},
        {"node_modules/a": {"link": True, "resolved": "../a"}},
        {"node_modules/a": {**entry("a"), "integrity": ""}},
    ],
)
def test_a_dependency_from_anywhere_but_the_registry_is_refused(bad):
    with pytest.raises(InstallError):
        npm_items(lock(bad), set())


def test_packages_for_other_systems_are_left_out():
    assert fits_platform({"os": ["linux"], "cpu": [packages.NPM_ARCH]})
    assert not fits_platform({"os": ["darwin"]})
    assert not fits_platform({"os": ["!linux"]})
    assert not fits_platform({"cpu": ["s390x"]})
    assert fits_platform({})


def test_pip_report_names_the_built_in_packages_on_one_line_without_staging_paths(tmp_path):
    output = "\n".join(
        [
            f"Collecting seaborn (from -r {tmp_path}/requirements.txt (line 1))",
            f"Requirement already satisfied: numpy>=1.20 in /usr/local/lib/python3.14/site-packages (from seaborn->-r {tmp_path}/requirements.txt (line 1)) (2.5.5)",
            "Would install seaborn-0.13.2",
        ]
    )
    assert tidy_pip_report(output, tmp_path) == "Already built in: numpy 2.5.5\nCollecting seaborn\nWould install seaborn-0.13.2"


def test_chat_ids_are_conversation_ids_only():
    packages.check_chat("11111111-2222-3333-4444-555555555555")
    for bad in ["../x", "", "11111111-2222-3333-4444-55555555555Z"]:
        with pytest.raises(ValueError):
            packages.check_chat(bad)


def test_unused_packages_go_after_7_days(tmp_path, monkeypatch):
    monkeypatch.setattr(packages, "CHATS", tmp_path / "chats")
    monkeypatch.setattr(packages, "STAGING", tmp_path / "staging")
    old, recent, new = (packages.CHATS / name for name in ("old", "recent", "new"))
    for base in (old, recent, new):
        base.mkdir(parents=True)
        (base / ".used").touch()
    import os
    import time

    for base, days in ((old, 8), (recent, 6)):
        os.utime(base / ".used", (time.time() - days * 86400, time.time() - days * 86400))
    packages.sweep()
    assert not old.exists() and recent.exists() and new.exists()


WHEEL = Item(name="pkg", version="1", url="https://files.pythonhosted.org/p/pkg-1-py3-none-any.whl", hash="a" * 64, requested=True)


@pytest.fixture
def staged(tmp_path, monkeypatch):
    """A staged folder of unpacked packages, with the marks of clean files in a cache of the test's own."""
    monkeypatch.setattr(packages, "CLEAN", tmp_path / "clean")
    folder = tmp_path / "staged"
    (folder / "pkg" / "sub").mkdir(parents=True)
    return folder


def fake_clamd(monkeypatch, verdicts=None):
    """clamd for a test: a file holding a key of `verdicts` gets its signature. Returns what it was asked to scan."""
    scanned = []

    async def scan_file(path):
        data = open(path, "rb").read()
        scanned.append(data)
        return next((signature for key, signature in (verdicts or {}).items() if key in data), None)

    monkeypatch.setattr(packages.clamd, "scan_file", scan_file)
    return scanned


def test_each_file_is_scanned_on_its_own_and_only_once(staged, monkeypatch):
    (staged / "pkg" / "a.py").write_bytes(b"a")
    (staged / "pkg" / "sub" / "b.so").write_bytes(b"b")
    (staged / "pkg" / "empty.py").write_bytes(b"")
    (staged / "pkg" / "link").symlink_to("a.py")
    (staged / "INSTALLER").write_bytes(b"pip")
    scanned = fake_clamd(monkeypatch)
    owner = {"pkg/a.py": WHEEL, "pkg/sub/b.so": WHEEL}.get

    # One log entry per package file; a clean file of no package is not logged
    assert asyncio.run(packages.scan_folder(staged, owner)) == [
        {"file": "pkg-1-py3-none-any.whl", "hash": "a" * 64, "status": "clean", "ms": ANY, "files": 2}
    ]
    assert sorted(scanned) == [b"a", b"b", b"pip"]
    # Scanned clean once: not again, in this chat or any other
    scanned.clear()
    assert asyncio.run(packages.scan_folder(staged, owner)) == []
    assert scanned == []


@pytest.mark.parametrize(
    "content,status,signature,message",
    [
        (b"EVIL", "virus", "Test.Virus", "was flagged as malware (Test.Virus)"),
        (
            b"MANY",
            "unchecked",
            "Heuristics.Limits.Exceeded.MaxFiles",
            "could not be checked for viruses (it is an archive with more files than the virus scanner checks)",
        ),
    ],
)
def test_a_file_that_is_not_clean_stops_the_install(staged, monkeypatch, content, status, signature, message):
    (staged / "pkg" / "x.bin").write_bytes(content)
    fake_clamd(monkeypatch, {b"EVIL": "Test.Virus", b"MANY": "Heuristics.Limits.Exceeded.MaxFiles"})
    with pytest.raises(InstallError) as err:
        asyncio.run(packages.scan_folder(staged, {"pkg/x.bin": WHEEL}.get))
    assert str(err.value) == f"pkg/x.bin (from pkg-1-py3-none-any.whl) {message}, so nothing was installed."
    assert err.value.scans == [{"file": WHEEL.filename, "hash": WHEEL.hash, "status": status, "signature": signature, "ms": ANY, "files": 1}]
    assert not (packages.CLEAN).exists()


def test_a_file_too_large_for_clamd_is_not_checked(staged, monkeypatch):
    monkeypatch.setattr(packages.clamd, "MAX_STREAM_BYTES", 3)
    (staged / "pkg" / "big.so").write_bytes(b"1234")
    scanned = fake_clamd(monkeypatch)
    with pytest.raises(InstallError, match=r"^pkg/big\.so could not be checked for viruses \(it is larger than"):
        asyncio.run(packages.scan_folder(staged, lambda _: None))
    assert scanned == []


def test_clamd_limits_are_not_detections():
    assert clamd.limit_exceeded("Heuristics.Limits.Exceeded.MaxScanSize") == "it unpacks to more data than the virus scanner checks"
    assert clamd.limit_exceeded("Heuristics.Limits.Exceeded.MaxNew") == "it goes past a limit of the virus scanner (Heuristics.Limits.Exceeded.MaxNew)"
    assert clamd.limit_exceeded("Eicar-Test-Signature") is None


def test_pips_record_says_which_wheel_a_file_came_from(tmp_path):
    dist = tmp_path / "Tab_Ulate-0.9.0.dist-info"
    dist.mkdir()
    (dist / "RECORD").write_text("../../bin/tabulate,sha256=x,1\ntabulate/__init__.py,sha256=y,2\nTab_Ulate-0.9.0.dist-info/RECORD,,\n")
    item = Item(name="tab-ulate", version="0.9.0", url="", hash="", requested=True)
    assert packages.pypi_owners(tmp_path, [item]) == {
        "bin/tabulate": item,
        "tabulate/__init__.py": item,
        "Tab_Ulate-0.9.0.dist-info/RECORD": item,
    }


def test_an_npm_file_belongs_to_the_innermost_package():
    a = Item(name="a", version="1", url="", hash="", requested=True, path="node_modules/a")
    b = Item(name="b", version="1", url="", hash="", requested=False, path="node_modules/a/node_modules/b")
    owner = packages.npm_owner([a, b])
    assert owner("node_modules/a/index.js") is a
    assert owner("node_modules/a/node_modules/b/lib/x.js") is b
    assert owner("package.json") is None


def test_bytecode_is_compiled_with_the_paths_a_run_sees(tmp_path):
    target = tmp_path / "staged"
    (target / "pkg").mkdir(parents=True)
    (target / "pkg" / "m.py").write_text("def f():\n    raise ValueError\n")
    (target / "pkg" / "broken.py").write_text("def (:\n")
    asyncio.run(packages.compile_bytecode(target, tmp_path))
    pyc = next((target / "pkg" / "__pycache__").glob("m.*.pyc"))
    assert marshal.loads(pyc.read_bytes()[16:]).co_filename == "/opt/packages/python/pkg/m.py"
    assert not list((target / "pkg" / "__pycache__").glob("broken.*"))
