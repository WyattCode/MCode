from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

def dark(q):
    return (q[0] + q[1] + q[2]) / 3 < 150

# "Drop the Lv1" 那行真实位置（y 大概 149-168 或 328）
for label, yr in (("Drop Lv1", range(140, 175)), ("美容师功能", range(228, 255))):
    xs = [x for x in range(950, 2200) if any(dark(px[x, y]) for y in yr)]
    if xs:
        print("%-10s x %.1f..%.1f  inset %.1f dp" % (label, min(xs)/DPI, max(xs)/DPI, min(xs)/DPI - 360))

# 右栏起点确认
bg = px[1200, 300]
print("right pane bg:", bg)
edge = None
for x in range(880, 960):
    if px[x, 300] != bg:
        edge = x
        break
print("pane left edge px:", edge, "=", (edge / DPI if edge else None))
