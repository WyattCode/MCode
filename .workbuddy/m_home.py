from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/CLAUDE-1.png").convert("RGB")
px = im.load()

def ink(q): return (q[0]+q[1]+q[2])/3 < 150

# 左栏（0..900），列出所有文字块
rows = {}
for y in range(80, 2272):
    xs = [x for x in range(10, 880) if ink(px[x, y])]
    if xs:
        rows[y] = (min(xs), max(xs))
ys = sorted(rows)
groups = []; cur = [ys[0]]
for a, b in zip(ys, ys[1:]):
    if b - a <= 10: cur.append(b)
    else: groups.append(cur); cur = [b]
groups.append(cur)
print("主页左栏（dp）：")
prev = None
for g in groups:
    top, bot = g[0], g[-1]
    x0 = min(rows[y][0] for y in g)
    x1 = max(rows[y][1] for y in g)
    gap = "" if prev is None else "  gap %.1f" % ((top-prev-1)/DPI)
    print("  y %6.1f..%6.1f  h%5.1f  x %6.1f..%6.1f%s"
          % (top/DPI, bot/DPI, (bot-top+1)/DPI, x0/DPI, x1/DPI, gap))
    prev = bot
