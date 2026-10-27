from PIL import Image
DPI = 2.5
for name, path, y0, y1 in (("Claude", ".workbuddy/shots/A_claude.png", 350, 460),
                           ("Mine", ".workbuddy/shots/C3.png", 370, 480)):
    im = Image.open(path).convert("RGB")
    px = im.load()
    def ink(q):
        return (q[0]+q[1]+q[2])/3 < 120
    rows = [y for y in range(y0, y1) if any(ink(px[x, y]) for x in range(100, 380))]
    if rows:
        print("%-6s text ink y %.1f..%.1f  h %.1f dp"
              % (name, min(rows)/DPI, max(rows)/DPI, (max(rows)-min(rows)+1)/DPI))
        # 文字最左
        xs = [x for x in range(60, 400) if any(ink(px[x, y]) for y in rows)]
        print("       text x0 %.1f dp" % (min(xs)/DPI))
