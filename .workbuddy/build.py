"""Build the Remote APK and, unless told otherwise, install it on the fold."""
import os
import subprocess
import sys
import time

ROOT = r"D:/Documents/Claude Code/MCode"
ANDROID = ROOT + "/android"
GRADLE = r"C:/Users/Wyatt/.workbuddy/binaries/gradle/gradle-8.7/bin/gradle.bat"
APK = ROOT + "/android/app/build/outputs/apk/debug/app-debug.apk"

import fold


def run(args, **kw):
    env = dict(os.environ)
    # WorkBuddy exports these to the shell; a JVM started with them inherits an
    # Electron-shaped environment and Gradle's daemon hangs on it.
    for key in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        env.pop(key, None)
    #
    # Gradle needs a JDK and this shell does not always have one on PATH: a
    # session that lost its environment answers "JAVA_HOME is not set and no
    # 'java' command could be found", which reads like a broken checkout rather
    # than a missing variable. Fall back to an installed JDK rather than making
    # every run export it by hand.
    #
    if not env.get("JAVA_HOME") or not os.path.isdir(env["JAVA_HOME"]):
        for guess in (
            "C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot",
            "C:/Program Files/Android/Android Studio/jbr",
        ):
            if os.path.isdir(guess):
                env["JAVA_HOME"] = guess
                env["PATH"] = os.path.join(guess, "bin") + os.pathsep + env.get("PATH", "")
                break
    return subprocess.run(args, cwd=ANDROID, capture_output=True, text=True, env=env, **kw)


def main():
    install = "--no-install" not in sys.argv
    t0 = time.time()
    # The unit tests run with the build, not as an afterthought.
    #
    # The selection's offset arithmetic had two bugs that no compiler and no
    # install could catch - they only showed up as "nothing can be selected" -
    # and both are answerable in milliseconds on the JVM. Running them here means
    # a broken range fails the build instead of being discovered on the pad.
    r = run([GRADLE, "-q", "app:testDebugUnitTest", "app:assembleDebug", "--console=plain"])
    print(r.stdout[-4000:])
    print(r.stderr[-4000:])
    if r.returncode != 0:
        print("build failed")
        return 1
    print("built in %.1fs" % (time.time() - t0))
    if install:
        if not fold.ensure():
            print("no device: set MCODE_DEVICE to fold / pad")
            return 1
        r = subprocess.run([fold.ADB, "-s", fold.FOLD, "install", "-r", APK], capture_output=True, text=True)
        print(fold.FOLD, (r.stdout + r.stderr).strip()[:300])
    return 0


if __name__ == "__main__":
    sys.exit(main())