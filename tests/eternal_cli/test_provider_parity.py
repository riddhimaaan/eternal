"""End-to-end provider parity contract: the desktop Providers tabs must show
the SAME provider universe as ``eternal model`` (the CLI/TUI picker).

This is the single load-bearing invariant of the unified provider catalog:

    keys(/api/env provider rows) ∪ ids(/api/providers/oauth) ⊇ CANONICAL_PROVIDERS

i.e. every provider the CLI picker offers is configurable from the desktop app,
on one of the two Providers sub-tabs (API keys or Accounts). It is asserted as
an invariant against the real FastAPI endpoints (not a snapshot / count), so it
can never silently drift again when a provider plugin is added.
"""

from fastapi.testclient import TestClient

from eternal_cli.models import CANONICAL_PROVIDERS
from eternal_cli.provider_catalog import provider_catalog
from eternal_cli.web_server import _SESSION_TOKEN, app

client = TestClient(app)
HEADERS = {"X-Eternal-Session-Token": _SESSION_TOKEN}

# `custom` is the bring-your-own-endpoint pseudo-provider configured inline via
# the model picker's local-endpoint flow, not a fixed credential card. It is in
# the CLI picker's universe but intentionally has no dedicated Providers-tab
# card. Exempt it from the union check.
#
# Virtual providers (auth_type "virtual", e.g. `moa`) are likewise in the CLI
# picker universe but have no real credential and no Providers-tab card — they
# are configured through their own feature UI (MoA presets). Exempt them too,
# derived from the catalog so any future virtual provider is covered without a
# hardcoded slug.
_VIRTUAL = {d.slug for d in provider_catalog() if d.auth_type == "virtual"}
_EXEMPT = {"custom"} | _VIRTUAL

# Providers that legitimately offer BOTH auth methods and so intentionally
# appear on both desktop tabs (an API-key card AND an account sign-in card).
# Anthropic supports a direct API key (Keys tab) and a subscription OAuth /
# Claude Code login (Accounts tab); surfacing both is correct, not a bug.
_DUAL_TAB = {"anthropic"}


def _keys_tab_providers() -> set[str]:
    """Provider slugs that have at least one card on the desktop API-keys tab."""
    data = client.get("/api/env", headers=HEADERS).json()
    return {
        info.get("provider")
        for info in data.values()
        if info.get("category") == "provider" and info.get("provider")
    }


def _accounts_tab_providers() -> set[str]:
    """Provider slugs offered on the desktop Accounts tab."""
    data = client.get("/api/providers/oauth", headers=HEADERS).json()
    return {p["id"] for p in data["providers"]}


def test_every_eternal_model_provider_is_configurable_in_desktop():
    """PARITY CONTRACT: GUI (keys ∪ accounts) ⊇ `eternal model` universe."""
    gui = _keys_tab_providers() | _accounts_tab_providers()
    missing = [
        e.slug
        for e in CANONICAL_PROVIDERS
        if e.slug not in _EXEMPT and e.slug not in gui
    ]
    assert not missing, (
        "providers shown in `eternal model` but not configurable in the desktop "
        f"Providers tabs: {missing}"
    )


def test_each_provider_lands_on_the_tab_its_auth_type_dictates():
    """A keys-tab provider must surface under /api/env; an accounts-tab provider
    under /api/providers/oauth. Cross-checks the catalog's tab routing against
    where each provider actually renders.
    """
    keys = _keys_tab_providers()
    accounts = _accounts_tab_providers()
    for d in provider_catalog():
        if d.slug in _EXEMPT:
            continue
        if d.tab == "keys" and d.api_key_env_vars:
            assert d.slug in keys, f"{d.slug} (keys tab) missing from /api/env"
        elif d.tab == "accounts":
            assert d.slug in accounts, f"{d.slug} (accounts tab) missing from /api/providers/oauth"




def test_removed_nous_provider_does_not_resurface_from_any_source():
    """The Nous Portal provider must be gone from EVERY source that feeds the
    provider surface, not just the one you happened to edit.

    Regression guard for a real whack-a-mole: removing the provider plugin, the
    model overlay and the explicit Accounts card each looked sufficient, and the
    desktop still rendered "Nous Portal — RECOMMENDED". Membership is a UNION --
    provider_catalog() folds in auth.PROVIDER_REGISTRY and
    models.CANONICAL_PROVIDERS, and _build_oauth_catalog() folds that into the
    hand-tuned cards -- so any single surviving entry puts the provider back on
    screen.

    A naive `"nous" in CANONICAL_PROVIDERS` is NOT a valid check: that list
    holds ProviderEntry tuples, so the membership test silently reports False
    for a slug that is present. Compare against .slug.
    """
    from eternal_cli.auth import PROVIDER_REGISTRY
    from eternal_cli.models import CANONICAL_PROVIDERS
    from eternal_cli.providers import ETERNAL_OVERLAYS
    from eternal_cli.web_server import _build_oauth_catalog

    assert "nous" not in [p.slug for p in CANONICAL_PROVIDERS]
    assert "nous" not in PROVIDER_REGISTRY
    assert "nous" not in ETERNAL_OVERLAYS
    assert "nous" not in [p["id"] for p in _build_oauth_catalog()]
    assert "nous" not in [d.slug for d in provider_catalog()]
