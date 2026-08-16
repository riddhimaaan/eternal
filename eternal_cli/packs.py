"""eternal pack — install skills, plugins, and MCP servers as one unit.

Eternal already ships three extension systems, but nothing that packages them
together:

    skills   markdown instructions      eternal skills install
    plugins  Python tools + hooks       eternal plugins install
    mcp      external servers           eternal mcp add

So "everything for working with n8n" — the skills that explain it, the plugin
that talks to it, the MCP server it needs — is three separate installs, and
nothing tells the user they need all three. A pack is the missing artifact:
one directory, one manifest, one install.

Manifest (``eternal-pack.yaml`` at the pack root)
-------------------------------------------------
    name: n8n-kit
    version: 1.0.0
    description: Everything for working with n8n
    author: you

    skills:                        # dirs containing SKILL.md
      - skills/n8n-workflow-patterns
    plugins:                       # dirs containing plugin.yaml
      - plugins/n8n-tools
    mcp_servers:                   # merged into config.yaml mcp_servers
      n8n:
        command: npx
        args: ["-y", "n8n-mcp"]

Install targets
---------------
    skills       -> ETERNAL_HOME/skills/<pack>/<skill>/
    plugins      -> ETERNAL_HOME/plugins/<plugin>/
    mcp_servers  -> config.yaml mcp_servers.<name>

Skills are namespaced under the pack name so two packs can ship a same-named
skill without collision, and so removal is exact.

Every install writes a receipt to ETERNAL_HOME/packs/<name>.json listing the
precise paths created and config keys added. ``pack remove`` replays that
receipt rather than guessing, so it never deletes something the pack did not
install.

Follows the ``eternal import-agent`` pattern: detect -> preview -> apply, with
a mandatory preview, per-item records, and a ``--dry-run`` that writes nothing.
Secrets are never installed: MCP env vars with secret-looking names are
stripped and reported so the user re-adds them deliberately.
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

MANIFEST_NAME = "eternal-pack.yaml"
_MANIFEST_ALT = "eternal-pack.yml"

# Manifest keys that carry installable content. Anything else is metadata.
_CONTENT_KEYS = ("skills", "plugins", "mcp_servers")


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def _home() -> Path:
    from eternal_constants import get_eternal_home
    return get_eternal_home()


def packs_dir() -> Path:
    """Where install receipts live."""
    return _home() / "packs"


def _skills_root() -> Path:
    return _home() / "skills"


def _plugins_root() -> Path:
    return _home() / "plugins"


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

@dataclass
class PackManifest:
    name: str
    version: str = "0.0.0"
    description: str = ""
    author: str = ""
    skills: List[str] = field(default_factory=list)
    plugins: List[str] = field(default_factory=list)
    mcp_servers: Dict[str, Any] = field(default_factory=dict)
    root: Optional[Path] = None

    @property
    def is_empty(self) -> bool:
        return not (self.skills or self.plugins or self.mcp_servers)


def find_manifest(source: Path) -> Optional[Path]:
    """Return the manifest path inside *source*, or None."""
    for candidate in (MANIFEST_NAME, _MANIFEST_ALT):
        p = source / candidate
        if p.is_file():
            return p
    return None


def load_manifest(source: Path) -> PackManifest:
    """Parse and validate a pack manifest. Raises ValueError on bad input."""
    import yaml

    mpath = find_manifest(source)
    if mpath is None:
        raise ValueError(
            f"no {MANIFEST_NAME} found in {source} — is this a pack directory?"
        )
    try:
        data = yaml.safe_load(mpath.read_text(encoding="utf-8")) or {}
    except Exception as e:
        raise ValueError(f"{mpath} is not valid YAML: {e}") from e
    if not isinstance(data, dict):
        raise ValueError(f"{mpath} must contain a mapping at the top level")

    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError(f"{mpath} is missing a `name:` field")
    if "/" in name or "\\" in name or name.startswith("."):
        raise ValueError(f"pack name {name!r} must not contain path separators")

    def _strlist(key: str) -> List[str]:
        raw = data.get(key) or []
        if isinstance(raw, str):
            raw = [raw]
        if not isinstance(raw, list):
            raise ValueError(f"{mpath}: `{key}:` must be a list of paths")
        return [str(x).strip() for x in raw if str(x).strip()]

    mcp = data.get("mcp_servers") or {}
    if not isinstance(mcp, dict):
        raise ValueError(f"{mpath}: `mcp_servers:` must be a mapping of name -> config")

    return PackManifest(
        name=name,
        version=str(data.get("version") or "0.0.0"),
        description=str(data.get("description") or ""),
        author=str(data.get("author") or ""),
        skills=_strlist("skills"),
        plugins=_strlist("plugins"),
        mcp_servers=mcp,
        root=source,
    )


def _resolve_inside(root: Path, rel: str) -> Path:
    """Resolve *rel* under *root*, refusing to escape the pack directory."""
    root_r = root.resolve()
    target = (root_r / rel).resolve()
    if root_r != target and root_r not in target.parents:
        raise ValueError(f"path {rel!r} escapes the pack directory")
    return target


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------

@dataclass
class PlanItem:
    kind: str          # skill | plugin | mcp
    name: str
    source: str        # where it comes from (path or "manifest")
    dest: str          # where it lands
    status: str        # ok | conflict | error
    note: str = ""


@dataclass
class Plan:
    manifest: PackManifest
    items: List[PlanItem] = field(default_factory=list)
    stripped_secrets: List[str] = field(default_factory=list)

    @property
    def conflicts(self) -> List[PlanItem]:
        return [i for i in self.items if i.status == "conflict"]

    @property
    def errors(self) -> List[PlanItem]:
        return [i for i in self.items if i.status == "error"]

    @property
    def installable(self) -> List[PlanItem]:
        return [i for i in self.items if i.status == "ok"]


def build_plan(manifest: PackManifest, *, force: bool = False) -> Plan:
    """Work out what installing this pack would do. Touches nothing."""
    from eternal_cli.agent_import import sanitize_mcp_env
    from eternal_cli.config import load_config_readonly

    plan = Plan(manifest=manifest)
    root = manifest.root or Path(".")

    # -- skills -------------------------------------------------------------
    skills_dest_root = _skills_root() / manifest.name
    for rel in manifest.skills:
        try:
            src = _resolve_inside(root, rel)
        except ValueError as e:
            plan.items.append(PlanItem("skill", rel, rel, "-", "error", str(e)))
            continue
        if not src.is_dir():
            plan.items.append(PlanItem("skill", rel, rel, "-", "error", "not a directory"))
            continue
        if not (src / "SKILL.md").is_file():
            plan.items.append(PlanItem("skill", src.name, rel, "-", "error", "no SKILL.md"))
            continue
        dest = skills_dest_root / src.name
        status, note = ("ok", "")
        if dest.exists():
            status, note = ("ok", "overwrite") if force else ("conflict", "already installed")
        plan.items.append(PlanItem("skill", src.name, rel, str(dest), status, note))

    # -- plugins ------------------------------------------------------------
    for rel in manifest.plugins:
        try:
            src = _resolve_inside(root, rel)
        except ValueError as e:
            plan.items.append(PlanItem("plugin", rel, rel, "-", "error", str(e)))
            continue
        if not src.is_dir():
            plan.items.append(PlanItem("plugin", rel, rel, "-", "error", "not a directory"))
            continue
        if not (src / "plugin.yaml").is_file():
            plan.items.append(PlanItem("plugin", src.name, rel, "-", "error", "no plugin.yaml"))
            continue
        dest = _plugins_root() / src.name
        status, note = ("ok", "")
        if dest.exists():
            status, note = ("ok", "overwrite") if force else ("conflict", "already installed")
        plan.items.append(PlanItem("plugin", src.name, rel, str(dest), status, note))

    # -- mcp servers --------------------------------------------------------
    existing = (load_config_readonly().get("mcp_servers") or {}) if manifest.mcp_servers else {}
    for name, cfg in (manifest.mcp_servers or {}).items():
        if not isinstance(cfg, dict):
            plan.items.append(PlanItem("mcp", str(name), "manifest", "-", "error", "config must be a mapping"))
            continue
        kept, stripped = sanitize_mcp_env(cfg.get("env"))
        if stripped:
            plan.stripped_secrets.extend(f"mcp_servers.{name}.env.{k}" for k in stripped)
        status, note = ("ok", "")
        if name in existing:
            status, note = ("ok", "overwrite") if force else ("conflict", "server already configured")
        plan.items.append(
            PlanItem("mcp", str(name), "manifest", f"config.yaml mcp_servers.{name}", status, note)
        )
    return plan


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

def apply_plan(plan: Plan, *, force: bool = False) -> Dict[str, Any]:
    """Execute *plan*. Returns the receipt dict that was written."""
    from eternal_cli.agent_import import sanitize_mcp_env
    from eternal_cli.config import load_config, save_config

    m = plan.manifest
    root = m.root or Path(".")
    receipt: Dict[str, Any] = {
        "name": m.name,
        "version": m.version,
        "description": m.description,
        "author": m.author,
        "source": str(root.resolve()),
        "installed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "skills": [],
        "plugins": [],
        "mcp_servers": [],
        "stripped_secrets": list(plan.stripped_secrets),
    }

    for item in plan.installable:
        if item.kind == "skill":
            src = _resolve_inside(root, item.source)
            dest = Path(item.dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(src, dest)
            receipt["skills"].append(str(dest))
        elif item.kind == "plugin":
            src = _resolve_inside(root, item.source)
            dest = Path(item.dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(src, dest)
            receipt["plugins"].append(str(dest))

    mcp_items = [i for i in plan.installable if i.kind == "mcp"]
    if mcp_items:
        cfg = load_config()
        servers = cfg.get("mcp_servers")
        if not isinstance(servers, dict):
            servers = {}
        for item in mcp_items:
            raw = dict(m.mcp_servers[item.name])
            kept, _stripped = sanitize_mcp_env(raw.get("env"))
            if kept:
                raw["env"] = kept
            elif "env" in raw:
                raw.pop("env")
            servers[item.name] = raw
            receipt["mcp_servers"].append(item.name)
        cfg["mcp_servers"] = servers
        save_config(cfg)

    packs_dir().mkdir(parents=True, exist_ok=True)
    (packs_dir() / f"{m.name}.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    return receipt


def load_receipt(name: str) -> Optional[Dict[str, Any]]:
    p = packs_dir() / f"{name}.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def list_receipts() -> List[Dict[str, Any]]:
    d = packs_dir()
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            logger.debug("skipping unreadable receipt %s", p)
    return out


def remove_pack(name: str, *, dry_run: bool = False) -> Tuple[List[str], List[str]]:
    """Undo an install using its receipt. Returns (removed, missing)."""
    from eternal_cli.config import load_config, save_config

    receipt = load_receipt(name)
    if receipt is None:
        raise ValueError(f"no installed pack named {name!r}")

    removed: List[str] = []
    missing: List[str] = []

    for key in ("skills", "plugins"):
        for path_s in receipt.get(key) or []:
            p = Path(path_s)
            if p.exists():
                if not dry_run:
                    shutil.rmtree(p, ignore_errors=True)
                removed.append(path_s)
            else:
                missing.append(path_s)

    servers = receipt.get("mcp_servers") or []
    if servers:
        cfg = load_config()
        existing = cfg.get("mcp_servers")
        if isinstance(existing, dict):
            touched = False
            for s in servers:
                if s in existing:
                    if not dry_run:
                        existing.pop(s)
                    touched = True
                    removed.append(f"config.yaml mcp_servers.{s}")
                else:
                    missing.append(f"config.yaml mcp_servers.{s}")
            if touched and not dry_run:
                cfg["mcp_servers"] = existing
                save_config(cfg)

    # Drop the now-empty pack skills namespace.
    ns = _skills_root() / name
    if ns.is_dir() and not any(ns.iterdir()):
        if not dry_run:
            ns.rmdir()

    if not dry_run:
        (packs_dir() / f"{name}.json").unlink(missing_ok=True)
    return removed, missing


# ---------------------------------------------------------------------------
# Scaffold
# ---------------------------------------------------------------------------

_SCAFFOLD_MANIFEST = """\
name: {name}
version: 0.1.0
description: What this pack gives you, in one line.
author: {author}

