from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

# 输入框：找其边框（浅灰）在右栏内的矩形
def isline(q):
    return 225 <= q[0] <= 242 and 225 <= q[1] <= 242 and 222 <= q[2] <= 240

# 竖向扫 x=1600 找输入框上下边
ys = [y for y in range(1900, 2272) if isline(px[1600, y])]
if ys:
    print("composer top edge y=%.1f dp" % (min(ys)/DPI))
    mid = (min(ys) + max(ys)) // 2
    xs = [x for x in range(900, 3408) if isline(px[x, mid])]
    if xs:
        print("composer x %.1f..%.1f dp  (inset left %.1f, right %.1f)"
              % (min(xs)/DPI, max(xs)/DPI, min(xs)/DPI - 360, 3408/DPI - max(xs)/DPI))
print("screen bottom = %.1f dp" % (2272/DPI))
