from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 参考件的两级列表：• 魅力确认框 / ◦ 框里显示...
for name, y0, y1 in (("bullet L1", 350, 380), ("sub L2", 400, 435), ("head", 296, 320)):
    xs = [x for x in range(990, 2200) if any(ink(px[x, y]) for y in range(y0, y1))]
    if xs:
        print("%-10s x0 %.1f dp  inset %.1f dp" % (name, min(xs)/DPI, min(xs)/DPI - 360))
