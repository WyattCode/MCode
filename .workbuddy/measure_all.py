"""One pass over every Claude reference shot: the numbers this port needs."""
from PIL import Image

DPI = 2.5
SHOTS = ".workbuddy/shots/"


def bands(path, x0, x1, y0, y1, thr=150, gap=10, minpx=2):
    im = Image.open(path).convert("RGB")
    px = im.load()
    rows = {}
    for y in range(y0, y1):
        xs = [x for x in range(x0, x1) if (px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3 < thr]
        if len(xs) >= minpx:
            rows[y] = (min(xs), max(xs))
    if not rows:
        return []
    ys = sorted(rows)
    gs, cur = [], [ys[0]]
    for a, b in zip(ys, ys[1:]):
        if b - a <= gap:
            cur.append(b)
        else:
            gs.append(cur)
            cur = [b]
    gs.append(cur)
    return [(g[0] / DPI, g[-1] / DPI,
             min(rows[y][0] for y in g) / DPI,
             max(rows[y][1] for y in g) / DPI) for g in gs]


def show(label, rows_, limit=14):
    print("\n== %s ==" % label)
    for top, bot, x0, x1 in rows_[:limit]:
        print("   y%7.1f..%7.1f  h%5.1f   x%7.1f..%7.1f  w%6.1f"
              % (top, bot, bot - top + 0.4, x0, x1, x1 - x0 + 0.4))


show("最近记录 左栏", bands(SHOTS + "CLAUDE-1.png", 5, 890, 80, 1300))
show("Code 左栏", bands(SHOTS + "CLAUDE-CODE.png", 5, 890, 80, 1300))
show("抽屉", bands(SHOTS + "CL-DRAW2.png", 5, 990, 60, 1600))
show("Artifacts 左栏", bands(SHOTS + "CL-ART.png", 5, 890, 80, 1300))
show("项目 左栏", bands(SHOTS + "CL-PROJ.png", 5, 890, 80, 1300))
