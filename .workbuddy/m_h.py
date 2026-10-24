from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()
# 卡片左边缘：x=31 处，(248,248,246) 的连续段就是卡片高度
for x in (31, 32, 33, 34, 35):
    ys = [y for y in range(660, 900) if px[x, y] == (248, 248, 246)]
    if len(ys) > 30:
        print("x=%d: %d rows, y %.1f..%.1f, H=%.1f dp"
              % (x, len(ys), min(ys)/DPI, max(ys)/DPI, (max(ys)-min(ys)+1)/DPI))
