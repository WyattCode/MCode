"""Compare a selection's rendered geometry, reference against this build.

Both pictures are measured the same way - connected components of the wash colour
and of the handle colour, filtered by size - so the numbers are comparable. The
reference is cl-sel.png (Claude on the same pad, 3408x2272 at 400 dpi).
"""
import sys
from collections import deque
from PIL import Image

DPI = 2.5  # px per dp at 400 dpi


def blobs(im, test, min_w, min_h, box):
    x0, y0, x1, y1 = box
    px = im.load()
    seen = [[False] * (x1 - x0) for _ in range(y1 - y0)]
    out = []
    for yy in range(y0, y1):
        for xx in range(x0, x1):
            if seen[yy - y0][xx - x0] or not test(px[xx, yy]):
                continue
            q = deque([(xx, yy)])
            seen[yy - y0][xx - x0] = True
            pts = []
            while q:
                cx, cy = q.popleft()
                pts.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if x0 <= nx < x1 and y0 <= ny < y1 and not seen[ny - y0][nx - x0] and test(px[nx, ny]):
                        seen[ny - y0][nx - x0] = True
                        q.append((nx, ny))
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            w, h = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
            if w >= min_w and h >= min_h:
                out.append((min(xs), min(ys), w, h, len(pts)))
    return out


def measure(path, label):
    im = Image.open(path).convert("RGB")
    box = (1100, 100, 3300, 2272)
    wash = blobs(im, lambda p: abs(p[0]-222) < 18 and abs(p[1]-190) < 20 and abs(p[2]-175) < 20, 20, 10, box)
    handle = blobs(im, lambda p: abs(p[0]-174) < 30 and abs(p[1]-107) < 30 and abs(p[2]-78) < 30, 30, 30, box)
    pill = blobs(im, lambda p: abs(p[0]-234) < 6 and abs(p[1]-223) < 6 and abs(p[2]-230) < 6, 100, 60, box)
    print(f"\n=== {label} ===")
    if wash:
        w = max(b[2] for b in wash)
        h = [b[3] for b in wash]
        print(f"wash   bands={len(wash):2d}  widest={w}px={w/DPI:.1f}dp  heights={sorted(set(h))[:5]} px = "
              f"{[round(v/DPI,1) for v in sorted(set(h))[:5]]} dp")
    else:
        print("wash   none")
    if handle:
        for b in handle:
            print(f"handle {b[2]}x{b[3]}px = {b[2]/DPI:.1f}x{b[3]/DPI:.1f}dp  at ({b[0]},{b[1]})")
    else:
        print("handle none")
    if pill:
        for b in pill:
            print(f"pill   {b[2]}x{b[3]}px = {b[2]/DPI:.1f}x{b[3]/DPI:.1f}dp  at ({b[0]},{b[1]})")
    else:
        print("pill   none")
    return im


for path, label in ((sys.argv[1], "REFERENCE"), (sys.argv[2], "THIS BUILD")):
    measure(path, label)
