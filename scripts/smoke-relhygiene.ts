import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as desktop from "../src/main/desktop-rules"
import { refusal } from "../src/main/updater"

const cases: { name: string; run: () => void }[] = []

function register(name: string, run: () => void): void { cases.push({ name, run }) }

const day = 24 * 60 * 60 * 1000
const skew = 5 * 60 * 1000
const now = Date.UTC(2026, 0, 31)
const feed = {
  version: "1.2.0",
  rollback: true,
  sha512: createHash("sha512").update("fake installer").digest("base64"),
}
const rollback = (age: number) => refusal({ ...feed, releaseDate: new Date(now - age).toISOString() }, "1.2.1", now)

register("rollback rejects dates beyond future skew", () => {
  assert.match(rollback(-skew - 1) ?? "", /future/)
  assert.equal(rollback(-skew), undefined)
})

register("rollback enforces the 30-day boundary", () => {
  assert.equal(rollback(30 * day), undefined)
  assert.match(rollback(30 * day + 1) ?? "", /30 days ago/)
})

function fixture(run: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "mcode-relhygiene-"))
  try {
    copyFileSync("scripts/bump-version.mjs", join(cwd, "bump-version.mjs"))
    writeFileSync(join(cwd, "package.json"), '{"version":"1.2.1","allowScripts":{"electron":"42.0.0"}}\n')
    writeFileSync(join(cwd, "package-lock.json"), '{"version":"1.2.1","packages":{"":{"version":"1.2.1"}}}\n')
    run(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function bump(cwd: string, options: string[] = [], version = "") {
  return spawnSync(process.execPath, [...options, "bump-version.mjs"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MCODE_RELEASE_VERSION: version },
  })
}

function versions(cwd: string) {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
  const lock = JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8"))
  assert.deepEqual(pkg.allowScripts, { electron: "42.0.0" })
  return [pkg.version, lock.version, lock.packages[""].version]
}

register("bump validates both files before replacement", () => fixture((cwd) => {
  const manifest = join(cwd, "package.json")
  const before = readFileSync(manifest, "utf8")
  writeFileSync(join(cwd, "package-lock.json"), "{")
  assert.equal(bump(cwd).status, 1)
  assert.equal(readFileSync(manifest, "utf8"), before, "manifest changed before lockfile validation")
}))

register("interrupted bump retries the same target", () => fixture((cwd) => {
  const preload = join(cwd, "interrupt.cjs")
  writeFileSync(preload, `
const fs = require("node:fs")
const { basename } = require("node:path")
const rename = fs.renameSync
let replacements = 0
fs.renameSync = (from, to) => {
  if (["package.json", "package-lock.json"].includes(basename(to)) && ++replacements === 2) {
    process.exit(73)
  }
  return rename(from, to)
}
`)
  const first = bump(cwd, ["--require", preload])
  assert.equal(first.status, 73, "expected interruption before the second atomic replacement")
  const partial = versions(cwd)
  assert.ok(partial.includes("1.2.1") && partial.includes("1.2.2"))
  const retry = bump(cwd)
  assert.equal(retry.status, 0, retry.stderr)
  assert.deepEqual(versions(cwd), ["1.2.2", "1.2.2", "1.2.2"])
  const nextBuild = bump(cwd)
  assert.equal(nextBuild.status, 0, nextBuild.stderr)
  assert.deepEqual(versions(cwd), ["1.2.3", "1.2.3", "1.2.3"])
}))

register("explicit Windows target is idempotent across two runs", () => fixture((cwd) => {
  for (let run = 0; run < 2; run++) {
    const result = bump(cwd, [], "1.4.0")
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(versions(cwd), ["1.4.0", "1.4.0", "1.4.0"])
  }
}))

register("Windows version selector uses explicit input or next tag version", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { selectVersion } from "./scripts/bump-version.mjs"
    const tags = ["v1.2.2", "v1.9.9", "v1.10.0-beta", "other"]
    assert.equal(selectVersion("1.2.1", "", tags), "2.0.0")
    assert.equal(selectVersion("1.2.1", "1.3.0", tags), "1.3.0")
    assert.equal(selectVersion("2.1.0", "", tags), "2.1.1")
    assert.throws(() => selectVersion("1.2.1", "1.2.2", tags), /already exists/)
    assert.throws(() => selectVersion("1.2.1", "v1.3.0", tags), /x.y.z/)
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
})

register("Windows workflow selects and checks the tag before packaging", () => {
  const workflow = readFileSync(".github/workflows/release-win.yml", "utf8")
  const packaging = workflow.indexOf("npm run package:win")
  assert.ok(packaging > 0)
  const before = workflow.slice(0, packaging)
  assert.match(before, /REQUESTED_VERSION:.*inputs\.version/)
  assert.match(before, /bump-version\.mjs --select "\$REQUESTED_VERSION"/)
  assert.match(before, /git ls-remote --exit-code.*refs\/tags/)
  assert.match(before, /MCODE_RELEASE_VERSION:.*steps\.ver\.outputs\.version/)
  assert.match(before, /"v\$MCODE_RELEASE_VERSION" != "\$RELEASE_TAG"/)
  assert.match(workflow, /"v\$version" != "\$RELEASE_TAG"/)
  assert.match(workflow, /gh release create.*--verify-tag/)
})

register("open-url relaunch preserves launch flags and replaces old links", () => {
  const incoming = "mcode://open-session?session=new"
  const argv = ["/path/to/MCode", "--user-data-dir=/tmp/profile with spaces",
    "MCODE://open-session?session=old", "--original-process-start-time=1", "--enable-logging"]
  assert.deepEqual(desktop.relaunchArgs(argv, incoming), [argv[1], argv[3], argv[4], incoming])
  assert.deepEqual(desktop.relaunchArgs(argv), [argv[1], argv[2], argv[4]])
  assert.deepEqual(desktop.relaunchArgs(["electron", "app", "--user-data-dir", "/tmp/other"], incoming),
    ["app", "--user-data-dir", "/tmp/other", incoming])
})

export async function relhygieneChecks(check: (label: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  for (const { name, run } of cases) {
    try { run(); check(name, true) } catch (err) { check(name, false, err instanceof Error ? err.message : String(err)) }
  }
}

/* Standalone entry, for `node_modules/.bin/jiti scripts/smoke-relhygiene.ts`. The battery drives
 * `relhygieneChecks` instead, so the count is never left to an argv match; the basename is compared
 * exactly because the battery builds this file as `rounds-smoke-relhygiene.mjs`. */
const entry = process.argv[1]?.split("/").pop()
if (entry === "smoke-relhygiene.ts" || entry === "smoke-relhygiene.mjs") {
  for (const { name, run } of cases) {
    try {
      run()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}: ${(error as Error).message}`)
      process.exitCode = 1
    }
  }
}
