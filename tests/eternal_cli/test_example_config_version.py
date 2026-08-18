"""The seeded example config must declare the current schema version.

The Docker image copies ``cli-config.yaml.example`` into a new user's
``$ETERNAL_HOME/config.yaml`` on first boot. When the file carried no
``_config_version``, the migrator read it as older than the support floor and
every first container launch printed:

    WARNING: This config predates version 12 (~2 years old) and can no longer
    be auto-migrated. Back up /opt/data/config.yaml and run `eternal setup`

— about a file written seconds earlier. A wrong-but-present version is worse
than none, because migrations the file genuinely needs would be skipped, so
this pins the value to the one source of truth rather than to a literal.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = REPO_ROOT / "cli-config.yaml.example"


def _example() -> dict:
    return yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))


def test_example_declares_a_config_version():
    assert "_config_version" in _example(), (
        f"{EXAMPLE.name} has no _config_version, so a config seeded from it reads "
        "as pre-support-floor and warns the user on first launch"
    )


def test_example_version_matches_the_code():
    from eternal_cli.config import DEFAULT_CONFIG

    expected = DEFAULT_CONFIG["_config_version"]
    assert _example()["_config_version"] == expected, (
        f"{EXAMPLE.name} declares _config_version "
        f"{_example()['_config_version']} but the code's current version is {expected}. "
        "Bump the example whenever the schema version moves."
    )


def test_example_version_is_above_the_support_floor():
    from eternal_cli.config_migrations import SUPPORT_FLOOR_VERSION

    assert _example()["_config_version"] >= SUPPORT_FLOOR_VERSION
