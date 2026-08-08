"""Tests for eternal backup and import commands."""

import json
import os
import sqlite3
import zipfile
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_eternal_tree(root: Path) -> None:
    """Create a realistic ~/.eternal directory structure for testing."""
    (root / "config.yaml").write_text("model:\n  provider: openrouter\n")
    (root / ".env").write_text("OPENROUTER_API_KEY=sk-test-123\n")
    for db_name in ("memory_store.db", "eternal_state.db"):
        with sqlite3.connect(root / db_name) as conn:
            conn.execute("CREATE TABLE sample (value TEXT)")
            conn.execute("INSERT INTO sample VALUES ('test')")

    # Sessions
    (root / "sessions").mkdir(exist_ok=True)
    (root / "sessions" / "abc123.json").write_text("{}")

    # Skills
    (root / "skills").mkdir(exist_ok=True)
    (root / "skills" / "my-skill").mkdir()
    (root / "skills" / "my-skill" / "SKILL.md").write_text("# My Skill\n")

    # Skins
    (root / "skins").mkdir(exist_ok=True)
    (root / "skins" / "cyber.yaml").write_text("name: cyber\n")

    # Cron
    (root / "cron").mkdir(exist_ok=True)
    (root / "cron" / "jobs.json").write_text("[]")

    # Memories
    (root / "memories").mkdir(exist_ok=True)
    (root / "memories" / "notes.json").write_text("{}")

    # Profiles
    (root / "profiles").mkdir(exist_ok=True)
    (root / "profiles" / "coder").mkdir()
    (root / "profiles" / "coder" / "config.yaml").write_text("model:\n  provider: anthropic\n")
    (root / "profiles" / "coder" / ".env").write_text("ANTHROPIC_API_KEY=sk-ant-123\n")

    # eternal-agent repo (should be EXCLUDED)
    (root / "eternal-agent").mkdir(exist_ok=True)
    (root / "eternal-agent" / "run_agent.py").write_text("# big file\n")
    (root / "eternal-agent" / ".git").mkdir()
    (root / "eternal-agent" / ".git" / "HEAD").write_text("ref: refs/heads/main\n")

    # __pycache__ (should be EXCLUDED)
    (root / "plugins").mkdir(exist_ok=True)
    (root / "plugins" / "__pycache__").mkdir()
    (root / "plugins" / "__pycache__" / "mod.cpython-312.pyc").write_bytes(b"\x00")

    # PID files (should be EXCLUDED)
    (root / "gateway.pid").write_text("12345")

    # Logs (should be included)
    (root / "logs").mkdir(exist_ok=True)
    (root / "logs" / "agent.log").write_text("log line\n")


def _symlink_file_or_skip(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable in test environment: {exc}")


# ---------------------------------------------------------------------------
# _should_exclude tests
# ---------------------------------------------------------------------------

class TestShouldExclude:
    def test_excludes_eternal_agent(self):
        from eternal_cli.backup import _should_exclude
        assert _should_exclude(Path("eternal-agent/run_agent.py"))
        assert _should_exclude(Path("eternal-agent/.git/HEAD"))

    def test_excludes_pycache(self):
        from eternal_cli.backup import _should_exclude
        assert _should_exclude(Path("plugins/__pycache__/mod.cpython-312.pyc"))

    def test_excludes_pyc_files(self):
        from eternal_cli.backup import _should_exclude
        assert _should_exclude(Path("some/module.pyc"))

    def test_excludes_pid_files(self):
        from eternal_cli.backup import _should_exclude
        assert _should_exclude(Path("gateway.pid"))
        assert _should_exclude(Path("cron.pid"))

    def test_excludes_checkpoints(self):
        """checkpoints/ is session-local trajectory cache — hash-keyed,
        regenerated per-session, won't port to another machine anyway."""
        from eternal_cli.backup import _should_exclude
        assert _should_exclude(Path("checkpoints/abc123/trajectory.json"))
        assert _should_exclude(Path("checkpoints/deadbeef/step_0001.json"))

    def test_excludes_backups_dir(self):
        """backups/ is excluded so pre-update backups don't nest exponentially."""
        from eternal_cli.backup import _should_exclude
        assert _should_exclude(Path("backups/pre-update-2026-04-27-063400.zip"))

    def test_excludes_sqlite_sidecars(self):
        """SQLite WAL/SHM/journal sidecars must not ship alongside the
        safe-copied .db — pairing a fresh snapshot with stale sidecar state
        produces a torn restore."""
        from eternal_cli.backup import _should_exclude
        assert _should_exclude(Path("state.db-wal"))
        assert _should_exclude(Path("state.db-shm"))
        assert _should_exclude(Path("state.db-journal"))
        assert _should_exclude(Path("memory_store.db-wal"))
        # The .db itself is still included (and safe-copied separately)
        assert not _should_exclude(Path("state.db"))

    def test_includes_config(self):
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path("config.yaml"))

    def test_includes_env(self):
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path(".env"))

    def test_includes_skills(self):
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path("skills/my-skill/SKILL.md"))

    def test_includes_profiles(self):
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path("profiles/coder/config.yaml"))

    def test_includes_sessions(self):
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path("sessions/abc.json"))

    def test_includes_logs(self):
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path("logs/agent.log"))

    def test_includes_nested_eternal_agent_in_skills(self):
        """skills/autonomous-ai-agents/eternal-agent/ must NOT be excluded —
        only the root-level eternal-agent/ repo is skipped."""
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path("skills/autonomous-ai-agents/eternal-agent/SKILL.md"))
        assert not _should_exclude(Path("skills/autonomous-ai-agents/eternal-agent/sub/item.txt"))

    @pytest.mark.parametrize(
        "rel",
        [
            "plugins/my-plugin/.venv/lib/python3.12/site-packages/x/__init__.py",
            "plugins/my-plugin/venv/bin/python",
            "mcp/server/site-packages/pkg/mod.py",
            ".cache/uv/wheels/abc.whl",
            "plugins/p/.cache/pip/http/deadbeef",
            ".tox/py312/log.txt",
            ".nox/tests/bin/pytest",
            "plugins/p/.pytest_cache/v/cache/lastfailed",
            ".mypy_cache/3.12/agent.meta.json",
            ".ruff_cache/0.4.0/abc",
        ],
    )
    def test_excludes_regeneratable_dependency_and_cache_dirs(self, rel):
        """Python dep trees and tool caches under ETERNAL_HOME must be skipped —
        these are what balloon a backup to hundreds of thousands of files."""
        from eternal_cli.backup import _should_exclude
        assert _should_exclude(Path(rel))

    def test_does_not_exclude_curator_archive(self):
        """skills/.archive/ holds restorable archived skills and MUST survive
        a backup — it is intentionally NOT in the exclusion set."""
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path("skills/.archive/old-skill/SKILL.md"))

    def test_does_not_exclude_legit_files_resembling_cache_names(self):
        """Only directory-component matches are excluded; a normal file is kept."""
        from eternal_cli.backup import _should_exclude
        assert not _should_exclude(Path("skills/my-skill/venv-notes.md"))
        assert not _should_exclude(Path("memories/cache.json"))

# ---------------------------------------------------------------------------
# Backup tests
# ---------------------------------------------------------------------------

