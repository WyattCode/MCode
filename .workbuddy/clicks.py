"""List clickable nodes in the conversation pane, with their bounds."""
import re
import sys

sys.path.insert(0, "D:/Documents/Claude Code/MCode/.workbuddy")
import fold


def parse(bounds):
    left, right = bounds.split("][")
    x1, y1 = [int(v) for v in left.strip("[").split(",")]
    x2, y2 = [int(v) for v in right.rstrip("]").split(",")]
    return x1, y1, x2, y2


if __name__ == "__main__":
    lo = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    hi = int(sys.argv[2]) if len(sys.argv) > 2 else 99999
    fold.ensure()
    dump = fold.dump()
    for match in re.finditer(r"<node[^>]*clickable=\"true\"[^>]*bounds=\"([^\"]*)\"", dump):
        x1, y1, x2, y2 = parse(match.group(1))
        if x1 > 900 and lo <= y1 <= hi:
            print(f"[{x1},{y1}][{x2},{y2}] w={x2 - x1} h={y2 - y1}")