/**
 * Proof that the R21-F2 checks fail on the code they were written against: the
 * v2.0 files are materialised into a temporary tree and the same check function
 * is run over it. Not part of the suite - run by hand while the lane was open.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { roundTwentyOneLaneFTwoChecks } from "./smoke-round21-f2"

const FILES = [
  "src/renderer/src/components/SettingsDialog.vue",
  "src/renderer/src/components/ModelsPage.vue",
  "src/renderer/src/components/CustomProviderForm.vue",
  "src/renderer/src/components/ProviderCloneDialog.vue",
  "src/renderer/src/components/ConfirmDialog.vue",
  "src/renderer/src/components/ConnectDialog.vue",
  "src/renderer/src/lib/i18n.ts",
]

const root = fs.mkdtempSync(path.join(os.tmpdir(), "r21f2-before-"))
for (const file of FILES) {
  const body = execFileSync("git", ["show", `v2.0:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), body)
}

let passed = 0
const failures: string[] = []
const check = (name: string, ok: unknown) => {
  if (ok) {
    passed++
    console.log("  STILL OK  " + name)
  } else failures.push(name)
}
const section = (name: string) => console.log("\n" + name)

await roundTwentyOneLaneFTwoChecks(check, section, root)
console.log(`\non v2.0: ${failures.length} of ${failures.length + passed} checks fail, ${passed} pass`)
