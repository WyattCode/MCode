from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/M-DRAW2.png").convert("RGB")
px = im.load()

def ink(q): return (q[0]+q[1]+q[2])/3 < 150

rows = {}
for y in range(80, 2272):
    xs = [x for x in range(5, 995) if ink(px[x, y])]
    if len(xs) >= 2:
        rows[y] = (min(xs), max(xs))
ys = sorted(rows)
gs = []; cur = [ys[0]]
for a, b in zip(ys, ys[1:]):
    if b - a <= 12: cur.append(b)
    else: gs.append(cur); cur = [b]
gs.append(cur)
print("抽屉内元素（y起, y止, x起, x止, 高度）：")
prev = None
for g in gs[:16]:
    top, bot = g[0], g[-1]
    x0 = min(rows[y][0] for y in g); x1 = max(rows[y][1] for y in g)
    gap = "" if prev is None else " gap %5.1f" % ((top-prev-1)/DPI)
    print("  %6.1f %6.1f | %6.1f %6.1f h%5.1f%s"
          % (top/DPI, bot/DPI, x0/DPI, x1/DPI, (bot-top+1)/DPI, gap))
    prev = bot
