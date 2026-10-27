from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D1.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    def ink(q): return (q[0]+q[1]+q[2])/3 < 120
    # 标题行：卡片内第一行文字（y 690..730）
    rows = [y for y in range(680, 745) if any(ink(px[x, y]) for x in range(200, 700))]
    if rows:
        print("%-6s title ink y %.1f..%.1f  h %.1f dp"
              % (name, min(rows)/DPI, max(rows)/DPI, (max(rows)-min(rows)+1)/DPI))
        xs = [x for x in range(200, 800) if any(ink(px[x, y]) for y in rows)]
        print("       title x0 %.1f dp" % (min(xs)/DPI))
