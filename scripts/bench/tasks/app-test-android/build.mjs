/*
 * Builds this app into app.apk with the Android SDK's own tools (no Gradle),
 * and with --install puts it on the connected phone or emulator.
 *
 *   node build.mjs            build app.apk
 *   node build.mjs --install  build, then install it (adb install -r)
 *
 * Needs a JDK and an Android SDK (ANDROID_HOME, or the usual places).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const folder = path.dirname(fileURLToPath(import.meta.url))
const output = path.join(folder, "app.apk")

const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk"), "D:\\Android\\sdk", "C:\\Android\\sdk"].find(
  (dir) => dir && fs.existsSync(path.join(dir, "platforms")),
)
if (!sdk) throw new Error("No Android SDK found; set ANDROID_HOME")
const newest = (dir) =>
  fs
    .readdirSync(dir)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1)
const androidJar = path.join(sdk, "platforms", newest(path.join(sdk, "platforms")), "android.jar")
const tools = path.join(sdk, "build-tools", newest(path.join(sdk, "build-tools")))
const exe = (name) => path.join(tools, process.platform === "win32" ? `${name}.exe` : name)
const bin = (name) => (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name)
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: ["ignore", "pipe", "inherit"] })

const work = fs.mkdtempSync(path.join(os.tmpdir(), "apk-"))
try {
  const base = path.join(work, "base.apk")
  run(exe("aapt2"), ["link", "-o", base, "-I", androidJar, "--manifest", path.join(folder, "AndroidManifest.xml"), "--min-sdk-version", "24", "--target-sdk-version", "34"])
  const sources = []
  const walk = (dir, into, suffix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file, into, suffix)
      else if (entry.name.endsWith(suffix)) into.push(file)
    }
  }
  walk(path.join(folder, "src"), sources, ".java")
  const classes = path.join(work, "classes")
  fs.mkdirSync(classes)
  run(bin("javac"), ["--release", "8", "-nowarn", "-encoding", "UTF-8", "-cp", androidJar, "-d", classes, ...sources])
  const compiled = []
  walk(classes, compiled, ".class")
  run(bin("java"), ["-cp", path.join(tools, "lib", "d8.jar"), "com.android.tools.r8.D8", "--min-api", "24", "--lib", androidJar, "--output", work, ...compiled])
  run(exe("aapt"), ["add", base, "classes.dex"], work)
  const aligned = path.join(work, "aligned.apk")
  run(exe("zipalign"), ["-p", "-f", "4", base, aligned])
  const keystore = path.join(os.tmpdir(), "mcode-debug.keystore")
  if (!fs.existsSync(keystore)) {
    run(bin("keytool"), ["-genkeypair", "-keystore", keystore, "-storepass", "android", "-keypass", "android", "-alias", "mcode", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Debug"])
  }
  run(bin("java"), ["-jar", path.join(tools, "lib", "apksigner.jar"), "sign", "--ks", keystore, "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", output, aligned])
  console.log(`built ${output}`)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

if (process.argv.includes("--install")) {
  const adb = path.join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb")
  const listed = () => spawnSync(adb, ["devices"], { encoding: "utf8" }).stdout.split(/\r?\n/).slice(1).filter((line) => /\tdevice$/.test(line)).map((line) => line.split("\t")[0])
  // An emulator whose adb connection dropped is found again on its usual local ports.
  if (!listed().length) for (const port of [16384, 7555, 5555, 62001]) if (/connected to/.test(spawnSync(adb, ["connect", `127.0.0.1:${port}`], { encoding: "utf8" }).stdout) && listed().length) break
  const device = listed()[0]
  if (!device) throw new Error("No Android device is connected")
  execFileSync(adb, ["-s", device, "install", "-r", output], { stdio: "inherit" })
  console.log(`installed on ${device}`)
}
