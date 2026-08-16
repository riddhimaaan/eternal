"""Unit tests for eternal_cli.toolset_validation (see #38798).

Pure logic — the validity predicate is injected, so these tests need neither the
tool registry nor a running Eternal.
"""

import pytest

from eternal_cli.toolset_validation import validate_platform_toolsets

# A representative set of real toolset names. `eternal` is deliberately absent —
# that is the corruption #38798 reported (`eternal-cli` rewritten to `eternal`).
_KNOWN = {
    "eternal-cli",
    "eternal-telegram",
    "eternal-discord",
    "terminal",
    "web",
}


def _is_valid(name):
    return name in _KNOWN




def test_38798_corruption_warns_and_suggests_correct_name():
    # The exact reported shape: cli holds 'eternal' instead of 'eternal-cli'.
    warnings = validate_platform_toolsets({"cli": ["eternal"]}, _is_valid)
    unknown = [w for w in warnings if "unknown toolset 'eternal'" in w]
    assert len(unknown) == 1
    # Actionable: points at the valid name the entry should have been.
    assert "did you mean 'eternal-cli'?" in unknown[0]
    # And the zero-valid-toolsets safety net fires.
    assert any("zero valid toolsets" in w for w in warnings)


def test_mixed_valid_and_invalid_flags_only_the_invalid():
    cfg = {"cli": ["eternal-cli"], "discord": ["bogus"]}
    warnings = validate_platform_toolsets(cfg, _is_valid)
    # One valid entry exists, so no zero-valid warning.
    assert not any("zero valid toolsets" in w for w in warnings)
    assert len(warnings) == 1
    assert "platform 'discord'" in warnings[0]
    assert "unknown toolset 'bogus'" in warnings[0]




