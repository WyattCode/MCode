"""Install the built APK on the fold and capture a screenshot."""
import subprocess
import sys
import time

ADB = r"C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"
DEV = "192.168.10.173:35317"
APK = r"D:/Documents/Claude Code/MCode/android/app/build/outputs/apk/debug/app-debug.apk"


def adb(*args, timeout=180):
    r = subprocess.run([ADB, "-s", DEV, *args], capture_output=True, timeout=timeout)
    return (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "shot"
    print(adb("connect", DEV).strip()[:40])
    if "--no-install" not in sys.argv:
        print(adb("install", "-r", APK).strip()[:40])
    adb("shell", "am force-stop com.mcode.remote")
    time.sleep(1)
    adb("shell", "am start -n com.mcode.remote/.MainActivity")
    time.sleep(5)
    adb("shell", "screencap -p /sdcard/_s.png")
    out = rf"D:/Documents/Claude Code/MCode/.workbuddy/shots/{name}.png"
    adb("pull", "/sdcard/_s.png", out)
    print("captured", out)


if __name__ == "__main__":
    main()