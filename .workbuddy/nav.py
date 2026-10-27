"""Drive the app by the coordinates the accessibility dump reports.

Clicking guessed coordinates wasted most of a session: the clock sits at 800 px
but 700 does nothing, the hamburger is at 24 but 20 falls outside, and a stray
tap near the edge becomes a system back gesture that drops the app. uiautomator
already knows where every control is, so ask it rather than guess.

Usage:
  nav.py dump                     - list tappable nodes with their bounds
  nav.py tap "<text>"             - tap the node whose text matches
  nav.py tapcd "<content-desc>"   - tap by content description
"""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
DEV = "0A06049009983540"


def sh(*args):
    return subprocess.run([ADB, "-s", DEV, *args], capture_output=True, text=True).stdout


def dump():
    sh("uiautomator", "dump", "/sdcard/nav.xml")
    # Pull the file rather than cat it: the shell path mangles the declaration
    # often enough that the parser sees an empty document.
    subprocess.run([ADB, "-s", DEV, "pull", "/sdcard/nav.xml", ".workbuddy/nav.xml"],
                   capture_output=True, text=True)
    with open(r"D:/Documents/Claude Code/MCode/.workbuddy/nav.xml", encoding="utf-8") as f:
        return ET.fromstring(f.read())


def centre(bounds):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not m:
        return None
    x1, y1, x2, y2 = (int(v) for v in m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def nodes(root):
    for n in root.iter("node"):
        b = n.get("bounds")
        c = centre(b) if b else None
        if c:
            yield n, c


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "dump"
    root = dump()
    if cmd == "dump":
        for n, (x, y) in nodes(root):
            text = (n.get("text") or "").strip()
            desc = (n.get("content-desc") or "").strip()
            if not text and not desc:
                continue
            print(f"{x:5d},{y:5d}  text={text[:28]!r:32s} desc={desc[:24]!r}")
        return 0

    field = "content-desc" if cmd == "tapcd" else "text"
    want = sys.argv[2]
    for n, (x, y) in nodes(root):
        if (n.get(field) or "").strip() == want:
            print(f"tap {want!r} at {x},{y}")
            sh("input", "tap", str(x), str(y))
            return 0
    # Fall back to a contains match, and say so.
    for n, (x, y) in nodes(root):
        if want in (n.get(field) or ""):
            print(f"tap {want!r} (contains) at {x},{y}")
            sh("input", "tap", str(x), str(y))
            return 0
    print(f"not found: {want!r}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
