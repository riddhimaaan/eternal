import json
from pathlib import Path

from eternal_cli import projects_db as pdb
from eternal_cli.project_storage import (
    export_session,
    initialize_project,
    memory_dir,
    storage_roots,
    sync_memory,
)
from eternal_state import SessionDB
from gateway.session_context import clear_session_vars, set_session_vars
from tools.memory_tool import MemoryStore, get_memory_dir


def _project(home: Path, *, folders=()) -> str:
    home.mkdir(parents=True, exist_ok=True)
    with pdb.connect_closing() as conn:
        return pdb.create_project(conn, name="Research", folders=folders)


def test_folderless_project_owns_isolated_storage(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    project_id = _project(home)

    status = initialize_project(project_id)

    assert status["status"] == "synced"
    assert storage_roots(project_id) == [home / "projects" / project_id]
    assert memory_dir(project_id) == home / "projects" / project_id / "memories"
    manifest = json.loads((home / "projects" / project_id / "project.json").read_text())
    assert manifest["project_id"] == project_id


def test_conversation_and_memory_replicate_to_every_project_folder(tmp_path, monkeypatch):
    home = tmp_path / "home"
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    project_id = _project(home, folders=[str(first), str(second)])
    initialize_project(project_id)

    primary_memory = memory_dir(project_id)
    assert primary_memory is not None
    primary_memory.mkdir(parents=True, exist_ok=True)
    (primary_memory / "MEMORY.md").write_text("project fact", encoding="utf-8")
    assert sync_memory(project_id)["status"] == "synced"

    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session("chat-1", source="desktop", project_id=project_id)
        db.append_message("chat-1", role="user", content="hello project")
        db.append_message("chat-1", role="assistant", content="hello back")
        assert export_session(project_id, db, "chat-1")["status"] == "synced"
        assert db.get_session("chat-1")["project_id"] == project_id
    finally:
        db.close()

    for folder in (first, second):
        root = folder / ".eternal" / "projects" / project_id
        assert (root / "memories" / "MEMORY.md").read_text() == "project fact"
        snapshot = json.loads((root / "sessions" / "chat-1.json").read_text())
        assert snapshot["project_id"] == project_id
        assert [message["content"] for message in snapshot["messages"]] == [
            "hello project",
            "hello back",
        ]


def test_adding_first_folder_copies_folderless_project_data(tmp_path, monkeypatch):
    home = tmp_path / "home"
    folder = tmp_path / "workspace"
    folder.mkdir()
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    project_id = _project(home)
    initialize_project(project_id)
    original_memory = memory_dir(project_id)
    assert original_memory is not None
    original_memory.mkdir(parents=True, exist_ok=True)
    (original_memory / "MEMORY.md").write_text("before folder", encoding="utf-8")

    with pdb.connect_closing() as conn:
        pdb.add_folder(conn, project_id, str(folder), is_primary=True)
    initialize_project(project_id)

    copied = folder / ".eternal" / "projects" / project_id / "memories" / "MEMORY.md"
    assert copied.read_text() == "before folder"


def test_session_context_routes_memory_to_its_explicit_project(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    first = _project(home)
    second = _project(home)

    tokens = set_session_vars(session_id="chat-a", project_id=first)
    try:
        assert get_memory_dir() == home / "projects" / first / "memories"
    finally:
        clear_session_vars(tokens)

    tokens = set_session_vars(session_id="chat-b", project_id=second)
    try:
        assert get_memory_dir() == home / "projects" / second / "memories"
    finally:
        clear_session_vars(tokens)


def test_terminal_cwd_infers_project_for_memory_and_session(tmp_path, monkeypatch):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    second_workspace = tmp_path / "second-workspace"
    workspace.mkdir()
    second_workspace.mkdir()
    monkeypatch.setenv("ETERNAL_HOME", str(home))
    project_id = _project(home, folders=[str(workspace), str(second_workspace)])
    initialize_project(project_id)
    monkeypatch.chdir(workspace)

    assert get_memory_dir() == workspace / ".eternal" / "projects" / project_id / "memories"
    store = MemoryStore()
    store.load_from_disk()
    assert store.add("memory", "terminal project fact")["success"] is True
    replica = second_workspace / ".eternal" / "projects" / project_id / "memories" / "MEMORY.md"
    assert "terminal project fact" in replica.read_text(encoding="utf-8")

    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session("terminal-chat", source="cli", cwd=str(workspace))
        assert db.get_session("terminal-chat")["project_id"] == project_id
    finally:
        db.close()
