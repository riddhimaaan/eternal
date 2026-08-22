"""Reusable, user-owned full-control prompt profiles.

Prompt profiles deliberately live under ``ETERNAL_HOME`` rather than in the
application source tree. A full Eternal profile owns its own library, while
each entry stores the user-editable sections 1-10 in a plain
``BASE_PROMPT.md`` file. Live skills, memory, workspace, and runtime facts are
still assembled by Eternal.
"""

from __future__ import annotations

import json
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from eternal_constants import get_eternal_home
from utils import atomic_write_text


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_SECTION_HEADING_RE = re.compile(r"(?m)^#{1,6}\s*(?P<number>10|[1-9])\s*[.):-]")
_LOCK = threading.RLock()
_MAX_PROMPT_CHARS = 100_000
ORIGINAL_PROMPT_PROFILE_ID = "original-base-prompt"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _root(home: Optional[Path] = None) -> Path:
    return Path(home or get_eternal_home()) / "prompt-profiles"


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return (slug or "agent")[:64].rstrip("-")


def _validate_id(profile_id: str) -> str:
    value = str(profile_id or "").strip().lower()
    if not _ID_RE.fullmatch(value):
        raise ValueError("Invalid prompt profile id")
    return value


def _paths(profile_id: str, home: Optional[Path] = None) -> tuple[Path, Path, Path]:
    safe_id = _validate_id(profile_id)
    directory = _root(home) / safe_id
    return directory, directory / "profile.json", directory / "BASE_PROMPT.md"


def _clean_prompt(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) > _MAX_PROMPT_CHARS:
        raise ValueError(f"Base prompt is limited to {_MAX_PROMPT_CHARS:,} characters")
    return text


def _read(profile_id: str, home: Optional[Path] = None) -> dict[str, Any]:
    directory, meta_path, prompt_path = _paths(profile_id, home)
    if not directory.is_dir() or not meta_path.is_file():
        raise FileNotFoundError(f"Prompt profile not found: {profile_id}")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError(f"Prompt profile metadata is unreadable: {profile_id}") from exc
    if not isinstance(meta, dict):
        raise ValueError(f"Prompt profile metadata is invalid: {profile_id}")
    try:
        prompt = prompt_path.read_text(encoding="utf-8") if prompt_path.is_file() else ""
    except OSError as exc:
        raise ValueError(f"Base prompt is unreadable: {profile_id}") from exc
    return {
        "id": _validate_id(profile_id),
        "name": str(meta.get("name") or profile_id),
        "description": str(meta.get("description") or ""),
        "icon": str(meta.get("icon") or "sparkles"),
        "created_at": str(meta.get("created_at") or ""),
        "updated_at": str(meta.get("updated_at") or ""),
        "full_control": bool(meta.get("full_control", False)),
        "prompt": prompt.strip(),
        "path": str(directory),
    }


def list_prompt_profiles(home: Optional[Path] = None) -> list[dict[str, Any]]:
    root = _root(home)
    if not root.is_dir():
        return []
    profiles: list[dict[str, Any]] = []
    for child in root.iterdir():
        if not child.is_dir() or not _ID_RE.fullmatch(child.name):
            continue
        try:
            profiles.append(_read(child.name, home))
        except (FileNotFoundError, ValueError):
            continue
    return sorted(profiles, key=lambda item: (item["name"].lower(), item["id"]))


def get_prompt_profile(profile_id: str, home: Optional[Path] = None) -> dict[str, Any]:
    return _read(profile_id, home)


def create_prompt_profile(
    name: str,
    prompt: str,
    *,
    description: str = "",
    icon: str = "sparkles",
    home: Optional[Path] = None,
) -> dict[str, Any]:
    display_name = str(name or "").strip()
    if not display_name:
        raise ValueError("Prompt profile name is required")
    clean_prompt = prepare_new_prompt(prompt)
    if not clean_prompt:
        raise ValueError("Base prompt cannot be empty")
    with _LOCK:
        root = _root(home)
        root.mkdir(parents=True, exist_ok=True)
        base = _slugify(display_name)
        profile_id = base
        suffix = 2
        while (root / profile_id).exists():
            tail = f"-{suffix}"
            profile_id = f"{base[:64 - len(tail)].rstrip('-')}{tail}"
            suffix += 1
        directory, meta_path, prompt_path = _paths(profile_id, home)
        directory.mkdir(mode=0o755)
        now = _now()
        meta = {
            "id": profile_id,
            "name": display_name[:120],
            "description": str(description or "").strip()[:500],
            "icon": str(icon or "sparkles").strip()[:40] or "sparkles",
            "created_at": now,
            "updated_at": now,
            "full_control": True,
        }
        atomic_write_text(meta_path, json.dumps(meta, indent=2) + "\n", create_mode=0o644)
        atomic_write_text(prompt_path, clean_prompt + "\n", create_mode=0o644)
        return _read(profile_id, home)


