"""Build, install and screenshot, with a guarantee that Kotlin actually compiled.

Gradle on this machine reports `compileDebugKotlin UP-TO-DATE` even after the
source file's contents change (its incremental check appears to miss the edit,
which on Windows is usually a timestamp that did not move). The symptom is
vicious because it looks like the change had no effect in the UI: six rounds of
this pass adjusted a number, saw the same screenshot, and concluded Compose was
ignoring the modifier - when in fact the old bytecode was still being packaged.

So: delete the Kotlin output first, then require the log to show the compile
task ran without UP-TO-DATE. A build that did not compile is a failure here, not
a pass.
"""
import os
import re
import subprocess
import sys
import time

ROOT = "D:/Documents/Claude Code/MCode"
ANDROID = ROOT + "/android"
GRADLE = "C:/Users/Wyatt/.workbuddy/binaries/gradle/gradle-8.7/bin/gradle.bat"
APK = ANDROID + "/app/build/outputs/apk/debug/app-debug.apk"
ENDPOINT = os.environ.get("MCODE_ENDPOINT", "192.168.10.173:35317")
ADB = "C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe"


def env():
    e = dict(os.environ)
    for k in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        e.pop(k, None)
    return e


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "shot"

    for stale in ("app/build/tmp/kotlin-classes", "app/build/classes"):
        subprocess.run(["rm", "-rf", stale], cwd=ANDROID)

    r = subprocess.run([GRADLE, "app:assembleDebug", "--console=plain"], cwd=ANDROID, capture_output=True, text=True, env=env())
    log = r.stdout + r.stderr
    if r.returncode != 0:
        print(log[-3000:])
        print("build failed")
        return 1

    hit = [l for l in log.splitlines() if "compileDebugKotlin" in l]
    if not hit or "UP-TO-DATE" in hit[0]:
        print("compiled nothing - %s" % (hit[0] if hit else "task absent"))
        print("refusing to install a stale APK")
        return 1
    print(hit[0].strip())

    # The pad drops its wireless debugging socket whenever it goes idle, and
    # every helper here runs as its own process - so a fresh `adb` server sees
    # an empty device list and `install` fails with "device not found" even
    # though the previous command worked. Reconnect first, every time.
    for _ in range(4):
        listed = subprocess.run([ADB, "devices"], capture_output=True, text=True, env=env()).stdout
        if ENDPOINT in listed and "device" in listed.split(ENDPOINT, 1)[1].split("\n", 1)[0]:
            break
        subprocess.run([ADB, "connect", ENDPOINT], capture_output=True, env=env())
        time.sleep(1.5)

    r = subprocess.run([ADB, "-s", ENDPOINT, "install", "-r", APK], capture_output=True, text=True, env=env())
    print((r.stdout + r.stderr).strip()[:120])
    if "Success" not in r.stdout:
        return 1

    subprocess.run([ADB, "-s", ENDPOINT, "shell", "am", "force-stop", "com.mcode.remote"], env=env())
    subprocess.run([ADB, "-s", ENDPOINT, "shell", "am", "start", "-n", "com.mcode.remote/.MainActivity"], env=env())
    time.sleep(5)
    subprocess.run([ADB, "-s", ENDPOINT, "shell", "screencap", "-p", "/sdcard/_s.png"], env=env())
    out = "%s/.workbuddy/shots/%s.png" % (ROOT, name)
    subprocess.run([ADB, "-s", ENDPOINT, "pull", "/sdcard/_s.png", out], env=env())
    print("captured", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())