from PIL import Image
DPI = 2.5

def probe(path, name):
    im = Image.open(path).convert("RGB")
    px = im.load()
    print("---", name)
    def line(q):
        m = (q[0] + q[1] + q[2]) / 3
        return 218 <= m <= 246
    hits = []
    for y in range(330, 460):
        xs = [x for x in range(30, 880) if line(px[x, y])]
        if len(xs) > 600:
            hits.append((y, min(xs), max(xs)))
    for y, a, b in hits[:4]:
        print("  hline y %.1f dp   x %.1f..%.1f" % (y/DPI, a/DPI, b/DPI))
    if hits:
        print("  card top = %.1f dp" % (hits[0][0]/DPI))

probe(".workbuddy/shots/A_claude.png", "Claude")
probe(".workbuddy/shots/V1.png", "Mine")
