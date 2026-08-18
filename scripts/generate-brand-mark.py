#!/usr/bin/env python3
"""Generate every copy of the Eternal brand mark from one definition.

The mark is a chevron drawn as a dot matrix that dissolves toward its tips.
It is generated rather than stored as artwork so that every size — a 32px
tray icon, a 1024px app icon, a badge inside the app — is crisp, and so that
changing the mark means editing the numbers below rather than re-cutting a
dozen files.

Run with no arguments to rewrite all of them:

    python3 scripts/generate-brand-mark.py

Pure standard library for the SVGs. Rasterising needs ``rsvg-convert`` and
ImageMagick, which are only required when regenerating the icons.
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import pathlib
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

# --- the mark ---------------------------------------------------------------
# Geometry lives in a unit square around the chevron: tips on the left edge,
# outer apex at the right edge, apex centred vertically.
THICKNESS = 0.30  # arm thickness, measured horizontally
PADDING = 0.11  # breathing room around the mark inside its tile

# The dot matrix.
COLUMNS = 46  # dots across the mark at full size
DOT = 0.58  # dot edge as a fraction of the grid pitch
DISSOLVE = 0.60  # the sparse tips resolve into solid by this fraction across
GAMMA = 0.62  # below 1 keeps the sparse end alive longer

BLACK = "#000000"
WHITE = "#ffffff"
CORNER = 0.22  # icon tile corner radius, as a fraction of its side


def chevron(side: float) -> list[tuple[float, float]]:
    """The six vertices of the chevron inside a ``side`` x ``side`` box."""
    slope = 0.5  # tip to apex across the full width
    t = THICKNESS * side
    drop = slope * t  # how far the inner edge sits below the outer one
    return [
        (0.0, 0.0),
        (side, side / 2),
        (0.0, side),
        (0.0, side - drop),
        (side - t, side / 2),
        (0.0, drop),
    ]


def inside(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    """Ray casting. The chevron is concave, so a convexity shortcut won't do."""
    hit = False
    j = len(poly) - 1
    for i, (xi, yi) in enumerate(poly):
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def dither(col: int, row: int) -> float:
    """A stable pseudo-random value, so the mark never shifts between runs."""
    digest = hashlib.blake2b(b"%d:%d" % (col, row), digest_size=8).digest()
    return int.from_bytes(digest, "big") / 2**64


def dots(side: float, columns: int) -> list[tuple[float, float, float]]:
    poly = chevron(side)
    pitch = side / columns
    out = []
    for col in range(columns + 1):
        for row in range(int(side / pitch) + 2):
            x = (col + 0.5) * pitch
            y = (row + 0.5) * pitch
            if not inside(x, y, poly):
                continue
            density = min(1.0, max(0.0, (x / side) / DISSOLVE)) ** GAMMA
            if dither(col, row) > density:
                continue
            out.append((x, y, pitch * DOT))
    return out


def svg(size: int, *, tile: str | None, fg: str = WHITE, solid: bool = False,
        columns: int = COLUMNS) -> str:
    """One square SVG. ``tile`` paints a rounded background; None leaves it clear."""
    side = size * (1 - 2 * PADDING)
    off = (size - side) / 2
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" '
        f'height="{size}" viewBox="0 0 {size} {size}">'
    ]
    if tile:
        r = size * CORNER
        parts.append(
            f'<rect width="{size}" height="{size}" rx="{r:.2f}" ry="{r:.2f}" '
            f'fill="{tile}"/>'
        )
    if solid:
        # Below roughly 48px the matrix turns to mush; a filled chevron reads.
        pts = " ".join(f"{off + x:.2f},{off + y:.2f}" for x, y in chevron(side))
        parts.append(f'<polygon points="{pts}" fill="{fg}"/>')
    else:
        parts.append(f'<g fill="{fg}">')
        for x, y, d in dots(side, columns):
            parts.append(
                f'<rect x="{off + x - d / 2:.2f}" y="{off + y - d / 2:.2f}" '
                f'width="{d:.2f}" height="{d:.2f}"/>'
            )
        parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts)


def label(path: pathlib.Path) -> str:
    """Repo-relative where possible, so the output stays readable."""
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


def banner(width: int = 1145, height: int = 196, left: float | None = None) -> str:
    """The README banner: the mark, then the wordmark, on black.

    Rasterised to PNG, so the typeface is baked in and nothing depends on the
    reader having it installed. ``left`` positions the lockup; the caller
    measures a first pass and passes the offset that centres it, because the
    width of set text is not knowable up front.
    """
    side = height * 0.62
    x = height * 0.30 if left is None else left
    y = (height - side) / 2
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" '
        f'height="{height}" viewBox="0 0 {width} {height}">',
        f'<rect width="{width}" height="{height}" fill="{BLACK}"/>',
        f'<g transform="translate({x:.2f},{y:.2f})" fill="{WHITE}">',
    ]
    for dx, dy, d in dots(side, 26):
        parts.append(f'<rect x="{dx - d / 2:.2f}" y="{dy - d / 2:.2f}" '
                     f'width="{d:.2f}" height="{d:.2f}"/>')
    parts.append("</g>")
    parts.append(
        f'<text x="{x + side * 1.55:.2f}" y="{height * 0.5:.2f}" '
        f'dominant-baseline="central" fill="{WHITE}" '
        f'font-family="Fira Sans, DejaVu Sans, sans-serif" '
        f'font-size="{height * 0.42:.2f}" font-weight="300" '
        f'letter-spacing="{height * 0.13:.2f}">ETERNAL</text>'
    )
    parts.append("</svg>")
    return "\n".join(parts)


