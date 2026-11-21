/*
 * The two ways a candidate's patch comes into being had different rules. A patch the model types is
 * validated, and validation refuses anything over 96KB. A whole-file reply instead has git produce
 * the patch, and nothing on that path carried a limit — so a model that rewrites a large file gets
 * its entire diff recorded on the card and retained for the run (git's own 8 MiB output buffer is
 * the only ceiling), then handed to the arena, while the same change typed as a patch would have
 * been refused at the door.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { candidateDiff } from "../src/server/lab"
import type { LabTask } from "../src/server/lab-catalog"

type Check = (label: string, ok: boolean, detail?: unknown) => void

const git = (directory: string, ...args: string[]): string =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" })

const MAX_PATCH_BYTES = 96_000

export async function labSizeChecks(check: Check) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "lab-size-"))
  try {
    git(repo, "init", "-q", ".")
    git(repo, "config", "user.email", "lab@mcode.local")
    git(repo, "config", "user.name", "Lab")
    const lines = Array.from({ length: 6000 }, (_, at) => `export const line${at} = ${at}`)
    await fs.writeFile(path.join(repo, "big.ts"), lines.join("\n") + "\n")
    git(repo, "add", "big.ts")
    git(repo, "commit", "-q", "-m", "big file")
    const task = { id: "SIZE-01", files: ["big.ts"] } as unknown as LabTask

    // Every line touched: a plausible reply for "add a comment to each of these".
    await fs.writeFile(path.join(repo, "big.ts"), lines.map((line) => `${line} // touched`).join("\n") + "\n")

    let diff = ""
    let error = ""
    try {
      diff = await candidateDiff(repo, task)
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    }
    const detail = { diffBytes: diff.length, error: error.slice(0, 160) }
    check("a git-produced candidate patch is bounded like a typed one", diff.length === 0 || diff.length <= MAX_PATCH_BYTES, detail)
    check("the refusal names the limit it hit", /96\s?KB|96_000|96000/.test(error), detail)
  } finally {
    await fs.rm(repo, { recursive: true, force: true })
  }
}
