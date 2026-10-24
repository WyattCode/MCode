from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D0.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 卡片上边框是横线：在 y 250..900 找"该行 x 300..800 全是 (248,248,246)"
    lines = []
    for y in range(250, 950):
        seg = [px[x, y] for x in range(300, 800, 10)]
        if all(abs(q[0]-248) <= 1 and abs(q[2]-246) <= 1 for q in seg):
            lines.append(y)
    # 分组
    if lines:
        g = []
        cur = [lines[0]]
        for a, b in zip(lines, lines[1:]):
            if b - a <= 3:
                cur.append(b)
            else:
                g.append(cur[0]); cur = [b]
        g.append(cur[0])
        print("%-6s hlines at dp: %s" % (name, [round(v/DPI,1) for v in g[:8]]))
