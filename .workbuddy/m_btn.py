from PIL import Image
DPI = 2.5

for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/NOW.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 新建会话按钮是深色胶囊，找底部 y 1700..2272 的深色块
    pts = [(x, y) for y in range(1700, 2272) for x in range(0, 900)
           if sum(px[x, y]) < 200]
    if not pts:
        print(name, "no dark button found")
        continue
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, x1 = min(xs), max(xs)
    print("%-6s button x %.1f..%.1f dp  width %.1f  centre %.1f  (column centre 180.0)"
          % (name, x0/DPI, x1/DPI, (x1-x0+1)/DPI, (x0+x1)/2/DPI))
    print("       y %.1f..%.1f dp  height %.1f" % (min(ys)/DPI, max(ys)/DPI, (max(ys)-min(ys)+1)/DPI))
