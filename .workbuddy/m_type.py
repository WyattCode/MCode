from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 「美容师功能这一轮的实测进展：」这一行的墨迹高度 -> 字号
rows = [y for y in range(228, 258) if any(ink(px[x, y]) for x in range(990, 1400))]
if rows:
    h = (max(rows) - min(rows) + 1) / DPI
    print("heading ink h = %.1f dp -> CJK 字号约 %.1f sp" % (h, h / 1.0))

# 行距：连续两行正文的基线差
# 找 y 范围内所有有墨迹的 y，聚类成行
ys = [y for y in range(320, 480) if any(ink(px[x, y]) for x in range(990, 3300))]
groups = []
cur = [ys[0]]
for a, b in zip(ys, ys[1:]):
    if b - a <= 6:
        cur.append(b)
    else:
        groups.append((cur[0], cur[-1]))
        cur = [b]
groups.append((cur[0], cur[-1]))
print("正文行（dp）：")
for g in groups[:6]:
    print("  y %.1f..%.1f  h=%.1f" % (g[0]/DPI, g[1]/DPI, (g[1]-g[0]+1)/DPI))
if len(groups) >= 2:
    pitch = (groups[1][0] - groups[0][0]) / DPI
    print("行距 = %.1f dp" % pitch)
