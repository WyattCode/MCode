"""Nudge the pad awake on a loop while it runs off its battery.

Android will not hold the screen on when nothing is plugged in -
stay_on_while_plugged_in is the only system mechanism and it needs power. This
does the crude thing instead: a wake key every few seconds.

The wireless debugging port changes whenever the pad reconnects, so a failed
nudge re-runs `adb connect` on the known port before giving up on that tick.
"""
import subprocess
import sys
import time

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
DEV = "192.168.10.173:35909"

INTERVAL = float(sys.argv[1]) if len(sys.argv) > 1 else 25.0
DEADLINE = time.time() + 60 * 60  # an hour


def run(*args, timeout=8):
    try:
        return subprocess.run([ADB, "-s", DEV, *args],
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


def woke():
    r = run("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    if r is not None and r.returncode == 0:
        return True
    # Port drifted: reconnect once, then retry.
    subprocess.run([ADB, "connect", DEV], capture_output=True, text=True, timeout=10)
    r = run("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    return r is not None and r.returncode == 0


while time.time() < DEADLINE:
    ok = woke()
    print(("nudged " if ok else "FAILED ") + time.strftime("%H:%M:%S"), flush=True)
    time.sleep(INTERVAL)
print("keepawake finished", flush=True)
