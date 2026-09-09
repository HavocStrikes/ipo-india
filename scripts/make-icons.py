#!/usr/bin/env python3
"""Icon generator for the IPO India PWA (dev tool — not part of the runtime).

Renders the brand mark (indigo→violet gradient rounded square with a white ₹,
same design as the inline SVG favicon) into the PNG sizes the web app manifest
needs. Requires Pillow:  pip install pillow

Usage:  python3 scripts/make-icons.py
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "icons")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

GRAD_A = (99, 102, 241)   # #6366f1 indigo-500  (top-left)
GRAD_B = (167, 139, 250)  # #a78bfa violet-400  (bottom-right)
SS = 4                    # supersample factor for crisp, anti-aliased edges

os.makedirs(OUT, exist_ok=True)


def gradient(size: int) -> Image.Image:
    """Diagonal indigo→violet gradient, built at C speed from two 1-D ramps."""
    gy = Image.linear_gradient("L").resize((size, size), Image.BILINEAR)  # top→bottom
    gx = gy.transpose(Image.ROTATE_90)                                    # left→right
    t = Image.blend(gy, gx, 0.5)                                          # average = diagonal
    # Make sure A sits top-left and B bottom-right (ROTATE_90 may mirror it).
    if t.getpixel((2, 2)) > t.getpixel((size - 3, size - 3)):
        t = t.transpose(Image.ROTATE_180)
    solid_a = Image.new("RGB", (size, size), GRAD_A)
    solid_b = Image.new("RGB", (size, size), GRAD_B)
    return Image.composite(solid_b, solid_a, t)


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def rupee_font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


def has_rupee_glyph(font: ImageFont.FreeTypeFont) -> bool:
    try:
        return bool(font.getmask("\u20b9").getbbox())
    except OSError:
        return False


def draw_rupee_fallback(draw: ImageDraw.ImageDraw, ss: int) -> None:
    """Vector ₹ drawn from strokes, used only if the font lacks U+20B9."""
    w = max(4, round(ss * 0.042))
    x0, x1 = ss * 0.28, ss * 0.72
    ytop, ymid, ybot = ss * 0.24, ss * 0.46, ss * 0.76
    draw.line([x0, ytop, x1, ytop], fill="white", width=w)          # top bar
    draw.line([x0, ytop, x0, ybot], fill="white", width=w)          # left stem
    draw.line([x0, ymid, x1, ymid], fill="white", width=w)          # middle bar
    draw.line([x0, ymid, ss * 0.66, ybot], fill="white", width=w)   # diagonal leg
    draw.line([x0, ybot, ss * 0.66, ybot], fill="white", width=w)   # foot


def make_icon(size: int, maskable: bool = False) -> Image.Image:
    ss = size * SS
    if maskable:
        # Full-bleed square; glyph kept inside the centered ~66% safe zone so
        # Android's circular/rounded masks never clip it.
        canvas = gradient(ss).convert("RGBA")
        glyph_frac, radius = 0.38, 0
    else:
        radius = round(ss * 0.22)  # matches the favicon's rx=16/64
        canvas = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
        canvas.paste(gradient(ss), (0, 0), rounded_mask(ss, radius))
        glyph_frac = 0.50
    draw = ImageDraw.Draw(canvas)
    font = rupee_font(round(ss * glyph_frac))
    if has_rupee_glyph(font):
        bbox = font.getbbox("\u20b9")
        x = (ss - (bbox[2] - bbox[0])) / 2 - bbox[0]
        y = (ss - (bbox[3] - bbox[1])) / 2 - bbox[1]
        draw.text((x, y), "\u20b9", font=font, fill=(255, 255, 255, 255))
    else:
        draw_rupee_fallback(draw, ss)
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-192.png", 192, True),
        ("icon-maskable-512.png", 512, True),
        ("icon-180.png", 180, False),  # apple-touch-icon
    ]
    for name, size, maskable in targets:
        img = make_icon(size, maskable)
        path = os.path.join(OUT, name)
        img.save(path, "PNG", optimize=True)
        # Round-trip check: reopen and confirm format/size.
        with Image.open(path) as check:
            assert check.format == "PNG" and check.size == (size, size), name
        print(f"  ✓ {name}  {size}x{size}  {'maskable' if maskable else 'any'}  "
              f"{os.path.getsize(path) // 1024} KB")
    print(f"Icons written to {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
