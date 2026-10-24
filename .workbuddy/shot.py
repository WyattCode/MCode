"""Screenshot the pad, retrying until the page itself is on screen."""
import os
import subprocess
import sys
import time

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
DEV = "192.168.10.173:35909"
OUT = sys.argv[1] if len(sys.argv) > 1 else ".workbuddy/shots/shot.png"

ENV = dict(os.environ)
ENV["MSYS_NO_PATHCONV"] = "1"


def sh(*a):
    return subprocess.run([ADB, "-s", DEV, *a], capture_output=True, text=True, env=ENV)


def grab():
    sh("shell", "screencap -p /sdcard/s.png")
    return sh("pull", "/sdcard/s.png", OUT).returncode == 0


def page_is_up():
    """The MCode page is #F9F9F7; a lock screen or a black frame is not."""
    from PIL import Image
    im = Image.open(OUT).convert("RGB")
    hit = 0
    for y in range(200, 2100, 60):
        for x in range(300, 3300, 100):
            r, g, b = im.getpixel((x, y))
            if 240 <= r <= 255 and 240 <= g <= 255 and 238 <= b <= 252:
                hit += 1
    return hit > 300


for attempt in range(8):
    sh("shell", "input keyevent 224")
    time.sleep(1)
    sh("shell", "input swipe 1136 2100 1136 500 140")
    time.sleep(1)
    sh("shell", "am start -n com.mcode.remote/.MainActivity")
    time.sleep(4)
    if grab() and page_is_up():
        print("ok on attempt", attempt + 1)
        break
    print("attempt", attempt + 1, "not the page yet")
else:
    print("gave up: screen stayed dark")
