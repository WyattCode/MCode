from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/C2.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 胶囊边框 (225,225,223)；在 x=180 竖扫找上下边
    ys = [y for y in range(340, 480) if px[180, y] == (225, 225, 223)]
    if not ys:
        ys = [y for y in range(340, 480) if abs(px[180,y][0]-225) < 4]
    if ys:
        top, bot = min(ys), max(ys)
        # 横扫找左右边
        mid = (top + bot)//2
        xs = [x for x in range(40, 400) if abs(px[x, mid][0]-225) < 4]
        print("%-6s capsule y %.1f..%.1f  H %.1f   x %.1f..%.1f  W %.1f"
              % (name, top/DPI, bot/DPI, (bot-top+1)/DPI,
                 min(xs)/DPI if xs else -1, max(xs)/DPI if xs else -1,
                 (max(xs)-min(xs)+1)/DPI if xs else -1))
        print("       fill: %s" % (px[180, mid],))
    # 文字墨迹高度
    def ink(q): return (q[0]+q[1]+q[2])/3 < 140
    tys = [y for y in range(top, bot) if any(ink(px[x,y]) for x in range(100, 380))]
    if tys:
        print("       text ink h %.1f dp" % ((max(tys)-min(tys)+1)/DPI))
