"""Pixel-space measurement helpers.

Every earlier helper took dp and multiplied by 2.5, which quietly clipped at the
image edge whenever a range ran past 1363dp - and a clipped range returned the
wrong answer instead of an error, so three "measurements" this pass were really
the range's own start. These take raw pixels, the way the screenshot is indexed.
"""
from PIL import Image

D = 2.5


def open_shot(name):
    return Image.open("D:/Documents/Claude Code/MCode/.workbuddy/shots/%s.png" % name).convert("RGB")


def px(dp):
    return int(round(dp * D))


def dp(v):
    return v / D


def ink(im, x0, y0, x1, y1, thr=150):
    """Ink box in pixels for a pixel-space window, returned in dp."""
    w, h = im.size
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    xs, ys = [], []
    for y in range(y0, y1):
        for x in range(x0, x1):
            p = im.getpixel((x, y))
            if (p[0] + p[1] + p[2]) / 3 < thr:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return (dp(min(xs)), dp(min(ys)), dp(max(xs)), dp(max(ys)))


def show(name, b):
    if not b:
        print("  %-24s --" % name)
        return
    print("  %-24s x %6.1f..%6.1f  y %6.1f..%6.1f   w %5.1f  h %5.1f" % (name, b[0], b[2], b[1], b[3], b[2] - b[0], b[3] - b[1]))


def firstink(im, x0, y0, x1, y1, thr=150):
    """Leftmost ink, in dp, searching down each column before moving right."""
    w, h = im.size
    x1, y1 = min(w, x1), min(h, y1)
    for x in range(max(0, x0), x1):
        for y in range(max(0, y0), y1):
            p = im.getpixel((x, y))
            if (p[0] + p[1] + p[2]) / 3 < thr:
                return dp(x)
    return None


def runs_y(im, x, y0, y1, tol=4):
    """Vertical colour runs at pixel column x, as (start_dp, end_dp, rgb)."""
    out, prev, start = [], None, y0
    for y in range(y0, min(im.size[1], y1)):
        p = im.getpixel((x, y))
        if prev is None or max(abs(a - b) for a, b in zip(p[:3], prev[:3])) > tol:
            if prev is not None:
                out.append((dp(start), dp(y - 1), prev))
            start, prev = y, p
    out.append((dp(start), dp(y1 - 1), prev))
    return [r for r in out if r[1] - r[0] > 0.6]


def runs_x(im, y, x0, x1, tol=4):
    out, prev, start = [], None, x0
    for x in range(x0, min(im.size[0], x1)):
        p = im.getpixel((x, y))
        if prev is None or max(abs(a - b) for a, b in zip(p[:3], prev[:3])) > tol:
            if prev is not None:
                out.append((dp(start), dp(x - 1), prev))
            start, prev = x, p
    out.append((dp(start), dp(x1 - 1), prev))
    return [r for r in out if r[1] - r[0] > 0.6]


def bands(im, x0, x1, y0, y1, thr=150, step=1, minh=1.0):
    """Text bands down a pixel-space window, in dp."""
    out, prev, start = [], False, y0
    for y in range(y0, min(im.size[1], y1)):
        has = False
        for x in range(x0, min(im.size[0], x1), step):
            p = im.getpixel((x, y))
            if (p[0] + p[1] + p[2]) / 3 < thr:
                has = True
                break
        if has and not prev:
            start = y
        if not has and prev and dp(y - start) >= minh:
            out.append((dp(start), dp(y - 1)))
        prev = has
    return out

# --- dp-facing wrappers -------------------------------------------------
# `ink`, `runs_x`, `runs_y` and `bands` take pixels. Calling them with dp was
# the mistake that made three rounds of this pass "measure" a window's own edge
# (a search from dp 115 looked at pixel 115, which is dp 46). These do the
# conversion once, so a caller can write the figure it reads off a screenshot.

def inkd(im, x0, y0, x1, y1, thr=150):
    """Ink box for a dp window.

    If the result's left edge equals x0 exactly, the window is clipping the
    mark - widen it and re-run before writing the number down. Three of this
    pass's "measurements" were really the window's own edge (46.4 was x0, not
    the title), and each one sent a fix in the wrong direction.
    """
    return ink(im, px(x0), px(y0), px(x1), px(y1), thr)


def runs_xd(im, y, x0, x1, tol=4):
    return runs_x(im, px(y), px(x0), px(x1), tol)


def runs_yd(im, x, y0, y1, tol=4):
    return runs_y(im, px(x), px(y0), px(y1), tol)


def bandsd(im, x0, x1, y0, y1, thr=150, minh=1.0):
    return bands(im, px(x0), px(x1), px(y0), px(y1), thr, 1, minh)


def firstinkd(im, x0, y0, x1, y1, thr=150):
    return firstink(im, px(x0), px(y0), px(x1), px(y1), thr)