class TestBackup:
    def test_creates_zip(self, tmp_path, monkeypatch):
        """Backup creates a valid zip containing expected files."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        # get_default_eternal_root needs this
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "backup.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        run_backup(args)

        assert out_zip.exists()
        with zipfile.ZipFile(out_zip, "r") as zf:
            names = zf.namelist()
            # Config should be present
            assert "config.yaml" in names
            assert ".env" in names
            # Skills
            assert "skills/my-skill/SKILL.md" in names
            # Profiles
            assert "profiles/coder/config.yaml" in names
            assert "profiles/coder/.env" in names
            # Sessions
            assert "sessions/abc123.json" in names
            # Logs
            assert "logs/agent.log" in names
            # Skins
            assert "skins/cyber.yaml" in names

    def test_failed_sqlite_backup_never_raw_copies_live_wal_db(self, tmp_path, monkeypatch, capsys):
        """A failed backup() must not silently archive the stale main DB file.

        Keep a real, uncheckpointed WAL transaction live so a raw copy of only
        ``state.db`` would be a valid-looking but torn snapshot.
        """
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("model: test\n")
        db_path = eternal_home / "state.db"

        writer = sqlite3.connect(db_path)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE events (value TEXT)")
        writer.commit()
        writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        writer.execute("INSERT INTO events VALUES ('only-in-wal')")
        writer.commit()
        assert Path(f"{db_path}-wal").stat().st_size > 0

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        import eternal_cli.backup as backup_mod
        real_connect = backup_mod.sqlite3.connect

        class FailingBackupConnection:
            def __init__(self, connection):
                self._connection = connection

            def backup(self, _destination):
                raise sqlite3.OperationalError("forced backup failure")

            def close(self):
                self._connection.close()

        def connect_with_failed_backup(database, *args, **kwargs):
            connection = real_connect(database, *args, **kwargs)
            if str(database).startswith(f"file:{db_path}"):
                return FailingBackupConnection(connection)
            return connection

        monkeypatch.setattr(backup_mod.sqlite3, "connect", connect_with_failed_backup)
        out_zip = tmp_path / "backup.zip"
        try:
            backup_mod.run_backup(Namespace(output=str(out_zip)))
        finally:
            writer.close()

        with zipfile.ZipFile(out_zip) as zf:
            assert "config.yaml" in zf.namelist()
            assert "state.db" not in zf.namelist()

        output = capsys.readouterr().out
        assert "Backup incomplete" in output
        assert "state.db: SQLite safe copy failed" in output
        assert "Restore with:" not in output

    def test_db_snapshots_staged_beside_output_zip(self, tmp_path, monkeypatch):
        """SQLite staging temp files must be created on the output zip's
        filesystem (dir=out_path.parent), NOT the system /tmp default — a
        small tmpfs there silently drops large DBs from the backup (#35376)."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_dir = tmp_path / "external-drive"
        out_dir.mkdir()
        out_zip = out_dir / "backup.zip"
        args = Namespace(output=str(out_zip))

        import eternal_cli.backup as backup_mod
        staged_dirs = []
        real_ntf = backup_mod.tempfile.NamedTemporaryFile

        def _spy(*a, **kw):
            staged_dirs.append(kw.get("dir"))
            return real_ntf(*a, **kw)

        monkeypatch.setattr(backup_mod.tempfile, "NamedTemporaryFile", _spy)
        backup_mod.run_backup(args)

        # At least one .db was staged, and every staging call targeted the
        # output zip's directory rather than the system temp default.
        assert staged_dirs, "no SQLite snapshot was staged"
        assert all(d == str(out_dir) for d in staged_dirs), staged_dirs

    def test_pre_update_db_snapshots_staged_beside_output_zip(self, tmp_path, monkeypatch):
        """The pre-update/pre-migration zip path (_write_full_zip_backup) must
        also stage SQLite snapshots beside its output zip, not in /tmp."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = eternal_home / "backups" / "pre-update-test.zip"
        out_zip.parent.mkdir(parents=True, exist_ok=True)

        import eternal_cli.backup as backup_mod
        staged_dirs = []
        real_ntf = backup_mod.tempfile.NamedTemporaryFile

        def _spy(*a, **kw):
            staged_dirs.append(kw.get("dir"))
            return real_ntf(*a, **kw)

        monkeypatch.setattr(backup_mod.tempfile, "NamedTemporaryFile", _spy)
        result = backup_mod._write_full_zip_backup(out_zip, eternal_home)

        assert result is not None
        assert staged_dirs, "no SQLite snapshot was staged"
        assert all(d == str(out_zip.parent) for d in staged_dirs), staged_dirs

    def test_excludes_eternal_agent(self, tmp_path, monkeypatch):
        """Backup does NOT include eternal-agent/ directory."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "backup.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        run_backup(args)

        with zipfile.ZipFile(out_zip, "r") as zf:
            names = zf.namelist()
            agent_files = [n for n in names if "eternal-agent" in n]
            assert agent_files == [], f"eternal-agent files leaked into backup: {agent_files}"

    def test_excludes_dependency_and_cache_trees(self, tmp_path, monkeypatch):
        """A plugin venv / site-packages / pip cache under ETERNAL_HOME must be
        pruned by the walk, while real data (skills, config) is preserved.
        This is the regression guard for the ballooning-backup bug."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)

        # Simulate the heavy regeneratable trees that ballooned the backup.
        venv_pkg = eternal_home / "plugins" / "heavy" / ".venv" / "lib" / "site-packages" / "dep"
        venv_pkg.mkdir(parents=True)
        (venv_pkg / "__init__.py").write_text("# dep\n")
        pip_cache = eternal_home / ".cache" / "uv" / "wheels"
        pip_cache.mkdir(parents=True)
        (pip_cache / "abc.whl").write_bytes(b"\x00")

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "backup.zip"
        from eternal_cli.backup import run_backup
        run_backup(Namespace(output=str(out_zip)))

        with zipfile.ZipFile(out_zip, "r") as zf:
            names = zf.namelist()
        leaked = [n for n in names if ".venv" in n or "site-packages" in n or ".cache" in n]
        assert leaked == [], f"regeneratable trees leaked into backup: {leaked}"
        # Real data still present.
        assert "skills/my-skill/SKILL.md" in names
        assert "config.yaml" in names

    def test_includes_nested_eternal_agent_in_skills(self, tmp_path, monkeypatch):
        """Backup includes skills/.../eternal-agent/ but NOT root eternal-agent/."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)

        # Add a nested eternal-agent directory inside skills (like the real layout)
        nested = eternal_home / "skills" / "autonomous-ai-agents" / "eternal-agent"
        nested.mkdir(parents=True)
        (nested / "SKILL.md").write_text("# Eternal Agent Skill\n")
        (nested / "sub").mkdir()
        (nested / "sub" / "item.txt").write_text("nested content\n")

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "backup.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        run_backup(args)

        with zipfile.ZipFile(out_zip, "r") as zf:
            names = zf.namelist()
            # Root eternal-agent must be excluded
            root_agent = [n for n in names if n.startswith("eternal-agent/")]
            assert root_agent == [], f"root eternal-agent leaked: {root_agent}"
            # Nested skill eternal-agent must be included
            assert "skills/autonomous-ai-agents/eternal-agent/SKILL.md" in names
            assert "skills/autonomous-ai-agents/eternal-agent/sub/item.txt" in names

    def test_excludes_pycache(self, tmp_path, monkeypatch):
        """Backup does NOT include __pycache__ dirs."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "backup.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        run_backup(args)

        with zipfile.ZipFile(out_zip, "r") as zf:
            names = zf.namelist()
            pycache_files = [n for n in names if "__pycache__" in n]
            assert pycache_files == []

    def test_excludes_pid_files(self, tmp_path, monkeypatch):
        """Backup does NOT include PID files."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "backup.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        run_backup(args)

        with zipfile.ZipFile(out_zip, "r") as zf:
            names = zf.namelist()
            pid_files = [n for n in names if n.endswith(".pid")]
            assert pid_files == []

    def test_default_output_path(self, tmp_path, monkeypatch):
        """When no output path given, zip goes to ~/eternal-backup-*.zip."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("model: test\n")

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        args = Namespace(output=None)

        from eternal_cli.backup import run_backup
        run_backup(args)

        # Should exist in home dir
        zips = list(tmp_path.glob("eternal-backup-*.zip"))
        assert len(zips) == 1

    def test_skips_symlinked_files(self, tmp_path, monkeypatch):
        """Backup must not dereference symlinks and leak files outside ETERNAL_HOME."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        _make_eternal_tree(eternal_home)
        outside = tmp_path / "outside-secret.txt"
        outside.write_text("outside secret\n")
        _symlink_file_or_skip(eternal_home / "skills" / "outside-link.txt", outside)

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "backup.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        run_backup(args)

        with zipfile.ZipFile(out_zip, "r") as zf:
            names = zf.namelist()
            assert "skills/outside-link.txt" not in names
            assert all(zf.read(name) != b"outside secret\n" for name in names)


# ---------------------------------------------------------------------------
# _validate_backup_zip tests
# ---------------------------------------------------------------------------

class TestValidateBackupZip:
    def _make_zip(self, zip_path: Path, filenames: list[str]) -> None:
        with zipfile.ZipFile(zip_path, "w") as zf:
            for name in filenames:
                zf.writestr(name, "dummy")

    def test_state_db_passes(self, tmp_path):
        """A zip containing state.db is accepted as a valid Eternal backup."""
        from eternal_cli.backup import _validate_backup_zip
        zip_path = tmp_path / "backup.zip"
        self._make_zip(zip_path, ["state.db", "sessions/abc.json"])
        with zipfile.ZipFile(zip_path, "r") as zf:
            ok, reason = _validate_backup_zip(zf)
        assert ok, reason

    def test_old_wrong_db_name_fails(self, tmp_path):
        """A zip with only eternal_state.db (old wrong name) is rejected."""
        from eternal_cli.backup import _validate_backup_zip
        zip_path = tmp_path / "old.zip"
        self._make_zip(zip_path, ["eternal_state.db", "memory_store.db"])
        with zipfile.ZipFile(zip_path, "r") as zf:
            ok, reason = _validate_backup_zip(zf)
        assert not ok

    def test_config_yaml_passes(self, tmp_path):
        """A zip containing config.yaml is accepted (existing behaviour preserved)."""
        from eternal_cli.backup import _validate_backup_zip
        zip_path = tmp_path / "backup.zip"
        self._make_zip(zip_path, ["config.yaml", "skills/x/SKILL.md"])
        with zipfile.ZipFile(zip_path, "r") as zf:
            ok, reason = _validate_backup_zip(zf)
        assert ok, reason


# ---------------------------------------------------------------------------
# Import tests
# ---------------------------------------------------------------------------

class TestImport:
    def _make_backup_zip(self, zip_path: Path, files: dict[str, str | bytes]) -> None:
        """Create a test zip with given files."""
        with zipfile.ZipFile(zip_path, "w") as zf:
            for name, content in files.items():
                if isinstance(content, bytes):
                    zf.writestr(name, content)
                else:
                    zf.writestr(name, content)

    def test_restores_files(self, tmp_path, monkeypatch):
        """Import extracts files into eternal home."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model:\n  provider: openrouter\n",
            ".env": "OPENROUTER_API_KEY=sk-test\n",
            "skills/my-skill/SKILL.md": "# My Skill\n",
            "profiles/coder/config.yaml": "model:\n  provider: anthropic\n",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        assert (eternal_home / "config.yaml").read_text() == "model:\n  provider: openrouter\n"
        assert (eternal_home / ".env").read_text() == "OPENROUTER_API_KEY=sk-test\n"
        assert (eternal_home / "skills" / "my-skill" / "SKILL.md").read_text() == "# My Skill\n"
        assert (eternal_home / "profiles" / "coder" / "config.yaml").exists()

    def test_strips_eternal_prefix(self, tmp_path, monkeypatch):
        """Import strips .eternal/ prefix if all entries share it."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            ".eternal/config.yaml": "model: test\n",
            ".eternal/skills/a/SKILL.md": "# A\n",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        assert (eternal_home / "config.yaml").read_text() == "model: test\n"
        assert (eternal_home / "skills" / "a" / "SKILL.md").read_text() == "# A\n"

    def test_rejects_empty_zip(self, tmp_path, monkeypatch):
        """Import rejects an empty zip."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "empty.zip"
        with zipfile.ZipFile(zip_path, "w"):
            pass  # empty

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        with pytest.raises(SystemExit):
            run_import(args)

    def test_rejects_non_eternal_zip(self, tmp_path, monkeypatch):
        """Import rejects a zip that doesn't look like a eternal backup."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "random.zip"
        self._make_backup_zip(zip_path, {
            "some/random/file.txt": "hello",
            "another/thing.json": "{}",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        with pytest.raises(SystemExit):
            run_import(args)

    def test_blocks_path_traversal(self, tmp_path, monkeypatch):
        """Import blocks zip entries with path traversal."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "evil.zip"
        # Include a marker file so validation passes
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: test\n",
            "../../etc/passwd": "root:x:0:0\n",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        # config.yaml should be restored
        assert (eternal_home / "config.yaml").exists()
        # traversal file should NOT exist outside eternal home
        assert not (tmp_path / "etc" / "passwd").exists()

    def test_preserves_live_gateway_state(self, tmp_path, monkeypatch):
        """Import must not overwrite the target's gateway_state.json.

        The backup carries the *source* machine's gateway run/desired state.
        Restoring it onto a hosted container drives the boot reconciler off
        stale/foreign state and leaves the gateway stuck "starting",
        disconnecting it from the Nous portal (NS-508). The live file wins.
        """
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        # The target (e.g. hosted container) already has its own live state.
        live_state = '{"gateway_state": "running", "desired_state": "running"}'
        (eternal_home / "gateway_state.json").write_text(live_state)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: test\n",
            # A backup from a laptop where the gateway was stopped.
            "gateway_state.json": '{"gateway_state": "stopped", "desired_state": "stopped"}',
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        # config.yaml is restored normally...
        assert (eternal_home / "config.yaml").read_text() == "model: test\n"
        # ...but the live gateway_state.json is untouched.
        assert (eternal_home / "gateway_state.json").read_text() == live_state

    def test_does_not_seed_gateway_state_when_absent(self, tmp_path, monkeypatch):
        """A backup's gateway_state.json is dropped, not written, when the
        target has none — a foreign state must never seed the reconciler."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: test\n",
            "gateway_state.json": '{"gateway_state": "stopped"}',
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        assert (eternal_home / "config.yaml").exists()
        assert not (eternal_home / "gateway_state.json").exists()

    def test_preserves_per_profile_gateway_state(self, tmp_path, monkeypatch):
        """The skip is matched by basename, so a named profile's
        gateway_state.json (profiles/<name>/gateway_state.json) is preserved
        the same way the root profile's is."""
        eternal_home = tmp_path / ".eternal"
        (eternal_home / "profiles" / "coder").mkdir(parents=True)
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        live_state = '{"gateway_state": "running"}'
        (eternal_home / "profiles" / "coder" / "gateway_state.json").write_text(live_state)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: test\n",
            "profiles/coder/config.yaml": "model: anthropic\n",
            "profiles/coder/gateway_state.json": '{"gateway_state": "stopped"}',
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        # Profile config is restored, but its live gateway state is preserved.
        assert (eternal_home / "profiles" / "coder" / "config.yaml").read_text() == "model: anthropic\n"
        assert (
            eternal_home / "profiles" / "coder" / "gateway_state.json"
        ).read_text() == live_state

    def test_preserves_runtime_pid_and_process_files(self, tmp_path, monkeypatch):
        """gateway.pid / cron.pid / gateway.lock / processes.json from a backup
        reference the source machine's process namespace and must never be
        written over the target's."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        # Live runtime files belonging to the target's own processes.
        (eternal_home / "gateway.pid").write_text("4242")
        (eternal_home / "processes.json").write_text('{"live": true}')

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: test\n",
            "gateway.pid": "9999",
            "cron.pid": "8888",
            "gateway.lock": "7777",
            "processes.json": '{"stale": true}',
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        # Live runtime files are untouched; the backup's foreign ones never land.
        assert (eternal_home / "gateway.pid").read_text() == "4242"
        assert (eternal_home / "processes.json").read_text() == '{"live": true}'
        # cron.pid / gateway.lock had no live copy and were not seeded.
        assert not (eternal_home / "cron.pid").exists()
        assert not (eternal_home / "gateway.lock").exists()

    def test_confirmation_prompt_abort(self, tmp_path, monkeypatch):
        """Import aborts when user says no to confirmation."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        # Pre-existing config triggers the confirmation
        (eternal_home / "config.yaml").write_text("existing: true\n")
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: restored\n",
        })

        args = Namespace(zipfile=str(zip_path), force=False)

        from eternal_cli.backup import run_import
        with patch("builtins.input", return_value="n"):
            run_import(args)

        # Original config should be unchanged
        assert (eternal_home / "config.yaml").read_text() == "existing: true\n"

    def test_force_skips_confirmation(self, tmp_path, monkeypatch):
        """Import with --force skips confirmation and overwrites."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("existing: true\n")
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: restored\n",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        assert (eternal_home / "config.yaml").read_text() == "model: restored\n"

    def test_missing_file_exits(self, tmp_path, monkeypatch):
        """Import exits with error for nonexistent file."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))

        args = Namespace(zipfile=str(tmp_path / "nonexistent.zip"), force=True)

        from eternal_cli.backup import run_import
        with pytest.raises(SystemExit):
            run_import(args)

    @pytest.mark.skipif(os.name != "posix", reason="POSIX file permissions only")
    def test_restores_secret_files_with_0600_perms(self, tmp_path, monkeypatch):
        """Secret files must end up at 0600 after restore (zipfile drops mode bits)."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: openrouter\n",
            ".env": "OPENROUTER_API_KEY=sk-secret\n",
            "auth.json": '{"providers": {"nous": "token"}}',
            "state.db": b"SQLite format 3\x00",
            "profiles/coder/.env": "ANTHROPIC_API_KEY=sk-ant-secret\n",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        for rel in (".env", "auth.json", "state.db", "profiles/coder/.env"):
            mode = (eternal_home / rel).stat().st_mode & 0o777
            assert mode == 0o600, f"{rel} restored with mode {oct(mode)}, expected 0o600"


# ---------------------------------------------------------------------------
# Round-trip test
# ---------------------------------------------------------------------------

class TestRoundTrip:
    def test_backup_then_import(self, tmp_path, monkeypatch):
        """Full round-trip: backup -> import to a new location -> verify."""
        # Source
        src_home = tmp_path / "source" / ".eternal"
        src_home.mkdir(parents=True)
        _make_eternal_tree(src_home)

        monkeypatch.setenv("ETERNAL_HOME", str(src_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path / "source")

        # Backup
        out_zip = tmp_path / "roundtrip.zip"
        from eternal_cli.backup import run_backup, run_import

        run_backup(Namespace(output=str(out_zip)))
        assert out_zip.exists()

        # Import into a different location
        dst_home = tmp_path / "dest" / ".eternal"
        dst_home.mkdir(parents=True)
        monkeypatch.setenv("ETERNAL_HOME", str(dst_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path / "dest")

        run_import(Namespace(zipfile=str(out_zip), force=True))

        # Verify key files
        assert (dst_home / "config.yaml").read_text() == "model:\n  provider: openrouter\n"
        assert (dst_home / ".env").read_text() == "OPENROUTER_API_KEY=sk-test-123\n"
        assert (dst_home / "skills" / "my-skill" / "SKILL.md").exists()
        assert (dst_home / "profiles" / "coder" / "config.yaml").exists()
        assert (dst_home / "sessions" / "abc123.json").exists()
        assert (dst_home / "logs" / "agent.log").exists()

        # eternal-agent should NOT be present
        assert not (dst_home / "eternal-agent").exists()
        # __pycache__ should NOT be present
        assert not (dst_home / "plugins" / "__pycache__").exists()
        # PID files should NOT be present
        assert not (dst_home / "gateway.pid").exists()


# ---------------------------------------------------------------------------
# Validate / detect-prefix unit tests
# ---------------------------------------------------------------------------

class TestFormatSize:
    def test_bytes(self):
        from eternal_cli.backup import _format_size
        assert _format_size(512) == "512 B"

    def test_kilobytes(self):
        from eternal_cli.backup import _format_size
        assert "KB" in _format_size(2048)

    def test_megabytes(self):
        from eternal_cli.backup import _format_size
        assert "MB" in _format_size(5 * 1024 * 1024)

    def test_gigabytes(self):
        from eternal_cli.backup import _format_size
        assert "GB" in _format_size(3 * 1024 ** 3)

    def test_terabytes(self):
        from eternal_cli.backup import _format_size
        assert "TB" in _format_size(2 * 1024 ** 4)


class TestValidation:
    def test_validate_with_config(self):
        """Zip with config.yaml passes validation."""
        import io
        from eternal_cli.backup import _validate_backup_zip

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("config.yaml", "test")
        buf.seek(0)
        with zipfile.ZipFile(buf, "r") as zf:
            ok, reason = _validate_backup_zip(zf)
        assert ok

    def test_validate_with_env(self):
        """Zip with .env passes validation."""
        import io
        from eternal_cli.backup import _validate_backup_zip

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(".env", "KEY=val")
        buf.seek(0)
        with zipfile.ZipFile(buf, "r") as zf:
            ok, reason = _validate_backup_zip(zf)
        assert ok

    def test_validate_rejects_random(self):
        """Zip without eternal markers fails validation."""
        import io
        from eternal_cli.backup import _validate_backup_zip

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("random/file.txt", "hello")
        buf.seek(0)
        with zipfile.ZipFile(buf, "r") as zf:
            ok, reason = _validate_backup_zip(zf)
        assert not ok

    def test_detect_prefix_eternal(self):
        """Detects .eternal/ prefix wrapping all entries."""
        import io
        from eternal_cli.backup import _detect_prefix

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(".eternal/config.yaml", "test")
            zf.writestr(".eternal/skills/a/SKILL.md", "skill")
        buf.seek(0)
        with zipfile.ZipFile(buf, "r") as zf:
            assert _detect_prefix(zf) == ".eternal/"

    def test_detect_prefix_none(self):
        """No prefix when entries are at root."""
        import io
        from eternal_cli.backup import _detect_prefix

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("config.yaml", "test")
            zf.writestr("skills/a/SKILL.md", "skill")
        buf.seek(0)
        with zipfile.ZipFile(buf, "r") as zf:
            assert _detect_prefix(zf) == ""

    def test_detect_prefix_only_dirs(self):
        """Prefix detection returns empty for zip with only directory entries."""
        import io
        from eternal_cli.backup import _detect_prefix

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            # Only directory entries (trailing slash)
            zf.writestr(".eternal/", "")
            zf.writestr(".eternal/skills/", "")
        buf.seek(0)
        with zipfile.ZipFile(buf, "r") as zf:
            assert _detect_prefix(zf) == ""


# ---------------------------------------------------------------------------
# Edge case tests for uncovered paths
# ---------------------------------------------------------------------------

class TestBackupEdgeCases:
    def test_nonexistent_eternal_home(self, tmp_path, monkeypatch):
        """Backup exits when eternal home doesn't exist."""
        fake_home = tmp_path / "nonexistent" / ".eternal"
        monkeypatch.setenv("ETERNAL_HOME", str(fake_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path / "nonexistent")

        args = Namespace(output=str(tmp_path / "out.zip"))

        from eternal_cli.backup import run_backup
        with pytest.raises(SystemExit):
            run_backup(args)

    def test_output_is_directory(self, tmp_path, monkeypatch):
        """When output path is a directory, zip is created inside it."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("model: test\n")

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_dir = tmp_path / "backups"
        out_dir.mkdir()

        args = Namespace(output=str(out_dir))

        from eternal_cli.backup import run_backup
        run_backup(args)

        zips = list(out_dir.glob("eternal-backup-*.zip"))
        assert len(zips) == 1

    def test_output_without_zip_suffix(self, tmp_path, monkeypatch):
        """Output path without .zip gets suffix appended."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("model: test\n")

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_path = tmp_path / "mybackup.tar"
        args = Namespace(output=str(out_path))

        from eternal_cli.backup import run_backup
        run_backup(args)

        # Should have .tar.zip suffix
        assert (tmp_path / "mybackup.tar.zip").exists()

    def test_empty_eternal_home(self, tmp_path, monkeypatch):
        """Backup handles empty eternal home (no files to back up)."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        # Only excluded dirs, no actual files
        (eternal_home / "__pycache__").mkdir()
        (eternal_home / "__pycache__" / "foo.pyc").write_bytes(b"\x00")

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        args = Namespace(output=str(tmp_path / "out.zip"))

        from eternal_cli.backup import run_backup
        run_backup(args)

        # No zip should be created
        assert not (tmp_path / "out.zip").exists()

    def test_permission_error_during_backup(self, tmp_path, monkeypatch):
        """Backup handles permission errors gracefully."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("model: test\n")

        # Create an unreadable file
        bad_file = eternal_home / "secret.db"
        bad_file.write_text("data")
        bad_file.chmod(0o000)

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "out.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        try:
            run_backup(args)
        finally:
            # Restore permissions for cleanup
            bad_file.chmod(0o644)

        # Zip should still be created with the readable files
        assert out_zip.exists()

    def test_pre1980_timestamp_skipped(self, tmp_path, monkeypatch):
        """Backup skips files with pre-1980 timestamps (ZIP limitation)."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("model: test\n")

        # Create a file with epoch timestamp (1970-01-01)
        old_file = eternal_home / "ancient.txt"
        old_file.write_text("old data")
        os.utime(old_file, (0, 0))

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        out_zip = tmp_path / "out.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        run_backup(args)

        # Zip should still be created with the valid files
        assert out_zip.exists()
        with zipfile.ZipFile(out_zip, "r") as zf:
            names = zf.namelist()
            assert "config.yaml" in names
            # The pre-1980 file should be skipped, not crash the backup
            assert "ancient.txt" not in names

    def test_skips_output_zip_inside_eternal(self, tmp_path, monkeypatch):
        """Backup skips its own output zip if it's inside eternal root."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("model: test\n")

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        # Output inside eternal home
        out_zip = eternal_home / "backup.zip"
        args = Namespace(output=str(out_zip))

        from eternal_cli.backup import run_backup
        run_backup(args)

        # The zip should exist but not contain itself
        assert out_zip.exists()
        with zipfile.ZipFile(out_zip, "r") as zf:
            assert "backup.zip" not in zf.namelist()


class TestImportEdgeCases:
    def _make_backup_zip(self, zip_path: Path, files: dict[str, str | bytes]) -> None:
        with zipfile.ZipFile(zip_path, "w") as zf:
            for name, content in files.items():
                zf.writestr(name, content)

    def test_not_a_zip(self, tmp_path, monkeypatch):
        """Import rejects a non-zip file."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))

        not_zip = tmp_path / "fake.zip"
        not_zip.write_text("this is not a zip")

        args = Namespace(zipfile=str(not_zip), force=True)

        from eternal_cli.backup import run_import
        with pytest.raises(SystemExit):
            run_import(args)

    def test_eof_during_confirmation(self, tmp_path, monkeypatch):
        """Import handles EOFError during confirmation prompt."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("existing\n")
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {"config.yaml": "new\n"})

        args = Namespace(zipfile=str(zip_path), force=False)

        from eternal_cli.backup import run_import
        with patch("builtins.input", side_effect=EOFError):
            with pytest.raises(SystemExit):
                run_import(args)

    def test_keyboard_interrupt_during_confirmation(self, tmp_path, monkeypatch):
        """Import handles KeyboardInterrupt during confirmation prompt."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / ".env").write_text("KEY=val\n")
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {"config.yaml": "new\n"})

        args = Namespace(zipfile=str(zip_path), force=False)

        from eternal_cli.backup import run_import
        with patch("builtins.input", side_effect=KeyboardInterrupt):
            with pytest.raises(SystemExit):
                run_import(args)

    def test_permission_error_during_import(self, tmp_path, monkeypatch):
        """Import handles permission errors during extraction."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        # Create a read-only directory so extraction fails
        locked_dir = eternal_home / "locked"
        locked_dir.mkdir()
        locked_dir.chmod(0o555)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: test\n",
            "locked/secret.txt": "data",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        try:
            run_import(args)
        finally:
            locked_dir.chmod(0o755)

        # config.yaml should still be restored despite the error
        assert (eternal_home / "config.yaml").exists()

    def test_progress_with_many_files(self, tmp_path, monkeypatch):
        """Import shows progress with 500+ files."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "big.zip"
        files = {"config.yaml": "model: test\n"}
        for i in range(600):
            files[f"sessions/s{i:04d}.json"] = "{}"

        self._make_backup_zip(zip_path, files)

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        assert (eternal_home / "config.yaml").exists()
        assert (eternal_home / "sessions" / "s0599.json").exists()


# ---------------------------------------------------------------------------
# Profile restoration tests
# ---------------------------------------------------------------------------

class TestProfileRestoration:
    def _make_backup_zip(self, zip_path: Path, files: dict[str, str | bytes]) -> None:
        with zipfile.ZipFile(zip_path, "w") as zf:
            for name, content in files.items():
                zf.writestr(name, content)

    def test_import_creates_profile_wrappers(self, tmp_path, monkeypatch):
        """Import auto-creates wrapper scripts for restored profiles."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        # Mock the wrapper dir to be inside tmp_path
        wrapper_dir = tmp_path / ".local" / "bin"
        wrapper_dir.mkdir(parents=True)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model:\n  provider: openrouter\n",
            "profiles/coder/config.yaml": "model:\n  provider: anthropic\n",
            "profiles/coder/.env": "ANTHROPIC_API_KEY=sk-test\n",
            "profiles/researcher/config.yaml": "model:\n  provider: deepseek\n",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        # Profile directories should exist
        assert (eternal_home / "profiles" / "coder" / "config.yaml").exists()
        assert (eternal_home / "profiles" / "researcher" / "config.yaml").exists()

        # Wrapper scripts should be created
        assert (wrapper_dir / "coder").exists()
        assert (wrapper_dir / "researcher").exists()

        # Wrappers should contain the right content
        coder_wrapper = (wrapper_dir / "coder").read_text()
        assert "eternal -p coder" in coder_wrapper

    def test_import_skips_profile_dirs_without_config(self, tmp_path, monkeypatch):
        """Import doesn't create wrappers for profile dirs without config."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        wrapper_dir = tmp_path / ".local" / "bin"
        wrapper_dir.mkdir(parents=True)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: test\n",
            "profiles/valid/config.yaml": "model: test\n",
            "profiles/empty/readme.txt": "nothing here\n",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        from eternal_cli.backup import run_import
        run_import(args)

        # Only valid profile should get a wrapper
        assert (wrapper_dir / "valid").exists()
        assert not (wrapper_dir / "empty").exists()

    def test_import_without_profiles_module(self, tmp_path, monkeypatch):
        """Import gracefully handles missing profiles module (fresh install)."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        zip_path = tmp_path / "backup.zip"
        self._make_backup_zip(zip_path, {
            "config.yaml": "model: test\n",
            "profiles/coder/config.yaml": "model: test\n",
        })

        args = Namespace(zipfile=str(zip_path), force=True)

        # Simulate profiles module not being available
        original_import = __builtins__.__import__ if hasattr(__builtins__, '__import__') else __import__

        def fake_import(name, *a, **kw):
            if name == "eternal_cli.profiles":
                raise ImportError("no profiles module")
            return original_import(name, *a, **kw)

        from eternal_cli.backup import run_import
        with patch("builtins.__import__", side_effect=fake_import):
            run_import(args)

        # Files should still be restored even if wrappers can't be created
        assert (eternal_home / "profiles" / "coder" / "config.yaml").exists()


# ---------------------------------------------------------------------------
# SQLite safe copy tests
# ---------------------------------------------------------------------------

class TestSafeCopyDb:
    def test_copies_valid_database(self, tmp_path):
        from eternal_cli.backup import _safe_copy_db
        src = tmp_path / "test.db"
        dst = tmp_path / "copy.db"

        conn = sqlite3.connect(str(src))
        conn.execute("CREATE TABLE t (x INTEGER)")
        conn.execute("INSERT INTO t VALUES (42)")
        conn.commit()
        conn.close()

        result = _safe_copy_db(src, dst)
        assert result is True

        conn = sqlite3.connect(str(dst))
        rows = conn.execute("SELECT x FROM t").fetchall()
        conn.close()
        assert rows == [(42,)]

    def test_copies_wal_mode_database(self, tmp_path):
        from eternal_cli.backup import _safe_copy_db
        src = tmp_path / "wal.db"
        dst = tmp_path / "copy.db"

        conn = sqlite3.connect(str(src))
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE t (x TEXT)")
        conn.execute("INSERT INTO t VALUES ('wal-test')")
        conn.commit()
        conn.close()

        result = _safe_copy_db(src, dst)
        assert result is True

        conn = sqlite3.connect(str(dst))
        rows = conn.execute("SELECT x FROM t").fetchall()
        conn.close()
        assert rows == [("wal-test",)]



    def test_is_zeroed_sqlite_file_detects_nul_header(self, tmp_path):
        from eternal_cli.backup import is_zeroed_sqlite_file
        p = tmp_path / "state.db"
        p.write_bytes(bytes(4096))  # all NULs
        assert is_zeroed_sqlite_file(p) is True

    def test_is_zeroed_sqlite_file_rejects_valid_db(self, tmp_path):
        from eternal_cli.backup import is_zeroed_sqlite_file
        p = tmp_path / "ok.db"
        conn = sqlite3.connect(str(p))
        conn.execute("CREATE TABLE t (x INT)")
        conn.commit()
        conn.close()
        assert is_zeroed_sqlite_file(p) is False

    def test_is_zeroed_sqlite_file_empty_file(self, tmp_path):
        from eternal_cli.backup import is_zeroed_sqlite_file
        p = tmp_path / "empty.db"
        p.write_bytes(b"")
        assert is_zeroed_sqlite_file(p) is False


# ---------------------------------------------------------------------------
# Quick state snapshot tests
# ---------------------------------------------------------------------------

class TestQuickSnapshot:
    @pytest.fixture
    def eternal_home(self, tmp_path):
        """Create a fake ETERNAL_HOME with critical state files."""
        home = tmp_path / ".eternal"
        home.mkdir()
        (home / "config.yaml").write_text("model:\n  provider: openrouter\n")
        (home / ".env").write_text("OPENROUTER_API_KEY=test-key-123\n")
        (home / "auth.json").write_text('{"providers": {}}\n')
        (home / "channel_aliases.json").write_text(
            '{"whatsapp": {"120363408391911677@g.us": "general"}}\n'
        )
        (home / "cron").mkdir()
        (home / "cron" / "jobs.json").write_text('{"jobs": []}\n')

        # Real SQLite database
        db_path = home / "state.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT)")
        conn.execute("INSERT INTO sessions VALUES ('s1', 'hello world')")
        conn.commit()
        conn.close()
        return home

    def test_creates_snapshot(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        assert snap_id is not None
        snap_dir = eternal_home / "state-snapshots" / snap_id
        assert snap_dir.is_dir()
        assert (snap_dir / "manifest.json").exists()

    def test_label_in_id(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(label="before-upgrade", eternal_home=eternal_home)
        assert "before-upgrade" in snap_id

    def test_state_db_safely_copied(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        db_copy = eternal_home / "state-snapshots" / snap_id / "state.db"
        assert db_copy.exists()
        conn = sqlite3.connect(str(db_copy))
        rows = conn.execute("SELECT * FROM sessions").fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0] == ("s1", "hello world")

    def test_failed_state_db_copy_is_loud(self, eternal_home, monkeypatch, capsys):
        """#68474: unreadable state.db must not look like a silent success."""
        from eternal_cli import backup as backup_mod

        def boom(src, dst):
            return False

        monkeypatch.setattr(backup_mod, "_safe_copy_db", boom)
        snap_id = backup_mod.create_quick_snapshot(eternal_home=eternal_home)
        err = capsys.readouterr().out
        assert "SQLite safe copy FAILED" in err or "CRITICAL" in err
        assert "state.db" in err
        # Other small files may still snapshot
        if snap_id:
            manifest = (eternal_home / "state-snapshots" / snap_id / "manifest.json")
            assert manifest.exists()
            data = json.loads(manifest.read_text(encoding="utf-8"))
            assert "state.db" not in data.get("files", {})
            assert "state.db" in data.get("failed_dbs", [])

    def test_copies_nested_files(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        assert (eternal_home / "state-snapshots" / snap_id / "cron" / "jobs.json").exists()

    def test_copies_discord_recovery_ledger(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot

        gateway_dir = eternal_home / "gateway"
        gateway_dir.mkdir()
        ledger = gateway_dir / "discord_message_recovery.db"
        conn = sqlite3.connect(ledger)
        conn.execute("CREATE TABLE handled (message_id TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO handled VALUES ('123')")
        conn.commit()
        conn.close()

        snap_id = create_quick_snapshot(eternal_home=eternal_home)

        copied = eternal_home / "state-snapshots" / snap_id / "gateway" / ledger.name
        assert copied.exists()
        conn = sqlite3.connect(copied)
        assert conn.execute("SELECT message_id FROM handled").fetchall() == [("123",)]
        conn.close()

    def test_copies_channel_aliases(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        copied = eternal_home / "state-snapshots" / snap_id / "channel_aliases.json"
        assert copied.exists()
        assert "120363408391911677@g.us" in copied.read_text()

    def test_missing_files_skipped(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        with open(eternal_home / "state-snapshots" / snap_id / "manifest.json") as f:
            meta = json.load(f)
        # gateway_state.json etc. don't exist in fixture
        assert "gateway_state.json" not in meta["files"]

    def test_empty_home_returns_none(self, tmp_path):
        from eternal_cli.backup import create_quick_snapshot
        empty = tmp_path / "empty"
        empty.mkdir()
        assert create_quick_snapshot(eternal_home=empty) is None

    def test_max_file_size_skips_oversized_file(self, eternal_home, capsys):
        """Files above the cap are skipped with a warning; small files
        (the pairing/cron data the snapshot exists for) still land."""
        from eternal_cli.backup import create_quick_snapshot
        # state.db in the fixture is a few KB — cap below it
        cap = 1024
        snap_id = create_quick_snapshot(
            eternal_home=eternal_home, max_file_size=cap
        )
        assert snap_id is not None
        snap_dir = eternal_home / "state-snapshots" / snap_id
        assert not (snap_dir / "state.db").exists()
        # Small files still captured
        assert (snap_dir / "cron" / "jobs.json").exists()
        with open(snap_dir / "manifest.json") as f:
            meta = json.load(f)
        assert "state.db" not in meta["files"]
        out = capsys.readouterr().out
        assert "skipping state.db" in out
        assert "exceeds" in out

    def test_max_file_size_none_copies_everything(self, eternal_home):
        """Default (no cap) preserves manual /snapshot behavior."""
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home, max_file_size=None)
        assert (eternal_home / "state-snapshots" / snap_id / "state.db").exists()

    def test_max_file_size_under_cap_copies(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(
            eternal_home=eternal_home, max_file_size=1 << 30
        )
        assert (eternal_home / "state-snapshots" / snap_id / "state.db").exists()

    def test_list_snapshots(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot, list_quick_snapshots
        id1 = create_quick_snapshot(label="first", eternal_home=eternal_home)
        id2 = create_quick_snapshot(label="second", eternal_home=eternal_home)

        snaps = list_quick_snapshots(eternal_home=eternal_home)
        assert len(snaps) == 2
        assert snaps[0]["id"] == id2  # most recent first
        assert snaps[1]["id"] == id1

    def test_list_limit(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot, list_quick_snapshots
        for i in range(5):
            create_quick_snapshot(label=f"s{i}", eternal_home=eternal_home)
        snaps = list_quick_snapshots(limit=3, eternal_home=eternal_home)
        assert len(snaps) == 3

    def test_restore_config(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot, restore_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)

        (eternal_home / "config.yaml").write_text("model:\n  provider: anthropic\n")
        assert "anthropic" in (eternal_home / "config.yaml").read_text()

        result = restore_quick_snapshot(snap_id, eternal_home=eternal_home)
        assert result is True
        assert "openrouter" in (eternal_home / "config.yaml").read_text()

    def test_restore_state_db(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot, restore_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)

        conn = sqlite3.connect(str(eternal_home / "state.db"))
        conn.execute("INSERT INTO sessions VALUES ('s2', 'new')")
        conn.commit()
        conn.close()

        restore_quick_snapshot(snap_id, eternal_home=eternal_home)

        conn = sqlite3.connect(str(eternal_home / "state.db"))
        rows = conn.execute("SELECT * FROM sessions").fetchall()
        conn.close()
        assert len(rows) == 1

    def test_restore_nonexistent(self, eternal_home):
        from eternal_cli.backup import restore_quick_snapshot
        assert restore_quick_snapshot("nonexistent", eternal_home=eternal_home) is False

    def test_auto_prune(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot, list_quick_snapshots, _QUICK_DEFAULT_KEEP
        for i in range(_QUICK_DEFAULT_KEEP + 5):
            create_quick_snapshot(label=f"snap-{i:03d}", eternal_home=eternal_home)
        snaps = list_quick_snapshots(limit=100, eternal_home=eternal_home)
        assert len(snaps) <= _QUICK_DEFAULT_KEEP

    def test_manual_prune(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot, prune_quick_snapshots, list_quick_snapshots
        for i in range(10):
            create_quick_snapshot(label=f"s{i}", eternal_home=eternal_home)
        deleted = prune_quick_snapshots(keep=3, eternal_home=eternal_home)
        assert deleted == 7
        assert len(list_quick_snapshots(eternal_home=eternal_home)) == 3

    def test_snapshot_includes_pairing_directories(self, eternal_home):
        """Pairing JSONs live outside state.db — snapshot must capture them
        recursively (generic + per-platform) so approved-user lists survive
        disasters like #15733."""
        from eternal_cli.backup import create_quick_snapshot

        # Generic pairing store (new location)
        (eternal_home / "platforms" / "pairing").mkdir(parents=True)
        (eternal_home / "platforms" / "pairing" / "telegram-approved.json").write_text(
            '{"12345": {"user_name": "alice"}}'
        )
        (eternal_home / "platforms" / "pairing" / "discord-approved.json").write_text(
            '{"67890": {"user_name": "bob"}}'
        )
        # Legacy pairing store (old location)
        (eternal_home / "pairing").mkdir()
        (eternal_home / "pairing" / "matrix-approved.json").write_text(
            '{"@charlie:server": {"user_name": "charlie"}}'
        )
        # Feishu's separate JSON
        (eternal_home / "feishu_comment_pairing.json").write_text(
            '{"doc_abc": {"allow_from": ["user_xyz"]}}'
        )

        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        assert snap_id is not None

        snap_dir = eternal_home / "state-snapshots" / snap_id
        assert (snap_dir / "platforms" / "pairing" / "telegram-approved.json").exists()
        assert (snap_dir / "platforms" / "pairing" / "discord-approved.json").exists()
        assert (snap_dir / "pairing" / "matrix-approved.json").exists()
        assert (snap_dir / "feishu_comment_pairing.json").exists()

        with open(snap_dir / "manifest.json") as f:
            meta = json.load(f)
        files = meta["files"]
        assert "platforms/pairing/telegram-approved.json" in files
        assert "platforms/pairing/discord-approved.json" in files
        assert "pairing/matrix-approved.json" in files
        assert "feishu_comment_pairing.json" in files

    def test_restore_recovers_pairing_data(self, eternal_home):
        """After restore, deleted pairing files reappear with original content."""
        from eternal_cli.backup import create_quick_snapshot, restore_quick_snapshot

        pairing_dir = eternal_home / "platforms" / "pairing"
        pairing_dir.mkdir(parents=True)
        approved = pairing_dir / "telegram-approved.json"
        approved.write_text('{"12345": {"user_name": "alice"}}')
        feishu = eternal_home / "feishu_comment_pairing.json"
        feishu.write_text('{"doc_abc": {"allow_from": ["user_xyz"]}}')

        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        assert snap_id is not None

        # Simulate the disaster — user loses both pairing files.
        approved.unlink()
        feishu.unlink()
        assert not approved.exists()
        assert not feishu.exists()

        assert restore_quick_snapshot(snap_id, eternal_home=eternal_home) is True
        assert approved.exists()
        assert '"alice"' in approved.read_text()
        assert feishu.exists()
        assert '"user_xyz"' in feishu.read_text()

    def test_empty_pairing_dir_does_not_fail(self, eternal_home):
        """An empty pairing directory should be silently skipped."""
        from eternal_cli.backup import create_quick_snapshot

        (eternal_home / "platforms" / "pairing").mkdir(parents=True)
        # Directory exists but contains no files.
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        # Other state still present → snapshot succeeds.
        assert snap_id is not None

# ---------------------------------------------------------------------------
# Pre-update backup (eternal update safety net)
# ---------------------------------------------------------------------------

    # -- security: path traversal regression coverage -----------------------
    # Per @egilewski audit on PR #9217: restore_quick_snapshot must reject
    # malicious snapshot_id values (the directory selector) AND malicious
    # rel paths inside the manifest (the per-file selector). Both surfaces
    # need explicit regression tests because they validate independent
    # traversal vectors.

    def test_restore_rejects_snapshot_id_traversal(self, eternal_home):
        """restore_quick_snapshot must reject snapshot_id values that
        contain path separators, POSIX traversal entries, or are empty.
        These are rejected on the input string before any filesystem
        lookup, so the guard cannot be bypassed by arranging a directory
        layout that would otherwise satisfy ``snap_dir.is_dir()``.

        Regression for the path-traversal surface where ``root /
        snapshot_id`` could resolve above the snapshots root."""
        from eternal_cli.backup import restore_quick_snapshot

        hostile_ids = [
            "../../etc",                # parent traversal
            "../outside",               # single parent
            "..",                       # bare parent dir
            ".",                        # bare current dir
            "subdir/snap",              # forward slash
            "subdir\\snap",           # backslash (Windows-style)
            "",                         # empty string
        ]
        for hostile in hostile_ids:
            assert restore_quick_snapshot(
                hostile, eternal_home=eternal_home
            ) is False, f"hostile snapshot_id was not rejected: {hostile!r}"

    def test_restore_rejects_manifest_rel_traversal(self, eternal_home):
        """A snapshot whose manifest.json contains a rel path that escapes
        the snapshot directory (e.g. ``../../outside.txt``) must skip that
        entry rather than restoring outside ETERNAL_HOME."""
        from eternal_cli.backup import create_quick_snapshot, restore_quick_snapshot

        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        assert snap_id is not None
        snap_dir = eternal_home / "state-snapshots" / snap_id

        # Inject a traversal entry into manifest.json AND seed the source
        # file outside the snapshot directory so a vulnerable implementation
        # would actually write something at the escaped destination.
        manifest_path = snap_dir / "manifest.json"
        with open(manifest_path) as f:
            meta = json.load(f)
        meta["files"]["../../outside.txt"] = 9
        with open(manifest_path, "w") as f:
            json.dump(meta, f)

        # Source: ../../outside.txt resolves above the snapshot root.
        # Place a payload there so we can detect a successful escape.
        escape_src = snap_dir.parent.parent / "outside.txt"
        escape_src.write_text("pwned-source")

        # Pre-condition: the destination must not exist before restore.
        escape_dst = eternal_home.parent.parent / "outside.txt"
        assert not escape_dst.exists()

        # Restore should succeed for legitimate files but skip the hostile
        # entry. We don't assert on the return value (other legitimate
        # entries may still restore); we assert on the file-system effect.
        restore_quick_snapshot(snap_id, eternal_home=eternal_home)

        assert not escape_dst.exists(), (
            f"manifest rel traversal escaped ETERNAL_HOME: {escape_dst} exists"
        )

        # Cleanup the seeded escape source so the test is hermetic.
        escape_src.unlink()

    def test_oversized_db_suppresses_pruning(self, eternal_home, capsys):
        """#68805: an oversized state.db skipped for size must suppress
        pruning so the older complete snapshot (containing the only
        recoverable database) is preserved.

        Reproduces the reviewer's scenario: keep=1 + a state.db exceeding
        the size cap → the new snapshot omits state.db, failed_dbs stays
        empty (the file wasn't unreadable, just too large), and without
        tracking oversized_skipped the older complete snapshot would be
        pruned — losing the only recovery copy.
        """
        import json
        import time as _t
        from eternal_cli.backup import create_quick_snapshot, list_quick_snapshots

        # First snapshot: complete (state.db is small, under any cap)
        first_id = create_quick_snapshot(label="complete", eternal_home=eternal_home)
        assert first_id is not None
        first_dir = eternal_home / "state-snapshots" / first_id
        assert (first_dir / "state.db").exists()

        _t.sleep(1.05)  # ensure distinct timestamp

        # Second snapshot: state.db exceeds the 1024-byte cap → skipped for
        # size, but small config files (32-54 bytes) still land in the manifest.
        second_id = create_quick_snapshot(
            label="oversized", eternal_home=eternal_home, max_file_size=1024, keep=1
        )
        assert second_id is not None
        second_dir = eternal_home / "state-snapshots" / second_id
        assert not (second_dir / "state.db").exists()

        # Manifest must record the oversized skip
        with open(second_dir / "manifest.json") as f:
            meta = json.load(f)
        assert "state.db" in meta.get("oversized_skipped", [])

        # CRITICAL: the first (complete) snapshot must survive pruning
        # because the second snapshot is incomplete (oversized state.db).
        all_snaps = list_quick_snapshots(limit=100, eternal_home=eternal_home)
        snap_ids = {s["id"] for s in all_snaps}
        assert first_id in snap_ids, (
            f"Complete snapshot {first_id} was pruned by an incomplete "
            f"(oversized) snapshot — the recovery copy was lost!"
        )
        assert second_id in snap_ids

        out = capsys.readouterr().out
        assert "skipping state.db" in out.lower() or "skipping snapshot prune" in out.lower()


class TestQuickSnapshotProjectsKanban:
    """Regression for #52889: projects.db / kanban.db must survive an upgrade.

    Both are per-profile user-created stores outside the git checkout. If they
    are not in the pre-update snapshot, the post-update ``CREATE TABLE IF NOT
    EXISTS`` runs against a missing file and every project / board row is lost.
    """

    @pytest.fixture
    def eternal_home(self, tmp_path):
        home = tmp_path / ".eternal"
        home.mkdir()
        # Minimal critical file so the snapshot is non-empty.
        (home / "config.yaml").write_text("model:\n  provider: openrouter\n")

        for name, table, row in (
            ("projects.db", "projects", ("p1", "demo")),
            ("kanban.db", "tasks", ("t1", "todo")),
        ):
            conn = sqlite3.connect(str(home / name))
            conn.execute(f"CREATE TABLE {table} (id TEXT PRIMARY KEY, data TEXT)")
            conn.execute(f"INSERT INTO {table} VALUES (?, ?)", row)
            conn.commit()
            conn.close()
        return home

    def test_in_quick_state_files(self):
        from eternal_cli.backup import _QUICK_STATE_FILES
        # All per-profile user-created stores that the upgrade can wipe.
        for name in (
            "projects.db", "kanban.db", "kanban/boards",
            "response_store.db", "memory_store.db", "verification_evidence.db",
        ):
            assert name in _QUICK_STATE_FILES, name

    def test_projects_db_snapshotted(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        copy = eternal_home / "state-snapshots" / snap_id / "projects.db"
        assert copy.exists()
        conn = sqlite3.connect(str(copy))
        rows = conn.execute("SELECT * FROM projects").fetchall()
        conn.close()
        assert rows == [("p1", "demo")]

    def test_kanban_db_snapshotted(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        copy = eternal_home / "state-snapshots" / snap_id / "kanban.db"
        assert copy.exists()
        conn = sqlite3.connect(str(copy))
        rows = conn.execute("SELECT * FROM tasks").fetchall()
        conn.close()
        assert rows == [("t1", "todo")]

    def test_restore_recreates_emptied_projects_db(self, eternal_home):
        from eternal_cli.backup import create_quick_snapshot, restore_quick_snapshot
        snap_id = create_quick_snapshot(eternal_home=eternal_home)

        # Simulate the upgrade wiping the store back to an empty schema.
        conn = sqlite3.connect(str(eternal_home / "projects.db"))
        conn.execute("DELETE FROM projects")
        conn.commit()
        conn.close()

        assert restore_quick_snapshot(snap_id, eternal_home=eternal_home) is True
        conn = sqlite3.connect(str(eternal_home / "projects.db"))
        rows = conn.execute("SELECT * FROM projects").fetchall()
        conn.close()
        assert rows == [("p1", "demo")]

    def test_non_default_kanban_board_snapshotted(self, eternal_home):
        """#52889 completeness: non-default boards live at
        <root>/kanban/boards/<slug>/kanban.db, not <root>/kanban.db. The
        ``kanban/boards`` dir entry must capture them too, or multi-board
        users still lose every board except ``default`` on upgrade."""
        from eternal_cli.backup import create_quick_snapshot, restore_quick_snapshot

        board_dir = eternal_home / "kanban" / "boards" / "work"
        board_dir.mkdir(parents=True)
        conn = sqlite3.connect(str(board_dir / "kanban.db"))
        conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT)")
        conn.execute("INSERT INTO tasks VALUES (?, ?)", ("w1", "ship"))
        conn.commit()
        conn.close()

        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        copy = (
            eternal_home / "state-snapshots" / snap_id
            / "kanban" / "boards" / "work" / "kanban.db"
        )
        assert copy.exists(), "non-default board kanban.db was not snapshotted"

        # Simulate the upgrade wiping the board, then restore it.
        conn = sqlite3.connect(str(board_dir / "kanban.db"))
        conn.execute("DELETE FROM tasks")
        conn.commit()
        conn.close()

        assert restore_quick_snapshot(snap_id, eternal_home=eternal_home) is True
        conn = sqlite3.connect(str(board_dir / "kanban.db"))
        rows = conn.execute("SELECT * FROM tasks").fetchall()
        conn.close()
        assert rows == [("w1", "ship")]

    def test_additional_per_profile_dbs_round_trip(self, eternal_home):
        """#52889 completeness: response_store.db (conversation history),
        memory_store.db (holographic memory) and verification_evidence.db are
        the same upgrade-wiped data-loss class as projects.db and must also be
        snapshotted + restored."""
        from eternal_cli.backup import create_quick_snapshot, restore_quick_snapshot

        seeded = {
            "response_store.db": ("responses", ("r1", "hello")),
            "memory_store.db": ("facts", ("f1", "the sky is blue")),
            "verification_evidence.db": ("verification_events", ("v1", "passed")),
        }
        for name, (table, row) in seeded.items():
            conn = sqlite3.connect(str(eternal_home / name))
            conn.execute(f"CREATE TABLE {table} (id TEXT PRIMARY KEY, data TEXT)")
            conn.execute(f"INSERT INTO {table} VALUES (?, ?)", row)
            conn.commit()
            conn.close()

        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        # Wipe every store (the upgrade failure), then restore.
        for name, (table, _row) in seeded.items():
            conn = sqlite3.connect(str(eternal_home / name))
            conn.execute(f"DELETE FROM {table}")
            conn.commit()
            conn.close()

        assert restore_quick_snapshot(snap_id, eternal_home=eternal_home) is True
        for name, (table, row) in seeded.items():
            conn = sqlite3.connect(str(eternal_home / name))
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
            conn.close()
            assert rows == [row], name

    def test_board_workspaces_and_attachments_are_skipped(self, eternal_home):
        """#52889 W3: the kanban/boards walk must capture board DBs + metadata
        but SKIP the heavy regenerable workspaces/ and attachments/ subtrees so
        snapshots don't bloat (×20 retained)."""
        from eternal_cli.backup import create_quick_snapshot

        board = eternal_home / "kanban" / "boards" / "work"
        (board / "workspaces" / "scratch").mkdir(parents=True)
        (board / "attachments" / "t1").mkdir(parents=True)
        conn = sqlite3.connect(str(board / "kanban.db"))
        conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT)")
        conn.commit()
        conn.close()
        (board / "board.json").write_text('{"name": "work"}')
        (board / "workspaces" / "scratch" / "big.bin").write_bytes(b"x" * 4096)
        (board / "attachments" / "t1" / "file.bin").write_bytes(b"y" * 4096)

        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        snap = eternal_home / "state-snapshots" / snap_id / "kanban" / "boards" / "work"
        # Board db + metadata captured...
        assert (snap / "kanban.db").exists()
        assert (snap / "board.json").exists()
        # ...but the heavy subtrees skipped.
        assert not (snap / "workspaces" / "scratch" / "big.bin").exists()
        assert not (snap / "attachments" / "t1" / "file.bin").exists()

    def test_board_db_copied_wal_safely(self, eternal_home, monkeypatch):
        """#52889 W2: a non-default board's .db (dir-branch) must go through the
        WAL-safe _safe_copy_db, not a raw shutil.copy2, so an open WAL doesn't
        produce an inconsistent copy."""
        import eternal_cli.backup as bk
        from eternal_cli.backup import create_quick_snapshot

        board = eternal_home / "kanban" / "boards" / "work"
        board.mkdir(parents=True)
        conn = sqlite3.connect(str(board / "kanban.db"))
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT)")
        conn.execute("INSERT INTO tasks VALUES ('w1', 'ship')")
        conn.commit()
        conn.close()

        called = {"db": []}
        real = bk._safe_copy_db

        def _spy(src, dst):
            called["db"].append(str(src))
            return real(src, dst)

        monkeypatch.setattr(bk, "_safe_copy_db", _spy)
        snap_id = create_quick_snapshot(eternal_home=eternal_home)
        # The board db was copied via _safe_copy_db (not raw copy).
        assert any(s.endswith("boards/work/kanban.db") for s in called["db"]), called["db"]
        copy = eternal_home / "state-snapshots" / snap_id / "kanban" / "boards" / "work" / "kanban.db"
        rows = sqlite3.connect(str(copy)).execute("SELECT * FROM tasks").fetchall()
        assert rows == [("w1", "ship")]


class TestPreUpdateBackup:
    """Tests for create_pre_update_backup — the auto-backup ``eternal update``
    runs before touching anything."""

    def test_failed_sqlite_snapshot_removes_incomplete_archive(self, tmp_path, monkeypatch):
        """The non-interactive full-zip helper must fail the entire archive
        rather than return success after omitting a live WAL database."""
        eternal_home = tmp_path / ".eternal"
        eternal_home.mkdir()
        (eternal_home / "config.yaml").write_text("model: test\n")
        db_path = eternal_home / "state.db"

        writer = sqlite3.connect(db_path)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE events (value TEXT)")
        writer.commit()
        writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        writer.execute("INSERT INTO events VALUES ('only-in-wal')")
        writer.commit()
        assert Path(f"{db_path}-wal").stat().st_size > 0

        import eternal_cli.backup as backup_mod
        real_connect = backup_mod.sqlite3.connect

        class FailingBackupConnection:
            def __init__(self, connection):
                self._connection = connection

            def backup(self, _destination):
                raise sqlite3.OperationalError("forced backup failure")

            def close(self):
                self._connection.close()

        def connect_with_failed_backup(database, *args, **kwargs):
            connection = real_connect(database, *args, **kwargs)
            if str(database).startswith(f"file:{db_path}"):
                return FailingBackupConnection(connection)
            return connection

        monkeypatch.setattr(backup_mod.sqlite3, "connect", connect_with_failed_backup)
        out_zip = tmp_path / "pre-update.zip"
        try:
            result = backup_mod._write_full_zip_backup(out_zip, eternal_home)
        finally:
            writer.close()

        assert result is None
        assert not out_zip.exists()

    @pytest.fixture
    def eternal_home(self, tmp_path):
        root = tmp_path / ".eternal"
        root.mkdir()
        _make_eternal_tree(root)
        return root

    def test_creates_backup_under_backups_dir(self, eternal_home):
        from eternal_cli.backup import create_pre_update_backup
        out = create_pre_update_backup(eternal_home=eternal_home)
        assert out is not None
        assert out.exists()
        assert out.parent == eternal_home / "backups"
        assert out.name.startswith("pre-update-")
        assert out.suffix == ".zip"

    def test_backup_contents_match_full_backup(self, eternal_home):
        """Pre-update backup should include the same user data that
        ``eternal backup`` would, and should exclude the same directories."""
        from eternal_cli.backup import create_pre_update_backup
        out = create_pre_update_backup(eternal_home=eternal_home)
        assert out is not None
        with zipfile.ZipFile(out) as zf:
            names = set(zf.namelist())
        # User data present
        assert "config.yaml" in names
        assert ".env" in names
        assert "sessions/abc123.json" in names
        assert "skills/my-skill/SKILL.md" in names
        assert "profiles/coder/config.yaml" in names
        # eternal-agent repo excluded
        assert not any(n.startswith("eternal-agent/") for n in names)
        # __pycache__ excluded
        assert not any("__pycache__" in n for n in names)
        # pid files excluded
        assert "gateway.pid" not in names

    def test_does_not_recurse_into_prior_backups(self, eternal_home):
        """The ``backups/`` directory must be excluded so that each backup
        doesn't grow exponentially by including all prior backups."""
        from eternal_cli.backup import create_pre_update_backup
        # First backup
        out1 = create_pre_update_backup(eternal_home=eternal_home)
        assert out1 is not None
        # Second backup — must not include the first
        out2 = create_pre_update_backup(eternal_home=eternal_home)
        assert out2 is not None
        with zipfile.ZipFile(out2) as zf:
            names = zf.namelist()
        assert not any(n.startswith("backups/") for n in names), (
            f"Pre-update backup recursed into backups/ — leaked: "
            f"{[n for n in names if n.startswith('backups/')]}"
        )

    def test_rotation_keeps_only_n(self, eternal_home):
        """After more than ``keep`` backups are created, older ones are
        pruned automatically."""
        import time as _t
        from eternal_cli.backup import create_pre_update_backup

        created = []
        for _ in range(5):
            out = create_pre_update_backup(eternal_home=eternal_home, keep=3)
            created.append(out)
            _t.sleep(1.05)  # ensure distinct seconds in timestamp

        remaining = sorted(
            p.name for p in (eternal_home / "backups").iterdir()
            if p.name.startswith("pre-update-")
        )
        assert len(remaining) == 3
        # Oldest two should have been pruned
        assert created[0].name not in remaining
        assert created[1].name not in remaining
        # Newest three should remain
        assert created[4].name in remaining

    def test_rotation_preserves_manual_files(self, eternal_home):
        """Hand-dropped zips in ``backups/`` must not be touched by
        rotation — it only prunes files matching ``pre-update-*.zip``."""
        import time as _t
        from eternal_cli.backup import create_pre_update_backup

        (eternal_home / "backups").mkdir(exist_ok=True)
        manual = eternal_home / "backups" / "my-manual.zip"
        manual.write_bytes(b"manual backup")

        for _ in range(5):
            create_pre_update_backup(eternal_home=eternal_home, keep=2)
            _t.sleep(1.05)

        assert manual.exists(), "Manual backup zip was incorrectly pruned"

    def test_returns_none_if_root_missing(self, tmp_path):
        from eternal_cli.backup import create_pre_update_backup
        assert create_pre_update_backup(eternal_home=tmp_path / "does-not-exist") is None

    def test_keep_zero_does_not_delete_freshly_created_backup(self, eternal_home):
        """Regression: ``backup_keep: 0`` previously triggered ``backups[0:]``
        in the pruner — wiping the just-created zip and leaving the user
        with no recovery point.  The floor (keep>=1) preserves the new file
        regardless of misconfiguration; users who don't want backups should
        set ``pre_update_backup: false`` instead.
        """
        from eternal_cli.backup import create_pre_update_backup
        out = create_pre_update_backup(eternal_home=eternal_home, keep=0)
        assert out is not None
        assert out.exists(), (
            "keep=0 silently deleted the freshly-created backup; floor "
            "should preserve the just-written file."
        )

    def test_keep_negative_does_not_delete_freshly_created_backup(self, eternal_home):
        """Mirror coverage: any value <1 should be floored, not literally
        applied as a slice index."""
        from eternal_cli.backup import create_pre_update_backup
        out = create_pre_update_backup(eternal_home=eternal_home, keep=-3)
        assert out is not None
        assert out.exists()

    def test_keep_zero_still_prunes_older_backups(self, eternal_home):
        """The floor preserves the new backup but should NOT regress the
        rotation behaviour for older zips: a third call with keep=0 must
        still remove pre-existing backups beyond the (floored) limit of 1.
        """
        import time as _t
        from eternal_cli.backup import create_pre_update_backup

        first = create_pre_update_backup(eternal_home=eternal_home, keep=5)
        _t.sleep(1.05)
        second = create_pre_update_backup(eternal_home=eternal_home, keep=5)
        _t.sleep(1.05)
        third = create_pre_update_backup(eternal_home=eternal_home, keep=0)

        remaining = {
            p.name for p in (eternal_home / "backups").iterdir()
            if p.name.startswith("pre-update-")
        }
        assert third.name in remaining, "Floor must preserve the new backup"
        assert first.name not in remaining and second.name not in remaining, (
            f"keep=0 floor of 1 should still prune older backups; "
            f"remaining={remaining}"
        )

    def test_skips_symlinked_files(self, eternal_home, tmp_path):
        """Pre-update backups must not dereference symlinks outside ETERNAL_HOME."""
        from eternal_cli.backup import create_pre_update_backup

        outside = tmp_path / "outside-secret.txt"
        outside.write_text("outside secret\n")
        _symlink_file_or_skip(eternal_home / "skills" / "outside-link.txt", outside)

        out = create_pre_update_backup(eternal_home=eternal_home)
        assert out is not None
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
            assert "skills/outside-link.txt" not in names
            assert all(zf.read(name) != b"outside secret\n" for name in names)


class TestRunPreUpdateBackup:
    """Tests for the ``_run_pre_update_backup`` wrapper in main.py —
    covers the consolidated off/quick/full mode gate, CLI flags, and
    user-facing output."""

    @pytest.fixture
    def eternal_home(self, tmp_path, monkeypatch):
        root = tmp_path / ".eternal"
        root.mkdir()
        _make_eternal_tree(root)
        # Point ETERNAL_HOME at the temp dir so config + backup paths resolve here
        monkeypatch.setenv("ETERNAL_HOME", str(root))
        # Make Path.home() point at tmp_path for anything that uses it
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        # Bust caches for eternal_cli.config + eternal_constants so they pick up ETERNAL_HOME
        for mod in list(__import__("sys").modules.keys()):
            if mod.startswith("eternal_cli.config") or mod == "eternal_constants":
                del __import__("sys").modules[mod]
        return root

    @staticmethod
    def _set_mode(eternal_home, value):
        import yaml
        (eternal_home / "config.yaml").write_text(yaml.safe_dump({
            "_config_version": 22,
            "updates": {"pre_update_backup": value},
        }))
        import sys as _sys
        for mod in list(_sys.modules.keys()):
            if mod.startswith("eternal_cli.config"):
                del _sys.modules[mod]

    @staticmethod
    def _zips(eternal_home):
        d = eternal_home / "backups"
        return list(d.glob("pre-update-*.zip")) if d.exists() else []

    @staticmethod
    def _snaps(eternal_home):
        d = eternal_home / "state-snapshots"
        return [p for p in d.iterdir() if p.is_dir()] if d.exists() else []

    def test_default_creates_quick_snapshot_only(self, eternal_home, capsys):
        """With no config, the default mode is ``quick``: a state snapshot is
        created but NOT the full zip."""
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=False))
        out = capsys.readouterr().out
        assert snap_id is not None
        assert "Pre-update snapshot" in out
        assert "Creating pre-update backup" not in out
        assert self._snaps(eternal_home)
        assert not self._zips(eternal_home)

    def test_backup_flag_forces_full(self, eternal_home, capsys):
        """--backup forces the full zip (plus quick snapshot) for one run."""
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=True))
        out = capsys.readouterr().out
        assert snap_id is not None
        assert "Pre-update snapshot" in out
        assert "Creating pre-update backup" in out
        assert "Saved:" in out
        assert "eternal import" in out
        assert len(self._zips(eternal_home)) == 1

    def test_no_backup_flag_skips_everything(self, eternal_home, capsys):
        """--no-backup skips BOTH the quick snapshot and the zip."""
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=True, backup=False))
        out = capsys.readouterr().out
        assert snap_id is None
        assert "skipped (--no-backup)" in out
        assert "Pre-update snapshot" not in out
        assert not self._snaps(eternal_home)
        assert not self._zips(eternal_home)

    def test_config_off_disables_everything_silently(self, eternal_home, capsys):
        """pre_update_backup: off — an explicit opt-out disables the quick
        snapshot too (it previously ran unconditionally), with no output."""
        self._set_mode(eternal_home, "off")
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=False))
        out = capsys.readouterr().out
        assert snap_id is None
        assert out == ""
        assert not self._snaps(eternal_home)
        assert not self._zips(eternal_home)

    def test_legacy_false_maps_to_off(self, eternal_home, capsys):
        """Legacy boolean ``false`` (the old zip opt-out) now means off."""
        self._set_mode(eternal_home, False)
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=False))
        assert snap_id is None
        assert capsys.readouterr().out == ""
        assert not self._snaps(eternal_home)
        assert not self._zips(eternal_home)

    def test_legacy_true_maps_to_full(self, eternal_home, capsys):
        """Legacy boolean ``true`` (the old always-zip opt-in) means full."""
        self._set_mode(eternal_home, True)
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=False))
        out = capsys.readouterr().out
        assert snap_id is not None
        assert "Creating pre-update backup" in out
        assert "Saved:" in out
        assert len(self._zips(eternal_home)) == 1

    def test_config_full_mode(self, eternal_home, capsys):
        self._set_mode(eternal_home, "full")
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=False))
        out = capsys.readouterr().out
        assert snap_id is not None
        assert "Pre-update snapshot" in out
        assert "Creating pre-update backup" in out
        assert len(self._zips(eternal_home)) == 1

    def test_config_quick_mode(self, eternal_home, capsys):
        self._set_mode(eternal_home, "quick")
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=False))
        out = capsys.readouterr().out
        assert snap_id is not None
        assert "Pre-update snapshot" in out
        assert "Creating pre-update backup" not in out
        assert not self._zips(eternal_home)

    def test_unknown_mode_falls_back_to_quick(self, eternal_home, capsys):
        self._set_mode(eternal_home, "bogus-mode")
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=False))
        out = capsys.readouterr().out
        assert snap_id is not None
        assert "Pre-update snapshot" in out
        assert not self._zips(eternal_home)

    def test_no_backup_flag_overrides_full_config(self, eternal_home, capsys):
        """--no-backup wins even when config says full."""
        self._set_mode(eternal_home, "full")
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=True, backup=False))
        out = capsys.readouterr().out
        assert snap_id is None
        assert "skipped (--no-backup)" in out
        assert not self._snaps(eternal_home)
        assert not self._zips(eternal_home)

    def test_backup_flag_overrides_off_config(self, eternal_home, capsys):
        """--backup wins over config off for a single run."""
        self._set_mode(eternal_home, "off")
        from eternal_cli.main import _run_pre_update_backup
        snap_id = _run_pre_update_backup(Namespace(no_backup=False, backup=True))
        out = capsys.readouterr().out
        assert snap_id is not None
        assert "Creating pre-update backup" in out
        assert len(self._zips(eternal_home)) == 1


