/**
 * Proof that the R22-L2 checks fail on the code they were written against: the
 * v2.0 files are materialised into a temporary tree and the same check function
 * is run over it. Not part of the suite - run by hand while the lane was open.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { roundTwentyTwoLaneTwoChecks } from "./smoke-round22-l2"

const FILES = [
  "src/renderer/src/components/RightPanel.vue",
  "src/renderer/src/components/right/OfficeTab.vue",
  "src/renderer/src/components/right/HtmlTab.vue",
  "src/renderer/src/components/right/RpFiles.vue",
  "src/renderer/src/components/right/OfficeFallback.vue",
  "src/renderer/src/components/right/VersionHistory.vue",
  "src/renderer/src/components/right/RpDiffTab.vue",
  "src/renderer/src/components/right/RpReview.vue",
  "src/renderer/src/components/right/DocxView.vue",
  "src/renderer/src/components/right/RpSubagents.vue",
  "src/renderer/src/components/right/PaneBoundary.vue",
  "src/renderer/src/components/AnnotationChips.vue",
  "src/renderer/src/components/ErrorBoundary.vue",
]

const root = fs.mkdtempSync(path.join(os.tmpdir(), "r22l2-before-"))
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
  } else {
    failures.push(name)
    console.log("  FAILS     " + name)
  }
}
const section = (name: string) => console.log("\n" + name)

await roundTwentyTwoLaneTwoChecks(check, section, root)
console.log(`\non v2.0: ${failures.length} of ${failures.length + passed} checks fail, ${passed} pass`)
