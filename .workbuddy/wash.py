"""Locate the selection wash's bands, so a drag can be described in numbers.

Colour-first: the wash renders as #EADFE6 (the source is #ECDFE6; the renderer
lands two levels out), and a band is a run of rows that carry more than a
handful of such pixels. Printing each band's height and its end columns is what
turned "the selection looks odd" into "it covers three lines".
"""
import sys
from PIL import Image

SHOT = "D:/Documents/Claude Code/MCode/.workbuddy/shots/%s.png"


def bands(name, tgt=(234, 223, 230), tol=7, x0=0, x1=3408, y0=0, y1=2272, minpx=40):
    im = Image.open(SHOT % name).convert("RGB")

    def near(p):
        return all(abs(p[i] - tgt[i]) <= tol for i in range(3))

    rows = {}
    for y in range(y0, y1):
        xs = [x for x in range(x0, x1) if near(im.getpixel((x, y)))]
        if len(xs) >= minpx:
            rows[y] = (min(xs), max(xs), len(xs))
    out, prev = [], None
    for y in sorted(rows):
        if prev is None or y - prev > 3:
            out.append([y, y, rows[y][0], rows[y][1]])
        else:
            b = out[-1]
            b[1] = y
            b[2] = min(b[2], rows[y][0])
            b[3] = max(b[3], rows[y][1])
        prev = y
    for b in out:
        print("band y%d..%d h=%d(%.1fdp) x%d..%d w=%d(%.1fdp)" % (
            b[0], b[1], b[1] - b[0] + 1, (b[1] - b[0] + 1) / 2.5, b[2], b[3],
            b[3] - b[2] + 1, (b[3] - b[2] + 1) / 2.5))
    return out


if __name__ == "__main__":
    bands(sys.argv[1], y0=int(sys.argv[2]) if len(sys.argv) > 2 else 0,
          y1=int(sys.argv[3]) if len(sys.argv) > 3 else 2272)
