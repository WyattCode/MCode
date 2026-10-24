from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D1.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    def ink(q): return (q[0]+q[1]+q[2])/3 < 150
    # 右栏顶栏 y 60..140
    xs = [x for x in range(890, 3400) if any(ink(px[x, y]) for y in range(60, 140))]
    if xs:
        print("%-6s top row ink x %.1f..%.1f dp" % (name, min(xs)/DPI, max(xs)/DPI))
        # 分段
        seg = []; cur = [xs[0]]
        for a, b in zip(xs, xs[1:]):
            if b - a <= 20: cur.append(b)
            else: seg.append((cur[0], cur[-1])); cur = [b]
        seg.append((cur[0], cur[-1]))
        print("       segments: %s" % [(round(a/DPI,1), round(b/DPI,1)) for a,b in seg[:6]])
