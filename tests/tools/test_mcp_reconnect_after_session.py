"""A server that already had a session reconnects instead of parking.

After a live session drops (keepalive failure, transport drop, OAuth
recovery) run() clears ``_ready`` before rebuilding. A rebuild failure then
used to look like a *first* connect failure: the short initial ladder ran and
the server parked for ``_PARKED_RETRY_INTERVAL`` with its tools removed, so a
remote server restarting for a few seconds lost its tools for 5 minutes.
"""
from __future__ import annotations

import asyncio


def test_failed_rebuild_after_session_uses_reconnect_ladder(monkeypatch):
    from tools import mcp_tool

    monkeypatch.setattr(mcp_tool, "_MAX_INITIAL_CONNECT_RETRIES", 1)
    monkeypatch.setattr(mcp_tool, "_MAX_RECONNECT_RETRIES", 5)
    monkeypatch.setattr(mcp_tool, "_PARKED_RETRY_INTERVAL", 3600)
    monkeypatch.setattr(mcp_tool, "_jittered", lambda _backoff: 0)

    attempts = []

    class _FlakyServer(mcp_tool.MCPServerTask):
        async def _run_stdio(self, config):
            attempts.append(len(attempts) + 1)
            n = len(attempts)
            if n == 1:
                # Live session, then the transport drops cleanly.
                self.session = object()
                self._ready.set()
                return "reconnect"
            if n <= 4:
                raise ConnectionError("server restarting")
            self.session = object()
            self._ready.set()
            await self._shutdown_event.wait()
            return None

    async def scenario():
        server = _FlakyServer("flaky")
        task = asyncio.ensure_future(server.run({"command": "unused"}))
        try:
            for _ in range(200):
                if len(attempts) >= 5 and server.session is not None:
                    break
                await asyncio.sleep(0.01)
            return server, len(attempts)
        finally:
            server._shutdown_event.set()
            server._reconnect_event.set()
            await asyncio.wait_for(task, timeout=5)

    server, count = asyncio.run(scenario())

    assert count == 5, "server stopped retrying after the session dropped"
    assert server._was_parked is False


def test_first_connect_failure_still_uses_initial_ladder(monkeypatch):
    """Control: a server that never connected keeps the short initial ladder."""
    from tools import mcp_tool

    monkeypatch.setattr(mcp_tool, "_MAX_INITIAL_CONNECT_RETRIES", 1)
    monkeypatch.setattr(mcp_tool, "_PARKED_RETRY_INTERVAL", 3600)
    monkeypatch.setattr(mcp_tool, "_jittered", lambda _backoff: 0)

    class _DeadServer(mcp_tool.MCPServerTask):
        async def _run_stdio(self, config):
            raise ConnectionError("never up")

    async def scenario():
        server = _DeadServer("dead")
        task = asyncio.ensure_future(server.run({"command": "unused"}))
        try:
            await asyncio.wait_for(server._ready.wait(), timeout=5)
            return server
        finally:
            server._shutdown_event.set()
            server._reconnect_event.set()
            await asyncio.wait_for(task, timeout=5)

    server = asyncio.run(scenario())
    assert server._was_parked is True
    assert server._error is not None
