"""Find the pad's wireless-debugging port after it comes back.

The endpoint is not stable. Toggling wireless debugging, rebooting, or even
letting the screen sleep gives a new port, and the remembered one then refuses
connections with 10061 - which reads exactly like the pad being offline even
though it answers ping. So the port is discovered rather than remembered:

  1. `adb mdns services` - what the platform advertises, when the pad is awake
     and advertising.
  2. A port sweep over the pad's own ephemeral range, since this MIUI picks a
     high port at random and 10061 means "nothing is listening here" rather than
     "host is gone".

Nothing here touches the device: it only asks how to reach it.
"""
import socket
import subprocess
import sys

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
PAD = "192.168.10.173"


def mdns():
    out = subprocess.run([ADB, "mdns", "services"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if PAD in line and "_adb-tls-connect._tcp" in line:
            tail = line.strip().split()[-1]
            if ":" in tail:
                return tail
    return None


def probes():
    """High ports this MIUI has used before, then a wider sweep."""
    known = [46545, 35317, 40025, 34313, 44871, 37861, 37000, 5555]
    return known + list(range(30000, 30120)) + list(range(40000, 40080))


def reachable(endpoint):
    host, port = endpoint.rsplit(":", 1)
    s = socket.socket()
    s.settimeout(0.35)
    try:
        s.connect((host, int(port)))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    found = mdns()
    if found:
        print("mdns:", found)
        subprocess.run([ADB, "connect", found], capture_output=True, text=True)
        return 0
    for port in probes():
        endpoint = f"{PAD}:{port}"
        if reachable(endpoint):
            print("open:", endpoint)
            r = subprocess.run([ADB, "connect", endpoint], capture_output=True, text=True)
            print((r.stdout + r.stderr).strip())
            if "connected" in (r.stdout + r.stderr):
                return 0
    print("no wireless-debugging port answered; unlock the pad and check that "
          "wireless debugging is still on")
    return 1


if __name__ == "__main__":
    sys.exit(main())
