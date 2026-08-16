"""Tests for `eternal pack` — bundled skill + plugin + MCP installs."""

import json

import pytest
import yaml

from eternal_cli import packs


@pytest.fixture
def home(tmp_path, monkeypatch):
    """An isolated ETERNAL_HOME with a config.yaml."""
    h = tmp_path / "home"
    h.mkdir()
    (h / "config.yaml").write_text("model:\n  default: x\n", encoding="utf-8")
    monkeypatch.setattr(packs, "_home", lambda: h)

    def _load():
        return yaml.safe_load((h / "config.yaml").read_text(encoding="utf-8")) or {}

    def _save(cfg, *a, **kw):
        (h / "config.yaml").write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")

    import eternal_cli.config as cfgmod
    monkeypatch.setattr(cfgmod, "load_config", _load)
    monkeypatch.setattr(cfgmod, "load_config_readonly", _load)
    monkeypatch.setattr(cfgmod, "save_config", _save)
    return h


def make_pack(root, name="demo", *, skills=True, plugins=True, mcp=True, env=None):
    p = root / name
    (p / "skills" / "s1").mkdir(parents=True)
    (p / "plugins" / "p1").mkdir(parents=True)
    (p / "skills" / "s1" / "SKILL.md").write_text("---\nname: s1\n---\nbody\n", encoding="utf-8")
    (p / "plugins" / "p1" / "plugin.yaml").write_text("name: p1\nkind: standalone\n", encoding="utf-8")
    m = {"name": name, "version": "1.0.0", "description": "d", "author": "a"}
    if skills:
        m["skills"] = ["skills/s1"]
    if plugins:
        m["plugins"] = ["plugins/p1"]
    if mcp:
        server = {"command": "npx", "args": ["-y", "x"]}
        if env is not None:
            server["env"] = env
        m["mcp_servers"] = {"srv": server}
    (p / packs.MANIFEST_NAME).write_text(yaml.safe_dump(m, sort_keys=False), encoding="utf-8")
    return p


# -- manifest ---------------------------------------------------------------

def test_manifest_requires_name(tmp_path):
    p = tmp_path / "bad"
    p.mkdir()
    (p / packs.MANIFEST_NAME).write_text("version: 1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing a `name:`"):
        packs.load_manifest(p)


def test_manifest_missing_file(tmp_path):
    with pytest.raises(ValueError, match="no eternal-pack.yaml"):
        packs.load_manifest(tmp_path)


def test_manifest_rejects_path_separator_in_name(tmp_path):
    p = tmp_path / "bad"
    p.mkdir()
    (p / packs.MANIFEST_NAME).write_text("name: ../escape\n", encoding="utf-8")
    with pytest.raises(ValueError, match="path separators"):
        packs.load_manifest(p)


def test_path_traversal_is_refused(tmp_path, home):
    p = make_pack(tmp_path, "trav")
    (p / packs.MANIFEST_NAME).write_text(
        yaml.safe_dump({"name": "trav", "skills": ["../../etc"]}, sort_keys=False), encoding="utf-8"
    )
    plan = packs.build_plan(packs.load_manifest(p))
    assert plan.errors
    assert "escapes the pack directory" in plan.errors[0].note


# -- plan -------------------------------------------------------------------

def test_plan_lists_all_three_kinds(tmp_path, home):
    plan = packs.build_plan(packs.load_manifest(make_pack(tmp_path)))
    assert {i.kind for i in plan.installable} == {"skill", "plugin", "mcp"}
    assert not plan.errors


def test_plan_flags_skill_without_skill_md(tmp_path, home):
    p = make_pack(tmp_path)
    (p / "skills" / "s1" / "SKILL.md").unlink()
    plan = packs.build_plan(packs.load_manifest(p))
    assert any(i.status == "error" and "no SKILL.md" in i.note for i in plan.items)


def test_plan_flags_conflict_on_second_install(tmp_path, home):
    p = make_pack(tmp_path)
    packs.apply_plan(packs.build_plan(packs.load_manifest(p)))
    plan2 = packs.build_plan(packs.load_manifest(p))
    assert len(plan2.conflicts) == 3
    assert not plan2.installable


def test_force_turns_conflicts_into_overwrites(tmp_path, home):
    p = make_pack(tmp_path)
    packs.apply_plan(packs.build_plan(packs.load_manifest(p)))
    plan2 = packs.build_plan(packs.load_manifest(p), force=True)
    assert not plan2.conflicts
    assert all(i.note == "overwrite" for i in plan2.installable)


