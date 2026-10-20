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
ENDPOINT = os.environ.get("MCODE_ENDPOINT", "192.168.10.173:39569")
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


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "shot":
        shot(sys.argv[2])
    elif cmd == "tap":
        tap(int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]) if len(sys.argv) > 4 else 0.8)
    elif cmd == "sh":
        print(sh(*sys.argv[2:]).stdout)
    else:
        print(ensure())