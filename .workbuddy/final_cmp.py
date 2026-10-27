from PIL import Image
DPI = 2.5
def bands(path, name, y1=1400):
    im = Image.open(path).convert("RGB"); px = im.load()
    def ink(q): return (q[0]+q[1]+q[2])/3 < 150
    rows = {}
    for y in range(80, y1):
        xs = [x for x in range(5, 890) if ink(px[x, y])]
        if len(xs) >= 2: rows[y] = (min(xs), max(xs))
    ys = sorted(rows); gs=[]; cur=[ys[0]]
    for a,b in zip(ys, ys[1:]):
        if b-a<=8: cur.append(b)
        else: gs.append(cur); cur=[b]
    gs.append(cur)
    out=[(g[0]/DPI, g[-1]/DPI, min(rows[y][0] for y in g)/DPI, max(rows[y][1] for y in g)/DPI) for g in gs]
    print("---", name)
    for b in out[:10]:
        print("   y%6.1f..%6.1f h%5.1f  x%6.1f..%6.1f" % (b[0],b[1],b[1]-b[0]+0.4,b[2],b[3]))
    return out

r = bands(".workbuddy/shots/CLAUDE-1.png", "CLAUDE")
m = bands(".workbuddy/shots/V3.png", "MINE")
