from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/final-list.png").convert("RGB")
px = im.load()

def dark(q):
    return (q[0] + q[1] + q[2]) / 3 < 150

# 右栏正文起点：找第一段深色文字的 x
found = None
for y in range(300, 900):
    xs = [x for x in range(950, 2600) if dark(px[x, y])]
    if xs:
        found = (y, min(xs))
        break
print("first ink row:", found)
if found:
    print("  x0 %.1f dp -> inset %.1f from 360" % (found[1] / DPI, found[1] / DPI - 360))
