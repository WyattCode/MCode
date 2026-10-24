from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D0.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    # 用卡片左边缘竖线：x=32 (12dp*2.5=30)
    for x in (30, 32, 34):
        ys = [y for y in range(330, 900) if px[x, y] == (248, 248, 246)]
        if len(ys) > 20:
            # 分段
            groups = []
            cur = [ys[0]]
            for a, b in zip(ys, ys[1:]):
                if b - a <= 4:
                    cur.append(b)
                else:
                    groups.append((cur[0], cur[-1]))
                    cur = [b]
            groups.append((cur[0], cur[-1]))
            print("%-6s x=%d card bands:" % (name, x))
            for t, b in groups[:3]:
                print("        y %.1f..%.1f  H %.1f" % (t/DPI, b/DPI, (b-t+1)/DPI))
            break
