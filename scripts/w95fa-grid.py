#!/usr/bin/env python3
"""Build "W95FA Grid", the pixel font of the Windows 95 theme, from W95FA.

W95FA (Alina Sava, SIL Open Font License 1.1) recreates the Windows 95 interface font as square
pixels of 80 font units (1 px at 12.5 px font size). Its glyphs sit 50 units (0.625 px) off the
pixel grid and its advances are fractional pixels, so browsers draw it with grey, blurred edges.
This script snaps every point to whole pixels (each glyph by its own grid phase), gives every
glyph a whole-pixel advance with one pixel of space on the right like MS Sans Serif, and rounds
the line metrics to whole pixels so the baseline lands on a pixel too. At 12.5 px (and 25, 37.5…)
the text then renders crisp, like the bitmap fonts of the time.

The result is a Modified Version under the OFL and keeps that licence (see
ui/public/licenses/W95FA-OFL.txt). W95FA declares no Reserved Font Name; the new name marks the
change anyway.

It also writes a bold face drawn the way MS Sans Serif Bold was: every glyph doubled one pixel
to the right, one pixel wider (a browser's synthetic bold smears it by a fraction of a pixel).

Usage (needs fonttools and brotli):
  npm pack @fontsource/win95fa@5.3.0 && tar xzf fontsource-win95fa-5.3.0.tgz
  python3 scripts/w95fa-grid.py package/files/win95fa-latin-400-normal.woff ui/src/assets/fonts
"""

import math
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

PX = 80  # font units per pixel


def main(src: str, out_dir: str) -> None:
    for bold in (False, True):
        build(src, f"{out_dir}/w95fa-grid{'-bold' if bold else ''}.woff2", bold)


def build(src: str, dst: str, bold: bool) -> None:
    font = TTFont(src)
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm

    outlines, advances = {}, {}
    y_max, y_min = 0, 0
    for name in order:
        rec = RecordingPen()
        glyphs[name].draw(rec)
        points = [pt for _, args in rec.value for pt in args]
        adv = font["hmtx"][name][0]
        pen = TTGlyphPen(None)
        extra = PX if bold else 0
        if not points:
            # Spaces: the nearest whole pixel.
            advances[name] = max(PX, round(adv / PX) * PX)
            outlines[name] = pen.glyph()
            continue
        phase = round(min(x for x, _ in points)) % PX
        snap_x = lambda x: round((x - phase) / PX) * PX
        snap_y = lambda y: round(y / PX) * PX
        # Bold draws the outline a second time one pixel to the right (overlaps fill as one).
        for shift in (0, extra) if bold else (0,):
            for op, args in rec.value:
                if op == "moveTo":
                    pen.moveTo((snap_x(args[0][0]) + shift, snap_y(args[0][1])))
                elif op in ("lineTo", "curveTo", "qCurveTo"):
                    # A pixel font is all straight edges; a stray curve becomes a line to its end.
                    x, y = args[-1]
                    pen.lineTo((snap_x(x) + shift, snap_y(y)))
                elif op in ("closePath", "endPath"):
                    pen.closePath()
        glyph = pen.glyph()
        outlines[name] = glyph
        snapped = [(snap_x(x), snap_y(y)) for x, y in points]
        x_max = max(x for x, _ in snapped) + extra
        y_max = max(y_max, max(y for _, y in snapped))
        y_min = min(y_min, min(y for _, y in snapped))
        # The glyph's pixels plus one blank pixel column, never less than the drawing itself.
        advances[name] = max(round((adv - 20) / PX) * PX + extra, x_max + PX)

    ascent = math.ceil(y_max / PX) * PX
    descent = math.ceil(-y_min / PX) * PX

    fb = FontBuilder(upm, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(outlines)
    metrics = {}
    for name in order:
        g = outlines[name]
        g.recalcBounds(fb.font["glyf"])
        metrics[name] = (advances[name], getattr(g, "xMin", 0) or 0)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ascent, descent=-descent, lineGap=0)
    fb.setupNameTable(
        {
            "familyName": "W95FA Grid",
            "styleName": "Bold" if bold else "Regular",
            "uniqueFontIdentifier": f"W95FA Grid {'Bold' if bold else 'Regular'}; OpenMusic",
            "fullName": "W95FA Grid Bold" if bold else "W95FA Grid",
            "psName": "W95FAGrid-Bold" if bold else "W95FAGrid-Regular",
            "version": "Version 1.002-grid",
            "copyright": "W95FA by Alina Sava. Snapped to whole pixels for OpenMusic (scripts/w95fa-grid.py).",
            "licenseDescription": "SIL Open Font License, Version 1.1",
            "licenseInfoURL": "https://openfontlicense.org",
        }
    )
    fb.setupOS2(
        version=4,
        usWeightClass=700 if bold else 400,
        sTypoAscender=ascent,
        sTypoDescender=-descent,
        sTypoLineGap=0,
        usWinAscent=ascent,
        usWinDescent=descent,
        sxHeight=font["OS/2"].sxHeight,
        sCapHeight=font["OS/2"].sCapHeight,
        fsSelection=(0x20 if bold else 0x40) | 0x80,  # BOLD or REGULAR, USE_TYPO_METRICS
        achVendID="OMUS",
    )
    fb.setupPost()
    if bold:
        fb.font["head"].macStyle = 1
    fb.font.flavor = "woff2"
    fb.save(dst)
    print(f"{dst}: {len(order)} glyphs, ascent {ascent / PX:g} px, descent {descent / PX:g} px at {upm / PX:g} px")


if __name__ == "__main__":
    main(*sys.argv[1:3])
