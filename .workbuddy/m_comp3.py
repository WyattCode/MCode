from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/v4.png").convert("RGB")
px = im.load()

def isline(q):
    return 225 <= q[0] <= 242 and 225 <= q[1] <= 242 and 222 <= q[2] <= 240

ys = [y for y in range(1900, 2272) if isline(px[1600, y])]
if ys:
    mid = (min(ys) + max(ys)) // 2
    xs = [x for x in range(900, 3408) if isline(px[x, mid])]
    if xs:
        print("mine composer x %.1f..%.1f  left %.1f right %.1f"
              % (min(xs)/DPI, max(xs)/DPI, min(xs)/DPI - 360, 3408/DPI - max(xs)/DPI))
print("target: left 36.8 right 13.2")
