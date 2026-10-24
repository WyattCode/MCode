from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/V1.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 在卡片左边缘 x=40 竖直扫，找边框竖线
    print("---", name)
    prev = None
    for y in range(320, 500):
        q = px[38, y]
        if q != prev and (max(q) - min(q) < 8):
            pass
        prev = q
    # 直接找"非白非底"像素：y 方向在 x=100 扫（图标块区）
    for x in [38, 60, 110]:
        col = [(y, px[x, y]) for y in range(330, 460)]
        changes = [(y, q) for y, q in col if q != (249, 249, 247) and q != (255, 255, 255)]
        if changes:
            print("  x=%d: %d non-bg px, y %.1f..%.1f" % (x, len(changes), changes[0][0]/DPI, changes[-1][0]/DPI))
