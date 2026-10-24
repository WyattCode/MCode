from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def dark(q):
    return (q[0] + q[1] + q[2]) / 3 < 190

# 状态行 y 304..320，找整行最左的墨迹（笔记本图标）
y0, y1 = 750, 800   # 300..320 dp * 2.5
xs = [x for x in range(40, 900) if any(dark(px[x, y]) for y in range(y0, y1))]
if xs:
    print("status row ink x %.1f..%.1f dp" % (min(xs)/DPI, max(xs)/DPI))
# 标题行 y 264..276
xs2 = [x for x in range(40, 900) if any(dark(px[x, y]) for y in range(660, 700))]
if xs2:
    print("title row ink x %.1f..%.1f dp" % (min(xs2)/DPI, max(xs2)/DPI))
# 图标块范围
def tile(q):
    m = (q[0]+q[1]+q[2])/3
    return 240 <= m <= 248
tp = [(x, y) for y in range(650, 800) for x in range(30, 220) if tile(px[x, y])]
if tp:
    xs3 = [p[0] for p in tp]; ys3 = [p[1] for p in tp]
    print("tile x %.1f..%.1f dp  w %.1f" % (min(xs3)/DPI, max(xs3)/DPI, (max(xs3)-min(xs3)+1)/DPI))
    print("tile y %.1f..%.1f dp  h %.1f" % (min(ys3)/DPI, max(ys3)/DPI, (max(ys3)-min(ys3)+1)/DPI))
