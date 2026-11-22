"""Tests of what the git tool runs: which commands and options, which URLs, and the jails they run in."""

from pathlib import Path

import pytest

import gitrepo
from gitrepo import GitError, check_url, parse, pick_urls


@pytest.mark.parametrize(
    "argv",
    [
        ["status"],
        ["log", "--oneline", "-5"],
        ["diff", "--stat", "HEAD~1"],
        ["commit", "-am", "Fix the parser"],
        ["checkout", "-b", "feature"],
        ["rebase", "-i", "main"],
        ["merge", "--no-ff", "feature"],
        ["format-patch", "-1", "-o", "patches"],
        ["archive", "--format=zip", "-o", "out/repo.zip", "HEAD"],
        ["config", "user.name", "Ada Lovelace"],
        ["config", "--get", "remote.origin.url"],
        ["config", "--list"],
        ["remote", "-v"],
        ["remote", "add", "upstream", "https://github.com/a/b.git"],
        ["bisect", "start"],
        ["branch", "--no-recurse-submodules"],
    ],
)
def test_local_commands_are_taken(argv):
    command = parse(argv)
    assert command.argv == argv and not command.fresh and command.url is None


@pytest.mark.parametrize(
    "argv",
    [
        ["push", "origin", "main"],
        ["submodule", "update"],
        ["worktree", "add", "../pristine", "HEAD"],
        ["archive", "-o", "/sandbox/pristine.tar", "HEAD"],
        ["-c", "core.pager=sh", "log"],
        ["--git-dir=/tmp/x", "status"],
        ["difftool"],
        ["help", "log"],
        ["rebase", "--exec", "make", "main"],
        ["rebase", "--ex=make", "main"],
        ["rebase", "-x", "make", "main"],
        ["rebase", "-ix", "make", "main"],
        ["diff", "--ext-diff"],
        ["log", "--output=/w/git/config"],
        ["diff", "--output", "../outside.txt"],
        ["format-patch", "-o", "/w/git/hooks"],
        ["format-patch", "-o.git"],
        ["archive", "--remote=https://example.com/r", "HEAD"],
        ["grep", "-O", "x"],
        ["grep", "--open-files-in-pager=vi", "x"],
        ["apply", "--directory=../../w/git", "fix.patch"],
        ["config", "core.fsmonitor", "touch /tmp/x"],
        ["config", "alias.x", "!sh"],
        ["config", "--global", "user.name", "x"],
        ["config", "--file", "/w/git/config", "core.pager", "sh"],
        ["config", "--add", "user.name", "x"],
        ["remote", "add", "evil", "ext::sh -c touch% /tmp/x"],
        ["remote", "add", "lan", "https://192.168.1.10/repo"],
        ["remote", "set-url", "origin", "file:///w/git"],
        ["remote", "add", "-f", "x", "https://github.com/a/b"],
        ["remote", "show", "origin"],
        ["bisect", "run", "make", "test"],
        ["fetch", "--upload-pack=touch /tmp/x"],
        ["pull", "--recurse-submodules"],
        ["clone", "--template=/sandbox/t", "https://github.com/a/b"],
        ["clone", "-c", "core.hooksPath=/sandbox", "https://github.com/a/b"],
        ["clone", "--config=core.fsmonitor=x", "https://github.com/a/b"],
        ["clone", "-u", "touch /tmp/x", "https://github.com/a/b"],
        ["clone", "--upload-pack=touch /tmp/x", "https://github.com/a/b"],
        ["clone", "--recurse-submodules", "https://github.com/a/b"],
        ["clone", "--separate-git-dir=/sandbox/g", "https://github.com/a/b"],
        ["clone", "--reference", "/w/git", "https://github.com/a/b"],
        ["clone", "--filter=blob:none", "https://github.com/a/b"],
        ["clone", "--bare", "https://github.com/a/b"],
        ["clone", "file:///etc"],
        ["clone", "/w/git"],
        ["clone", "git@github.com:a/b.git"],
        ["clone", "ssh://github.com/a/b"],
        ["clone", "http://github.com/a/b"],
        ["clone", "https://user:secret@github.com/a/b"],
        ["clone", "https://localhost/a/b"],
        ["clone", "https://127.0.0.1/a/b"],
        ["clone", "https://10.0.0.1/a/b"],
        ["clone", "https://github.com:8443/a/b"],
        ["clone", "https://github.com/a/b?x=1"],
        ["clone", "ext::sh -c 'touch /tmp/x'"],
        ["init", "--bare"],
        ["init", "--template=/sandbox/t"],
        ["log\0", "x"],
    ],
)
def test_what_would_run_a_program_or_reach_out_is_refused(argv):
    with pytest.raises(GitError):
        parse(argv)


def test_a_refusal_says_what_works_instead():
    with pytest.raises(GitError, match=r"git archive -o <file in the repository's folder> <commit>"):
        parse(["worktree", "add", "../pristine", "HEAD"])
    with pytest.raises(GitError, match=r"relative to the repository's folder, such as out/repo.tar"):
        parse(["archive", "-o", "/sandbox/pristine.tar", "HEAD"])


