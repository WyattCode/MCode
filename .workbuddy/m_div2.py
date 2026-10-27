from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D1.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    print("---", name)
    for x in range(860, 950):
        col = [px[x, y] for y in range(300, 1800, 50)]
        # 该列有多少像素不是背景
        nb = sum(1 for q in col if q != (249, 249, 247))
        if nb > len(col) * 0.8:
            print("  x=%d %.1fdp  %d/%d non-bg  sample %s" % (x, x/DPI, nb, len(col), col[0]))
