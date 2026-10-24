from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/v3.png").convert("RGB")
px = im.load()

def ink(q):
    return (q[0] + q[1] + q[2]) / 3 < 170

# 用户气泡 "hello-there" 的右边缘，用它推列右界
rows = [y for y in range(130, 260) if any(ink(px[x, y]) for x in range(2400, 3300))]
if rows:
    xs = [x for x in range(2400, 3350) if any(ink(px[x, y]) for y in rows)]
    print("bubble ink x %.1f..%.1f dp" % (min(xs)/DPI, max(xs)/DPI))

# 右栏宽度
print("screen width dp = %.1f" % (3408/DPI))
print("pane width dp = %.1f (from 360)" % (3408/DPI - 360))
print("centred 812 column -> left edge at 360 + (%.1f-812)/2 = %.1f"
      % (3408/DPI - 360, 360 + ((3408/DPI - 360) - 812)/2))
