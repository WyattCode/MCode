"""One-shot device session: connect, screencap, sample colors.

Usage: python verify_session.py <name> [x y ...]
Takes a screenshot of the current device state, saves it to
.workbuddy/shots/<name>.png and prints pixel colors at given coords,
plus horizontal/vertical scans for element edges.
"""
import subprocess, sys, os, time

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
DEV = "192.168.10.155:44329"
SHOTS = r"D:/Documents/Claude Code/MCode/.workbuddy/shots"
os.makedirs(SHOTS, exist_ok=True)


def adb(*args, timeout=30):
    r = subprocess.run([ADB, "-s", DEV, *args], capture_output=True, timeout=timeout)
    return r


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "shot"
    points = []
    if len(sys.argv) > 2:
        nums = [int(x) for x in sys.argv[2:]]
        points = list(zip(nums[::2], nums[1::2]))

    adb("connect", DEV)
    r = adb("devices")
    if DEV.encode() not in r.stdout:
        print("DEVICE NOT CONNECTED"); sys.exit(1)

    adb("shell", "screencap -p /sdcard/mcode-verify.png")
    dest = os.path.join(SHOTS, f"{name}.png")
    adb("pull", "/sdcard/mcode-verify.png", dest)

    from PIL import Image
    img = Image.open(dest).convert("RGB")
    w, h = img.size
    print(f"shot: {name}.png {w}x{h}")

    for (x, y) in points:
        if 0 <= x < w and 0 <= y < h:
            c = img.getpixel((x, y))
            print(f"  ({x:4d},{y:4d}) #{c[0]:02X}{c[1]:02X}{c[2]:02X}")

    if len(sys.argv) > 2 and len(points) == 1:
        x, y = points[0]
        row = [img.getpixel((x, yy)) for yy in range(0, h, 4)]
        uniq = []
        for i, c in enumerate(row):
            if not uniq or uniq[-1][1] != c:
                uniq.append((i * 4, c))
        print("  vertical scan (y, color):")
        for yy, c in uniq[:40]:
            print(f"    y={yy:4d} #{c[0]:02X}{c[1]:02X}{c[2]:02X}")


if __name__ == "__main__":
    main()