# ---------------------------------------------------------------------------
# Pre-migration backup (eternal claw migrate safety net)
# ---------------------------------------------------------------------------

class TestPreMigrationBackup:
    """Tests for create_pre_migration_backup — the auto-backup
    ``eternal claw migrate`` runs before mutating ~/.eternal/."""

    @pytest.fixture
    def eternal_home(self, tmp_path):
        root = tmp_path / ".eternal"
        root.mkdir()
        _make_eternal_tree(root)
        return root

    def test_creates_backup_under_backups_dir(self, eternal_home):
        from eternal_cli.backup import create_pre_migration_backup
        out = create_pre_migration_backup(eternal_home=eternal_home)
        assert out is not None
        assert out.exists()
        # Shares the backups/ directory with pre-update backups so `eternal
        # import` and the update-backup listing both pick them up.
        assert out.parent == eternal_home / "backups"
        assert out.name.startswith("pre-migration-")
        assert out.suffix == ".zip"

    def test_backup_uses_shared_exclusion_rules(self, eternal_home):
        """Pre-migration backup reuses the same exclusion rules as
        ``eternal backup`` / ``create_pre_update_backup`` — no drift."""
        from eternal_cli.backup import create_pre_migration_backup
        out = create_pre_migration_backup(eternal_home=eternal_home)
        assert out is not None
        with zipfile.ZipFile(out) as zf:
            names = set(zf.namelist())
        # User data present
        assert "config.yaml" in names
        assert ".env" in names
        assert "skills/my-skill/SKILL.md" in names
        # Same exclusions as the shared helper
        assert not any(n.startswith("eternal-agent/") for n in names)
        assert not any("__pycache__" in n for n in names)
        assert "gateway.pid" not in names

    def test_restorable_with_eternal_import(self, eternal_home, tmp_path):
        """The zip produced by pre-migration backup must be a valid Eternal
        backup — `eternal import` should accept it."""
        from eternal_cli.backup import create_pre_migration_backup, _validate_backup_zip
        out = create_pre_migration_backup(eternal_home=eternal_home)
        assert out is not None
        with zipfile.ZipFile(out) as zf:
            valid, _reason = _validate_backup_zip(zf)
        assert valid, "pre-migration zip failed _validate_backup_zip"

    def test_does_not_recurse_into_prior_backups(self, eternal_home):
        from eternal_cli.backup import create_pre_migration_backup
        out1 = create_pre_migration_backup(eternal_home=eternal_home)
        assert out1 is not None
        out2 = create_pre_migration_backup(eternal_home=eternal_home)
        assert out2 is not None
        with zipfile.ZipFile(out2) as zf:
            names = zf.namelist()
        assert not any(n.startswith("backups/") for n in names)

    def test_rotation_keeps_only_n(self, eternal_home):
        import time as _t
        from eternal_cli.backup import create_pre_migration_backup

        created = []
        for _ in range(7):
            out = create_pre_migration_backup(eternal_home=eternal_home, keep=3)
            if out is not None:
                created.append(out)
            _t.sleep(1.05)  # timestamp resolution

        remaining = sorted((eternal_home / "backups").glob("pre-migration-*.zip"))
        assert len(remaining) <= 3, f"expected <=3 backups retained, got {len(remaining)}"

    def test_missing_eternal_home_returns_none(self, tmp_path):
        """Fresh install with no ~/.eternal yet — nothing to back up."""
        from eternal_cli.backup import create_pre_migration_backup
        missing = tmp_path / "does-not-exist"
        out = create_pre_migration_backup(eternal_home=missing)
        assert out is None

    def test_does_not_touch_pre_update_backups(self, eternal_home):
        """Pre-migration rotation must only prune pre-migration-*.zip files,
        leaving pre-update-*.zip backups untouched."""
        from eternal_cli.backup import create_pre_update_backup, create_pre_migration_backup
        update_backup = create_pre_update_backup(eternal_home=eternal_home, keep=5)
        assert update_backup is not None and update_backup.exists()
        # Spin up a lot of migration backups with keep=1
        import time as _t
        for _ in range(3):
            out = create_pre_migration_backup(eternal_home=eternal_home, keep=1)
            assert out is not None
            _t.sleep(1.05)
        # Update backup must still be there
        assert update_backup.exists(), "pre-migration rotation wrongly pruned the pre-update backup"


