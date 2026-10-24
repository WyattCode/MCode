from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/D0.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    def ink(q): return (q[0]+q[1]+q[2])/3 < 120
    # 卡内标题文字（x 200..700，排除图标块）
    rows = [y for y in range(600, 2200) if any(ink(px[x, y]) for x in range(200, 760))]
    if not rows:
        print(name, "none"); continue
    groups = []
    cur = [rows[0]]
    for a, b in zip(rows, rows[1:]):
        if b - a <= 8:
            cur.append(b)
        else:
            groups.append(cur); cur = [b]
    groups.append(cur)
    tops = [g[0] for g in groups]
    print("%-6s text bands at dp: %s" % (name, [round(t/DPI,1) for t in tops[:9]]))
    if len(tops) >= 3:
        pitches = [round((tops[i+1]-tops[i])/DPI,1) for i in range(min(4,len(tops)-1))]
        print("       pitches: %s" % pitches)
