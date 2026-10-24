from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

# 找胶囊的白色填充区（比页面 #F9F9F7 更白，或就是纯白）
print("horizontal rows in capsule area:")
for y in range(370, 450, 4):
    seg = []
    prev = None
    for x in range(30, 400):
        q = px[x, y]
        m = (q[0]+q[1]+q[2])/3
        cat = "PAGE" if m >= 248 else ("LINE" if 220 <= m < 240 else ("FILL" if 240 <= m < 248 else "INK"))
        if cat != prev:
            seg.append((x/DPI, cat, q))
            prev = cat
    print(" y%.0f dp: %s" % (y/DPI, seg[:6]))
