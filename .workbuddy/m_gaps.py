from PIL import Image
DPI = 2.5

def gaps(path, name):
    im = Image.open(path).convert("RGB")
    px = im.load()
    rows = {}
    for y in range(100, 700):
        xs = [x for x in range(0, 900)
              if (px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3 < 170]
        if xs:
            rows[y] = (min(xs), max(xs))
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
    print("---", name)
    prev_end = None
    for g in groups:
        top, bot = g[0], g[-1]
        x0 = min(rows[y][0] for y in g)
        gap = "" if prev_end is None else "  gap %.1f" % ((top - prev_end - 1) / DPI)
        print("  top %6.1f  bottom %6.1f  h %5.1f  x0 %6.1f%s"
              % (top/DPI, bot/DPI, (bot-top+1)/DPI, x0/DPI, gap))
        prev_end = bot

gaps(".workbuddy/shots/A_claude.png", "CLAUDE")
gaps(".workbuddy/shots/FIX5.png", "MINE")
