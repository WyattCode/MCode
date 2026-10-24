from PIL import Image
DPI = 2.5

def card(path, name):
    im = Image.open(path).convert("RGB")
    px = im.load()
    bg = px[700, 900]      # 页面背景
    # 卡片是白色且带浅灰边框；找 y 290..420 内与背景不同的连续带
    def diff(q):
        return abs(q[0]-bg[0]) + abs(q[1]-bg[1]) + abs(q[2]-bg[2]) > 4
    ys = [y for y in range(250, 500) if diff(px[450, y])]
    if not ys:
        print(name, "no card band")
        return
    groups = []
    cur = [ys[0]]
    for a, b in zip(ys, ys[1:]):
        if b - a <= 3:
            cur.append(b)
        else:
            groups.append(cur)
            cur = [b]
    groups.append(cur)
    g = groups[0]
    top, bot = g[0], g[-1]
    xs = [x for x in range(0, 900) if diff(px[x, (top+bot)//2])]
    print("%-6s card y %.1f..%.1f  H %.1f   x %.1f..%.1f  W %.1f"
          % (name, top/DPI, bot/DPI, (bot-top+1)/DPI,
             min(xs)/DPI, max(xs)/DPI, (max(xs)-min(xs)+1)/DPI))
    print("       top edge colour %s   fill %s" % (px[450, top], px[450, (top+bot)//2]))

card(".workbuddy/shots/A_claude.png", "Claude")
card(".workbuddy/shots/V1.png", "Mine")
