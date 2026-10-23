"""Find the two handle discs by connected-component size, not by colour alone.

The handle is #AE6B4E and so are several tokens in this code theme, so a colour
mask alone found the digits and the string literals too. A disc is the only blob
of that colour that is at least 30 px tall *and* 30 px wide, which is what this
looks for.
"""
import sys
from collections import deque
from PIL import Image

shot = sys.argv[1]
x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6]) if len(sys.argv) > 5 else (1200, 1000, 3200, 1900)
im = Image.open(shot).convert("RGB")
px = im.load()


def ish(p):
    return abs(p[0] - 174) < 26 and abs(p[1] - 107) < 26 and abs(p[2] - 78) < 26


seen = [[False] * (x1 - x0) for _ in range(y1 - y0)]
blobs = []
for yy in range(y0, y1):
    for xx in range(x0, x1):
        if seen[yy - y0][xx - x0] or not ish(px[xx, yy]):
            continue
        q = deque([(xx, yy)])
        seen[yy - y0][xx - x0] = True
        pts = []
        while q:
            cx, cy = q.popleft()
            pts.append((cx, cy))
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                if x0 <= nx < x1 and y0 <= ny < y1 and not seen[ny - y0][nx - x0] and ish(px[nx, ny]):
                    seen[ny - y0][nx - x0] = True
                    q.append((nx, ny))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        w, h = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        if w >= 30 and h >= 30:
            blobs.append(((min(xs) + max(xs)) // 2, (min(ys) + max(ys)) // 2, w, h, len(pts)))

blobs.sort()
for cx, cy, w, h, n in blobs:
    print(f"disc centre ({cx},{cy})  {w}x{h} px = {w/2.5:.1f}x{h/2.5:.1f} dp  area {n}")
if not blobs:
    print("no disc found in that region")
