#!/usr/bin/env python3
"""Generate the NSIS installer artwork for both apps.

Writes apps/<app>/src-tauri/installer/{sidebar,header}.bmp from assets/icons/<app>.png.
Run from the repo root: python3 scripts/installer-art.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
INTER = Path("/usr/share/fonts/opentype/inter")
APPS = {
    "ytspot": ("YTSpot", "Your YouTube Music,\nin a cleaner player."),
    "plexspot": ("PLEXSpot", "Your Plex music,\nin a cleaner player."),
}
S = 4  # supersampling factor


def font(weight, size):
    return ImageFont.truetype(str(INTER / f"Inter-{weight}.otf"), size * S)


def logo(app, size):
    return Image.open(ROOT / "assets/icons" / f"{app}.png").convert("RGBA").resize((size * S, size * S), Image.LANCZOS)


def finish(im, w, h):
    return im.resize((w, h), Image.LANCZOS).convert("RGB")


def sidebar(app, name, tagline):
    w, h = 164, 314
    im = Image.new("RGB", (w * S, h * S), "#121212")
    top = (29, 185, 84)
    px = im.load()
    # Spotify-style wash: brand green fading into the dark background.
    for y in range(h * S):
        t = min(1.0, y / (h * S * 0.62))
        t = t * t * (3 - 2 * t)
        c = tuple(round(top[i] * 0.55 * (1 - t) + 18 * t) for i in range(3))
        for x in range(w * S):
            px[x, y] = c
    im = im.convert("RGBA")
    im.alpha_composite(logo(app, 56), (20 * S, 28 * S))
    d = ImageDraw.Draw(im)
    d.text((20 * S, 100 * S), name, font=font("Bold", 24), fill="white")
    d.multiline_text((20 * S, 134 * S), tagline, font=font("Regular", 11), fill=(179, 179, 179), spacing=4 * S)
    d.rounded_rectangle((20 * S, 186 * S, 44 * S, 189 * S), radius=2 * S, fill=top)
    d.text((20 * S, (h - 28) * S), "OpenMusic", font=font("SemiBold", 10), fill=(120, 120, 120))
    return finish(im, w, h)


def header(app, name):
    w, h = 150, 57
    im = Image.new("RGBA", (w * S, h * S), "white")
    im.alpha_composite(logo(app, 34), ((w - 34 - 12) * S, 11 * S))
    d = ImageDraw.Draw(im)
    f = font("Bold", 15)
    tw = d.textlength(name, font=f)
    d.text(((w - 34 - 20) * S - tw, 18 * S), name, font=f, fill="#121212")
    return finish(im, w, h)


for app, (name, tagline) in APPS.items():
    out = ROOT / "apps" / app / "src-tauri" / "installer"
    out.mkdir(exist_ok=True)
    sidebar(app, name, tagline).save(out / "sidebar.bmp")
    header(app, name).save(out / "header.bmp")
    print("wrote", out)
