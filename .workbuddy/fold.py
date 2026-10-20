"""Drive one exact Android device, never "whichever device happens to be live".

The target is picked by its serial number. There are three Android devices on
this network and `adb devices` lists whichever answered last, so a check that
reads the device list rather than the serial has already led to driving the
wrong phone once. `MCODE_DEVICE` chooses the target: `fold` (the 18 Fold),
`pad` (the Xiaomi Pad), or `serial:IP:PORT`.
"""
import os
import subprocess
import sys
import time

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"

# Wireless debugging picks a new port whenever it is toggled or the device
# reboots, and each device sits at its own address, so both are discovered
# rather than remembered.
DEVICES = {
    "fold": ("192.168.10.155", "0186D460499C3540", "192.168.10.155:40025"),
    "pad": ("192.168.10.173", "0A06049009983540", "192.168.10.173:39569"),
}

TARGET = os.environ.get("MCODE_DEVICE", "pad")
if TARGET.startswith("serial:"):
    # The docstring has always promised this form and nothing implemented it, so
    # a device that is not one of the two named above could only be driven by
    # editing this file. `serial:IP:PORT` is the new debugging endpoint as
    # `adb devices` prints it - the pad's port changes whenever the toggle is
    # flipped, which is the reason this escape hatch exists.
    _endpoint = TARGET[len("serial:"):]
    HOST, SERIAL, ENDPOINT = _endpoint.rsplit(":", 1)[0], "", _endpoint
else:
    HOST, SERIAL, ENDPOINT = DEVICES.get(TARGET, DEVICES["pad"])
FOLD = ENDPOINT  # kept: every helper here already speaks in terms of this name


def _adb_raw(*args, timeout=30):
    r = subprocess.run([ADB, *args], capture_output=True, timeout=timeout)
    return (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")


def _attached():
    """The endpoint this host already has, only if it is the right device."""
    for line in _adb_raw("devices", "-l").splitlines():
        if " device " not in line:
            continue
        endpoint = line.split()[0]
        if endpoint.startswith(HOST + ":"):
            if SERIAL in _adb_raw("-s", endpoint, "shell", "getprop ro.serialno"):
                return endpoint
    return None


def _from_mdns():
    text = _adb_raw("mdns", "services", timeout=20)
    for line in text.splitlines():
        if "_adb-tls-connect._tcp" in line and HOST in line:
            tail = line.strip().split()[-1]
            if ":" in tail:
                return tail
    return None


def _from_scan():
    import concurrent.futures
    import socket

    def probe(port):
        s = socket.socket()
        s.settimeout(0.15)
        try:
            s.connect((HOST, port))
            s.close()
            return port
        except Exception:
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=256) as pool:
        return [f"{HOST}:{p}" for p in pool.map(probe, range(30000, 50000)) if p]


def alive():
    """True only when the shell answers with the bare word: an error line also
    contains the word 'device', which made every check pass."""
    return _adb_raw("-s", FOLD, "shell", "echo device").strip() == "device"


def discover(force=False):
    """Attach to the target device and return its endpoint, or None."""
    global FOLD
    if not force and alive():
        return FOLD
    known = _attached()
    if known:
        FOLD = known
        if alive():
            return FOLD
    candidates = [ENDPOINT]
    mdns = _from_mdns()
    if mdns:
        candidates.append(mdns)
    for endpoint in candidates:
        _adb_raw("connect", endpoint)
        FOLD = endpoint
        if alive():
            return FOLD
    for endpoint in _from_scan():
        _adb_raw("connect", endpoint)
        FOLD = endpoint
        if alive():
            return FOLD
    return None


def adb(*a, t=90, retry=True):
    r = subprocess.run([ADB, "-s", FOLD, *a], capture_output=True, timeout=t)
    out = (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")
    if retry and "not found" in out:
        # The wireless session drops between tool calls, and toggling it on the
        # device changes the port. Look the endpoint up again, replay once.
        if discover(force=True):
            r = subprocess.run([ADB, "-s", FOLD, *a], capture_output=True, timeout=t)
            out = (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")
            out = out.replace("connected to " + FOLD + "\n", "")
    return out


def ensure():
    """Connect once; returns True when the target device answers."""
    return bool(discover())


def shot(path):
    adb("shell", "screencap -p /sdcard/_s.png")
    adb("pull", "/sdcard/_s.png", path)
    return path


def dump():
    adb("shell", "uiautomator dump /sdcard/_ui.xml")
    return adb("shell", "cat /sdcard/_ui.xml")


def tap(x, y):
    adb("shell", f"input tap {x} {y}")


def serial():
    return adb("shell", "getprop ro.serialno").strip()


if __name__ == "__main__":
    for cmd in sys.argv[1:]:
        print(f"$ {cmd}\n{adb('shell', cmd).strip()}\n")