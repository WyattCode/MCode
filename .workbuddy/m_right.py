from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def dark(q):
    return (q[0] + q[1] + q[2]) / 3 < 150

# paragraph line
rows = {}
for y in range(300, 430):
    xs = [x for x in range(950, 2100) if dark(px[x, y])]
    if xs:
        rows[y] = (min(xs), max(xs))
if rows:
    ys = sorted(rows)
    print("para y %.1f..%.1f h=%.1f dp" % (ys[0]/DPI, ys[-1]/DPI, (ys[-1]-ys[0]+1)/DPI))
    print("  x0 %.1f dp  -> inset %.1f dp from 360" % (rows[ys[0]][0]/DPI, rows[ys[0]][0]/DPI - 360))

# tool row
tr = {}
for y in range(230, 305):
    xs = [x for x in range(950, 1600) if dark(px[x, y])]
    if xs:
        tr[y] = (min(xs), max(xs))
if tr:
    ys = sorted(tr)
    print("tool row y %.1f..%.1f h=%.1f dp x0=%.1f" % (ys[0]/DPI, ys[-1]/DPI, (ys[-1]-ys[0]+1)/DPI, tr[ys[0]][0]/DPI))
