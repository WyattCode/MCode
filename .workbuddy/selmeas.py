"""Measure a selection's own pixels, so a change can be read rather than guessed.

The wash is #DEBFAF and the handles #AE6B4E; both were sampled from the pad's own
screenshot rather than from a design token, so these are the real rendered values.
"""
import sys
from PIL import Image
from collections import Counter

SHOT = sys.argv[1] if len(sys.argv) > 1 else ".workbuddy/shots/live-03.png"
im = Image.open(SHOT).convert("RGB")


def is_wash(p):
    return abs(p[0] - 217) < 14 and abs(p[1] - 192) < 14 and abs(p[2] - 177) < 14


def is_handle(p):
    return abs(p[0] - 174) < 22 and abs(p[1] - 107) < 22 and abs(p[2] - 78) < 22


xs, ys = [], []
for y in range(0, 2272, 1):
    row = [x for x in range(1200, 3300, 1) if is_wash(im.getpixel((x, y)))]
    if row:
        xs += [min(row), max(row)]
        ys.append(y)

print("wash pixels:", "none" if not xs else f"x {min(xs)}..{max(xs)}  y {min(ys)}..{max(ys)}  rows {len(ys)}")

hx, hy = [], []
for y in range(0, 2272, 1):
    row = [x for x in range(1200, 3300, 1) if is_handle(im.getpixel((x, y)))]
    if row:
        hx += [min(row), max(row)]
        hy.append(y)
print("handles:", "none" if not hx else f"x {min(hx)}..{max(hx)}  y {min(hy)}..{max(hy)}")

# The pill, found by its own fill rather than by proximity to anything else.
px, py = [], []
for y in range(1300, 2200):
    row = [x for x in range(1500, 2600) if (lambda p: abs(p[0]-234)<6 and abs(p[1]-223)<6 and abs(p[2]-230)<6)(im.getpixel((x, y)))]
    if len(row) > 40:
        px += [min(row), max(row)]
        py.append(y)
if px:
    print("pill: x %d..%d w %d   y %d..%d h %d   (dp %.1f x %.1f at 2.5 px/dp)"
          % (min(px), max(px), max(px)-min(px)+1, min(py), max(py), max(py)-min(py)+1,
             (max(px)-min(px)+1)/2.5, (max(py)-min(py)+1)/2.5))
