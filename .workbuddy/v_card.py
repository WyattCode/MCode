from PIL import Image
DPI = 2.5
for name, path in (("Claude", ".workbuddy/shots/A_claude.png"), ("Mine", ".workbuddy/shots/C0.png")):
    im = Image.open(path).convert("RGB")
    px = im.load()
    for y in (700, 760):
        row = [(x, px[x, y]) for x in range(0, 900)]
        nb = [(x, q) for x, q in row if q != (249, 249, 247)]
        if nb and nb[-1][0] > 800:
            print("%-6s y=%.0fdp  card x %.1f..%.1f  edge colour %s"
                  % (name, y/DPI, nb[0][0]/DPI, nb[-1][0]/DPI, nb[0][1]))
