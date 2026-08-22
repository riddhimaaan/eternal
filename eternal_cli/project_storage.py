"""Project-owned conversation and memory storage.

The profile ``state.db`` remains Eternal's compatibility index, while every
explicit Project owns a portable bundle containing complete conversation
snapshots and its curated memory.  Folder-backed projects replicate that
bundle into every selected folder; folderless projects keep it under the
active profile home.

Only the backend writes these bundles.  A monotonically increasing revision
in ``project.json`` makes partial/offline replicas observable and lets a later
sync choose the newest complete copy without merging independently edited
SQLite databases.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Iterable, Optional

from eternal_constants import get_eternal_home
from utils import atomic_write_text

logger = logging.getLogger(__name__)

_BUNDLE_VERSION = 1
_PROJECT_DIR = Path(".eternal") / "projects"


def _project(project_id: str):
    """Resolve an explicit project in the active profile, or return ``None``."""
    project_id = str(project_id or "").strip()
    if not project_id:
        return None
    try:
        from eternal_cli import projects_db as pdb

        with pdb.connect_closing() as conn:
            return pdb.get_project(conn, project_id)
    except Exception:
        logger.debug("project storage lookup failed for %s", project_id, exc_info=True)
        return None


def _internal_root(project_id: str) -> Path:
    return get_eternal_home() / "projects" / project_id


def storage_roots(project_id: str, *, include_internal_fallback: bool = False) -> list[Path]:
    """Return the bundle destinations for an explicit Project.

    A project with folders stores one copy below every folder.  A project with
    no folders stores one isolated copy below the profile home.  The internal
    fallback can be included while adopting folders so pre-folder data remains
    available as a migration source.
    """
    project = _project(project_id)
    if project is None:
        return []
    roots = [Path(folder.path) / _PROJECT_DIR / project.id for folder in project.folders]
    internal = _internal_root(project.id)
    if not roots:
        roots = [internal]
    elif include_internal_fallback and internal.exists():
        roots.append(internal)
    # A folder can be listed twice with different spelling on case-insensitive
    # hosts. Preserve display spelling but write each physical destination once.
    seen: set[str] = set()
    unique: list[Path] = []
    for root in roots:
        key = os.path.normcase(os.path.abspath(str(root)))
        if key not in seen:
            seen.add(key)
            unique.append(root)
    return unique


def primary_storage_root(project_id: str) -> Optional[Path]:
    roots = storage_roots(project_id)
    if not roots:
        return None
    project = _project(project_id)
    if project is not None and project.folders:
        by_path = {
            os.path.normcase(os.path.abspath(folder.path)): Path(folder.path) / _PROJECT_DIR / project.id
            for folder in project.folders
        }
        for folder in project.folders:
            if Path(folder.path).is_dir():
                return by_path[os.path.normcase(os.path.abspath(folder.path))]
    return roots[0]


def memory_dir(project_id: str) -> Optional[Path]:
    root = primary_storage_root(project_id)
    return root / "memories" if root is not None else None


def _manifest(root: Path) -> dict[str, Any]:
    try:
        raw = json.loads((root / "project.json").read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _revision(root: Path) -> int:
    try:
        return int(_manifest(root).get("revision") or 0)
    except (TypeError, ValueError):
        return 0


def _new_revision(roots: Iterable[Path]) -> int:
    return max([time.time_ns(), *(_revision(root) + 1 for root in roots)])


def _atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}-{time.time_ns()}")
    shutil.copy2(source, temporary)
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)


def _write_manifest(root: Path, project, revision: int) -> None:
    root.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(root, 0o700)
    except OSError:
        pass
    payload = {
        "bundle_version": _BUNDLE_VERSION,
        "project_id": project.id,
        "slug": project.slug,
        "name": project.name,
        "revision": revision,
        "updated_at": time.time(),
        "folders": [folder.path for folder in project.folders],
    }
    path = root / "project.json"
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _locally_exclude_bundle(folder: Path) -> None:
    """Keep project data out of Git without editing the tracked .gitignore."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(folder), "rev-parse", "--git-path", "info/exclude"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return
        exclude = Path(proc.stdout.strip())
        if not exclude.is_absolute():
            exclude = folder / exclude
        exclude.parent.mkdir(parents=True, exist_ok=True)
        current = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        rule = "/.eternal/"
        if rule not in {line.strip() for line in current.splitlines()}:
            with exclude.open("a", encoding="utf-8") as handle:
                if current and not current.endswith("\n"):
                    handle.write("\n")
                handle.write("# Eternal project-local conversations and memory\n/.eternal/\n")
    except Exception:
        logger.debug("could not add local Git exclusion for %s", folder, exc_info=True)


