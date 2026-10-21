"""Measure one screen of either app off the pad and print its geometry in dp.

The method that finally worked on the composer: do not reason about the
layout, scan the pixels. Two numbers always come out - where the box's edges
are, and where the rows inside it sit - and those are what a 1:1 copy needs.

Usage:
    python .workbuddy/measure.py claude sidebar   # Claude's list screen
    python .workbuddy/measure.py mcode  sidebar   # ours, same screen
    python .workbuddy/measure.py compare          # both, side by side

`shot` writes .workbuddy/shots/<app>_<screen>.png so runs can be compared
later without going back to the device.
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pad  # noqa: E402

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
ENV = dict(os.environ)
ENV.pop("ELECTRON_RUN_AS_NODE", None)

APPS = {
    "claude": "com.anthropic.claude",
    "mcode": "com.mcode.remote",
}
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")

# Pixels per dp. The pad reports 400 dpi, so a dp is 2.5 px - not the 3.156
# (3408 over the 1080 a screenshot is nominally named at) that every figure in
# this file used to be divided by. That factor inflated every dp reading by 26%,
# which is why so many "measured" values were a quarter too large: the composer
# was written to 79dp of card where Claude's is 63, the transcript to 112dp of
# inset where Claude's is 89. Confirmed by inverting a value this app sets
# itself: `contentPadding(start = 112.dp)` inside a pane starting at 925 px puts
# the text's left edge at 925 + 112 * 2.5 = 1205 px, and the screenshot shows
# 1207. `wm density` says 400; that is the number to trust.
DENSITY = 400 / 160.0


def launch(which):
    pkg = APPS[which]
    pad.sh("monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(3.2)


def shot(which, screen):
    os.makedirs(SHOTS, exist_ok=True)
    local = os.path.join(SHOTS, f"{which}_{screen}.png")
    pad.sh("screencap", "-p", f"/sdcard/m_{which}.png")
    subprocess.run([ADB, "-s", pad.ENDPOINT, "pull", f"/sdcard/m_{which}.png", local], capture_output=True, env=ENV)
    return local


def dp(px):
    return px / DENSITY


def edges_down(im, x, y0, y1, threshold=4):
    """Vertical edges in one column: where the colour steps by more than `threshold`."""
    out = []
    prev = None
    for y in range(y0, y1):
        p = im.getpixel((x, y))[:3]
        if prev is not None and abs(p[0] - prev[0]) > threshold:
            out.append(y)
        prev = p
    return out


def edges_across(im, y, x0, x1, threshold=4):
    """Horizontal edges along one row - box left and right edges, text starts."""
    out = []
    prev = None
    for x in range(x0, x1):
        p = im.getpixel((x, y))[:3]
        if prev is not None and abs(p[0] - prev[0]) > threshold:
            out.append(x)
        prev = p
    return out


def rows(im, x0, x1, y0, y1, ink=520, least=3, step=4):
    """Bands of content: rows holding more than `least` dark pixels.

    This is the reading that matters - `[15.8, 44.0]` against a reference's
    `[16.5, 44.7]` says whether a card's inside is right, in one number pair.
    """
    bands = []
    start = None
    for y in range(y0, y1):
        count = sum(1 for x in range(x0, x1, step) if sum(im.getpixel((x, y))[:3]) < ink)
        if count > least:
            if start is None:
                start = y
        elif start is not None:
            bands.append((start, y - 1))
            start = None
    if start is not None:
        bands.append((start, y1 - 1))
    return bands


def colours(im, points):
    return {name: im.getpixel((x, y))[:3] for name, (x, y) in points.items()}


def hexof(rgb):
    return "#%02X%02X%02X" % rgb


def report(which, screen, im):
    print(f"=== {which} / {screen}  ({im.size[0]}x{im.size[1]}) ===")
    # The page's own fill, well away from any card.
    print(f"  page      {hexof(im.getpixel((im.size[0] // 2, 300))[:3])}")
    for y in (200, 600, 1200, 1800):
        e = edges_across(im, y, 0, im.size[0])
        if e:
            print(f"  row y={y:4} edges at dp: " + ", ".join(f"{dp(x):.1f}" for x in e[:8]))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    if sys.argv[1] == "compare" and len(sys.argv) > 2:
        screen = sys.argv[2]
        launch("claude")
        a = shot("claude", screen)
        launch("mcode")
        b = shot("mcode", screen)
    else:
        which = sys.argv[1]
        screen = sys.argv[2] if len(sys.argv) > 2 else "screen"
        launch(which)
        path = shot(which, screen)
        from PIL import Image

        report(which, screen, Image.open(path))
        return

    from PIL import Image

    report("claude", screen, Image.open(a))
    report("mcode", screen, Image.open(b))


if __name__ == "__main__":
    main()