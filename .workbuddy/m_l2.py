from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 从放大图定位：一级 bullet 在裁剪 y≈30 -> 原图 y = 720 + 30*430/324 ≈ 760
# 直接扫原图 730..1160，每行取 x0
rows = {}
for y in range(730, 1160):
    xs = [x for x in range(965, 2400) if ink(px[x, y])]
    if xs:
        rows[y] = min(xs)

ys = sorted(rows)
groups = []
cur = [ys[0]]
for a, b in zip(ys, ys[1:]):
    if b - a <= 6:
        cur.append(b)
    else:
        groups.append(cur)
        cur = [b]
groups.append(cur)

for g in groups:
    x0 = min(rows[y] for y in g)
    print("y %.1f..%.1f  x0=%.1f dp  inset=%.1f"
          % (g[0]/DPI, g[-1]/DPI, x0/DPI, x0/DPI - 360))
