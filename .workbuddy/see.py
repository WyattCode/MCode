"""Install the APK and land on a screen that is actually on, then shoot it.

The fold locks itself every few minutes, and `screencap` keeps returning the
last frame while it is asleep, which reads as "the app never redrew". This
walks the phone back to awake + unlocked + our app in front before every shot.
"""
import subprocess
import sys
import time

sys.path.insert(0, "D:/Documents/Claude Code/MCode/.workbuddy")
import fold

APK = r"D:/Documents/Claude Code/MCode/android/app/build/outputs/apk/debug/app-debug.apk"
SHOTS = r"D:/Documents/Claude Code/MCode/.workbuddy/shots"


def wake():
    fold.ensure()
    fold.adb("shell", "input keyevent KEYCODE_WAKEUP")
    time.sleep(0.6)
    fold.adb("shell", "wm dismiss-keyguard")
    time.sleep(0.8)
    out = fold.adb("shell", "dumpsys window | grep isKeyguardShowing").strip()
    if "isKeyguardShowing=true" in out:
        # A swipe is the only way past a lock screen without a password.
        fold.adb("shell", "input swipe 584 1400 584 300 240")
        time.sleep(1.2)
    fold.adb("shell", "am start -n com.mcode.remote/.MainActivity")
    time.sleep(3.5)


def shoot(name):
    wake()
    fold.adb("shell", "screencap -p /sdcard/_s.png")
    out = f"{SHOTS}/{name}.png"
    fold.adb("pull", "/sdcard/_s.png", out)
    print("captured", out)
    return out


def install():
    fold.ensure()
    r = subprocess.run([fold.ADB, "-s", fold.FOLD, "install", "-r", APK], capture_output=True, text=True)
    print((r.stdout + r.stderr).strip()[:160])
    fold.adb("shell", "am force-stop com.mcode.remote")
    time.sleep(1)


if __name__ == "__main__":
    if "install" in sys.argv:
        install()
    shoot(sys.argv[1] if sys.argv[1] != "install" else "after")