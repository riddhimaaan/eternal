from pathlib import Path

import pytest

from eternal_cli import projects_db as pdb
from eternal_cli.project_prompt import (
    current_project_id,
    get_project_prompt,
    save_project_prompt,
    scan_project_workspace,
)
from eternal_cli.project_storage import storage_roots
from gateway.session_context import clear_session_vars, set_session_vars


def _project(home: Path, *, folders=()) -> str:
    home.mkdir(parents=True, exist_ok=True)
    with pdb.connect_closing() as conn:
        return pdb.create_project(conn, name="Content Engine", folders=folders)


def test_project_prompt_is_filled_and_replicated(tmp_path, monkeypatch):
    home = tmp_path / "home"
    first = tmp_path / "founder"
    second = tmp_path / "cmo"
    first.mkdir()
    second.mkdir()
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    project_id = _project(home, folders=[str(first), str(second)])

    saved = save_project_prompt(
        project_id,
        "# 1. Workspace Overview\n\nThis workspace produces founder content.",
        source="manual",
    )

    assert saved["exists"] is True
    assert saved["source"] == "manual"
    assert "# 1. Workspace Overview" in saved["prompt"]
    for section in range(4, 11):
        assert f"# {section}." in saved["prompt"]
    for root in storage_roots(project_id):
        assert (root / "BASE_PROMPT.md").read_text(encoding="utf-8").strip() == saved["prompt"]

    edited = save_project_prompt(project_id, "Only the user's later instructions.")
    assert edited["prompt"] == "Only the user's later instructions."


def test_manual_scan_reads_workspace_evidence_but_skips_sensitive_files(tmp_path, monkeypatch):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("A workspace for evidence-led COO content.", encoding="utf-8")
    (workspace / "AGENTS.md").write_text("Company claims must be sourced.", encoding="utf-8")
    skill = workspace / "skills" / "research"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("Research approved sources.", encoding="utf-8")
    (workspace / ".env").write_text("OPENROUTER_API_KEY=do-not-read", encoding="utf-8")
    dependency = workspace / "node_modules" / "package"
    dependency.mkdir(parents=True)
    (dependency / "README.md").write_text("do-not-index", encoding="utf-8")
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    project_id = _project(home, folders=[str(workspace)])

    result = scan_project_workspace(project_id)

    assert result["files_read"] == 3
    assert "evidence-led COO content" in result["context"]
    assert "Research approved sources" in result["context"]
    assert "do-not-read" not in result["context"]
    assert "do-not-index" not in result["context"]
    assert get_project_prompt(project_id)["exists"] is False


def test_folderless_project_cannot_be_scanned(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    project_id = _project(home)

    with pytest.raises(ValueError, match="root folder"):
        scan_project_workspace(project_id)


def test_explicit_project_wins_and_terminal_cwd_can_infer_project(tmp_path, monkeypatch):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    inferred = _project(home, folders=[str(workspace)])
    explicit = _project(home)

    assert current_project_id(str(workspace)) == inferred

    tokens = set_session_vars(project_id=explicit)
    try:
        assert current_project_id(str(workspace)) == explicit
    finally:
        clear_session_vars(tokens)


def test_project_agent_api_round_trip_and_scan_never_auto_saves(tmp_path, monkeypatch):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    from eternal_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("A design workspace for the COO.", encoding="utf-8")
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    project_id = _project(home, folders=[str(workspace)])
    monkeypatch.setattr(
        "eternal_cli.prompt_designer.design_project_prompt",
        lambda *_args, **_kwargs: {
            "reply": "Proposed from one file.",
            "draft": "PROPOSED BUT UNSAVED",
            "suggested_name": "COO Design",
            "description": "Design workspace",
            "ready": True,
        },
    )
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    loaded = client.get(f"/api/project-agents/{project_id}")
    assert loaded.status_code == 200
    assert loaded.json()["agent"]["exists"] is False

    saved = client.put(
        f"/api/project-agents/{project_id}",
        json={"prompt": "# 1. Workspace Overview\n\nCurrent saved prompt.", "source": "manual"},
    )
    assert saved.status_code == 200
    assert "Current saved prompt" in saved.json()["agent"]["prompt"]

    scanned = client.post(f"/api/project-agents/{project_id}/scan")
    assert scanned.status_code == 200
    assert scanned.json()["draft"] == "PROPOSED BUT UNSAVED"
    assert scanned.json()["files_read"] == 1

    reloaded = client.get(f"/api/project-agents/{project_id}")
    assert "Current saved prompt" in reloaded.json()["agent"]["prompt"]
    assert "PROPOSED BUT UNSAVED" not in reloaded.json()["agent"]["prompt"]
