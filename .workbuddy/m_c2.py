from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/c2.png").convert("RGB")
px = im.load()
W, H = im.size

# 输入框是白色卡片 + 浅灰边。在底部区找与页面背景 (249,249,247) 不同的整行
def notbg(q):
    return abs(q[0]-249) + abs(q[1]-249) + abs(q[2]-247) > 6

for y in range(H - 30, 1600, -1):
    xs = [x for x in range(920, W - 5) if notbg(px[x, y])]
    if len(xs) > 800:
        print("top edge y=%.1f dp" % (y/DPI))
        print("  x %.1f..%.1f  left inset %.1f  right %.1f"
              % (min(xs)/DPI, max(xs)/DPI, min(xs)/DPI - 360, 3408/DPI - max(xs)/DPI))
        break
else:
    print("no wide band found; sampling row 2050:")
    xs = [x for x in range(900, W) if notbg(px[x, 2050])]
    if xs:
        print("  x %.1f..%.1f" % (min(xs)/DPI, max(xs)/DPI))
