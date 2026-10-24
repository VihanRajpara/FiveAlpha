"""Builds every rendered logo the app ships, from the artwork in `assets/`.

    python scripts/icons.py

Two kinds of output:

* `public/brand/*.png` — alpha-only masks of each lockup. The page paints them
  in its own ink through `mask-image`, so one file serves both themes.
* `public/icon-*.png`, favicon, apple-touch — the installed-app icon: the SA
  monogram in newsprint cream on a warm-ink tile, with the amber rule the app
  uses to mark a section. Same three colours as the interface.

Pillow rather than sharp, because sharp wants Node >=20 and this project is
pinned to 18.
"""
from PIL import Image, ImageDraw

SOURCE = 'assets/logo-monogram.png'  # the mark the shortcut/app icon carries
FILL = 0.78     # the mark's share of the tile — the usual app-icon inset
SATURATION = 28  # a pixel this colourful is the mark, not the paper or its shadow
SS = 4          # supersample the corner mask, so the radius is not stair-stepped
RADIUS = 0.235  # of the tile's width — the squircle iOS and Android both expect
MASKABLE = 0.86  # the mark's share of a maskable tile, inside the 80% safe circle

FLOOR = 10      # a pixel this dark is the black paper, not the mark's edge
MASK_W = 600    # the stacked mark shows at ≤190px; 600 is 3x with room

_squared = None


# ---------- brand masks ----------

def brandmask(src, dst):
    """The artwork as a white-on-transparent PNG: the mark is bright and the
    paper is black, so its own luminance is the alpha channel."""
    art = Image.open(src).convert('L')
    peak = art.getextrema()[1]
    alpha = art.point(lambda v: 0 if v < FLOOR else min(255, round(v * 255 / peak)))
    alpha = alpha.crop(alpha.getbbox())
    if alpha.width > MASK_W:
        alpha = alpha.resize((MASK_W, round(alpha.height * MASK_W / alpha.width)),
                             Image.LANCZOS)
    white = Image.new('L', alpha.size, 255)
    # Lossless WebP: the alpha edge is the whole image, and it is a third the
    # size of the PNG it replaces.
    Image.merge('RGBA', (white, white, white, alpha)).save(dst, 'WEBP', lossless=True, method=6)
    print(f'{dst}  {alpha.width}x{alpha.height}  aspect-ratio: '
          f'{alpha.width / alpha.height:.3f}')


# ---------- app icon ----------

INK = (27, 25, 21)       # --on-surface, light theme: the tile
CREAM = (237, 233, 225)  # --on-surface, dark theme: the mark
AMBER = (242, 170, 69)   # --primary, dark theme: the rule under it


def squared():
    """The monogram mask, printed cream on an ink square with an amber rule
    beneath it, the pair centred as one group. Computed once at a large size;
    every icon below is a resize of it."""
    global _squared
    if _squared is not None:
        return _squared

    mask = Image.open('public/brand/monogram.webp').split()[-1]
    side = round(mask.width / FILL)
    rule_h = round(side * 0.04)
    rule_gap = round(side * 0.075)
    group_h = mask.height + rule_gap + rule_h
    out = Image.new('RGB', (side, side), INK)
    x = (side - mask.width) // 2
    y = (side - group_h) // 2
    out.paste(Image.new('RGB', mask.size, CREAM), (x, y), mask)
    rule_w = round(side * 0.2)
    ry = y + mask.height + rule_gap
    ImageDraw.Draw(out).rectangle([x, ry, x + rule_w, ry + rule_h - 1], fill=AMBER)
    _squared = out
    return out


def tile(size, rounded=True, scale=1.0):
    art = squared()
    if scale == 1.0:
        img = art.resize((size, size), Image.LANCZOS)
    else:
        inner = round(size * scale)
        img = Image.new('RGB', (size, size), art.getpixel((2, 2)))
        img.paste(art.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2,) * 2)

    if not rounded:
        return img.convert('RGBA')

    out = img.convert('RGBA')
    # No outline: against a light page the ink tile has shape of its own, and a
    # light ring at 16px would be a third of the icon.
    mask = Image.new('L', (size * SS,) * 2, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * SS - 1, size * SS - 1],
                                           radius=RADIUS * size * SS, fill=255)
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


if __name__ == '__main__':
    # Header at ≥481px, small-phone header, and the loading screen respectively.
    brandmask('assets/logo-horizontal.png', 'public/brand/lockup.webp')
    brandmask('assets/logo-monogram.png', 'public/brand/monogram.webp')
    brandmask('assets/logo-stacked.png', 'public/brand/stacked.webp')

    tile(180).save('public/apple-touch-icon.png')
    tile(192).save('public/icon-192.png')
    tile(512).save('public/icon-512.png')
    # Maskable: full bleed, mark pulled in so a circular crop cannot clip it.
    tile(512, rounded=False, scale=MASKABLE).save('public/icon-512-maskable.png')
    tile(256).save('public/favicon.ico',
                   sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
                   append_images=[tile(128), tile(64), tile(48), tile(32), tile(16)])
    print('icons written')
