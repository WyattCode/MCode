from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/v2.png").convert("RGB")
px = im.load()
W, H = im.size

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 右栏起点：找左栏与右栏的分界（背景色变化）
left_bg = px[400, 400]
edge = None
for x in range(850, 1000):
    p = px[x, 400]
    if abs(p[0]-left_bg[0]) > 3 or abs(p[1]-left_bg[1]) > 3:
        edge = x
        break
print("pane edge px:", edge, "dp:", edge/DPI if edge else None)

# 右栏第一块正文墨迹的 x0
best = None
for y in range(300, 1500):
    xs = [x for x in range(edge or 900, W-20) if ink(px[x, y])]
    if len(xs) > 6:
        best = (y, min(xs))
        break
print("first prose row:", best)
if best and edge:
    print("  inset from pane: %.1f dp" % (best[1]/DPI - edge/DPI))
