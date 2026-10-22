"""A missing ``mcp`` SDK must be reported as missing, on every transport.

Packaged desktop builds used to ship without the ``mcp`` package. Stdio
servers then said the SDK was not installed, but HTTP servers said
"mcp.client.streamable_http is not available. Upgrade the mcp package" —
sending the user after an upgrade of something they did not have at all.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from tools.mcp_tool import MCPServerTask


def _run(coro_fn, config):
    async def _drive():
        with patch("tools.mcp_tool._MCP_AVAILABLE", False):
            await coro_fn(config)

    with pytest.raises(ImportError) as excinfo:
        asyncio.run(_drive())

    return str(excinfo.value)


def test_http_server_reports_sdk_not_installed():
    message = _run(MCPServerTask("remote")._run_http, {"url": "https://example.invalid/mcp"})

    assert "'remote'" in message
    assert "not installed" in message
    assert "Upgrade" not in message


def test_http_and_stdio_give_the_same_advice():
    http = _run(MCPServerTask("same")._run_http, {"url": "https://example.invalid/mcp"})
    stdio = _run(MCPServerTask("same")._run_stdio, {"command": "echo"})

    assert http == stdio
