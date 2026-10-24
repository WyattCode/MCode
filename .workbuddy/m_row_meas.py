from PIL import Image
DPI = 2.5

def probe(path, name, y0, y1):
    im = Image.open(path).convert("RGB")
    px = im.load()
    def ink(q): return (q[0]+q[1]+q[2])/3 < 150
    rows = {}
    for y in range(y0, y1):
        xs = [x for x in range(10, 880) if ink(px[x, y])]
        if len(xs) >= 2:
            rows[y] = (min(xs), max(xs))
    ys = sorted(rows)
    gs = []; cur = [ys[0]]
    for a, b in zip(ys, ys[1:]):
        if b - a <= 6: cur.append(b)
        else: gs.append(cur); cur = [b]
    gs.append(cur)
    print("---", name)
    for g in gs[:4]:
        top, bot = g[0], g[-1]
        x0 = min(rows[y][0] for y in g); x1 = max(rows[y][1] for y in g)
        print("   y%6.1f..%6.1f  h%5.1f  x%6.1f..%6.1f"
              % (top/DPI, bot/DPI, (bot-top+1)/DPI, x0/DPI, x1/DPI))

probe(".workbuddy/shots/CLAUDE-1.png", "CLAUDE 首行拆解", 420, 560)
probe(".workbuddy/shots/M-REC6.png", "MINE 首行拆解", 440, 580)
