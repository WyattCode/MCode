from PIL import Image
DPI = 2.5
for name, path, cy in (("Claude", ".workbuddy/shots/A_claude.png", 163),
                       ("Mine", ".workbuddy/shots/C2.png", 172)):
    im = Image.open(path).convert("RGB")
    px = im.load()
    y = int(cy * DPI)
    # 胶囊内部填充 = 非 PAGE。从中心向外找边界
    def is_page(q):
        return abs(q[0]-249) <= 1 and abs(q[1]-249) <= 1 and abs(q[2]-247) <= 1
    cx = 200
    if is_page(px[cx, y]):
        # 找中心附近非 page 的点
        for xc in range(120, 400):
            if not is_page(px[xc, y]):
                cx = xc
                break
    # 向左
    xl = cx
    while xl > 10 and not is_page(px[xl-1, y]):
        xl -= 1
    xr = cx
    while xr < 880 and not is_page(px[xr+1, y]):
        xr += 1
    print("%-6s capsule x %.1f..%.1f dp   W %.1f   fill %s"
          % (name, xl/DPI, xr/DPI, (xr-xl+1)/DPI, px[(xl+xr)//2, y]))
