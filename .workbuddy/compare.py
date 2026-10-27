"""Open an app on the target device and grab the screen."""
import sys
import time

sys.path.insert(0, "D:/Documents/Claude Code/MCode/.workbuddy")
import fold

SHOTS = r"D:/Documents/Claude Code/MCode/.workbuddy/shots"

APPS = {
    "claude": "com.anthropic.claude/com.anthropic.claude.mainactivity.MainActivity",
    "mcode": "com.mcode.remote/.MainActivity",
}


def shot(name):
    fold.ensure()
    fold.adb("shell", "screencap -p /sdcard/_s.png")
    out = f"{SHOTS}/{name}.png"
    fold.adb("pull", "/sdcard/_s.png", out)
    print("captured", out)
    return out


def open_app(which):
    fold.ensure()
    fold.adb("shell", f"am start -n {APPS[which]}")
    time.sleep(6)


if __name__ == "__main__":
    action = sys.argv[1]
    if action in APPS:
        open_app(action)
        shot(sys.argv[2] if len(sys.argv) > 2 else action)
    else:
        shot(action)