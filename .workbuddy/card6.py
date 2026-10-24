from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/V1.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 在卡片中部 y=380 横向扫，找非 (249,249,247) 的像素
    row = [(x, px[x, 380]) for x in range(0, 900)]
    nb = [(x, q) for x, q in row if q != (249, 249, 247)]
    if nb:
        print("%-6s y=152dp: card spans x %.1f .. %.1f dp" % (name, nb[0][0]/DPI, nb[-1][0]/DPI))
        print("       left px %s   right px %s" % (nb[0][1], nb[-1][1]))
