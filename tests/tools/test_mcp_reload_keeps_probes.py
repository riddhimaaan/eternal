"""``/reload-mcp`` must not kill a standalone probe running on the MCP loop.

The dashboard OAuth worker runs as a probe and waits minutes for the browser
callback. Reload used to stop (and drain) the shared loop unconditionally, so
saving or toggling any other server mid sign-in cancelled the flow.
"""
from __future__ import annotations

import asyncio
import threading
import time


def _start_probe(mcp_tool):
    """Run a long coroutine on the MCP loop inside a probe lifetime."""
    started = threading.Event()
    outcome = {}

    async def _waiting_for_browser():
        started.set()
        try:
            await asyncio.sleep(30)
            outcome["result"] = "finished"
        except asyncio.CancelledError:
            outcome["result"] = "cancelled"
            raise

    def _worker():
        with mcp_tool._mcp_probe_lifetime():
            try:
                mcp_tool._run_on_mcp_loop(_waiting_for_browser, timeout=60)
            except BaseException:
                pass

    mcp_tool._ensure_mcp_loop()
    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()
    assert started.wait(5)
    return thread, outcome


def _loop_running(mcp_tool) -> bool:
    with mcp_tool._lock:
        loop = mcp_tool._mcp_loop
    return loop is not None and loop.is_running()


def test_reload_keeps_loop_while_probe_active(monkeypatch, tmp_path):
    monkeypatch.setenv("ETERNAL_HOME", str(tmp_path))
    from tools import mcp_tool

    mcp_tool.shutdown_mcp_servers()
    thread, outcome = _start_probe(mcp_tool)
    try:
        mcp_tool.shutdown_mcp_servers(for_reload=True)
        time.sleep(0.2)
        assert "result" not in outcome, "reload cancelled the in-flight probe"
        assert _loop_running(mcp_tool)
    finally:
        mcp_tool.shutdown_mcp_servers()
        thread.join(5)


def test_full_shutdown_still_stops_loop_and_probes(monkeypatch, tmp_path):
    monkeypatch.setenv("ETERNAL_HOME", str(tmp_path))
    from tools import mcp_tool

    mcp_tool.shutdown_mcp_servers()
    thread, outcome = _start_probe(mcp_tool)
    mcp_tool.shutdown_mcp_servers()
    thread.join(5)

    assert outcome.get("result") == "cancelled"
    assert not _loop_running(mcp_tool)


def test_reload_without_probes_stops_idle_loop(monkeypatch, tmp_path):
    monkeypatch.setenv("ETERNAL_HOME", str(tmp_path))
    from tools import mcp_tool

    mcp_tool.shutdown_mcp_servers()
    mcp_tool._ensure_mcp_loop()
    mcp_tool.shutdown_mcp_servers(for_reload=True)
    assert not _loop_running(mcp_tool)
