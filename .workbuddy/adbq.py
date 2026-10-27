"""One-shot adb helper: starts the server, picks whatever serial is live, runs cmds."""
import subprocess
import sys

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"


def ensure():
    subprocess.run([ADB, "start-server"], capture_output=True, timeout=60)
    out = subprocess.run([ADB, "devices"], capture_output=True, timeout=30)
    lines = [l.split("\t") for l in out.stdout.decode("utf-8", "ignore").splitlines()]
    for parts in lines:
        if len(parts) == 2 and parts[1].strip() == "device":
            return parts[0]
    # try mDNS connect
    subprocess.run([ADB, "connect", "192.168.10.155:44329"], capture_output=True, timeout=30)
    subprocess.run([ADB, "mdns", "services"], capture_output=True, timeout=20)
    out = subprocess.run([ADB, "devices"], capture_output=True, timeout=30)
    for l in out.stdout.decode("utf-8", "ignore").splitlines():
        if l.endswith("\tdevice"):
            return l.split("\t")[0]
    return None


def adb(dev, *args, timeout=90):
    r = subprocess.run([ADB, "-s", dev, *args], capture_output=True, timeout=timeout)
    return (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")


if __name__ == "__main__":
    dev = ensure()
    print("SERIAL:", dev)
    if not dev:
        sys.exit(1)
    for cmd in sys.argv[1:]:
        print(f"$ {cmd}")
        print(adb(dev, "shell", cmd).strip())
        print()