def variant(size: int) -> dict:
    """How to draw the mark at a given pixel size.

    The dot matrix stops reading once a dot is a couple of pixels across, so
    small icons get a filled chevron instead and mid sizes get a coarser grid.
    """
    if size <= 64:
        return {"solid": True}
    if size < 256:
        return {"columns": 30}
    return {}


def need(tool: str) -> str:
    found = shutil.which(tool)
    if not found:
        sys.exit(f"{tool} is required to rasterise the icons; install it first")
    return found


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(f"  {label(path)}")


def png(path: pathlib.Path, size: int, quiet: bool = False, **kw) -> None:
    src = path.with_suffix(".tmp.svg")
    src.write_text(svg(size, **kw), encoding="utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [need("rsvg-convert"), "-w", str(size), "-h", str(size),
         str(src), "-o", str(path)],
        check=True,
    )
    src.unlink()
    if not quiet:
        print(f"  {label(path)}")


# ICNS entry types that take a PNG payload, mapped to their pixel size.
ICNS_TYPES = [
    (b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128),
    (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024),
]


def icns(target: pathlib.Path, render) -> None:
    """Write a real macOS icon.

    ImageMagick will happily accept ``icon.icns`` as an output name and write a
    plain PNG into it, which is what shipped here before. The container is
    simple enough to build directly: a header, then one length-prefixed PNG per
    size.
    """
    chunks = []
    for kind, size in ICNS_TYPES:
        part = target.parent / f".icns-{size}.png"
        render(part, size)
        data = part.read_bytes()
        part.unlink()
        chunks.append(kind + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)
    target.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)
    print(f"  {label(target)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--preview", metavar="PATH",
                    help="write a single wide preview PNG and stop")
    args = ap.parse_args()

    if args.preview:
        png(pathlib.Path(args.preview), 512, tile=BLACK)
        return

    desktop = REPO / "apps/desktop"
    installer = REPO / "apps/bootstrap-installer"

    print("brand glyph (transparent, for in-app use)")
    glyph = svg(512, tile=None)
    write(desktop / "public/eternal-mark.svg", glyph)
    write(installer / "public/eternal-mark.svg", glyph)

    print("readme banner")
    src = REPO / "assets/banner.tmp.svg"
    out = REPO / "assets/banner.png"
    rsvg, magick = need("rsvg-convert"), need("magick")

    def render(left=None):
        src.write_text(banner(left=left), encoding="utf-8")
        subprocess.run([rsvg, "-w", "1145", "-h", "196", str(src),
                        "-o", str(out)], check=True)

    render()
    # Measure the ink, then lay it out again centred on that measurement.
    box = subprocess.run([magick, str(out), "-trim", "-format", "%w %X",
                          "info:"], capture_output=True, text=True, check=True)
    ink_w, ink_x = (int(v.lstrip("+")) for v in box.stdout.split())
    render(left=(196 * 0.30) + (1145 - ink_w) / 2 - ink_x)
    src.unlink()
    print(f"  {label(out)}")

    print("desktop app icon")
    png(desktop / "assets/icon.png", 1024, tile=BLACK)
    png(desktop / "public/apple-touch-icon.png", 1024, tile=BLACK)

    print("installer icons")
    for size in (32, 128, 256):
        name = {32: "32x32.png", 128: "128x128.png", 256: "128x128@2x.png"}[size]
        png(installer / "src-tauri/icons" / name, size, tile=BLACK,
            **variant(size))

    print("windows and macos bundles")
    magick = need("magick")
    scratch = REPO / "apps/desktop/assets"
    ico_parts = []
    for size in (16, 32, 48, 64, 128, 256):
        part = scratch / f".ico-{size}.png"
        png(part, size, tile=BLACK, **variant(size))
        ico_parts.append(part)
    for target in (desktop / "assets/icon.ico",
                   installer / "src-tauri/icons/icon.ico"):
        subprocess.run([magick, *map(str, ico_parts), str(target)], check=True)
        print(f"  {label(target)}")
    def render(part: pathlib.Path, size: int) -> None:
        png(part, size, tile=BLACK, quiet=True, **variant(size))

    for target in (desktop / "assets/icon.icns",
                   installer / "src-tauri/icons/icon.icns"):
        icns(target, render)
    for part in ico_parts:
        part.unlink()


if __name__ == "__main__":
    main()
