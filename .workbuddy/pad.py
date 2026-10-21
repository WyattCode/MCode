"""adb that survives the pad's wireless debugging dropping between concepts.

Wireless debugging on this tablet tears the transport down whenever its socket
goes idle, and every helper here runs as its own process, so `adb devices` sees
an empty list at random. This retries the connect, waits for the device, and
then runs the command - so a helper never fails on the connection alone.
"""
import os
import subprocess
import sys
import time

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
ENDPOINT = os.environ.get("MCODE_ENDPOINT", "192.168.10.173:35317")
ENV = dict(os.environ)
ENV.pop("ELECTRON_RUN_AS_NODE", None)


def _run(args, timeout=60):
    return subprocess.run([ADB, *args], capture_output=True, text=True, timeout=timeout, env=ENV)


def ensure(attempts=4):
    for _ in range(attempts):
        listed = _run(["devices"]).stdout
        if ENDPOINT in listed and "device" in listed.split(ENDPOINT, 1)[1].split("\n", 1)[0]:
            return True
        _run(["connect", ENDPOINT])
        time.sleep(1.4)
    listed = _run(["devices"]).stdout
    return ENDPOINT in listed


def sh(*args, timeout=90):
    """`adb -s ENDPOINT shell …`, after making sure the endpoint is attached."""
    ensure()
    return _run(["-s", ENDPOINT, "shell", *args], timeout=timeout)


def tap(x, y, wait=0.0):
    sh("input", "tap", str(x), str(y))
    if wait:
        time.sleep(wait)


def shot(name):
    sh("screencap", "-p", "/sdcard/_q.png")
    out = f"D:/Documents/Claude Code/MCode/.workbuddy/shots/{name}.png"
    ensure()
    _run(["pull", "/sdcard/_q.png", out])
    print("captured", out)
    return out


def keep_awake():
    """
    Holds the pad on: no screen timeout, no lock screen, no screensaver.

    The pad used to fall asleep mid-test, and its lock screen took a password
    that adb cannot type - so every run lost minutes waiting for a human, and a
    screenshot of a sleeping screen is black whether the app is working or not.
    `stay_on_while_plugged_in` is 7 (AC + USB + wireless) rather than 15 so a
    pad on a charger with the screen dimmed stays on too.

    `locksettings set-disabled true` is the half that matters and the half that
    is easy to miss: the timeout alone still leaves a swipe-to-unlock screen.
    Restore with `locksettings set-disabled false`.
    """
    for args in (
        ("settings", "put", "system", "screen_off_timeout", "2147483647"),
        ("settings", "put", "global", "stay_on_while_plugged_in", "7"),
        ("settings", "put", "secure", "screensaver_enabled", "0"),
        ("settings", "put", "secure", "screensaver_activate_on_sleep", "0"),
        ("locksettings", "set-disabled", "true"),
    ):
        sh(*args)
    return {
        "timeout": sh("settings", "get", "system", "screen_off_timeout").stdout.strip(),
        "stay_on": sh("settings", "get", "global", "stay_on_while_plugged_in").stdout.strip(),
        "screensaver": sh("settings", "get", "secure", "screensaver_enabled").stdout.strip(),
    }


def wake():
    """Brings the screen up. KEYCODE_POWER rather than KEYCODE_WAKEUP: the latter
    is ignored often enough on this pad that a run silently read a black screen."""
    state = sh("dumpsys", "power").stdout
    if "mWakefulness=Awake" not in state:
        sh("input", "keyevent", "KEYCODE_POWER")
        time.sleep(2.0)
    return sh("dumpsys", "power").stdout.split("mWakefulness=")[-1].split("\n")[0].strip()


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "shot":
        shot(sys.argv[2])
    elif cmd == "tap":
        tap(int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]) if len(sys.argv) > 4 else 0.8)
    elif cmd == "sh":
        print(sh(*sys.argv[2:]).stdout)
    elif cmd == "awake":
        print(keep_awake())
    elif cmd == "wake":
        print(wake())
    else:
        print(ensure())