def test_a_clone_downloads_what_its_options_say_and_runs_against_the_copy():
    command = parse(["clone", "--depth", "1", "-b", "dev", "--single-branch", "https://github.com/a/b.git", "b"])
    assert command.fresh and command.url == "https://github.com/a/b.git"
    assert command.download == ["--depth=1", "--branch=dev", "--single-branch"]
    # The folder is the app's; git clones into the jail's work tree
    assert command.argv == ["clone", "--depth", "1", "-b", "dev", "--single-branch", "--", "https://github.com/a/b.git", "/w/tree"]


def test_a_fetch_downloads_every_branch_of_its_remote():
    command = parse(["pull", "--rebase", "upstream", "main"])
    assert command.repository == "upstream" and command.download == ["--no-single-branch"]
    assert command.argv == ["pull", "--rebase", "upstream", "main"]
    assert parse(["fetch", "--depth=3"]).download == ["--depth=3", "--no-single-branch"]
    assert parse(["fetch", "--unshallow"]).download == ["--no-single-branch"]
    assert parse(["fetch", "--all"]).all_remotes


def test_init_makes_the_repository_in_the_work_tree():
    command = parse(["init", "-b", "trunk", "project"])
    assert command.fresh and command.argv == ["init", "-b", "trunk", "/w/tree"]


def test_a_fetch_downloads_the_remote_it_names_or_the_upstream():
    info = {"remotes": {"origin": "https://github.com/a/b", "fork": "https://gitlab.com/c/b"}, "upstream": "fork"}
    assert pick_urls(parse(["fetch"]), info) == ["https://gitlab.com/c/b"]
    assert pick_urls(parse(["fetch", "origin"]), info) == ["https://github.com/a/b"]
    assert pick_urls(parse(["fetch", "--all"]), info) == ["https://github.com/a/b", "https://gitlab.com/c/b"]
    assert pick_urls(parse(["pull", "https://codeberg.org/x/y", "main"]), info) == ["https://codeberg.org/x/y"]
    with pytest.raises(GitError):
        pick_urls(parse(["fetch", "nope"]), info)
    with pytest.raises(GitError):
        pick_urls(parse(["fetch"]), {"remotes": {}})
    # A remote whose URL is not a public https:// one is not fetched
    with pytest.raises(GitError):
        pick_urls(parse(["fetch"]), {"remotes": {"origin": "file:///etc"}})


@pytest.mark.parametrize("url", ["https://github.com/a/b", "https://gitlab.com/group/sub/repo.git", "https://8.8.8.8/r", "https://codeberg.org:443/a/b"])
def test_public_https_urls_are_taken(url):
    assert check_url(url) == url


def test_the_jail_of_the_command_has_no_network_and_the_downloaded_copies_read_only():
    command = gitrepo.local_command(Path("/packages/staging/git-x"), 5, 6)
    assert "--unshare-all" in command and "--share-net" not in command
    assert "--clearenv" in command
    assert ["--ro-bind", "/packages/staging/git-x", "/net"] == command[command.index("/net") - 2 : command.index("/net") + 1]
    assert ["--ro-bind", "/opt/git", "/opt/git"] == command[command.index("/opt/git") - 1 : command.index("/opt/git") + 2]
    assert "--bind" not in command
    assert command[command.index("--uid") + 1] == "1000"
    assert command[-2:] == ["5", "6"]


def test_the_download_jail_holds_nothing_of_the_chat_and_runs_a_command_of_its_own():
    command = gitrepo.download_command("https://github.com/a/b", ["--depth=1"], Path("/packages/staging/git-x/0"))
    assert "--share-net" in command and "--clearenv" in command
    # Only the folder of the copy is writable; no work tree, no .git folder, no runner, no server code
    assert [i for i, part in enumerate(command) if part == "--bind"] == [command.index("/net") - 2]
    assert "/opt/jail" not in command and not any(p.startswith(("/opt/server", "/packages/chats")) for p in command)
    env = {command[i + 1]: command[i + 2] for i, part in enumerate(command) if part == "--setenv"}
    forced = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(int(env["GIT_CONFIG_COUNT"]))}
    assert forced["protocol.allow"] == "never" and forced["protocol.https.allow"] == "always"
    assert "protocol.file.allow" not in forced and forced["core.hooksPath"] == "/opt/git/hooks"
    assert forced["transfer.fsckObjects"] == "true"
    assert command[-8:] == [gitrepo.GIT, "clone", "--bare", "--quiet", "--depth=1", "--", "https://github.com/a/b", "/net/repo.git"]


def test_git_runs_with_hooks_editors_and_helpers_off_and_only_local_copies():
    env = gitrepo.git_env(gitrepo.LOCAL_FORCED, repo=True)
    forced = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(int(env["GIT_CONFIG_COUNT"]))}
    assert forced["protocol.allow"] == "never" and forced["protocol.file.allow"] == "always" and "protocol.https.allow" not in forced
    assert forced["core.fsmonitor"] == "false" and forced["credential.helper"] == ""
    assert env["GIT_CONFIG_NOSYSTEM"] == "1" and env["GIT_TERMINAL_PROMPT"] == "0"
    assert env["GIT_DIR"] == "/w/git" and env["GIT_WORK_TREE"] == "/w/tree"
