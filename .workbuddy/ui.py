"""Find a control by its text and tap it, using uiautomator's own bounds.

Screenshots come back at 3408x2272 and every viewer shows them at 1080x720, so
reading a coordinate off a picture means multiplying by 3.155 - and getting it
wrong silently, because a tap that lands nowhere looks exactly like a tap that
was ignored. The dump has the device's own numbers, so nothing is converted.
"""
import re
import subprocess
import sys

sys.path.insert(0, "D:/Documents/Claude Code/MCode/.workbuddy")
import pad

DUMP = "/sdcard/window_dump.xml"


def nodes():
    pad.sh("uiautomator", "dump", timeout=60)
    xml = subprocess.run(
        [pad.ADB, "-s", pad.ENDPOINT, "exec-out", "cat", DUMP],
        capture_output=True, text=True, env=pad.ENV,
    ).stdout
    for m in re.finditer(r"<node[^>]*>", xml):
        s = m.group(0)
        text = re.search(r'text="([^"]*)"', s)
        desc = re.search(r'content-desc="([^"]*)"', s)
        bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', s)
        cls = re.search(r'class="([^"]*)"', s)
        if not bounds:
            continue
        x1, y1, x2, y2 = (int(bounds.group(i)) for i in range(1, 5))
        yield {
            "text": text.group(1) if text else "",
            "desc": desc.group(1) if desc else "",
            "class": cls.group(1).split(".")[-1] if cls else "",
            "box": (x1, y1, x2, y2),
            "center": ((x1 + x2) // 2, (y1 + y2) // 2),
        }


def find(label, exact=False):
    hits = []
    for n in nodes():
        for field in (n["text"], n["desc"]):
            if not field:
                continue
            if (field == label) if exact else (label in field):
                hits.append(n)
                break
    return hits


if __name__ == "__main__":
    if sys.argv[1] == "list":
        for n in nodes():
            if n["text"] or n["desc"]:
                print(repr(n["text"] or n["desc"]), n["class"], n["center"])
    elif sys.argv[1] == "tap":
        label = sys.argv[2]
        exact = "--exact" in sys.argv
        hits = [n for n in find(label, exact) if n["box"][2] - n["box"][0] > 2]
        if not hits:
            print("no node matching", repr(label))
            sys.exit(1)
        # An exact match beats a substring one: looking for the header's 搜索
        # also matched the transcript's 「已搜索 "*.json"」 row, and the "lowest
        # node" rule below then tapped the transcript instead of the icon.
        exact_hits = [n for n in hits if label in (n["text"], n["desc"])]
        if exact_hits:
            hits = exact_hits
        for n in hits[:6]:
            print("hit", repr(n["text"] or n["desc"]), n["center"])
        # Several rows can carry the same word - "更多" is the composer's plus
        # and the header's overflow - so the lowest one on the screen is picked:
        # the composer sits under the conversation.
        pick = max(hits, key=lambda n: n["center"][1])
        wait = float(sys.argv[-1]) if sys.argv[-1].replace(".", "").isdigit() else 1.0
        pad.tap(*pick["center"], wait=wait)
        print("tapped", pick["center"])