from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 参考件列表区 y 296..430：找到每一行的 x0
prev = None
for y in range(292, 440):
    xs = [x for x in range(985, 2400) if ink(px[x, y])]
    if xs and (prev is None or y - prev > 8):
        print("row start y=%.1f  x0=%.1f  inset=%.1f" % (y/DPI, min(xs)/DPI, min(xs)/DPI - 360))
        prev = y
