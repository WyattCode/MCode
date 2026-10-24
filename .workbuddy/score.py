"""Score the two screens, element by element, by pixel position."""
from PIL import Image

DPI = 2.5

def bands(path, x0, x1, y0, y1, thr=150, gap=10):
    im = Image.open(path).convert("RGB")
    px = im.load()
    rows = {}
    for y in range(y0, y1):
        xs = [x for x in range(x0, x1) if (px[x, y][0]+px[x, y][1]+px[x, y][2])/3 < thr]
        if len(xs) >= 3:
            rows[y] = (min(xs), max(xs))
    if not rows:
        return []
    ys = sorted(rows)
    gs = []; cur = [ys[0]]
    for a, b in zip(ys, ys[1:]):
        if b - a <= gap: cur.append(b)
        else: gs.append(cur); cur = [b]
    gs.append(cur)
    return [(g[0]/DPI, g[-1]/DPI,
             min(rows[y][0] for y in g)/DPI,
             max(rows[y][1] for y in g)/DPI) for g in gs]

ref = bands(".workbuddy/shots/CLAUDE-CODE.png", 10, 880, 80, 1500)
mine = bands(".workbuddy/shots/MINE-CODE.png", 10, 880, 80, 1500)

print("CLAUDE Code 页左栏（y起, y止, x起, x止）")
for b in ref[:10]:
    print("   %6.1f %6.1f | %6.1f %6.1f" % b)
print()
print("MINE Code 页左栏")
for b in mine[:10]:
    print("   %6.1f %6.1f | %6.1f %6.1f" % b)