# ---------------------------------------------------------------------------
# Cron jobs auto-restore after silent migration loss (issue #34600)
# ---------------------------------------------------------------------------

class TestRestoreCronJobsIfEmptied:
    """`eternal update` config migration can leave cron/jobs.json valid-but-empty,
    silently dropping every scheduled job. `restore_cron_jobs_if_emptied` is the
    post-migration safety net that restores from the pre-update snapshot."""

    @staticmethod
    def _seed_jobs(path: Path, jobs):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"jobs": jobs}))

    def _make_snapshot(self, eternal_home: Path, label="pre-update"):
        from eternal_cli.backup import create_quick_snapshot
        return create_quick_snapshot(label=label, eternal_home=eternal_home, keep=5)

    def test_restores_when_emptied_after_migration(self, tmp_path):
        from eternal_cli.backup import restore_cron_jobs_if_emptied
        eternal_home = tmp_path / ".eternal"
        jobs_path = eternal_home / "cron" / "jobs.json"
        # Pre-update: 3 real jobs.
        self._seed_jobs(jobs_path, [{"id": "a"}, {"id": "b"}, {"id": "c"}])
        snap_id = self._make_snapshot(eternal_home)
        assert snap_id

        # Migration silently empties the file (valid JSON, zero jobs).
        jobs_path.write_text(json.dumps({"jobs": []}))

        result = restore_cron_jobs_if_emptied(snap_id, eternal_home=eternal_home)
        assert result is not None
        assert result["restored"] is True
        assert result["job_count"] == 3
        assert result["snapshot_id"] == snap_id

        # The live file now has the jobs back.
        restored = json.loads(jobs_path.read_text())
        assert len(restored["jobs"]) == 3

    def test_noop_when_live_file_still_has_jobs(self, tmp_path):
        from eternal_cli.backup import restore_cron_jobs_if_emptied
        eternal_home = tmp_path / ".eternal"
        jobs_path = eternal_home / "cron" / "jobs.json"
        self._seed_jobs(jobs_path, [{"id": "a"}, {"id": "b"}])
        snap_id = self._make_snapshot(eternal_home)

        # Healthy path: file unchanged after update.
        result = restore_cron_jobs_if_emptied(snap_id, eternal_home=eternal_home)
        assert result is None

    def test_restores_when_partial_job_loss(self, tmp_path):
        """Desktop scheduler overwrites jobs.json with its own small set,
        losing tool-created crons while keeping desktop-tracked ones."""
        from eternal_cli.backup import restore_cron_jobs_if_emptied
        eternal_home = tmp_path / ".eternal"
        jobs_path = eternal_home / "cron" / "jobs.json"
        # Pre-update: 19 jobs (18 tool-created + 1 desktop watchdog).
        self._seed_jobs(
            jobs_path,
            [{"id": f"job-{i}"} for i in range(19)],
        )
        snap_id = self._make_snapshot(eternal_home)
        assert snap_id

        # Desktop scheduler overwrites with only its own 1 job.
        jobs_path.write_text(json.dumps({"jobs": [{"id": "desktop-watchdog"}]}))

        result = restore_cron_jobs_if_emptied(snap_id, eternal_home=eternal_home)
        assert result is not None
        assert result["restored"] is True
        assert result["job_count"] == 19

        # The live file now has all 19 jobs back.
        restored = json.loads(jobs_path.read_text())
        assert len(restored["jobs"]) == 19

    def test_noop_when_snapshot_had_no_jobs(self, tmp_path):
        from eternal_cli.backup import restore_cron_jobs_if_emptied
        eternal_home = tmp_path / ".eternal"
        jobs_path = eternal_home / "cron" / "jobs.json"
        # Pre-update genuinely had zero jobs; current is also empty.
        self._seed_jobs(jobs_path, [])
        snap_id = self._make_snapshot(eternal_home)
        jobs_path.write_text(json.dumps({"jobs": []}))

        result = restore_cron_jobs_if_emptied(snap_id, eternal_home=eternal_home)
        assert result is None

    def test_bom_live_file_still_counted(self, tmp_path):
        """A UTF-8 BOM on the live jobs.json (Windows editors) must not make
        _count_cron_jobs report None — that would silently disable the
        auto-restore safety net. utf-8-sig matches cron/jobs.load_jobs."""
        from eternal_cli.backup import _count_cron_jobs, restore_cron_jobs_if_emptied
        eternal_home = tmp_path / ".eternal"
        jobs_path = eternal_home / "cron" / "jobs.json"
        self._seed_jobs(jobs_path, [{"id": "a"}, {"id": "b"}, {"id": "c"}])
        snap_id = self._make_snapshot(eternal_home)
        assert snap_id

        # Migration empties the file AND a Windows editor leaves a BOM.
        jobs_path.write_bytes(b"\xef\xbb\xbf" + json.dumps({"jobs": []}).encode())
        assert _count_cron_jobs(jobs_path) == 0  # not None

        result = restore_cron_jobs_if_emptied(snap_id, eternal_home=eternal_home)
        assert result is not None
        assert result["restored"] is True
        assert result["job_count"] == 3

    def test_noop_when_live_file_unreadable(self, tmp_path):
        """An unparseable live file is left alone — that's a different failure
        mode the user should see, not silently overwrite."""
        from eternal_cli.backup import restore_cron_jobs_if_emptied
        eternal_home = tmp_path / ".eternal"
        jobs_path = eternal_home / "cron" / "jobs.json"
        self._seed_jobs(jobs_path, [{"id": "a"}])
        snap_id = self._make_snapshot(eternal_home)
        jobs_path.write_text("{ this is not valid json")

        result = restore_cron_jobs_if_emptied(snap_id, eternal_home=eternal_home)
        assert result is None
        # File left untouched.
        assert jobs_path.read_text() == "{ this is not valid json"

    def test_noop_when_snapshot_id_missing(self, tmp_path):
        from eternal_cli.backup import restore_cron_jobs_if_emptied
        eternal_home = tmp_path / ".eternal"
        jobs_path = eternal_home / "cron" / "jobs.json"
        self._seed_jobs(jobs_path, [])
        assert restore_cron_jobs_if_emptied(None, eternal_home=eternal_home) is None
        assert restore_cron_jobs_if_emptied("", eternal_home=eternal_home) is None

    def test_restores_legacy_bare_list_snapshot_shape(self, tmp_path):
        """A legacy snapshot storing a bare JSON list (not {"jobs": [...]}) is
        still counted and restored."""
        from eternal_cli.backup import restore_cron_jobs_if_emptied
        eternal_home = tmp_path / ".eternal"
        jobs_path = eternal_home / "cron" / "jobs.json"
        jobs_path.parent.mkdir(parents=True, exist_ok=True)
        jobs_path.write_text(json.dumps([{"id": "a"}, {"id": "b"}]))
        snap_id = self._make_snapshot(eternal_home)

        jobs_path.write_text(json.dumps({"jobs": []}))
        result = restore_cron_jobs_if_emptied(snap_id, eternal_home=eternal_home)
        assert result is not None
        assert result["job_count"] == 2


