from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

# 图标块：浅灰方块。先找它的范围（比页面稍灰）
def tile(q):
    m = (q[0] + q[1] + q[2]) / 3
    return 240 <= m <= 248 and abs(q[0] - q[2]) < 6

# 卡片第一张在 y 640..820；图标块在其左侧
pts = [(x, y) for y in range(660, 800) for x in range(50, 200) if tile(px[x, y])]
if pts:
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    print("tile x %.1f..%.1f  w %.1f" % (min(xs)/DPI, max(xs)/DPI, (max(xs)-min(xs)+1)/DPI))
    print("tile y %.1f..%.1f  h %.1f" % (min(ys)/DPI, max(ys)/DPI, (max(ys)-min(ys)+1)/DPI))
    print("tile fill:", px[(min(xs)+max(xs))//2, min(ys)+5])

# 圆环：块内的深色弧
def ring(q):
    return (q[0] + q[1] + q[2]) / 3 < 170
rp = [(x, y) for y in range(660, 800) for x in range(60, 190) if ring(px[x, y])]
if rp:
    xs = [p[0] for p in rp]; ys = [p[1] for p in rp]
    print("ring x %.1f..%.1f  w %.1f" % (min(xs)/DPI, max(xs)/DPI, (max(xs)-min(xs)+1)/DPI))
    print("ring y %.1f..%.1f  h %.1f" % (min(ys)/DPI, max(ys)/DPI, (max(ys)-min(ys)+1)/DPI))
