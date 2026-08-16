"""Resolve ETERNAL_HOME for standalone skill scripts.

Skill scripts may run outside the Eternal process (system Python, nix env,
CI) where ``eternal_constants`` is not importable.  This module provides the
same ``get_eternal_home()`` contract without requiring it on ``sys.path``.

When ``eternal_constants`` IS available it is used directly so profile
resolution and any future enhancements are picked up automatically.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from eternal_constants import get_eternal_home as get_eternal_home
except (ModuleNotFoundError, ImportError):

    def get_eternal_home() -> Path:
        """Return the Eternal home directory (default: ``~/.eternal``)."""
        val = os.environ.get("ETERNAL_HOME", "").strip()
        return Path(val) if val else Path.home() / ".eternal"
