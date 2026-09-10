"""
Brand asset builder for IPO India.

Renders the logo master (assets/logo-source.png — growth chart + rocket
mark, navy→green on white) into every raster brand asset the site needs:

    public/icons/icon-192.png            PWA manifest icon (any)
    public/icons/icon-512.png            PWA manifest icon (any)
    public/icons/icon-maskable-192.png   PWA manifest icon (maskable)
    public/icons/icon-maskable-512.png   PWA manifest icon (maskable)
    public/icons/icon-180.png            apple-touch-icon
    public/icons/logo-mark.png           transparent mark for the header badge
    public/favicon.png                   64px white rounded badge

The artwork is designed against white, so transparent variants are made by
un-blending it from white (alpha = 1 − min(R,G,B)/255). That keeps the
anti-aliased edges smooth without eating the white cut-outs that are part
of the design — those only matter over non-white chips, and every chip this
pipeline feeds is white.

Requires Pillow + numpy:  pip install pillow numpy
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "logo-source.png"
OUT = ROOT / "public"

WHITE = (255, 255, 255)


def unblend_from_white(img: Image.Image) -> Image.Image:
    """RGBA copy of `img` with its white background turned into smooth alpha."""
    px = np.asarray(img.convert("RGBA")).astype(np.float64)
    rgb, src_alpha = px[..., :3], px[..., 3]
    alpha = 255.0 - rgb.min(axis=-1)  # distance from pure white, per pixel
    alpha = np.minimum(alpha, src_alpha)  # never exceed source opacity
    safe = np.maximum(alpha, 1e-6)
    # Un-premultiply against white: C' = (C − (1 − a)·255) / a, with a in 0..1
    unpre = (rgb - (255.0 - alpha)[..., None]) / (safe[..., None] / 255.0)
    out = np.dstack([np.clip(unpre, 0.0, 255.0), alpha]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def tight(art: Image.Image) -> Image.Image:
    """Trim near-transparent margins so the mark fills its box evenly."""
    a = np.asarray(art)[..., 3]
    ys, xs = np.where(a > 32)  # bg ghosts unblend to alpha < ~20
    return art.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def scaled(art: Image.Image, box: int) -> Image.Image:
    """Longest side scaled to `box` px, aspect preserved."""
    w, h = art.size
    k = box / max(w, h)
    return art.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)


def centered(canvas: Image.Image, art: Image.Image) -> None:
    canvas.paste(
        art,
        ((canvas.width - art.width) // 2, (canvas.height - art.height) // 2),
        art,
    )


def on_opaque(size: int, box_frac: float) -> Image.Image:
    """Square icon: opaque white background, logo centered."""
    canvas = Image.new("RGB", (size, size), WHITE)
    centered(canvas, scaled(ART, round(size * box_frac)))
    return canvas


def on_rounded(size: int, box_frac: float, radius_frac: float) -> Image.Image:
    """Favicon-style badge: white rounded square, transparent corners."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=round(size * radius_frac), fill=WHITE
    )
    centered(canvas, scaled(ART, round(size * box_frac)))
    return canvas


def transparent_mark(size: int, box_frac: float) -> Image.Image:
    """Art only — CSS supplies the white chip in the header badge."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    art = scaled(ART, round(size * box_frac))
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return canvas


def main() -> None:
    targets = [
        ("icons/icon-192.png", lambda s: on_opaque(s, 0.74), 192),
        ("icons/icon-512.png", lambda s: on_opaque(s, 0.74), 512),
        # Maskable safe zone: the mark must survive a circular mask, so keep it
        # inside a centered circle of radius 40% (54% box leaves corner margin).
        ("icons/icon-maskable-192.png", lambda s: on_opaque(s, 0.54), 192),
        ("icons/icon-maskable-512.png", lambda s: on_opaque(s, 0.54), 512),
        ("icons/icon-180.png", lambda s: on_opaque(s, 0.74), 180),  # apple-touch
        ("icons/logo-mark.png", lambda s: transparent_mark(s, 0.98), 128),
        ("favicon.png", lambda s: on_rounded(s, 0.66, 0.22), 64),
    ]
    for rel, render, size in targets:
        dest = OUT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        render(size).save(dest, optimize=True)
        print(f"wrote {dest.relative_to(ROOT)} ({dest.stat().st_size:,} bytes)")


if __name__ == "__main__":
    ART = tight(unblend_from_white(Image.open(SRC)))
    print(f"logo master: {SRC.name} -> art {ART.width}x{ART.height}")
    main()
