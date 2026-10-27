"""Walk Claude's drawer and capture each page it opens."""
import subprocess
import sys
import time

sys.path.insert(0, "D:/Documents/Claude Code/MCode/.workbuddy")
import fold

SHOTS = r"D:/Documents/Claude Code/MCode/.workbuddy/shots"
CLAUDE = "com.anthropic.claude/com.anthropic.claude.mainactivity.MainActivity"

# Where each drawer row sits, measured from the drawer dump.
ROWS = {
    "projects": (150, 300),
    "code": (150, 440),
    "artifacts": (150, 580),
    "scheduled": (150, 720),
    "main": (150, 975),
}


def shot(name):
    fold.adb("shell", "screencap -p /sdcard/_s.png")
    out = f"{SHOTS}/{name}.png"
    fold.adb("pull", "/sdcard/_s.png", out)
    print("captured", out)


if __name__ == "__main__":
    fold.ensure()
    fold.adb("shell", f"am start -n {CLAUDE}")
    time.sleep(5)
    for page, (x, y) in ROWS.items():
        # Open the drawer, then the row.
        fold.tap(70, 140)
        time.sleep(1.5)
        fold.tap(x, y)
        time.sleep(3)
        shot(f"claude_{page}")