from PIL import Image
DPI = 2.5

def bands(path, x0=0, x1=900, y0=0, y1=2272, thr=170):
    """Rows that carry ink, grouped into bands."""
    im = Image.open(path).convert("RGB")
    px = im.load()
    rows = {}
    for y in range(y0, y1):
        xs = [x for x in range(x0, x1)
              if (px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3 < thr]
        if xs:
            rows[y] = (min(xs), max(xs))
    if not rows:
        return []
    ys = sorted(rows)
    groups = []
    cur = [ys[0]]
    for a, b in zip(ys, ys[1:]):
        if b - a <= 8:
            cur.append(b)
        else:
            groups.append(cur)
            cur = [b]
    groups.append(cur)
    return [(g[0], g[-1], min(rows[y][0] for y in g), max(rows[y][1] for y in g)) for g in groups]

for name, path in (("CLAUDE", ".workbuddy/shots/A_claude.png"), ("MINE", ".workbuddy/shots/NOW.png")):
    print("=" * 62)
    print(name)
    for (yt, yb, xl, xr) in bands(path, 0, 900, 100, 1300):
        print("  y %6.1f..%6.1f  h%5.1f   x %6.1f..%6.1f"
              % (yt/DPI, yb/DPI, (yb-yt+1)/DPI, xl/DPI, xr/DPI))
