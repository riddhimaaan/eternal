"""Refresh-token handling for Eternal's MCP OAuth provider.

Each test drives the real ``EternalMCPOAuthProvider`` through an
``httpx.AsyncClient`` backed by ``httpx.MockTransport``, so the full
``async_auth_flow`` generator round-trip runs, and asserts on the tokens file
written by the real ``EternalTokenStorage``. These cover three ways the
provider used to force a needless browser re-authorization:

* a refresh response that omits ``refresh_token`` erased the stored one;
* a 401 on a locally-valid access token skipped the refresh token entirely;
* a transient token-endpoint failure (5xx / 429) cleared the tokens.
"""
from __future__ import annotations

import json
import time

import pytest

pytest.importorskip("mcp.client.auth.oauth2", reason="MCP SDK 1.26.0+ required")

import httpx  # noqa: E402

MCP_URL = "https://mcp.example.com/mcp"
TOKEN_URL = "https://idp.example.com/oauth/token"


async def _no_browser_redirect(_url: str) -> None:
    raise AssertionError("refresh path must not open a browser")


async def _no_browser_callback() -> tuple[str, str | None]:
    raise AssertionError("refresh path must not wait for a browser callback")


async def _provider(tmp_path, monkeypatch, *, access="old-access", refresh="r1", expired=False):
    """Build a provider with seeded tokens + client, skipping network discovery."""
    from mcp.shared.auth import (
        OAuthClientInformationFull,
        OAuthClientMetadata,
        OAuthMetadata,
        OAuthToken,
    )
    from pydantic import AnyUrl

    from tools.mcp_oauth import EternalTokenStorage
    from tools.mcp_oauth_manager import _ETERNAL_PROVIDER_CLS, reset_manager_for_tests

    monkeypatch.setenv("ETERNAL_HOME", str(tmp_path))
    reset_manager_for_tests()

    storage = EternalTokenStorage("srv")
    tokens = OAuthToken(
        access_token=access, token_type="Bearer", expires_in=3600, refresh_token=refresh
    )
    await storage.set_tokens(tokens)
    client = OAuthClientInformationFull(
        client_id="test-client",
        redirect_uris=[AnyUrl("http://127.0.0.1:12345/callback")],
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        token_endpoint_auth_method="none",
    )
    await storage.set_client_info(client)

    provider = _ETERNAL_PROVIDER_CLS(
        server_name="srv",
        server_url=MCP_URL,
        client_metadata=OAuthClientMetadata(
            redirect_uris=[AnyUrl("http://127.0.0.1:12345/callback")],
            client_name="Eternal Agent",
        ),
        storage=storage,
        redirect_handler=_no_browser_redirect,
        callback_handler=_no_browser_callback,
    )
    provider.context.current_tokens = tokens
    provider.context.client_info = client
    provider.context.oauth_metadata = OAuthMetadata(
        issuer=AnyUrl("https://idp.example.com"),
        authorization_endpoint=AnyUrl("https://idp.example.com/oauth/authorize"),
        token_endpoint=AnyUrl(TOKEN_URL),
    )
    provider.context.token_expiry_time = time.time() + (-10 if expired else 3600)
    provider._initialized = True
    return provider, storage


def _stored(tmp_path) -> dict:
    return json.loads((tmp_path / "mcp-tokens" / "srv.json").read_text())


def _token_body(**fields) -> httpx.Response:
    return httpx.Response(200, json={"token_type": "Bearer", "expires_in": 3600, **fields})


@pytest.mark.asyncio
async def test_refresh_without_refresh_token_keeps_previous_one(tmp_path, monkeypatch):
    provider, _ = await _provider(tmp_path, monkeypatch, expired=True)

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            return _token_body(access_token="new-access")  # no refresh_token
        assert request.headers["authorization"] == "Bearer new-access"
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), auth=provider) as c:
        assert (await c.post(MCP_URL)).status_code == 200

    stored = _stored(tmp_path)
    assert stored["access_token"] == "new-access"
    assert stored["refresh_token"] == "r1"
    assert provider.context.can_refresh_token()


@pytest.mark.asyncio
async def test_rotated_refresh_token_replaces_previous_one(tmp_path, monkeypatch):
    provider, _ = await _provider(tmp_path, monkeypatch, expired=True)

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            return _token_body(access_token="new-access", refresh_token="r2")
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), auth=provider) as c:
        await c.post(MCP_URL)

    assert _stored(tmp_path)["refresh_token"] == "r2"


@pytest.mark.asyncio
async def test_401_on_valid_looking_token_refreshes_instead_of_browser(tmp_path, monkeypatch):
    """Server ended the access token early; the refresh token must be tried."""
    provider, _ = await _provider(tmp_path, monkeypatch, expired=False)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if str(request.url) == TOKEN_URL:
            assert b"refresh_token=r1" in request.content
            return _token_body(access_token="new-access", refresh_token="r2")
        if request.headers.get("authorization") == "Bearer new-access":
            return httpx.Response(200)
        return httpx.Response(401)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), auth=provider) as c:
        assert (await c.post(MCP_URL)).status_code == 200

    assert seen == [MCP_URL, TOKEN_URL, MCP_URL]
    assert _stored(tmp_path)["access_token"] == "new-access"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [429, 500, 503])
async def test_transient_refresh_failure_keeps_tokens(tmp_path, monkeypatch, status):
    from tools.mcp_oauth import OAuthRefreshTransientError

    provider, _ = await _provider(tmp_path, monkeypatch, expired=True)

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            return httpx.Response(status)
        raise AssertionError("must not send the MCP request without a token")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), auth=provider) as c:
        with pytest.raises(OAuthRefreshTransientError):
            await c.post(MCP_URL)

    assert _stored(tmp_path)["refresh_token"] == "r1"
    assert provider.context.can_refresh_token()


@pytest.mark.asyncio
async def test_rejected_refresh_adopts_tokens_another_process_wrote(tmp_path, monkeypatch):
    """Another process rotated the refresh token first; use its tokens."""
    from mcp.shared.auth import OAuthToken

    provider, storage = await _provider(tmp_path, monkeypatch, expired=True)

    async def other_process_refresh():
        await storage.set_tokens(
            OAuthToken(
                access_token="other-access",
                token_type="Bearer",
                expires_in=3600,
                refresh_token="r2",
            )
        )

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            return httpx.Response(400, json={"error": "invalid_grant"})
        assert request.headers["authorization"] == "Bearer other-access"
        return httpx.Response(200)

    await other_process_refresh()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), auth=provider) as c:
        assert (await c.post(MCP_URL)).status_code == 200

    assert provider.context.current_tokens.refresh_token == "r2"


@pytest.mark.asyncio
async def test_rejected_refresh_with_no_newer_tokens_clears(tmp_path, monkeypatch):
    provider, _ = await _provider(tmp_path, monkeypatch, expired=True)

    response = httpx.Response(
        400,
        json={"error": "invalid_grant"},
        request=httpx.Request("POST", TOKEN_URL),
    )
    assert await provider._handle_refresh_response(response) is False
    assert provider.context.current_tokens is None
