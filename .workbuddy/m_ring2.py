from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()
def ink(q): return (q[0]+q[1]+q[2])/3 < 200
# 图标区域 x 40..130, y 690..760
pts = [(x,y) for y in range(670,790) for x in range(38,140) if ink(px[x,y])]
if pts:
    xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
    print("mark x %.1f..%.1f  W %.1f" % (min(xs)/DPI, max(xs)/DPI, (max(xs)-min(xs)+1)/DPI))
    print("mark y %.1f..%.1f  H %.1f" % (min(ys)/DPI, max(ys)/DPI, (max(ys)-min(ys)+1)/DPI))
    print("colour sample:", px[(min(xs)+max(xs))//2, min(ys)+2])
