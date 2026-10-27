from PIL import Image
DPI = 2.5
im = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
px = im.load()

# 胶囊 y 146.4..177.6dp -> 366..444px, x 30.0..116.8dp -> 75..292px
print("vertical scan at x=180px (inside capsule):")
prev = None
for y in range(350, 460):
    q = px[180, y]
    if q != prev:
        print("  y %5.1f dp  %s" % (y/DPI, q))
        prev = q
print()
print("fill at centre:", px[180, 405])
print("horizontal scan at y=405:")
prev = None
for x in range(60, 320):
    q = px[x, 405]
    if q != prev:
        print("  x %5.1f dp  %s" % (x/DPI, q))
        prev = q
