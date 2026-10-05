"""A header referencing an unset ``${VAR}`` fails fast with an actionable error.

Unresolved placeholders used to be sent as literal text; the server answered
401 and the failure was reported (and offered "Sign in") as an OAuth problem.
"""
from __future__ import annotations


def _reset(mcp_tool) -> None:
    mcp_tool.shutdown_mcp_servers()
    with mcp_tool._lock:
        mcp_tool._servers.clear()
        mcp_tool._server_connecting.clear()
        mcp_tool._server_connect_errors.clear()


def test_unset_header_variable_reports_missing_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("ETERNAL_HOME", str(tmp_path))
    monkeypatch.delenv("ETERNAL_TEST_MISSING_KEY", raising=False)
    from tools import mcp_tool

    _reset(mcp_tool)
    try:
        registered = mcp_tool.register_mcp_servers({
            "keyed": {
                # Unroutable on purpose: the check must fire before any I/O.
                "url": "https://mcp.invalid/mcp",
                "headers": {"Authorization": "Bearer ${ETERNAL_TEST_MISSING_KEY}"},
                "connect_timeout": 5,
            }
        })
        with mcp_tool._lock:
            error = mcp_tool._server_connect_errors.get("keyed", "")
    finally:
        _reset(mcp_tool)

    assert registered == []
    assert "${ETERNAL_TEST_MISSING_KEY}" in error
    assert ".env" in error
    assert "401" not in error and "auth" not in error.lower()


def test_unset_env_refs_ignores_set_and_context_variables(monkeypatch):
    from tools import mcp_tool

    monkeypatch.setenv("ETERNAL_TEST_SET_KEY", "value")
    monkeypatch.delenv("ETERNAL_TEST_UNSET_KEY", raising=False)

    assert mcp_tool._unset_env_refs({
        "a": "Bearer ${ETERNAL_TEST_SET_KEY}",
        "b": "${env:ETERNAL_TEST_UNSET_KEY}",
        "c": "${userHome}/x",
        "d": "plain",
        "e": 3,
    }) == ["ETERNAL_TEST_UNSET_KEY"]
    assert mcp_tool._unset_env_refs(None) == []


def test_missing_secret_is_a_permanent_failure():
    from tools import mcp_tool

    exc = mcp_tool._missing_secret_error("srv", ["A"])
    assert mcp_tool._classify_mcp_failure(exc) == "permanent"
