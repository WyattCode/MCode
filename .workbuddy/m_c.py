from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/c1.png").convert("RGB")
px = im.load()
W, H = im.size
print("size", im.size)

def isline(q):
    return 220 <= q[0] <= 245 and 220 <= q[1] <= 245 and 218 <= q[2] <= 243

# 从底部往上找输入框上边线
best = None
for y in range(H - 20, 1700, -2):
    xs = [x for x in range(920, W - 10) if isline(px[x, y])]
    if len(xs) > 400:
        best = (y, min(xs), max(xs))
        break
if best:
    y, x0, x1 = best
    print("composer top y=%.1f dp" % (y/DPI))
    print("  x %.1f..%.1f -> left inset %.1f, right %.1f"
          % (x0/DPI, x1/DPI, x0/DPI - 360, 3408/DPI - x1/DPI))
print("target: left 36.8  right 13.2")
