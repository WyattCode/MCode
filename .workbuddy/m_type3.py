from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 真正在右栏（x 1000..3200）
ys = [y for y in range(560, 1200) if any(ink(px[x, y]) for x in range(1010, 3200))]
if not ys:
    print("none")
    raise SystemExit
groups = []
cur = [ys[0]]
for a, b in zip(ys, ys[1:]):
    if b - a <= 6:
        cur.append(b)
    else:
        groups.append((cur[0], cur[-1]))
        cur = [b]
groups.append((cur[0], cur[-1]))
for g in groups:
    print("  y %.1f..%.1f  h=%.1f" % (g[0]/DPI, g[1]/DPI, (g[1]-g[0]+1)/DPI))
print("起点差:", [round((groups[i+1][0]-groups[i][0])/DPI,1) for i in range(len(groups)-1)])
