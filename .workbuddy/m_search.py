from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/CLAUDE-1.png").convert("RGB")
px = im.load()

# 描边色 (206,206,206)，填充白
def is_edge(q): return abs(q[0]-206) < 12 and abs(q[1]-206) < 12 and abs(q[2]-206) < 12
def is_white(q): return q[0] >= 253 and q[1] >= 253 and q[2] >= 253

ys = [y for y in range(250, 400) if is_edge(px[450, y])]
print("edges at x=450:", [round(y/DPI,1) for y in ys])
if len(ys) >= 2:
    top, bot = min(ys), max(ys)
    print("search box y %.1f..%.1f  H %.1f dp" % (top/DPI, bot/DPI, (bot-top+1)/DPI))
    mid = (top+bot)//2
    xs = [x for x in range(10, 890) if is_edge(px[x, mid])]
    print("left/right edges:", [round(x/DPI,1) for x in xs][:6])
    if xs:
        print("search box x %.1f..%.1f  W %.1f dp" % (min(xs)/DPI, max(xs)/DPI, (max(xs)-min(xs)+1)/DPI))
    # 白色填充范围
    wx = [x for x in range(10, 890) if is_white(px[x, mid])]
    if wx:
        print("white fill x %.1f..%.1f" % (min(wx)/DPI, max(wx)/DPI))
