/*
 * Builds an Android app from a folder holding AndroidManifest.xml and src/
 * (Java) into a signed, installable .apk - with the SDK's own tools and no
 * Gradle: aapt2 links the manifest, javac and d8 make the dex, aapt adds it,
 * zipalign aligns and apksigner signs with a debug key made on first use.
 *
 * Used for scripts/fixtures/android-demo (the app tool's Android checks) and
 * copied into the Android benchmark task as its build script.
 *
 * Run with: node scripts/android-demo.mjs [folder] [out.apk]
 * Needs a JDK (javac, java, keytool) and an Android SDK with a platform and build-tools.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const folder = path.resolve(process.argv[2] ?? path.join(here, "fixtures", "android-demo"))
const output = path.resolve(process.argv[3] ?? path.join(folder, "app.apk"))

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
const run = (file, args) => execFileSync(file, args, { stdio: ["ignore", "pipe", "inherit"] })

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-apk-"))
try {
  // 1. The manifest, linked against the platform into an apk with no code yet.
  const base = path.join(work, "base.apk")
  run(exe("aapt2"), ["link", "-o", base, "-I", androidJar, "--manifest", path.join(folder, "AndroidManifest.xml"), "--min-sdk-version", "24", "--target-sdk-version", "34"])

  // 2. The Java, compiled and turned into classes.dex.
  const sources = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith(".java")) sources.push(file)
    }
  }
  walk(path.join(folder, "src"))
  const classes = path.join(work, "classes")
  fs.mkdirSync(classes)
  run(bin("javac"), ["--release", "8", "-nowarn", "-encoding", "UTF-8", "-cp", androidJar, "-d", classes, ...sources])
  const compiled = []
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) collect(file)
      else if (entry.name.endsWith(".class")) compiled.push(file)
    }
  }
  collect(classes)
  run(bin("java"), ["-cp", path.join(tools, "lib", "d8.jar"), "com.android.tools.r8.D8", "--min-api", "24", "--lib", androidJar, "--output", work, ...compiled])

  // 3. The dex into the apk (aapt adds a file by the name it is given, so it is added from inside the folder).
  execFileSync(exe("aapt"), ["add", base, "classes.dex"], { cwd: work, stdio: ["ignore", "pipe", "inherit"] })

  // 4. Aligned, then signed with a debug key of MCode's own in the temp folder - never the user's ~/.android one. A key made
  //    anew (the temp folder was cleaned) cannot update an app signed with the old one; whoever installs uninstalls first then.
  const aligned = path.join(work, "aligned.apk")
  run(exe("zipalign"), ["-p", "-f", "4", base, aligned])
  const keystore = path.join(os.tmpdir(), "mcode-debug.keystore")
  if (!fs.existsSync(keystore)) {
    run(bin("keytool"), ["-genkeypair", "-keystore", keystore, "-storepass", "android", "-keypass", "android", "-alias", "mcode", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=MCode Debug"])
  }
  run(bin("java"), ["-jar", path.join(tools, "lib", "apksigner.jar"), "sign", "--v4-signing-enabled", "false", "--ks", keystore, "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", output, aligned])
  console.log(`built ${output} (${fs.statSync(output).size} bytes)`)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
