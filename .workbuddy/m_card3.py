from PIL import Image
DPI = 2.5

def probe(path, name):
    im = Image.open(path).convert("RGB")
    px = im.load()
    print("---", name)
    # 卡片顶部边框：横向扫 y 250..420，找连续浅灰横线
    def line(q):
        m = (q[0] + q[1] + q[2]) / 3
        return 220 <= m <= 244
    for y in range(250, 430):
        xs = [x for x in range(30, 880) if line(px[x, y])]
        if len(xs) > 700:
            print("  hline at y %.1f dp  x %.1f..%.1f"
                  % (y/DPI, min(xs)/DPI, max(xs)/DPI))
            break
    # 标题墨迹
    def ink(q):
        return (q[0] + q[1] + q[2]) / 3 < 140
    ys = [y for y in range(250, 430) if any(ink(px[x, y]) for x in range(100, 700))]
    if ys:
        print("  text ink y %.1f..%.1f dp" % (min(ys)/DPI, max(ys)/DPI))
    xs = [x for x in range(30, 880) if any(ink(px[x, y]) for y in range(250, 430))]
    if xs:
        print("  text ink x0 %.1f dp" % (min(xs)/DPI))

probe(".workbuddy/shots/A_claude.png", "Claude")
probe(".workbuddy/shots/V1.png", "Mine")