# ---------------------------------------------------------------------------
# Memory-provider external paths (~/.honcho, ~/.hindsight, ...) — captured via
# MemoryProvider.backup_paths() and restored to their original home-relative
# location, NOT under ETERNAL_HOME. (backup/import cycle data-loss fix)
# ---------------------------------------------------------------------------

class TestMemoryProviderExternalPaths:
    def _make_min_tree(self, eternal_home: Path) -> None:
        eternal_home.mkdir(parents=True, exist_ok=True)
        (eternal_home / "config.yaml").write_text("model:\n  provider: openrouter\n")
        (eternal_home / ".env").write_text("OPENROUTER_API_KEY=sk-test\n")
        (eternal_home / "state.db").write_bytes(b"x")

    def test_backup_captures_external_paths_under_external_prefix(self, tmp_path, monkeypatch):
        """Provider state under ~/.honcho is archived beneath _external/,
        encoded relative to the home directory."""
        eternal_home = tmp_path / ".eternal"
        self._make_min_tree(eternal_home)
        # External provider state living OUTSIDE ETERNAL_HOME.
        honcho = tmp_path / ".honcho"
        honcho.mkdir()
        (honcho / "config.json").write_text('{"peer":"alice"}')
        (honcho / "sub").mkdir()
        (honcho / "sub" / "x.json").write_text('{"a":1}')

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        import eternal_cli.backup as backup_mod
        monkeypatch.setattr(
            backup_mod, "_collect_memory_provider_external_paths", lambda: [honcho]
        )

        out_zip = tmp_path / "backup.zip"
        backup_mod.run_backup(Namespace(output=str(out_zip)))

        with zipfile.ZipFile(out_zip) as zf:
            names = set(zf.namelist())
        assert "_external/.honcho/config.json" in names
        assert "_external/.honcho/sub/x.json" in names
        # In-home files still present.
        assert "config.yaml" in names

    def test_backup_skips_external_paths_outside_home(self, tmp_path, monkeypatch):
        """A declared path outside the home dir is not portable and must be
        skipped, never archived."""
        eternal_home = tmp_path / ".eternal"
        self._make_min_tree(eternal_home)
        outside = tmp_path.parent / "outside-home-secret"
        outside.mkdir(exist_ok=True)
        (outside / "leak.json").write_text('{"secret":1}')

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        import eternal_cli.backup as backup_mod
        monkeypatch.setattr(
            backup_mod, "_collect_memory_provider_external_paths", lambda: [outside]
        )

        out_zip = tmp_path / "backup.zip"
        backup_mod.run_backup(Namespace(output=str(out_zip)))

        with zipfile.ZipFile(out_zip) as zf:
            names = set(zf.namelist())
        assert not any(n.startswith("_external/") for n in names)
        assert not any("leak.json" in n for n in names)
        (outside / "leak.json").unlink()
        outside.rmdir()

    def test_import_restores_external_to_home_relative_location(self, tmp_path, monkeypatch):
        """_external/ members restore to ~/<relpath>, not under ETERNAL_HOME,
        and credential-shaped files get 0600."""
        dst_home = tmp_path / "dst"
        dst_home.mkdir()
        eternal_home = dst_home / ".eternal"
        eternal_home.mkdir()

        zip_path = tmp_path / "backup.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("config.yaml", "model: {}\n")
            zf.writestr(".env", "X=1\n")
            zf.writestr("state.db", "")
            zf.writestr("_external/.honcho/config.json", '{"peer":"bob"}')

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: dst_home)

        from eternal_cli.backup import run_import
        run_import(Namespace(zipfile=str(zip_path), force=True))

        restored = dst_home / ".honcho" / "config.json"
        assert restored.exists()
        assert restored.read_text() == '{"peer":"bob"}'
        # Credential-shaped file tightened.
        assert (restored.stat().st_mode & 0o777) == 0o600
        # External state did NOT leak into ETERNAL_HOME.
        assert not (eternal_home / "_external").exists()

    def test_import_blocks_external_path_traversal(self, tmp_path, monkeypatch):
        """A malicious _external/ member that escapes the home dir is blocked."""
        dst_home = tmp_path / "dst"
        dst_home.mkdir()
        eternal_home = dst_home / ".eternal"
        eternal_home.mkdir()
        sentinel = tmp_path / "PWNED"

        zip_path = tmp_path / "backup.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("config.yaml", "model: {}\n")
            zf.writestr(".env", "X=1\n")
            zf.writestr("state.db", "")
            zf.writestr("_external/../../PWNED", "pwned")

        monkeypatch.setenv("ETERNAL_HOME", str(eternal_home))
        monkeypatch.setattr(Path, "home", lambda: dst_home)

        from eternal_cli.backup import run_import
        run_import(Namespace(zipfile=str(zip_path), force=True))

        assert not sentinel.exists()

    def test_abc_backup_paths_defaults_empty(self):
        """The ABC default returns [] so providers opt in explicitly."""
        from agent.memory_provider import MemoryProvider

        class _Dummy(MemoryProvider):
            @property
            def name(self):
                return "dummy"

            def is_available(self):
                return True

            def initialize(self, session_id, **kwargs):
                pass

            def get_tool_schemas(self):
                return []

        assert _Dummy().backup_paths() == []

    def test_honcho_provider_declares_global_config_dir(self, tmp_path, monkeypatch):
        """The honcho provider's backup_paths() resolves to ~/.honcho."""
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        from plugins.memory.honcho import HonchoMemoryProvider

        paths = HonchoMemoryProvider().backup_paths()
        assert str(tmp_path / ".honcho") in paths

    def test_hindsight_provider_declares_legacy_dir(self, tmp_path, monkeypatch):
        """The hindsight provider's backup_paths() resolves to ~/.hindsight."""
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        from plugins.memory.hindsight import HindsightMemoryProvider

        paths = HindsightMemoryProvider().backup_paths()
        assert str(tmp_path / ".hindsight") in paths
