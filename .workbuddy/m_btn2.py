from PIL import Image
DPI = 2.5

def find_capsule(path, name):
    im = Image.open(path).convert("RGB")
    px = im.load()
    W, H = im.size
    # 按钮是近乎黑的实心块：r,g,b 都 < 60
    rows = {}
    for y in range(1700, H):
        xs = [x for x in range(0, 900) if max(px[x, y]) < 60]
        if len(xs) > 100:      # 一条实心横带
            rows[y] = (min(xs), max(xs))
    if not rows:
        print(name, "none")
        return
    ys = sorted(rows)
    # 取最厚的一段
    groups = []
    cur = [ys[0]]
    for a, b in zip(ys, ys[1:]):
        if b - a <= 3:
            cur.append(b)
        else:
            groups.append(cur)
            cur = [b]
    groups.append(cur)
    g = max(groups, key=len)
    x0 = min(rows[y][0] for y in g)
    x1 = max(rows[y][1] for y in g)
    print("%-6s y %.1f..%.1f (h %.1f)  x %.1f..%.1f (w %.1f)  centre %.1f"
          % (name, g[0]/DPI, g[-1]/DPI, (g[-1]-g[0]+1)/DPI,
             x0/DPI, x1/DPI, (x1-x0+1)/DPI, (x0+x1)/2/DPI))

find_capsule(".workbuddy/shots/A_claude.png", "Claude")
find_capsule(".workbuddy/shots/NOW.png", "Mine")
print("column width 360 dp -> centre should be 180.0")