def initialize_project(project_id: str) -> dict[str, Any]:
    """Create/synchronize a project's storage roots without deleting old data."""
    project = _project(project_id)
    if project is None:
        return {"project_id": project_id, "status": "missing", "roots": []}

    destinations = storage_roots(project.id)
    candidates = storage_roots(project.id, include_internal_fallback=True)
    source = max((root for root in candidates if root.exists()), key=_revision, default=None)
    revision = _new_revision(candidates)
    failures: list[dict[str, str]] = []

    for root in destinations:
        try:
            root.mkdir(parents=True, exist_ok=True)
            if source is not None and source != root:
                for relative in (
                    Path("memories") / "MEMORY.md",
                    Path("memories") / "USER.md",
                    Path("BASE_PROMPT.md"),
                    Path("project-agent.json"),
                ):
                    src = source / relative
                    if src.is_file():
                        _atomic_copy(src, root / relative)
                source_sessions = source / "sessions"
                if source_sessions.is_dir():
                    for src in source_sessions.glob("*.json"):
                        _atomic_copy(src, root / "sessions" / src.name)
            _write_manifest(root, project, revision)
        except Exception as exc:
            failures.append({"root": str(root), "error": str(exc)})

    for folder in project.folders:
        _locally_exclude_bundle(Path(folder.path))
    return storage_status(project.id, failures=failures)


def sync_memory(project_id: str) -> dict[str, Any]:
    """Replicate the primary project's curated memory to every selected folder."""
    project = _project(project_id)
    roots = storage_roots(project_id)
    if project is None or not roots:
        return {"project_id": project_id, "status": "missing", "roots": []}
    source = primary_storage_root(project_id) or roots[0]
    revision = _new_revision(roots)
    failures: list[dict[str, str]] = []
    for root in roots:
        try:
            if root != source:
                for name in ("MEMORY.md", "USER.md"):
                    src = source / "memories" / name
                    if src.is_file():
                        _atomic_copy(src, root / "memories" / name)
            _write_manifest(root, project, revision)
        except Exception as exc:
            failures.append({"root": str(root), "error": str(exc)})
    return storage_status(project_id, failures=failures)


def export_session(project_id: str, db, session_id: str) -> dict[str, Any]:
    """Write one complete, portable conversation snapshot to every root."""
    project = _project(project_id)
    roots = storage_roots(project_id)
    if project is None or not roots or db is None or not session_id:
        return {"project_id": project_id, "status": "missing", "roots": []}
    row = db.get_session(session_id)
    if row is None:
        return storage_status(project_id)
    messages = db.get_messages(session_id, include_compacted=True)
    payload = {
        "bundle_version": _BUNDLE_VERSION,
        "project_id": project.id,
        "exported_at": time.time(),
        "session": row,
        "messages": messages,
    }
    encoded = json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n"
    revision = _new_revision(roots)
    failures: list[dict[str, str]] = []
    for root in roots:
        try:
            target = root / "sessions" / f"{session_id}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(target, encoded)
            try:
                os.chmod(target, 0o600)
            except OSError:
                pass
            _write_manifest(root, project, revision)
        except Exception as exc:
            failures.append({"root": str(root), "error": str(exc)})
    return storage_status(project_id, failures=failures)


def storage_status(project_id: str, *, failures: Optional[list[dict[str, str]]] = None) -> dict[str, Any]:
    roots = storage_roots(project_id)
    states = [
        {
            "path": str(root),
            "available": root.is_dir(),
            "revision": _revision(root),
        }
        for root in roots
    ]
    revisions = [state["revision"] for state in states if state["available"]]
    synced = bool(states) and len(revisions) == len(states) and len(set(revisions)) <= 1
    return {
        "project_id": project_id,
        "status": "synced" if synced else "degraded",
        "synced": sum(1 for state in states if state["available"] and state["revision"] == max(revisions or [0])),
        "total": len(states),
        "roots": states,
        "failures": failures or [],
    }
