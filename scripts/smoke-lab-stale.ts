/*
 * A task's regression is a patch cut from history, so it rots as the file moves under it — LAB-05
 * sat behind 185 commits of change to `ToolPart.vue`. Nothing noticed until the patch was applied
 * while preparing candidates, outside any candidate's error handling, and the run failed with
 * seven still-valid tasks discarded behind it. A task that no longer lands must cost its own
 * round and say so.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { staleTask } from "../src/server/lab"
import type { LabTask } from "../src/server/lab-catalog"

type Check = (label: string, ok: boolean, detail?: unknown) => void

const git = (directory: string, ...args: string[]): string =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" })

const ORIGINAL = "export const label = (n: number): string => {\n  return `step ${n}`\n}\n"
const BROKEN = "export const label = (n: number): string => {\n  return \"\"\n}\n"

export async function labStaleChecks(check: Check) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "lab-stale-"))
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lab-stale-scratch-"))
  try {
    git(repo, "init", "-q", ".")
    git(repo, "config", "core.hooksPath", "/dev/null")
    await fs.writeFile(path.join(repo, "steps.ts"), ORIGINAL)
    git(repo, "add", "steps.ts")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "clean")

    await fs.writeFile(path.join(repo, "steps.ts"), BROKEN)
    const regression = git(repo, "diff", "--", "steps.ts")
    await fs.writeFile(path.join(repo, "steps.ts"), ORIGINAL)
    const task: LabTask = { id: "LAB-X", title: "label is empty", commit: git(repo, "rev-parse", "HEAD").trim(), files: ["steps.ts"], regression, tests: [] }

    check("a task that still lands is not called stale", (await staleTask(repo, scratch, task)) === "", await staleTask(repo, scratch, task))

    // The same patch against a file that has since moved on.
    await fs.writeFile(path.join(repo, "steps.ts"), "export const label = (n: number): string => {\n  return `step ${n + 1} of many`\n}\n")
    git(repo, "add", "steps.ts")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "the file moved")

    const stale = await staleTask(repo, scratch, task)
    check("a task whose file moved on is reported stale", stale.includes("no longer applies"), stale)
    check("the message names the task so a card can show which one", stale.includes("LAB-X"), stale)
    check("the message carries Git's own complaint", stale.includes("steps.ts"), stale)

    // Asked before the fixture restores anything: after a restore commit the tree is clean
    // whatever the check did to it, so the assertion below could never notice a side effect.
    check("checking leaves the checkout untouched", git(repo, "status", "--porcelain") === "", git(repo, "status", "--porcelain"))

    /*
     * A Git that could not run at all — no repository, an index lock, an unreadable object — says
     * `fatal:`, which is not the same event as a patch that no longer matches the file. Reported as
     * stale, the task is skipped and the round goes green with fewer tasks than the catalog has.
     */
    const savedPath = process.env.PATH
    try {
      process.env.PATH = ""
      let infrastructure = ""
      try {
        await staleTask(repo, scratch, task)
      } catch (error) {
        infrastructure = error instanceof Error ? error.message : String(error)
      }
      check("a Git that never started is raised instead of called stale", infrastructure !== "", infrastructure)
    } finally {
      process.env.PATH = savedPath
    }

    await fs.writeFile(path.join(repo, "steps.ts"), ORIGINAL)
    git(repo, "add", "steps.ts")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "back")
    check("the checkout is clean again once the fixture restores the file", git(repo, "status", "--porcelain") === "", git(repo, "status", "--porcelain"))
    check("no patch file is left behind in scratch", (await fs.readdir(scratch)).length === 0, await fs.readdir(scratch))
  } finally {
    await fs.rm(repo, { recursive: true, force: true })
    await fs.rm(scratch, { recursive: true, force: true })
  }
}
