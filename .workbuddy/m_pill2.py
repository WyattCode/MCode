from PIL import Image
DPI = 2.5
for name, path, yc in (("Claude", ".workbuddy/shots/CLAUDE-CODE.png", 171),
                       ("Mine", ".workbuddy/shots/MINE-CODE.png", 171)):
    im = Image.open(path).convert("RGB")
    px = im.load()
    y = int(yc * DPI)
    # 胶囊描边 (225,225,223) 在该行左右边界
    xs = [x for x in range(5, 880) if abs(px[x, y][0]-225) < 8 and abs(px[x, y][2]-223) < 8]
    if xs:
        print("%-6s pill y=%d  edges at x %s dp"
              % (name, y, [round(x/DPI,1) for x in xs[:6]]))
        print("       left %.1f  right %.1f  W %.1f"
              % (min(xs)/DPI, max(xs)/DPI, (max(xs)-min(xs)+1)/DPI))
