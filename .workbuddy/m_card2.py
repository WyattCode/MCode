from PIL import Image
DPI = 2.5

def card(path, name):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 卡片边框是浅灰 (~225-240)，纵向在 x=460 列扫 y 250..480
    def isline(q):
        m = (q[0] + q[1] + q[2]) / 3
        return 222 <= m <= 243
    ys = [y for y in range(250, 500) if isline(px[460, y])]
    print("%-6s border rows at x=460: %s" % (name, [(int(y/DPI)) for y in ys][:12]))
    # 卡片内的浅灰圆/方块
    # 也找 hline：在 y 中点横扫
    if len(ys) >= 2:
        top, bot = ys[0], ys[-1]
        hx = [x for x in range(0, 900) if isline(px[x, (top + bot)//2])]
        print("       card y %.1f..%.1f  H %.1f ; verticals x %s"
              % (top/DPI, bot/DPI, (bot-top+1)/DPI,
                 [int(x/DPI) for x in hx][:6]))

card(".workbuddy/shots/A_claude.png", "Claude")
card(".workbuddy/shots/V1.png", "Mine")
