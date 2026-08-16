"""Resolve ETERNAL_HOME for standalone skill scripts.

Skill scripts may run outside the Eternal process (e.g. system Python,
nix env, CI) where ``eternal_constants`` is not importable.  This module
provides the same ``get_eternal_home()`` and ``display_eternal_home()``
contracts as ``eternal_constants`` without requiring it on ``sys.path``.

When ``eternal_constants`` IS available it is used directly so that any
future enhancements (profile resolution, Docker detection, etc.) are
picked up automatically.  The fallback path replicates the core logic
from ``eternal_constants.py`` using only the stdlib.

All scripts under ``google-workspace/scripts/`` should import from here
instead of duplicating the ``ETERNAL_HOME = Path(os.getenv(...))`` pattern.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from eternal_constants import display_eternal_home as display_eternal_home
    from eternal_constants import get_eternal_home as get_eternal_home
except (ModuleNotFoundError, ImportError):

    def get_eternal_home() -> Path:
        """Return the Eternal home directory (default: ~/.eternal).

        Mirrors ``eternal_constants.get_eternal_home()``."""
        val = os.environ.get("ETERNAL_HOME", "").strip()
        return Path(val) if val else Path.home() / ".eternal"

    def display_eternal_home() -> str:
        """Return a user-friendly ``~/``-shortened display string.

        Mirrors ``eternal_constants.display_eternal_home()``."""
        home = get_eternal_home()
        try:
            return "~/" + str(home.relative_to(Path.home()))
        except ValueError:
            return str(home)
