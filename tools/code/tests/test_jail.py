"""Tests of how a jail is made: what it sees, and what it does not."""

from pathlib import Path

import jail


def test_paths_stay_inside_the_sandbox():
    assert jail.safe_path("out/plot.png") == "out/plot.png"
    assert jail.safe_path("./a//b.txt") == "a/b.txt"
    assert jail.safe_path("../etc/passwd") is None
    assert jail.safe_path("a/../../b") is None
    assert jail.safe_path("") is None


def test_the_jail_has_no_network_no_environment_and_only_its_own_folders():
    command = jail.bwrap_command({"python": Path("/packages/chats/c/python")}, 5, 6)
    assert "--unshare-all" in command  # user, PID, network, IPC, UTS and cgroup namespaces of its own
    assert "--clearenv" in command
    assert "--share-net" not in command
    assert command[command.index("--uid") + 1] == "1000"
    # The chat's packages read-only; no server code, no other chat's folder, no volume
    assert ["--ro-bind", "/packages/chats/c/python", "/opt/packages/python"] == command[command.index("/packages/chats/c/python") - 1 : command.index("/packages/chats/c/python") + 2]
    assert not any(part.startswith("/opt/server") for part in command)
    assert "--bind" not in command
    # The run's folders come as open directories, not mounts
    assert command[-2:] == ["5", "6"]


def test_every_jail_is_sealed_after_its_last_mount():
    import gitrepo

    for command in (
        jail.bwrap_command({"python": Path("/packages/chats/c/python"), "node": Path("/packages/chats/c/node")}, 5, 6),
        gitrepo.local_command(Path("/packages/staging/git-x"), 5, 6),
        gitrepo.download_command("https://github.com/a/b", [], Path("/packages/staging/git-x/0")),
    ):
        # No user namespaces of the code's own, and no writable tmpfs without a size
        uid = command.index("--uid")
        assert command[uid - len(jail.SEAL) : uid] == jail.SEAL
        assert "--disable-userns" in jail.SEAL and jail.SEAL[-4:-2] == ["--remount-ro", "/"]


def test_the_limits_of_a_run_are_those_of_the_plan():
    assert jail.RUN_SECONDS == 120
    assert jail.MEMORY_BYTES == 2048 * 1024 * 1024
    assert jail.MAX_PROCESSES == 128
    assert jail.MAX_OUTPUT_BYTES == 1024 * 1024
    assert jail.MAX_FILE_BYTES == 20 * 1024 * 1024
