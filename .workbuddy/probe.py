from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/V1.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    print("---", name)
    # x=450 竖直扫 y 320..460，列出颜色变化
    prev = None
    for y in range(320, 470):
        q = px[450, y]
        if q != prev:
            print("  y %5.1f  %s" % (y/DPI, q))
            prev = q
