"""Print the bounds of every text node whose text matches a keyword."""
import re
import sys

sys.path.insert(0, "D:/Documents/Claude Code/MCode/.workbuddy")
import fold

KEY = sys.argv[1] if len(sys.argv) > 1 else "晚间随想"


def parse(bounds):
    left, right = bounds.split("][")
    x1, y1 = [int(v) for v in left.strip("[").split(",")]
    x2, y2 = [int(v) for v in right.rstrip("]").split(",")]
    return x1, y1, x2, y2


if __name__ == "__main__":
    fold.ensure()
    dump = fold.dump()
    for match in re.finditer(r'<node[^>]*text="([^"]*)"[^>]*bounds="([^"]*)"', dump):
        if KEY in match.group(1):
            x1, y1, x2, y2 = parse(match.group(2))
            print(f"{match.group(1)[:24]!r} {match.group(2)}  w={x2 - x1} h={y2 - y1}")