"""A server slower than ``connect_timeout`` keeps connecting in the background.

Runs a real stdio MCP server subprocess that sleeps longer than its
``connect_timeout`` before serving. Discovery used to cancel the server's run
task when the budget ran out, so nothing retried it until a restart or
``/reload-mcp``. Now discovery adopts the still-running task and the server
publishes its tools once it is up.
"""
from __future__ import annotations

import sys
import textwrap
import time

import pytest

pytest.importorskip("mcp.server.fastmcp", reason="MCP SDK required")

SERVER_NAME = "slow-start"


def _reset(mcp_tool) -> None:
    mcp_tool.shutdown_mcp_servers()
    with mcp_tool._lock:
        mcp_tool._servers.clear()
        mcp_tool._server_connecting.clear()
        mcp_tool._server_connect_errors.clear()


def _slow_server_script(tmp_path, delay: float):
    script = tmp_path / "slow_server.py"
    script.write_text(textwrap.dedent(f"""
        import time
        time.sleep({delay})
        from mcp.server.fastmcp import FastMCP
        mcp = FastMCP("slow")

        @mcp.tool()
        def ping() -> str:
            return "pong"

        mcp.run()
    """))
    return script


def _wait_for(predicate, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def test_server_slower_than_connect_timeout_connects_in_background(monkeypatch, tmp_path):
    monkeypatch.setenv("ETERNAL_HOME", str(tmp_path / "home"))
    from tools import mcp_tool
    from tools.registry import registry

    _reset(mcp_tool)
    script = _slow_server_script(tmp_path, delay=3)
    try:
        registered = mcp_tool.register_mcp_servers({
            SERVER_NAME: {
                "command": sys.executable,
                "args": [str(script)],
                "connect_timeout": 1,
            }
        })
        assert registered == []
        with mcp_tool._lock:
            server = mcp_tool._servers.get(SERVER_NAME)
            error = mcp_tool._server_connect_errors.get(SERVER_NAME, "")
        assert server is not None, "slow server was dropped instead of adopted"
        assert "background" in error

        assert _wait_for(lambda: server.session is not None, timeout=30), (
            "adopted slow server never connected"
        )
        assert _wait_for(
            lambda: any(
                registry.get_toolset_for_tool(name)
                for name in server._registered_tool_names
            ),
            timeout=5,
        )
        assert any(name.endswith("ping") for name in server._registered_tool_names)
        with mcp_tool._lock:
            assert SERVER_NAME not in mcp_tool._server_connect_errors
    finally:
        mcp_tool.shutdown_mcp_servers()

    assert server._task is None or server._task.done(), "adopted task not reaped"


def test_handshake_budget_grows_only_after_slow_start():
    from tools import mcp_tool

    server = mcp_tool.MCPServerTask("srv")
    assert server._handshake_timeout({"connect_timeout": 10}) == 10
    server._slow_start = True
    assert server._handshake_timeout({"connect_timeout": 10}) >= 50
    assert server._handshake_timeout({"connect_timeout": 10}) >= mcp_tool._SLOW_START_MIN_TIMEOUT
