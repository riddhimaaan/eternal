#!/usr/bin/env python3
"""Replay the Hermes -> ETERNAL rebrand over a source tree.

Derived empirically from the original rebrand commit (3ccc6e6ad) so the
transformation is repeatable against any future upstream snapshot instead of
being a one-off hand edit.

The transformation is a case-preserving substring swap of "hermes" -> "eternal"
in three casings (lower / Title / UPPER), with a protected list that must stay
untouched: upstream URLs, the Nous model family names, and contributor records.
Renaming a model name would silently break model routing, which is why the
protection list exists and why this script is validated against the known-good
fork tree before use.

Usage:
    rebrand-to-eternal.py --root <tree> [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

# ---------------------------------------------------------------------------
# Protected patterns — matched BEFORE substitution and restored afterwards.
# Order matters: longer / more specific patterns first.
# ---------------------------------------------------------------------------
PROTECTED = [
    # Whole URLs into upstream Nous properties. The narrower host and repo
    # patterns below only protect the part they match, so the *path* after them
    # still got rebranded — producing links that resolve to a real site but a
    # page or file that never existed there (docs/guides/build-a-eternal-plugin,
    # hermes-agent/blob/main/eternal_cli/commands.py). Protect the whole URL.
    # The character class stops at Markdown and quoting delimiters so a link in
    # `[text](url)` or `"url"` does not swallow its terminator.
    r"https?://hermes-agent\.nousresearch\.com/[^\s)\]\"'`<>]*",
    r"https?://(?:raw\.githubusercontent|github)\.com/NousResearch/hermes-agent/[^\s)\]\"'`<>]*",
    # Any Nous-owned identifier: GitHub repositories, Docker images, and
    # HuggingFace datasets under the NousResearch org. We do not own that
    # namespace, so renaming inside it invents repositories that do not exist
    # (e.g. the plugin index and the example-plugins repo the installer reads).
    # Listed first so the longest Nous-owned name wins over the narrower
    # hermes-agent entries below.
    r"NousResearch/[A-Za-z0-9._-]*[Hh]ermes[A-Za-z0-9._-]*",
    r"nousresearch/[A-Za-z0-9._-]*hermes[A-Za-z0-9._-]*",
    # Upstream repository and install endpoints. These are real, live URLs.
    r"NousResearch/hermes-agent",
    r"nousresearch/hermes-agent",
    r"hermes-agent\.nousresearch\.com",
    r"github\.com/NousResearch/hermes-agent",
    # The Nous model family. Renaming these breaks model selection outright.
    r"[Hh]ermes-4-405[Bb]",
    r"[Hh]ermes-4-70[Bb]",
    r"[Hh]ermes-4-14[Bb]",
    r"[Hh]ermes-4",
    r"[Hh]ermes-3-llama-3\.1-70[Bb]",
    r"[Hh]ermes-3-llama-3\.1-405[Bb]",
    r"[Hh]ermes-3-llama-3\.1-8[Bb]",
    r"[Hh]ermes-3",
    r"[Hh]ermes-2-pro",
    r"[Hh]ermes-2",
    r"[Hh]ermes-0day",
    # Model families written with a space, and prose naming them. These appear
    # in the "these models are not agentic" warnings, where renaming them would
    # make the warning refer to a model that does not exist.
    r"Nous Research Hermes 3 & 4",
    r"Nous Research [Hh]ermes",
    r"Nous [Hh]ermes",
    r"[Hh]ermes 3 & 4",
    r"[Hh]ermes 3",
    r"[Hh]ermes 4",
    r"nous[-_]hermes",
    r"Nous[-_]Hermes",
    r"NousHermes",
    r"hermes3",
    r"[Hh]ermes-brain",
    # The engine ETERNAL is built on, named as prose in the system prompt.
    r"Hermes Agent engine",
    # Titles of upstream documentation pages we link out to. These name a page
    # on Nous's site, so they must keep its title — and "a Eternal Plugin" is
    # not English either.
    r"Build a Hermes Plugin",
    # The non-agentic model detector. This regex must keep matching real Hermes
    # 3/4 model names; renaming it silently disables the warning.
    r"_NOUS_HERMES_NON_AGENTIC_RE",
    r"nous_hermes_non_agentic",
    r"hermes\[-_ \]\?\[34\]",
    r"hermes\[-_ \]\?\[34\]\(\?:",
    # Real contributor machine/email identifiers.
    r"@hermes\.local",
    r"pi@hermes",
    r"agent@hermes",
    # Test fixture identifiers that encode the literal string.
    # The bare model-family token in the edit-format table. It sits in a list of
    # families (claude / gemini / qwen / hermes / llama ...), so renaming it stops
    # Hermes models matching and silently changes the guidance they are given.
    r'"hermes", "llama"',
    # Fixtures for the non-agentic detector: these must stay real Hermes model
    # ids or the test asserts against names no model ever had.
    r"hermes_4_70b",
    r"hermes2-pro",
    r"hermes-3a7b9c14d2e8",
    r"hermes-7d4f9c8b-2026",
    r"hermes-123",
    r"brain-hermes-3-impostor",
    r"FP16_Hermes_4\.5",
    r"_hermes_0day_entry",
    r"\.mount_Hermes",
]

# NOTE: "hermes-cli" is deliberately NOT protected. It is used for two unrelated
# things: the internal default toolset name (correctly renamed to "eternal-cli"),
# and the OAuth client_id sent to Nous Portal (which arguably should have stayed
# "hermes-cli"). The original rebrand renamed both; this script reproduces that
# faithfully. See eternal_cli/auth.py DEFAULT_NOUS_CLIENT_ID.

# Files whose content is never rewritten (identity records, lockfiles, binaries).
SKIP_CONTENT = {
    # This script. It quotes both names by necessity, so rewriting it turns
    # every rule into "eternal" -> "eternal" and destroys the tool.
    "rebrand-to-eternal.py",
    ".mailmap",
    "package-lock.json",
    "uv.lock",
    "flake.lock",
}
SKIP_DIRS = {
    ".git",
    "node_modules",
    "venv",
    ".venv",
    "__pycache__",
    "contributors",
    ".pytest-cache",
    # Generated caches and build metadata. pytest's real directory is spelled
    # with an underscore, so the hyphenated entry above never matched it.
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    "eternal_agent.egg-info",
    "release",
    "linux-unpacked",
    "dist",
}
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".woff", ".woff2",
    ".ttf", ".otf", ".zip", ".gz", ".db", ".so", ".dylib", ".exe", ".webp",
    ".mp4", ".mp3", ".wav", ".bin", ".node", ".wasm",
}

_PROTECT_RE = re.compile("|".join(f"(?:{p})" for p in PROTECTED))
_SENTINEL = "\x00PROT{}\x00"


def substitute(text: str) -> str:
    """Case-preserving hermes -> eternal, honouring the protected list."""
    saved: list[str] = []

    def stash(m: re.Match) -> str:
        saved.append(m.group(0))
        return _SENTINEL.format(len(saved) - 1)

    text = _PROTECT_RE.sub(stash, text)

    text = text.replace("HERMES", "ETERNAL")
    text = text.replace("Hermes", "Eternal")
    text = text.replace("hermes", "eternal")
    # Mixed-case identifiers that the three passes above do not reach.
    text = text.replace("HERMes", "ETERNal")

    for i, original in enumerate(saved):
        text = text.replace(_SENTINEL.format(i), original)
    return text


def rename_path(path: str) -> str:
    """Apply the same swap to a single path component.

    Goes through ``substitute`` so the protected list applies to filenames too:
    ``test_nous_hermes_non_agentic.py`` names a protected identifier, and
    renaming the file leaves it describing a detector that no longer exists.
    """
    return substitute(path)


def should_skip_dir(name: str) -> bool:
    return name in SKIP_DIRS


def is_binary(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in BINARY_EXT


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 2

    edited = renamed = 0

    # ---- Pass 1: file contents -------------------------------------------
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not should_skip_dir(d)]
        for fn in filenames:
            if fn in SKIP_CONTENT or is_binary(fn):
                continue
            full = os.path.join(dirpath, fn)
            if os.path.islink(full):
                continue
            try:
                with open(full, "r", encoding="utf-8") as fh:
                    original = fh.read()
            except (UnicodeDecodeError, OSError):
                continue
            if "hermes" not in original.lower():
                continue
            updated = substitute(original)
            if updated != original:
                edited += 1
                if not args.dry_run:
                    with open(full, "w", encoding="utf-8") as fh:
                        fh.write(updated)

    # ---- Pass 2: paths (deepest first so parents stay valid) -------------
    targets: list[tuple[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        if any(should_skip_dir(p) for p in dirpath.split(os.sep)):
            continue
        for name in filenames + dirnames:
            if "hermes" not in name.lower():
                continue
            src = os.path.join(dirpath, name)
            dst = os.path.join(dirpath, rename_path(name))
            if src != dst:
                targets.append((src, dst))

    for src, dst in targets:
        renamed += 1
        if args.dry_run:
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        # Use git mv inside a repo so history/rename detection stays clean.
        rc = subprocess.run(
            ["git", "-C", root, "mv", os.path.relpath(src, root), os.path.relpath(dst, root)],
            capture_output=True,
        ).returncode
        if rc != 0:
            os.rename(src, dst)

    verb = "would edit" if args.dry_run else "edited"
    verb2 = "would rename" if args.dry_run else "renamed"
    print(f"{verb} {edited} files, {verb2} {renamed} paths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
