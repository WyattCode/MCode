from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A2.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 正文「你好，...」在裁剪图 y≈129/692 处 -> 原图 y ≈ 120 + 129*2.14 ≈ 396
for y in range(360, 430):
    xs = [x for x in range(910, 2400) if ink(px[x, y])]
    if len(xs) > 15:
        print("y=%.1f dp  x0=%.1f dp  inset=%.1f" % (y/DPI, min(xs)/DPI, min(xs)/DPI - 360))
        break
