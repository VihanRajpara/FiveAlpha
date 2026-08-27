"""Builds the icon set from the FiveAlpha artwork.

`assets/logo-source.png` is the only input, and it can be the raw export at
whatever size and framing it came in: this finds the mark, squares it, and
resizes it onto a rounded tile. Drop a new file over it and rerun —

    python scripts/icons.py

Pillow rather than sharp, because sharp wants Node >=20 and this project is
pinned to 18.
"""
from PIL import Image, ImageDraw

SOURCE = 'assets/logo-source.png'
FILL = 0.80     # the mark's share of the tile — the usual app-icon inset
SATURATION = 28  # a pixel this colourful is the mark, not the paper or its shadow
SS = 4          # supersample the corner mask, so the radius is not stair-stepped
RADIUS = 0.235  # of the tile's width — the squircle iOS and Android both expect
EDGE = (0xD8, 0xDF, 0xE9)
MASKABLE = 0.86  # the mark's share of a maskable tile, inside the 80% safe circle

_squared = None


def squared():
    """The artwork, cropped to the mark and centred on a square of its own
    background. Computed once; every size below is a resize of it."""
    global _squared
    if _squared is not None:
        return _squared

    art = Image.open(SOURCE).convert('RGB')
    paper = art.getpixel((2, 2))
    px = art.load()
    x0, y0, x1, y1 = art.width, art.height, 0, 0
    for y in range(art.height):
        for x in range(art.width):
            r, g, b = px[x, y]
            if max(r, g, b) - min(r, g, b) > SATURATION:
                x0, x1 = min(x0, x), max(x1, x)
                y0, y1 = min(y0, y), max(y1, y)
    if x0 > x1:
        raise SystemExit(f'{SOURCE}: found no coloured mark to crop to')

    side = round(max(x1 - x0, y1 - y0) / FILL)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    box = [round(cx - side / 2), round(cy - side / 2)]
    # The crop can run off the edge — the export is rarely padded enough to
    # square it — so it is pasted onto a canvas of the paper colour instead.
    out = Image.new('RGB', (side, side), paper)
    out.paste(art.crop((max(0, box[0]), max(0, box[1]),
                        min(art.width, box[0] + side), min(art.height, box[1] + side))),
              (max(0, -box[0]), max(0, -box[1])))
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
    # A hairline edge, or the near-white tile has no shape of its own against a
    # white page — which is exactly where this icon sits in the app's header.
    ImageDraw.Draw(out).rounded_rectangle(
        [0.5, 0.5, size - 1.5, size - 1.5], radius=RADIUS * size,
        outline=EDGE, width=max(1, size // 128))
    mask = Image.new('L', (size * SS,) * 2, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * SS - 1, size * SS - 1],
                                           radius=RADIUS * size * SS, fill=255)
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


if __name__ == '__main__':
    tile(256).save('public/logo.png')            # the header's <img>
    tile(180).save('public/apple-touch-icon.png')
    tile(192).save('public/icon-192.png')
    tile(512).save('public/icon-512.png')
    # Maskable: full bleed, mark pulled in so a circular crop cannot clip it.
    tile(512, rounded=False, scale=MASKABLE).save('public/icon-512-maskable.png')
    tile(256).save('public/favicon.ico',
                   sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
                   append_images=[tile(128), tile(64), tile(48), tile(32), tile(16)])
    print('icons written')
