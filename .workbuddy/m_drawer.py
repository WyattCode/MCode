from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/CL-DRAW2.png").convert("RGB")
px = im.load()

# 抽屉宽度：找左边白色区与右边灰色遮罩的分界
row = 1200
prev = None
for x in range(1000, 1800):
    q = px[x, row]
    if q != prev:
        print("x %.1f  %s" % (x/DPI, q))
        prev = q
