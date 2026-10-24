from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D0.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 卡片中线竖直扫 x=350（卡片中部，避开图标和文字）
    x = 880 // 2
    col = [(y, px[x, y]) for y in range(640, 900)]
    # 找非页面色
    nb = [(y, q) for y, q in col if q != (249, 249, 247)]
    if nb:
        print("%-6s x=%d non-page y %.1f..%.1f  H %.1f dp"
              % (name, x, nb[0][0]/DPI, nb[-1][0]/DPI, (nb[-1][0]-nb[0][0]+1)/DPI))
        print("       first %s  last %s" % (nb[0][1], nb[-1][1]))
