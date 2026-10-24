from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 先求每行是否有墨迹，再按空行切块
has = {}
for y in range(290, 460):
    xs = [x for x in range(985, 2400) if ink(px[x, y])]
    if xs:
        has[y] = min(xs)

ys = sorted(has)
groups = []
cur = [ys[0]]
for a, b in zip(ys, ys[1:]):
    if b - a <= 5:
        cur.append(b)
    else:
        groups.append(cur)
        cur = [b]
groups.append(cur)

for g in groups:
    x0 = min(has[y] for y in g)
    print("block y %.1f..%.1f  x0 %.1f  inset %.1f"
          % (g[0]/DPI, g[-1]/DPI, x0/DPI, x0/DPI - 360))
