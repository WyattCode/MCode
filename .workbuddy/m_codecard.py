from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/CLAUDE-CODE.png").convert("RGB")
px = im.load()

# 卡片描边：浅灰。竖扫 x=450（卡片中部）
prev = None
print("vertical at x=450, y 600..850:")
for y in range(600, 870):
    q = px[450, y]
    if q != prev:
        print("  y %.1f  %s" % (y/DPI, q))
        prev = q
