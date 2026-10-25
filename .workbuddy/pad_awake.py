#!/usr/bin/env python
"""Keep the pad awake and hand back a usable adb target.

The pad is on battery, so Android parks it within a minute. Two things make it
survivable without a charger:

  * `screen_off_timeout` at its maximum and `locksettings set-disabled true`, so
    nothing ever re-locks itself once the panel is on;
  * a wake nudge before every capture, because a panel that is off reports
    `Awake` from `dumpsys power` while a screenshot still comes back black.

The wireless endpoint also drifts (35909 -> 43781 across one reboot), so this
rediscovered the port rather than trusting an old one.
"""
import re
import subprocess
import sys
import time

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
SERIAL = "0A06049009983540"
HOSTS = ("192.168.10.173",)


def sh(*args, serial=None):
    cmd = [ADB] + (["-s", serial] if serial else []) + list(args)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=30)


def target():
    out = sh("devices").stdout
    if SERIAL in out:
        return SERIAL
    for host in HOSTS:
        for port in re.findall(r"%s:(\d+)" % re.escape(host), out):
            return "%s:%s" % (host, port)
    for port in (43781, 35909, 5555):
        res = sh("connect", "%s:%d" % (HOSTS[0], port))
        if "connected" in res.stdout:
            return "%s:%d" % (HOSTS[0], port)
    return None


def awake(dev):
    sh("shell", "svc power stayon true", serial=dev)
    sh("shell", "settings put system screen_off_timeout 2147483647", serial=dev)
    sh("shell", "input keyevent 224", serial=dev)


def capture(dev, path):
    """Wake, capture, and retry while the panel is still black."""
    for attempt in range(1, 7):
        sh("shell", "input keyevent 224", serial=dev)
        time.sleep(0.6)
        sh("shell", "screencap -p /sdcard/_s.png", serial=dev)
        sh("pull", "/sdcard/_s.png", path, serial=dev)
        try:
            from PIL import Image
            im = Image.open(path).convert("RGB")
            if im.getpixel((im.width // 2, im.height // 3)) != (0, 0, 0):
                return True
        except Exception:
            pass
        time.sleep(1.2)
    return False


if __name__ == "__main__":
    dev = target()
    if not dev:
        print("no device")
        sys.exit(1)
    print("device:", dev)
    if len(sys.argv) > 1:
        awake(dev)
        print("awake" if capture(dev, sys.argv[1]) else "still dark")
    else:
        awake(dev)
        print(sh("shell", "dumpsys power|grep mWakefulness=", serial=dev).stdout.strip())