from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def green(q):
    return q[1] > q[0] + 12 and q[1] > q[2] + 12

rows = [y for y in range(600, 900) if any(green(px[x, y]) for x in range(50, 900))]
print("green rows dp:", [round(y/DPI, 1) for y in rows][:20])
if rows:
    y0, y1 = min(rows), max(rows)
    xs = [x for x in range(50, 900) if any(green(px[x, y]) for y in range(y0, y1+1))]
    print("green x %.1f..%.1f dp" % (min(xs)/DPI, max(xs)/DPI))
    print("green colour:", px[(min(xs)+max(xs))//2, (y0+y1)//2])
