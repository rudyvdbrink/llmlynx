"""Tests of what an install takes: only names from PyPI and npm, files from their own hosts, for this system."""

import pytest

import packages
from packages import InstallError, fits_platform, npm_items, npm_requirement, pypi_requirement, tidy_pip_report


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


def test_unused_packages_go_after_30_days(tmp_path, monkeypatch):
    monkeypatch.setattr(packages, "CHATS", tmp_path / "chats")
    monkeypatch.setattr(packages, "STAGING", tmp_path / "staging")
    old, new = (packages.CHATS / name for name in ("old", "new"))
    for base in (old, new):
        base.mkdir(parents=True)
        (base / ".used").touch()
    import os
    import time

    month = 31 * 86400
    os.utime(old / ".used", (time.time() - month, time.time() - month))
    packages.sweep()
    assert not old.exists() and new.exists()