def update_prompt_profile(
    profile_id: str,
    *,
    name: Optional[str] = None,
    prompt: Optional[str] = None,
    description: Optional[str] = None,
    icon: Optional[str] = None,
    home: Optional[Path] = None,
) -> dict[str, Any]:
    with _LOCK:
        current = _read(profile_id, home)
        directory, meta_path, prompt_path = _paths(profile_id, home)
        del directory
        new_name = current["name"] if name is None else str(name).strip()
        if not new_name:
            raise ValueError("Prompt profile name is required")
        new_prompt = current["prompt"] if prompt is None else _clean_prompt(prompt)
        if not new_prompt:
            raise ValueError("Base prompt cannot be empty")
        meta = {
            "id": current["id"],
            "name": new_name[:120],
            "description": current["description"] if description is None else str(description).strip()[:500],
            "icon": current["icon"] if icon is None else (str(icon).strip()[:40] or "sparkles"),
            "created_at": current["created_at"] or _now(),
            "updated_at": _now(),
            # Saving through the current editor upgrades older behavioral-only
            # profiles to the sections 1-10 format.
            "full_control": True,
        }
        atomic_write_text(meta_path, json.dumps(meta, indent=2) + "\n", preserve_mode=True, create_mode=0o644)
        atomic_write_text(prompt_path, new_prompt + "\n", preserve_mode=True, create_mode=0o644)
        return _read(profile_id, home)


def delete_prompt_profile(profile_id: str, home: Optional[Path] = None) -> Path:
    with _LOCK:
        directory, _, _ = _paths(profile_id, home)
        if not directory.is_dir():
            raise FileNotFoundError(f"Prompt profile not found: {profile_id}")
        shutil.rmtree(directory)
        return directory


def ensure_original_prompt_profile(
    identity: str = "", home: Optional[Path] = None
) -> dict[str, Any]:
    """Return the guaranteed global fallback, creating it when necessary.

    Environment Profiles must always have one complete Base Prompt available.
    Keeping that invariant here makes it apply equally to desktop, terminal,
    gateway, and background execution instead of depending on one UI having
    opened first.
    """
    authored_identity = str(identity or "").strip()
    desired_prompt = default_full_prompt(authored_identity).strip()

    # A legacy inline prompt is user data. Prefer an existing exact conversion,
    # and never overwrite a different Original profile merely to migrate it.
    if authored_identity:
        for profile in list_prompt_profiles(home):
            if str(profile.get("prompt") or "").strip() == desired_prompt:
                return profile
    else:
        try:
            return _read(ORIGINAL_PROMPT_PROFILE_ID, home)
        except (FileNotFoundError, ValueError):
            for profile in list_prompt_profiles(home):
                if profile.get("name") == "Original Base Prompt":
                    return profile

    with _LOCK:
        if not authored_identity:
            try:
                return _read(ORIGINAL_PROMPT_PROFILE_ID, home)
            except (FileNotFoundError, ValueError):
                for profile in list_prompt_profiles(home):
                    if profile.get("name") == "Original Base Prompt":
                        return profile
        return create_prompt_profile(
            "Original Base Prompt",
            desired_prompt,
            description="Eternal's global Base Prompt",
            home=home,
        )


def resolve_prompt_profile(profile_id: Any, home: Optional[Path] = None) -> str:
    """Return a selected profile's prompt, or empty when stale/invalid."""
    value = str(profile_id or "").strip().lower()
    if not value:
        return ""
    try:
        return str(_read(value, home).get("prompt") or "").strip()
    except (FileNotFoundError, ValueError):
        return ""


def resolve_agent_base_prompt(agent_config: Any, home: Optional[Path] = None) -> str:
    """Resolve the selected global Base Prompt with a guaranteed fallback."""
    from eternal_cli.personality import prompt_text

    config = agent_config if isinstance(agent_config, dict) else {}
    selected = resolve_prompt_profile(config.get("prompt_profile", ""), home=home)
    if selected:
        return selected
    legacy = prompt_text(config.get("base_prompt", ""))
    return ensure_original_prompt_profile(legacy, home=home)["prompt"]


