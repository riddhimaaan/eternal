"""A cancelled or failed re-authentication must not destroy a working sign-in.

The SDK writes ``client.json`` (dynamic registration) before the browser
step. The rollback used to treat that leftover as a successful concurrent
write and skip restoring the old tokens; the CLI path took no backup at all.
"""
from __future__ import annotations

import json

import pytest


def _seed(tmp_path, monkeypatch, name="srv"):
    monkeypatch.setenv("ETERNAL_HOME", str(tmp_path))
    d = tmp_path / "mcp-tokens"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.json").write_text(json.dumps({
        "access_token": "old-access", "token_type": "Bearer", "refresh_token": "old-refresh",
    }))
    (d / f"{name}.client.json").write_text(json.dumps({"client_id": "old-client"}))
    return d


def _half_finished_flow(d, name="srv"):
    """What a cancelled sign-in leaves behind: a new client, no tokens."""
    (d / f"{name}.client.json").write_text(json.dumps({"client_id": "new-client"}))


def test_restore_ignores_client_written_by_cancelled_flow(tmp_path, monkeypatch):
    from tools.mcp_oauth import EternalTokenStorage

    d = _seed(tmp_path, monkeypatch)
    storage = EternalTokenStorage("srv")
    backup = storage.snapshot()
    storage.remove()
    _half_finished_flow(d)

    storage.restore(backup, only_if_absent=True)

    assert json.loads((d / "srv.json").read_text())["refresh_token"] == "old-refresh"
    assert json.loads((d / "srv.client.json").read_text())["client_id"] == "old-client"


def test_restore_keeps_tokens_from_successful_concurrent_flow(tmp_path, monkeypatch):
    from tools.mcp_oauth import EternalTokenStorage

    d = _seed(tmp_path, monkeypatch)
    storage = EternalTokenStorage("srv")
    backup = storage.snapshot()
    storage.remove()
    (d / "srv.json").write_text(json.dumps({"access_token": "new", "token_type": "Bearer"}))

    storage.restore(backup, only_if_absent=True)

    assert json.loads((d / "srv.json").read_text())["access_token"] == "new"


@pytest.mark.parametrize("outcome", ["returns_false", "raises", "interrupted"])
def test_cli_reauth_failure_restores_previous_sign_in(tmp_path, monkeypatch, outcome):
    from eternal_cli import mcp_config

    d = _seed(tmp_path, monkeypatch)

    def _fake_probe(name, cfg, url):
        _half_finished_flow(d)
        if outcome == "raises":
            raise RuntimeError("provider error")
        if outcome == "interrupted":
            raise KeyboardInterrupt
        return False

    monkeypatch.setattr(mcp_config, "_run_oauth_login_probe", _fake_probe)
    cfg = {"url": "https://mcp.example.com/mcp", "auth": "oauth"}

    if outcome in ("raises", "interrupted"):
        with pytest.raises((RuntimeError, KeyboardInterrupt)):
            mcp_config._reauth_oauth_server("srv", cfg)
    else:
        assert mcp_config._reauth_oauth_server("srv", cfg) is False

    assert json.loads((d / "srv.json").read_text())["refresh_token"] == "old-refresh"
    assert json.loads((d / "srv.client.json").read_text())["client_id"] == "old-client"


def test_cli_reauth_success_keeps_new_sign_in(tmp_path, monkeypatch):
    from eternal_cli import mcp_config

    d = _seed(tmp_path, monkeypatch)

    def _fake_probe(name, cfg, url):
        (d / "srv.json").write_text(json.dumps({"access_token": "new", "token_type": "Bearer"}))
        return True

    monkeypatch.setattr(mcp_config, "_run_oauth_login_probe", _fake_probe)
    assert mcp_config._reauth_oauth_server(
        "srv", {"url": "https://mcp.example.com/mcp", "auth": "oauth"}
    ) is True
    assert json.loads((d / "srv.json").read_text())["access_token"] == "new"
