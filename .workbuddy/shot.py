"""Take one screenshot without touching the app.

`see.py` walks the device back to awake and re-launches the activity, which is
right before a run and wrong in the middle of one: `am start` on this activity
builds a second instance, so any sheet that was open is gone and every
`remember` in it is back to its initial value. This only captures.
"""
import subprocess
import sys

sys.path.insert(0, "D:/Documents/Claude Code/MCode/.workbuddy")
import fold

SHOTS = r"D:/Documents/Claude Code/MCode/.workbuddy/shots"


def shot(name):
    fold.adb("shell", "screencap -p /sdcard/_q.png")
    out = f"{SHOTS}/{name}.png"
    fold.adb("pull", "/sdcard/_q.png", out)
    print("captured", out)
    return out


if __name__ == "__main__":
    shot(sys.argv[1] if len(sys.argv) > 1 else "shot")