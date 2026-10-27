from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def dark(q):
    return (q[0] + q[1] + q[2]) / 3 < 150

# 逐行扫描右栏，输出所有文字块
rows = {}
for y in range(100, 2200):
    xs = [x for x in range(950, 3380) if dark(px[x, y])]
    if xs:
        rows[y] = (min(xs), max(xs))
if not rows:
    print("no ink")
    raise SystemExit
ys = sorted(rows)
groups = []
cur = [ys[0]]
for a, b in zip(ys, ys[1:]):
    if b - a <= 10:
        cur.append(b)
    else:
        groups.append((cur[0], cur[-1]))
        cur = [b]
groups.append((cur[0], cur[-1]))
print("右栏文字块（dp，x 相对栏左 360）：")
for g in groups:
    x0 = min(rows[y][0] for y in g)
    x1 = max(rows[y][1] for y in g)
    print("  y %6.1f..%6.1f h=%5.1f   x %6.1f..%6.1f  inset=%6.1f"
          % (g[0]/DPI, g[1]/DPI, (g[1]-g[0]+1)/DPI, x0/DPI, x1/DPI, x0/DPI-360))
