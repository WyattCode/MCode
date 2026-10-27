from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

# 「已连接 · Remote control」这一行 y 289..303（前面量到 289.2..302.8）
# 找绿色部分的 x 范围、灰部分的 x 范围、分隔点位置
def green(q):
    return q[1] > q[0] + 15 and q[1] > q[2] + 15

def gray(q):
    m = (q[0] + q[1] + q[2]) / 3
    return 110 < m < 190

gy = [(x, y) for y in range(285, 310) for x in range(60, 900) if green(px[x, y])]
if gy:
    xs = [p[0] for p in gy]
    print("green ink x %.1f .. %.1f dp" % (min(xs)/DPI, max(xs)/DPI))

# 分隔点：在 「已连接」之后、Remote 之前那块
gr = [(x, y) for y in range(285, 310) for x in range(200, 320) if gray(px[x, y])]
if gr:
    xs = [p[0] for p in gr]; ys = [p[1] for p in gr]
    print("separator region x %.1f..%.1f  y %.1f..%.1f"
          % (min(xs)/DPI, max(xs)/DPI, min(ys)/DPI, max(ys)/DPI))
