from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D0.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 卡片边框 (248,248,246)，在 x=160 竖扫找上下边
    ys = [y for y in range(340, 560) if px[160, y] == (248, 248, 246)]
    if ys:
        print("%-6s card edge rows: %s" % (name, [round(y/DPI,1) for y in ys[:3]] + ["..."] + [round(y/DPI,1) for y in ys[-3:]]))
        print("       H = %.1f dp" % ((max(ys)-min(ys)+1)/DPI))
    # 第二张卡片顶部，用来算行距
    ys2 = [y for y in range(560, 760) if px[160, y] == (248, 248, 246)]
    if ys2 and ys:
        print("       next card top %.1f dp -> pitch %.1f"
              % (min(ys2)/DPI, (min(ys2)-min(ys))/DPI))
