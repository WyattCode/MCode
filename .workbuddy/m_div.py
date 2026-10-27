from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D1.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 两栏交界约在 x 880..920；横扫看有没有竖线
    print("---", name)
    for x in range(870, 930, 2):
        col = [px[x, y] for y in range(300, 1800, 100)]
        uniq = set(col)
        if len(uniq) == 1 and list(uniq)[0] != (249, 249, 247):
            print("  x=%d dp=%.1f  SOLID %s" % (x, x/DPI, list(uniq)[0]))
