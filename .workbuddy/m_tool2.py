from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 190

for label, y0, y1 in (("toolrow", 266, 292), ("para", 226, 258)):
    xs = [x for x in range(950, 2200) if any(ink(px[x, y]) for y in range(y0, y1))]
    if xs:
        print("%-8s x %.1f..%.1f  inset %.1f dp" % (label, min(xs)/DPI, max(xs)/DPI, min(xs)/DPI - 360))
