"""Resolve the FOLD only - the fold has a known serial prefix.

The plain `adb devices` answer can be a different Xiaomi phone on the same
network; picking whichever serial happens to be live is how a session ends up
reading another device's foreground app and reporting the wrong thing.
"""
import subprocess
import sys

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
FOLD_SERIAL = "0186D460499C3540"


def devices():
    out = subprocess.run([ADB, "devices"], capture_output=True, timeout=30)
    result = []
    for line in out.stdout.decode("utf-8", "ignore").splitlines():
        if "\t" not in line:
            continue
        serial, state = line.split("\t", 1)
        if state.strip() == "device":
            result.append(serial)
    return result


def serial_of(dev):
    r = subprocess.run([ADB, "-s", dev, "shell", "getprop", "ro.serialno"], capture_output=True, timeout=20)
    return (r.stdout or b"").decode("utf-8", "ignore").strip()


def main():
    live = devices()
    if not live:
        print("NO DEVICES: nothing is connected over adb")
        return 1
    for dev in live:
        serial = serial_of(dev)
        model = subprocess.run(
            [ADB, "-s", dev, "shell", "getprop", "ro.product.model"], capture_output=True, timeout=20
        ).stdout.decode("utf-8", "ignore").strip()
        fold = serial == FOLD_SERIAL or "Fold" in model or "lhasa" in model
        print(f"{dev}\tserial={serial}\tmodel={model}\t{'FOLD' if fold else 'other'}")
        if fold:
            print("USE:", dev)
            return 0
    print("FOLD NOT FOUND: the connected device(s) are not the 18 Fold")
    return 2


if __name__ == "__main__":
    sys.exit(main())