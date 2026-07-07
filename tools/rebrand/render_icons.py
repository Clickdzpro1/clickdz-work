#!/usr/bin/env python3
"""ClickDz Work icon factory.

Renders the full desktop + web icon set from the REAL ClickDZ logo SVGs
(extracted from clickdz.ai). Grounded assets only — no invented artwork.

Usage:  python3 render_icons.py <brand_dir> <out_dir>
  brand_dir must contain logo.svg (color) and logo-white.svg (white fills)

Outputs (per build variant stable/beta/canary/internal):
  icon_<v>.png (2048)  icon_<v>_512x512.png  icon_<v>_64x64.png
  icon_<v>.ico (16..256)  icon_<v>.icns (1024)
  (stable also written as icon.png / icon.ico / icon.icns)
Plus: dmg-background.png (610x365) + @2x, web favicon.ico,
      favicon-192.png, favicon-512.png, preview.png (approval grid)

Brand tokens (from clickdz.ai live site 2026-07-07):
  primary #2B7FFF | accent(sky) #0EA5E9 | logo blue #1D4ED8
  deep navy #0B1F3B | dark slate hsl(215,25%,20%) -> #263440
"""
import io
import sys
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw

PRIMARY = (43, 127, 255)      # #2B7FFF
SKY = (14, 165, 233)          # #0EA5E9
LOGO_BLUE = (29, 78, 216)     # #1D4ED8
NAVY = (11, 31, 59)           # #0B1F3B
SLATE = (38, 52, 64)          # #263440  hsl(215 25% 20%)
LIGHT_A = (255, 255, 255)
LIGHT_B = (240, 246, 252)     # hero gradient light blue-white

MASTER = 2048


def svg_to_png(svg_path: Path, size: int) -> Image.Image:
    data = cairosvg.svg2png(url=str(svg_path), output_width=size,
                            output_height=size)
    return Image.open(io.BytesIO(data)).convert("RGBA")


def diag_gradient(size: int, c1, c2) -> Image.Image:
    """135deg linear gradient, built small then upscaled (visually exact)."""
    n = 128
    base = Image.new("RGB", (n, n))
    px = base.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            px[x, y] = tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))
    return base.resize((size, size), Image.BICUBIC).convert("RGBA")


def rounded_mask(size: int, radius_pct: float = 0.223) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1],
                        radius=int(size * radius_pct), fill=255)
    return m


def make_tile(size: int, bg: Image.Image, mark: Image.Image,
              mark_scale: float = 0.66) -> Image.Image:
    tile = bg.copy()
    ms = int(size * mark_scale)
    mark = mark.resize((ms, ms), Image.LANCZOS)
    pos = ((size - ms) // 2, (size - ms) // 2)
    tile.paste(mark, pos, mark)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(tile, (0, 0), rounded_mask(size))
    return out


def save_variant(out: Path, name: str, master: Image.Image):
    master.save(out / f"icon_{name}.png")
    master.resize((512, 512), Image.LANCZOS).save(
        out / f"icon_{name}_512x512.png")
    master.resize((64, 64), Image.LANCZOS).save(
        out / f"icon_{name}_64x64.png")
    ico_base = master.resize((256, 256), Image.LANCZOS)
    ico_base.save(out / f"icon_{name}.ico", format="ICO",
                  sizes=[(16, 16), (32, 32), (48, 48), (64, 64),
                         (128, 128), (256, 256)])
    master.resize((1024, 1024), Image.LANCZOS).save(
        out / f"icon_{name}.icns", format="ICNS")


def main(brand_dir: str, out_dir: str):
    brand, out = Path(brand_dir), Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    mark_color = svg_to_png(brand / "logo.svg", MASTER)
    mark_white = svg_to_png(brand / "logo-white.svg", MASTER)

    variants = {
        "stable": (diag_gradient(MASTER, LIGHT_A, LIGHT_B), mark_color),
        "beta": (diag_gradient(MASTER, PRIMARY, SLATE), mark_white),
        "canary": (diag_gradient(MASTER, SKY, PRIMARY), mark_white),
        "internal": (Image.new("RGBA", (MASTER, MASTER), NAVY + (255,)),
                     mark_white),
    }

    tiles = {}
    for name, (bg, mark) in variants.items():
        tile = make_tile(MASTER, bg, mark)
        tiles[name] = tile
        save_variant(out, name, tile)

    # stable also ships as the unsuffixed files
    for ext in ("png", "ico", "icns"):
        (out / f"icon.{ext}").write_bytes(
            (out / f"icon_stable.{ext}").read_bytes())
    (out / "icon_512x512.png").write_bytes(
        (out / "icon_stable_512x512.png").read_bytes())
    (out / "icon_64x64.png").write_bytes(
        (out / "icon_stable_64x64.png").read_bytes())

    # dmg backgrounds: light hero gradient + right-side watermark mark
    for scale, fname in ((1, "dmg-background.png"),
                         (2, "dmg-background@2x.png")):
        w, h = 610 * scale, 365 * scale
        bg = diag_gradient(max(w, h), LIGHT_A, LIGHT_B).crop((0, 0, w, h))
        wm = mark_color.resize((int(h * 0.72),) * 2, Image.LANCZOS)
        faint = wm.copy()
        faint.putalpha(wm.split()[3].point(lambda a: int(a * 0.14)))
        bg.paste(faint, (w - int(h * 0.82), int(h * 0.14)), faint)
        bg.convert("RGB").save(out / fname)

    # web favicons from the stable tile (exact AFFiNE public/ file set)
    fav = tiles["stable"]
    for s in (32, 36, 48, 72, 96, 144, 192, 512):
        fav.resize((s, s), Image.LANCZOS).save(out / f"favicon-{s}.png")
    fav.resize((180, 180), Image.LANCZOS).save(out / "apple-touch-icon.png")
    fav.resize((256, 256), Image.LANCZOS).save(
        out / "favicon.ico", format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)])

    # system tray icon (54x54 RGBA, mark only, matches upstream dims)
    mark_color.resize((54, 54), Image.LANCZOS).save(out / "tray-icon.png")

    # NSIS installer sidebar (328x628 RGB BMP): brand gradient + white mark
    sw, sh = 328, 628
    side = diag_gradient(sh, NAVY, PRIMARY).crop((0, 0, sw, sh))
    sm = mark_white.resize((int(sw * 0.62),) * 2, Image.LANCZOS)
    side.paste(sm, ((sw - sm.width) // 2, int(sh * 0.16)), sm)
    side.convert("RGB").save(out / "nsis-sidebar.bmp", format="BMP")

    # approval preview grid
    cell, pad = 256, 24
    grid = Image.new("RGBA", (4 * cell + 5 * pad, cell + 2 * pad),
                     (245, 247, 250, 255))
    for i, name in enumerate(("stable", "beta", "canary", "internal")):
        t = tiles[name].resize((cell, cell), Image.LANCZOS)
        grid.paste(t, (pad + i * (cell + pad), pad), t)
    grid.convert("RGB").save(out / "preview.png")
    print("DONE:", len(list(out.iterdir())), "files ->", out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "brand",
         sys.argv[2] if len(sys.argv) > 2 else "rebrand/out")
