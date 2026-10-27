from PIL import Image
DPI = 2.5

def cap(path, name):
    im = Image.open(path).convert("RGB")
    px = im.load()
    H = im.height
    rows = {}
    for y in range(2050, min(H, 2250)):
        xs = [x for x in range(0, 900) if max(px[x, y]) < 60]
        if len(xs) > 80:
            rows[y] = (min(xs), max(xs))
    ys = sorted(rows)
    g = [ys[0]]
    for a, b in zip(ys, ys[1:]):
        if b - a <= 3:
            g.append(b)
        else:
            break
    x0 = min(rows[y][0] for y in g)
    x1 = max(rows[y][1] for y in g)
    print("%-6s  x %.1f .. %.1f dp   w %.1f   LEFT MARGIN %.1f   RIGHT MARGIN %.1f"
          % (name, x0/DPI, x1/DPI, (x1-x0+1)/DPI, x0/DPI, (900-x1)/DPI))
    print("        y %.1f .. %.1f   h %.1f" % (g[0]/DPI, g[-1]/DPI, (g[-1]-g[0]+1)/DPI))

cap(".workbuddy/shots/A_claude.png", "Claude")
cap(".workbuddy/shots/V1.png", "Mine")
print()
print("column = 900 px = 360 dp")
