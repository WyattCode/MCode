from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/v3.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 「你好，有什么可以帮你的吗？」在裁剪图 y=129，原图 y = 120 + 129*2528/1200
scale = 2528 / 1200
y = int(120 + 129 * scale)
rows = [yy for yy in range(y - 20, y + 20) if any(ink(px[x, yy]) for x in range(950, 2400))]
if rows:
    xs = [x for x in range(950, 2400) if any(ink(px[x, yy]) for yy in rows)]
    print("prose x0 = %.1f px = %.1f dp" % (min(xs), min(xs)/DPI))
    print("  pane starts at 360.0 dp (900 px)")
    print("  inset = %.1f dp" % (min(xs)/DPI - 360.0))

# 同时找栏边界
for x in range(880, 930):
    if px[x, 700] != px[400, 700]:
        print("pane edge at x=%d = %.1f dp" % (x, x/DPI))
        break