# Directories inside this pack, each containing a SKILL.md.
# Installed to ETERNAL_HOME/skills/{name}/<dir-name>/
skills: []

# Directories inside this pack, each containing a plugin.yaml.
# Installed to ETERNAL_HOME/plugins/<dir-name>/
plugins: []

# Merged into config.yaml mcp_servers. Secret-looking env vars are stripped
# on install and reported — add those yourself afterwards.
mcp_servers: {{}}
"""


def scaffold(name: str, dest: Path, *, author: str = "") -> Path:
    root = dest / name
    if root.exists():
        raise ValueError(f"{root} already exists")
    (root / "skills").mkdir(parents=True)
    (root / "plugins").mkdir(parents=True)
    (root / MANIFEST_NAME).write_text(
        _SCAFFOLD_MANIFEST.format(name=name, author=author), encoding="utf-8"
    )
    (root / "README.md").write_text(
        f"# {name}\n\nAn Eternal pack. Install with:\n\n    eternal pack install ./{name}\n",
        encoding="utf-8",
    )
    return root


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def register_cli(parser) -> None:
    sub = parser.add_subparsers(dest="pack_action")

    p_install = sub.add_parser("install", help="Install a pack from a directory")
    p_install.add_argument("source", help="Path to a directory containing eternal-pack.yaml")
    p_install.add_argument("--dry-run", action="store_true", help="Preview only; write nothing")
    p_install.add_argument("--force", action="store_true", help="Overwrite anything already installed")
    p_install.add_argument("-y", "--yes", action="store_true", help="Skip the confirmation prompt")

    sub.add_parser("list", help="List installed packs")

    p_show = sub.add_parser("show", help="Show one installed pack's contents")
    p_show.add_argument("name")

    p_rm = sub.add_parser("remove", help="Uninstall a pack using its receipt")
    p_rm.add_argument("name")
    p_rm.add_argument("--dry-run", action="store_true", help="Preview only; write nothing")
    p_rm.add_argument("-y", "--yes", action="store_true", help="Skip the confirmation prompt")

    p_new = sub.add_parser("create", help="Scaffold a new pack directory")
    p_new.add_argument("name")
    p_new.add_argument("--dest", default=".", help="Where to create it (default: cwd)")
    p_new.add_argument("--author", default="")


def _console():
    try:
        from rich.console import Console
        return Console()
    except Exception:
        return None


def _print(console, msg: str, plain: str = "") -> None:
    if console:
        console.print(msg)
    else:
        print(plain or msg)


def pack_command(args) -> int:
    console = _console()
    action = getattr(args, "pack_action", None)

    if action == "list":
        receipts = list_receipts()
        if not receipts:
            _print(console, "\n  No packs installed.\n\n  Create one with:\n    [bold]eternal pack create my-pack[/bold]\n",
                   "\n  No packs installed.\n\n  Create one with:\n    eternal pack create my-pack\n")
            return 0
        _print(console, "")
        for r in receipts:
            counts = (f"{len(r.get('skills') or [])} skills, "
                      f"{len(r.get('plugins') or [])} plugins, "
                      f"{len(r.get('mcp_servers') or [])} mcp")
            _print(console,
                   f"  [bold]{r.get('name')}[/bold]  {r.get('version','')}  [dim]{counts}[/dim]",
                   f"  {r.get('name')}  {r.get('version','')}  ({counts})")
        _print(console, "")
        return 0

    if action == "show":
        r = load_receipt(args.name)
        if r is None:
            _print(console, f"[red]No installed pack named {args.name!r}[/red]", f"No installed pack named {args.name!r}")
            return 1
        _print(console, "")
        _print(console, f"  [bold]{r.get('name')}[/bold] {r.get('version','')}", f"  {r.get('name')} {r.get('version','')}")
        if r.get("description"):
            _print(console, f"  [dim]{r['description']}[/dim]", f"  {r['description']}")
        _print(console, f"  [dim]installed {r.get('installed_at','?')} from {r.get('source','?')}[/dim]",
               f"  installed {r.get('installed_at','?')} from {r.get('source','?')}")
        for key, label in (("skills", "Skills"), ("plugins", "Plugins"), ("mcp_servers", "MCP servers")):
            vals = r.get(key) or []
            if vals:
                _print(console, f"\n  {label}:", f"\n  {label}:")
                for v in vals:
                    _print(console, f"    {v}", f"    {v}")
        if r.get("stripped_secrets"):
            _print(console, "\n  [yellow]Secrets stripped on install (re-add manually):[/yellow]",
                   "\n  Secrets stripped on install (re-add manually):")
            for v in r["stripped_secrets"]:
                _print(console, f"    {v}", f"    {v}")
        _print(console, "")
        return 0

    if action == "create":
        try:
            root = scaffold(args.name, Path(args.dest).expanduser(), author=args.author)
        except ValueError as e:
            _print(console, f"[red]{e}[/red]", str(e))
            return 1
        _print(console, f"\n  Created [bold]{root}[/bold]\n\n  Add skills and plugins, then:\n    [bold]eternal pack install {root}[/bold]\n",
               f"\n  Created {root}\n\n  Add skills and plugins, then:\n    eternal pack install {root}\n")
        return 0

    if action == "remove":
        try:
            removed, missing = remove_pack(args.name, dry_run=True)
        except ValueError as e:
            _print(console, f"[red]{e}[/red]", str(e))
            return 1
        _print(console, f"\n  Removing [bold]{args.name}[/bold] would delete:", f"\n  Removing {args.name} would delete:")
        for r in removed:
            _print(console, f"    [red]-[/red] {r}", f"    - {r}")
        for m in missing:
            _print(console, f"    [dim]· {m} (already gone)[/dim]", f"    . {m} (already gone)")
        if args.dry_run:
            _print(console, "\n  [dim]Dry run — nothing changed.[/dim]\n", "\n  Dry run - nothing changed.\n")
            return 0
        if not args.yes:
            try:
                if input("\n  Proceed? [y/N] ").strip().lower() not in ("y", "yes"):
                    _print(console, "  Cancelled.", "  Cancelled.")
                    return 1
            except (EOFError, KeyboardInterrupt):
                _print(console, "\n  Cancelled.", "\n  Cancelled.")
                return 1
        remove_pack(args.name, dry_run=False)
        _print(console, f"\n  [green]✓[/green] Removed {args.name}\n", f"\n  Removed {args.name}\n")
        return 0

    if action == "install":
        source = Path(args.source).expanduser()
        if not source.is_dir():
            _print(console, f"[red]{source} is not a directory[/red]", f"{source} is not a directory")
            return 1
        try:
            manifest = load_manifest(source)
        except ValueError as e:
            _print(console, f"[red]{e}[/red]", str(e))
            return 1

        plan = build_plan(manifest, force=args.force)

        _print(console, "")
        _print(console, f"  [bold]{manifest.name}[/bold] {manifest.version}"
                        + (f"  [dim]by {manifest.author}[/dim]" if manifest.author else ""),
               f"  {manifest.name} {manifest.version}"
               + (f"  by {manifest.author}" if manifest.author else ""))
        if manifest.description:
            _print(console, f"  [dim]{manifest.description}[/dim]", f"  {manifest.description}")

        if manifest.is_empty:
            _print(console, "\n  [yellow]This pack declares no skills, plugins, or MCP servers.[/yellow]\n",
                   "\n  This pack declares no skills, plugins, or MCP servers.\n")
            return 1

        _print(console, "\n  Would install:", "\n  Would install:")
        for item in plan.items:
            if item.status == "ok":
                mark = "[green]+[/green]" if console else "+"
                note = f" [dim]({item.note})[/dim]" if item.note else ""
                plain_note = f" ({item.note})" if item.note else ""
                _print(console, f"    {mark} {item.kind:<7} {item.name} [dim]→ {item.dest}[/dim]{note}",
                       f"    + {item.kind:<7} {item.name} -> {item.dest}{plain_note}")
        for item in plan.conflicts:
            _print(console, f"    [yellow]![/yellow] {item.kind:<7} {item.name} [yellow]{item.note}[/yellow]",
                   f"    ! {item.kind:<7} {item.name} {item.note}")
        for item in plan.errors:
            _print(console, f"    [red]✗[/red] {item.kind:<7} {item.name} [red]{item.note}[/red]",
                   f"    x {item.kind:<7} {item.name} {item.note}")

        if plan.stripped_secrets:
            _print(console, "\n  [yellow]Secret-looking env vars will be stripped:[/yellow]",
                   "\n  Secret-looking env vars will be stripped:")
            for s in plan.stripped_secrets:
                _print(console, f"    {s}", f"    {s}")
            _print(console, "  [dim]Add them yourself after install.[/dim]", "  Add them yourself after install.")

        if plan.errors:
            _print(console, "\n  [red]Fix the errors above before installing.[/red]\n",
                   "\n  Fix the errors above before installing.\n")
            return 1
        if plan.conflicts and not args.force:
            _print(console, "\n  [yellow]Nothing installed — rerun with --force to overwrite.[/yellow]\n",
                   "\n  Nothing installed - rerun with --force to overwrite.\n")
            return 1
        if not plan.installable:
            _print(console, "\n  Nothing to install.\n", "\n  Nothing to install.\n")
            return 0
        if args.dry_run:
            _print(console, "\n  [dim]Dry run — nothing changed.[/dim]\n", "\n  Dry run - nothing changed.\n")
            return 0
        if not args.yes:
            try:
                if input("\n  Proceed? [y/N] ").strip().lower() not in ("y", "yes"):
                    _print(console, "  Cancelled.", "  Cancelled.")
                    return 1
            except (EOFError, KeyboardInterrupt):
                _print(console, "\n  Cancelled.", "\n  Cancelled.")
                return 1

        apply_plan(plan, force=args.force)
        _print(console, f"\n  [green]✓[/green] Installed [bold]{manifest.name}[/bold] "
                        f"({len(plan.installable)} items)\n",
               f"\n  Installed {manifest.name} ({len(plan.installable)} items)\n")
        if any(i.kind == "mcp" for i in plan.installable):
            _print(console, "  [dim]Restart Eternal to pick up the new MCP servers.[/dim]\n",
                   "  Restart Eternal to pick up the new MCP servers.\n")
        return 0

    _print(console, "Usage: eternal pack {install,list,show,remove,create}",
           "Usage: eternal pack {install,list,show,remove,create}")
    return 1