# -- apply ------------------------------------------------------------------

def test_install_writes_all_three(tmp_path, home):
    packs.apply_plan(packs.build_plan(packs.load_manifest(make_pack(tmp_path))))
    assert (home / "skills" / "demo" / "s1" / "SKILL.md").is_file()
    assert (home / "plugins" / "p1" / "plugin.yaml").is_file()
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert "srv" in cfg["mcp_servers"]


def test_skills_are_namespaced_under_pack(tmp_path, home):
    """Two packs shipping a same-named skill must not collide."""
    a = make_pack(tmp_path / "a", "alpha")
    b = make_pack(tmp_path / "b", "beta")
    packs.apply_plan(packs.build_plan(packs.load_manifest(a)))
    packs.apply_plan(packs.build_plan(packs.load_manifest(b)))
    assert (home / "skills" / "alpha" / "s1" / "SKILL.md").is_file()
    assert (home / "skills" / "beta" / "s1" / "SKILL.md").is_file()


def test_secret_env_vars_are_stripped(tmp_path, home):
    p = make_pack(tmp_path, env={"MY_API_KEY": "sk-secret", "REGION": "eu"})
    plan = packs.build_plan(packs.load_manifest(p))
    assert any("MY_API_KEY" in s for s in plan.stripped_secrets)
    packs.apply_plan(plan)
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    env = cfg["mcp_servers"]["srv"]["env"]
    assert "MY_API_KEY" not in env
    assert env["REGION"] == "eu"


def test_receipt_records_what_was_written(tmp_path, home):
    packs.apply_plan(packs.build_plan(packs.load_manifest(make_pack(tmp_path))))
    r = json.loads((home / "packs" / "demo.json").read_text(encoding="utf-8"))
    assert len(r["skills"]) == 1 and len(r["plugins"]) == 1
    assert r["mcp_servers"] == ["srv"]


# -- remove -----------------------------------------------------------------

def test_remove_undoes_the_install(tmp_path, home):
    packs.apply_plan(packs.build_plan(packs.load_manifest(make_pack(tmp_path))))
    packs.remove_pack("demo")
    assert not (home / "skills" / "demo" / "s1").exists()
    assert not (home / "plugins" / "p1").exists()
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert "srv" not in (cfg.get("mcp_servers") or {})
    assert not (home / "packs" / "demo.json").exists()


def test_remove_spares_content_the_pack_did_not_install(tmp_path, home):
    """The property that matters: removal replays a receipt, it does not guess."""
    packs.apply_plan(packs.build_plan(packs.load_manifest(make_pack(tmp_path))))

    mine_skill = home / "skills" / "demo" / "my-own"
    mine_skill.mkdir(parents=True)
    (mine_skill / "SKILL.md").write_text("mine", encoding="utf-8")
    mine_plugin = home / "plugins" / "my-own"
    mine_plugin.mkdir(parents=True)
    (mine_plugin / "plugin.yaml").write_text("name: my-own\n", encoding="utf-8")
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    cfg["mcp_servers"]["mine"] = {"command": "echo"}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")

    packs.remove_pack("demo")

    assert (mine_skill / "SKILL.md").is_file()
    assert (mine_plugin / "plugin.yaml").is_file()
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert "mine" in cfg["mcp_servers"]
    assert "srv" not in cfg["mcp_servers"]


def test_remove_dry_run_changes_nothing(tmp_path, home):
    packs.apply_plan(packs.build_plan(packs.load_manifest(make_pack(tmp_path))))
    removed, _missing = packs.remove_pack("demo", dry_run=True)
    assert removed
    assert (home / "skills" / "demo" / "s1" / "SKILL.md").is_file()
    assert (home / "packs" / "demo.json").is_file()


def test_remove_unknown_pack_raises(home):
    with pytest.raises(ValueError, match="no installed pack"):
        packs.remove_pack("nope")


# -- scaffold ---------------------------------------------------------------

def test_scaffold_produces_an_installable_shell(tmp_path, home):
    root = packs.scaffold("newpack", tmp_path, author="me")
    m = packs.load_manifest(root)
    assert m.name == "newpack"
    assert m.is_empty          # nothing declared yet
    plan = packs.build_plan(m)
    assert not plan.errors


def test_scaffold_refuses_to_clobber(tmp_path, home):
    packs.scaffold("dup", tmp_path)
    with pytest.raises(ValueError, match="already exists"):
        packs.scaffold("dup", tmp_path)
