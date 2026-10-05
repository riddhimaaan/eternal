"""Stdio command lookup under a minimal PATH, and clear "not found" errors.

GUI and service launches inherit a PATH that misses per-user tool installs
(uvx, cargo, bun, nvm/fnm node, ...), so a config that works in a terminal
failed in the desktop app. A command that is truly missing used to surface
only as "connection closed" (the watchdog re-execs it) and was retried
forever.
"""
from __future__ import annotations

import os
import stat

import pytest


def _make_exe(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("ETERNAL_HOME", str(home / ".eternal"))
    monkeypatch.delenv("NVM_DIR", raising=False)
    monkeypatch.delenv("FNM_DIR", raising=False)
    return home


def test_resolves_tool_from_user_dir_missing_from_path(fake_home):
    from tools.mcp_tool import _resolve_stdio_command

    exe = _make_exe(fake_home / ".cargo" / "bin" / "eternal-test-mcp")
    command, env = _resolve_stdio_command("eternal-test-mcp", {"PATH": "/usr/bin:/bin"})

    assert command == str(exe)
    assert env["PATH"].split(os.pathsep)[0] == str(exe.parent)


def test_nvm_uses_newest_installed_node(fake_home):
    from tools.mcp_tool import _resolve_stdio_command

    versions = fake_home / ".nvm" / "versions" / "node"
    _make_exe(versions / "v9.11.2" / "bin" / "eternal-test-npx")
    newest = _make_exe(versions / "v20.11.1" / "bin" / "eternal-test-npx")

    command, env = _resolve_stdio_command("eternal-test-npx", {"PATH": "/usr/bin:/bin"})

    assert command == str(newest)
    # npx's `#!/usr/bin/env node` needs node's own directory on PATH.
    assert str(newest.parent) in env["PATH"].split(os.pathsep)


def test_path_hit_wins_over_user_dirs(fake_home, tmp_path):
    from tools.mcp_tool import _resolve_stdio_command

    _make_exe(fake_home / ".cargo" / "bin" / "eternal-test-mcp")
    on_path = _make_exe(tmp_path / "onpath" / "eternal-test-mcp")

    command, _ = _resolve_stdio_command("eternal-test-mcp", {"PATH": str(on_path.parent)})
    assert command == str(on_path)


def test_missing_command_reports_not_found(fake_home):
    from tools import mcp_tool

    mcp_tool.shutdown_mcp_servers()
    with mcp_tool._lock:
        mcp_tool._server_connect_errors.clear()
    try:
        registered = mcp_tool.register_mcp_servers({
            "missing": {"command": "eternal-definitely-not-installed", "connect_timeout": 10}
        })
        with mcp_tool._lock:
            error = mcp_tool._server_connect_errors.get("missing", "")
            server = mcp_tool._servers.get("missing")
    finally:
        mcp_tool.shutdown_mcp_servers()

    assert registered == []
    assert "eternal-definitely-not-installed" in error
    assert "closed" not in error.lower()
    # Permanent failure: parked, not burning the transient retry ladder.
    if server is not None:
        assert server._was_parked
