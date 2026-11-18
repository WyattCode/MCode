// Optional build-time helper. The app uses System Events when this binary is absent.
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform === "darwin") {
  const source = fileURLToPath(new URL("../resources/macctl/cgevent.swift", import.meta.url))
  const output = fileURLToPath(new URL("../resources/macctl/mcode-cgevent", import.meta.url))
  rmSync(output, { force: true })
  const compiler = spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], { encoding: "utf8" })
  if (compiler.status !== 0) {
    console.warn("macOS CGEvent shim is unavailable: swiftc not found. Keyboard input uses System Events.")
  } else {
    const sdk = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" })
    if (sdk.status !== 0) throw new Error("Could not find the macOS SDK")
    const cache = mkdtempSync(path.join(os.tmpdir(), "mcode-swift-"))
    try {
      const result = spawnSync(compiler.stdout.trim(), ["-sdk", sdk.stdout.trim(), "-module-cache-path", cache, "-O", source, "-o", output], { stdio: "inherit" })
      process.exitCode = result.status ?? 1
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  }
}
