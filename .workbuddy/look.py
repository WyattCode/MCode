"""Screenshot / tap helpers that never restart the app."""
import sys, time
sys.path.insert(0, "D:/Documents/Claude Code/MCode/.workbuddy")
import fold

SHOTS = r"D:/Documents/Claude Code/MCode/.workbuddy/shots"


def shot(name):
    fold.ensure()
    fold.adb("shell", "screencap -p /sdcard/_s.png")
    out = f"{SHOTS}/{name}.png"
    fold.adb("pull", "/sdcard/_s.png", out)
    print("captured", out)
    return out


if __name__ == "__main__":
    if sys.argv[1] == "shot":
        shot(sys.argv[2])
    elif sys.argv[1] == "tap":
        fold.ensure()
        fold.tap(int(sys.argv[2]), int(sys.argv[3]))
        time.sleep(1.0)
        shot(sys.argv[4] if len(sys.argv) > 4 else "tap")
    elif sys.argv[1] == "text":
        fold.ensure()
        fold.adb("shell", "input text '%s'" % sys.argv[2])
        time.sleep(1.0)
        shot(sys.argv[3] if len(sys.argv) > 3 else "text")