from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/cc.png").convert("RGB")
px = im.load()
W, H = im.size

# 输入框是白色卡片，比页面背景 (249,249,247) 更白或带边框
# 找底部区域内最白的一段连续像素
def is_card(q):
    return q[0] >= 250 and q[1] >= 250 and q[2] >= 248

found = []
for y in range(1700, H):
    xs = [x for x in range(900, W) if is_card(px[x, y])]
    if len(xs) > 900:
        found.append(y)
if found:
    y0, y1 = min(found), max(found)
    mid = (y0 + y1) // 2
    xs = [x for x in range(900, W) if is_card(px[x, mid])]
    print("card y %.1f..%.1f dp" % (y0/DPI, y1/DPI))
    print("card x %.1f..%.1f dp  left %.1f  right %.1f"
          % (min(xs)/DPI, max(xs)/DPI, min(xs)/DPI - 360, 3408/DPI - max(xs)/DPI))
    if xs:
        print("  edges: %s .. %s" % (px[min(xs), mid], px[max(xs), mid]))
else:
    print("no card band; row samples at 1900:")
    print([px[x, 1900] for x in range(900, 1400, 100)])
