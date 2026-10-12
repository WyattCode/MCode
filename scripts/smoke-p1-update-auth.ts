import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  compareVersions,
  createUpdater,
  feedProblem,
  refusal,
  UPDATE_AUTH_RESIDUAL,
  type AutoUpdaterLike,
  type FeedInfo,
} from "../src/main/updater"

const now = Date.UTC(2024, 0, 15)
const current = "1.0.0"
const newer = "1.0.1"
const older = "0.9.0"

const validBase64 = createHash("sha512").update("installer").digest("base64")
const validHex = createHash("sha512").update("installer").digest("hex")
const zeroHex = "0".repeat(128)
const zeroBase64 = "A".repeat(86) + "=="

function check(name: string, fn: () => void): void {
  fn()
  console.log(`ok - ${name}`)
}

check("valid base64 sha512 is accepted for a newer version", () => {
  assert.equal(refusal({ version: newer, files: [{ url: "installer.exe", sha512: validBase64 }] }, current, now), undefined)
})

check("valid hex sha512 is accepted for a newer version", () => {
  assert.equal(refusal({ version: newer, files: [{ url: "installer.exe", sha512: validHex }] }, current, now), undefined)
})

check("legacy sha512 is accepted when files are absent", () => {
  assert.equal(refusal({ version: newer, sha512: validBase64 }, current, now), undefined)
})

check("missing sha512 is refused", () => {
  assert.match(refusal({ version: newer, files: [{ url: "installer.exe" }] }, current, now) ?? "", /sha512/)
})

check("empty sha512 is refused", () => {
  assert.match(refusal({ version: newer, files: [{ url: "installer.exe", sha512: "" }] }, current, now) ?? "", /sha512/)
})

check("short sha512 is refused", () => {
  assert.match(refusal({ version: newer, files: [{ url: "installer.exe", sha512: "abc" }] }, current, now) ?? "", /sha512/)
})

check("all-zero hex sha512 is refused as a placeholder", () => {
  assert.match(refusal({ version: newer, files: [{ url: "installer.exe", sha512: zeroHex }] }, current, now) ?? "", /placeholder/)
})

check("all-zero base64 sha512 is refused as a placeholder", () => {
  assert.match(refusal({ version: newer, files: [{ url: "installer.exe", sha512: zeroBase64 }] }, current, now) ?? "", /placeholder/)
})

check("legacy all-zero sha512 is refused as a placeholder", () => {
  assert.match(refusal({ version: newer, sha512: zeroBase64 }, current, now) ?? "", /placeholder/)
})

check("empty files array is refused", () => {
  assert.match(refusal({ version: newer, files: [] }, current, now) ?? "", /no files/)
})

check("file entry without url is refused", () => {
  assert.match(refusal({ version: newer, files: [{ sha512: validBase64 }] }, current, now) ?? "", /url/)
})

check("file entry with empty url is refused", () => {
  assert.match(refusal({ version: newer, files: [{ url: "   ", sha512: validBase64 }] }, current, now) ?? "", /url/)
})

check("one bad file in a multi-file feed is refused", () => {
  assert.match(
    refusal({
      version: newer,
      files: [
        { url: "installer.exe", sha512: validBase64 },
        { url: "installer.exe.blockmap", sha512: zeroHex },
      ],
    }, current, now) ?? "",
    /placeholder/,
  )
})

check("older version without rollback is refused", () => {
  assert.match(refusal({ version: older, files: [{ url: "installer.exe", sha512: validBase64 }] }, current, now) ?? "", /rollback/)
})

check("recent declared rollback is accepted", () => {
  assert.equal(
    refusal({
      version: older,
      rollback: true,
      releaseDate: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      files: [{ url: "installer.exe", sha512: validBase64 }],
    }, current, now),
    undefined,
  )
})

check("https feed is accepted", () => {
  assert.equal(feedProblem("https://example.com/latest.yml"), undefined)
})

check("http localhost feed is accepted", () => {
  assert.equal(feedProblem("http://localhost:8080/latest.yml"), undefined)
})

check("http 127.0.0.1 feed is accepted", () => {
  assert.equal(feedProblem("http://127.0.0.1:8080/latest.yml"), undefined)
})

check("http ::1 feed is accepted", () => {
  assert.equal(feedProblem("http://[::1]:8080/latest.yml"), undefined)
})

check("http non-localhost feed is refused", () => {
  assert.match(feedProblem("http://example.com/latest.yml") ?? "", /https/)
})

check("invalid feed address is refused", () => {
  assert.match(feedProblem("not a url") ?? "", /valid address/)
})

check("residual risk constant documents absent code signing", () => {
  assert.match(UPDATE_AUTH_RESIDUAL, /code signing/)
  assert.match(UPDATE_AUTH_RESIDUAL, /publisher/)
})

async function checkCreateUpdater(): Promise<void> {
  const info: FeedInfo = {
    version: newer,
    files: [{ url: "installer.exe", sha512: "abc" }],
  }
  const logs: string[] = []

  const fake: AutoUpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    allowPrerelease: false,
    disableWebInstaller: false,
    requestHeaders: null,
    isUpdateSupported: async () => true,
    setFeedURL: () => {},
    checkForUpdates: async () => {
      const supported = await fake.isUpdateSupported(info)
      return {
        isUpdateAvailable: supported && compareVersions(info.version, current) > 0,
        updateInfo: info,
      }
    },
    quitAndInstall: () => {},
  }

  const updater = createUpdater({
    currentVersion: current,
    feedURL: () => "https://example.com/latest.yml",
    autoUpdater: fake,
    emit: () => {},
    log: (line) => logs.push(line),
    now: () => now,
  })

  const result = await updater.checkNow()
  assert.equal(result.outcome, "failed")
  assert.equal(result.during, "check")
  assert.match(result.error ?? "", /sha512/)
  assert.ok(logs.some((line) => line.includes("authenticity check refused")))
  console.log("ok - createUpdater fails closed for a newer unverified feed")
}

void checkCreateUpdater().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
