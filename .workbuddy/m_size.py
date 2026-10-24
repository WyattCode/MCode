from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# "Drop the Lv1 杨格斯 (throwaway reward pet) to free a slot." 这行英文
# 它在 y 一百多那里，先找它
for y0, y1, name in ((140, 180, "Drop the Lv1"), (580, 620, "正在读取")):
    rows = [y for y in range(y0, y1) if any(ink(px[x, y]) for x in range(1000, 3000))]
    if rows:
        h = (max(rows) - min(rows) + 1) / DPI
        print("%-12s ink h = %.1f dp" % (name, h))