def selected_prompt_has_full_control(agent_config: Any, home: Optional[Path] = None) -> bool:
    """Whether the resolved global prompt owns editable sections 1-10."""
    config = agent_config if isinstance(agent_config, dict) else {}
    value = str(config.get("prompt_profile") or "").strip()
    if value:
        try:
            return bool(_read(value, home).get("full_control", False))
        except (FileNotFoundError, ValueError):
            pass
    # A missing/stale selection resolves to the complete Original Base Prompt.
    ensure_original_prompt_profile(home=home)
    return True


def _default_prompt_sections(identity: str = "") -> list[str]:
    """Return Eternal's canonical editable sections 1-10."""
    from agent.prompt_builder import (
        ETERNAL_AGENT_HELP_GUIDANCE,
        MEMORY_GUIDANCE,
        PARALLEL_TOOL_CALL_GUIDANCE,
        SESSION_SEARCH_GUIDANCE,
        SKILLS_GUIDANCE,
        STEER_CHANNEL_NOTE,
        TASK_COMPLETION_GUIDANCE,
        TOOL_USE_ENFORCEMENT_GUIDANCE,
    )

    role = str(identity or "").strip() or (
        "You are Eternal, a personal AI assistant running on the user's machine. "
        "Help with the user's requested work clearly, accurately, and directly."
    )
    return [
        "# 1. Identity and Purpose\n\n" + role + "\n\n" + ETERNAL_AGENT_HELP_GUIDANCE,
        """# 2. Communication Style

Be direct and concrete. Answer the question that was asked without padding.
Use plain language, explain necessary technical terms briefly, and adapt the
amount of detail to the user. You may correct a mistaken assumption clearly.""",
        """# 3. Accuracy and Honesty

Never invent facts, sources, file paths, commands, file contents, API responses,
or execution results. When uncertain, say what is uncertain and use available
tools to resolve it. Report genuine blockers instead of fabricating an answer.""",
        "# 4. Completing the User's Request\n\n" + TASK_COMPLETION_GUIDANCE,
        "# 5. Tool-Use Strategy\n\n" + PARALLEL_TOOL_CALL_GUIDANCE + "\n\n" + TOOL_USE_ENFORCEMENT_GUIDANCE,
        "# 6. Persistent Memory\n\n" + MEMORY_GUIDANCE + "\n\n" + SESSION_SEARCH_GUIDANCE,
        """# 7. Skills

Before replying, inspect the live skills catalog appended by Eternal. If a
skill is relevant or partially relevant, load it with `skill_view(name)` and
follow it. Use the `eternal-agent` skill for Eternal configuration, setup,
extension, and troubleshooting.

""" + SKILLS_GUIDANCE,
        "# 8. Mid-Turn User Steering\n\n" + STEER_CHANNEL_NOTE,
        """# 9. Profile and Data Boundaries

Work within the active Eternal profile. Other profiles have separate skills,
plugins, scheduled jobs, memories, and configuration. Do not modify another
profile unless the user explicitly directs you to do so.""",
        """# 10. Interface Behavior

Adapt output to the current Eternal interface reported in the live runtime
context. In the desktop app, use readable Markdown and deliver local files with
`MEDIA:/absolute/path/to/file`. Use `setup_mcp` for MCP authorization when that
tool is available instead of manually changing MCP server configuration.""",
    ]


def default_full_prompt(identity: str = "") -> str:
    """Return the editable sections 1-10 used to seed a Prompt Profile."""
    return "\n\n".join(
        section.strip() for section in _default_prompt_sections(identity)
    ) + "\n"


def prepare_new_prompt(prompt: Any) -> str:
    """Fill Eternal's operational defaults into a newly-created profile.

    Creation is intentionally safer than later editing: sections 4-10 are
    always present initially, but ``update_prompt_profile`` never restores
    them after a user deliberately edits or removes them.
    """
    supplied = _clean_prompt(prompt)
    if not supplied:
        return ""
    present = {
        int(match.group("number"))
        for match in _SECTION_HEADING_RE.finditer(supplied)
    }
    if not present:
        return _clean_prompt(default_full_prompt(supplied))

    defaults = _default_prompt_sections()
    missing_operational = [
        defaults[number - 1] for number in range(4, 11) if number not in present
    ]
    if not missing_operational:
        return supplied
    return _clean_prompt(
        supplied.rstrip()
        + "\n\n"
        + "\n\n".join(section.strip() for section in missing_operational)
    )
