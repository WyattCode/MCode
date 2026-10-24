from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 正文段落区：y 320..560（"美容师功能..." 到 "宠物栏"）
ys = [y for y in range(320, 620) if any(ink(px[x, y]) for x in range(995, 3300))]
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
for g in groups:
    print("  y %.1f..%.1f  h=%.1f" % (g[0]/DPI, g[1]/DPI, (g[1]-g[0]+1)/DPI))
pitches = [round((groups[i+1][0]-groups[i][0])/DPI, 1) for i in range(len(groups)-1)]
print("相邻行起点差：", pitches)
