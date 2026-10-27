"""Tap by text, with a dump that is never stale.

Every one of the wasted passes tonight came from the same thing: a dump that had
been read once and then answered from memory, so a tap went to coordinates that
described the screen two steps ago. This forces a fresh dump every call, deletes
the file first so a failed dump cannot leave the previous one in place, and
prints the file's timestamp so a stale read is visible rather than silent.

Usage:
  drive.py dump                 - fresh dump, list text nodes
  drive.py tap "<text>"         - fresh dump, tap the centre of that text's bounds
  drive.py tapn "<text>" <n>    - tap the n-th match (0-based), for duplicates
  drive.py back                 - system back
  drive.py shot <path>          - screenshot
"""
import os
import re
import subprocess
import sys
import time

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
DEV = "0A06049009983540"
LOCAL = r"D:/Documents/Claude Code/MCode/.workbuddy/ui_drive.xml"


def sh(*args, path_conv=False):
    env = dict(os.environ)
    if not path_conv:
        env["MSYS_NO_PATHCONV"] = "1"
    return subprocess.run(
        [ADB, "-s", DEV, *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )


def fresh_dump():
    """Dump the current screen and return [(text, x0, y0, x1, y1)]."""
    sh("shell", "rm", "-f", "/sdcard/ui.xml")
    r = sh("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    if "dumped to" not in (r.stdout or "") + (r.stderr or ""):
        raise SystemExit("dump failed: " + ((r.stderr or r.stdout or "")[:200]))
    if os.path.exists(LOCAL):
        os.remove(LOCAL)
    sh("pull", "/sdcard/ui.xml", LOCAL, path_conv=True)
    if not os.path.exists(LOCAL):
        raise SystemExit("pull failed")
    xml = open(LOCAL, encoding="utf-8", errors="replace").read()
    out = []
    for m in re.finditer(
        r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml
    ):
        t = m.group(1)
        if not t.strip():
            continue
        out.append((t, int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))))
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]

    if cmd == "back":
        sh("shell", "input", "keyevent", "4")
        return

    if cmd == "shot":
        path = sys.argv[2]
        sh("shell", "screencap", "-p", "/sdcard/s.png")
        sh("pull", "/sdcard/s.png", path, path_conv=True)
        print("saved", path, os.path.getsize(path), "bytes")
        return

    rows = fresh_dump()

    if cmd == "dump":
        print("%d text nodes  (dump file %s)" % (len(rows), time.ctime(os.path.getmtime(LOCAL))))
        for t, x0, y0, x1, y1 in rows:
            print("  %-30s centre=(%d,%d)" % (t[:28], (x0 + x1) // 2, (y0 + y1) // 2))
        return

    if cmd in ("tap", "tapn"):
        needle = sys.argv[2]
        want = int(sys.argv[3]) if cmd == "tapn" else 0
        found = [r for r in rows if needle in r[0]]
        if not found:
            print("no node matching %r. Current screen:" % needle)
            for t, x0, y0, x1, y1 in rows:
                print("   ", t[:40])
            raise SystemExit(1)
        if want >= len(found):
            print("only %d matches for %r" % (len(found), needle))
            raise SystemExit(1)
        t, x0, y0, x1, y1 = found[want]
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        print("tap %r (%d of %d) at %d,%d" % (t, want + 1, len(found), cx, cy))
        sh("shell", "input", "tap", str(cx), str(cy))
        return

    print(__doc__)


if __name__ == "__main__":
    main()