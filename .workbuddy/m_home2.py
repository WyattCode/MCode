from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/CLAUDE-1.png").convert("RGB")
px = im.load()

# 搜索框：找描边（浅灰）矩形
def isline(q):
    m = (q[0]+q[1]+q[2])/3
    return 210 <= m <= 240

# 竖扫 x=450 找搜索框上下边
ys = [y for y in range(240, 400) if isline(px[450, y])]
if ys:
    print("search box y %.1f..%.1f  H %.1f dp" % (min(ys)/DPI, max(ys)/DPI, (max(ys)-min(ys)+1)/DPI))
    mid = (min(ys)+max(ys))//2
    xs = [x for x in range(20, 880) if isline(px[x, mid])]
    if xs:
        print("search box x %.1f..%.1f  W %.1f dp" % (min(xs)/DPI, max(xs)/DPI, (max(xs)-min(xs)+1)/DPI))
        print("fill:", px[450, mid])

# 「最近记录」标题居中？
def ink(q): return (q[0]+q[1]+q[2])/3 < 150
xs2 = [x for x in range(200, 700) if any(ink(px[x, y]) for y in range(125, 150))]
if xs2:
    print("title x %.1f..%.1f  centre %.1f (column centre 180)" % (min(xs2)/DPI, max(xs2)/DPI, (min(xs2)+max(xs2))/2/DPI))
