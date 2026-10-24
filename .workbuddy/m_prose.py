from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A2.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 「你好，有什么可以帮你的吗？」在裁剪图 y=129 -> 原图 y = 120 + 129*(1480/692)
# 直接用原图扫 y 300..450
best = None
for y in range(280, 460):
    xs = [x for x in range(910, 3000) if ink(px[x, y])]
    if len(xs) > 8:
        best = (y, min(xs))
        break
if best:
    print("prose y=%.1f dp  x0=%.1f dp  inset=%.1f" % (best[0]/DPI, best[1]/DPI, best[1]/DPI - 360))
