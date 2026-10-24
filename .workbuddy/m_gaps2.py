from PIL import Image
DPI = 2.5

def bands(path, name):
    im = Image.open(path).convert("RGB")
    px = im.load()
    rows = {}
    # 只认"文字级"深色：亮度 < 120，排除浅灰边框
    for y in range(100, 700):
        xs = [x for x in range(20, 880)
              if (px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3 < 120]
        if len(xs) >= 3:
            rows[y] = (min(xs), max(xs))
    if not rows:
        print(name, "no ink")
        return
    ys = sorted(rows)
    groups = []
    cur = [ys[0]]
    for a, b in zip(ys, ys[1:]):
        if b - a <= 10:
            cur.append(b)
        else:
            groups.append(cur)
            cur = [b]
    groups.append(cur)
    print("---", name)
    prev = None
    for g in groups:
        top, bot = g[0], g[-1]
        x0 = min(rows[y][0] for y in g)
        gap = "" if prev is None else "  gap %5.1f" % ((top - prev - 1) / DPI)
        print("  top %6.1f  bot %6.1f  h %5.1f  x0 %6.1f%s"
              % (top/DPI, bot/DPI, (bot-top+1)/DPI, x0/DPI, gap))
        prev = bot

bands(".workbuddy/shots/A_claude.png", "CLAUDE")
bands(".workbuddy/shots/V1.png", "MINE")
