/*
 * A candidate that passed every acceptance test still lost its run: the arena answered
 * `patch does not apply` at the very hunk the task's regression had moved. The reason was two
 * different baselines — the candidate's checkout had the bug in its files but clean code in its
 * index, so `git diff` described the whole fix against clean code, while the arena replays the
 * patch onto a checkout whose index carries the bug. Both sides now start from the bug, and
 * this file is the reason that stays true.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { applyPatch, candidateDiff, enterBugState, rankRepairs } from "../src/server/lab"
import type { LabTask } from "../src/server/lab-catalog"

type Check = (label: string, ok: boolean, detail?: unknown) => void

const CLEAN = "export const width = (text: string): number => {\n  return text.length\n}\n"
const BUGGED = "export const width = (text: string): number => {\n  return 0\n}\n"
/* The model's answer restores the body and adds a line of its own, so its patch cannot be
 * mistaken for a plain revert of the regression. */
const FIXED = "export const width = (text: string): number => {\n  const trimmed = text.trim()\n  return trimmed.length\n}\n"

const git = (directory: string, ...args: string[]): string =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" })

export async function labReplayChecks(check: Check) {
  // Which candidate reaches the arena is decided here, and length alone picked the wrong one.
  const shape = (worker: number, score: number | undefined, patchSize: number) =>
    ({ patch: "x".repeat(patchSize), card: { worker, score } })
  const better = shape(2, 1, 900)
  const shorter = shape(1, 0, 100)
  check("the candidate that passed the acceptance tests outranks a shorter guess",
    rankRepairs([shorter, better])[0] === better, rankRepairs([shorter, better]).map((r) => r.card.worker))
  check("equal scores prefer the smaller patch",
    rankRepairs([shape(1, 1, 900), shape(2, 1, 100)])[0]?.card.worker === 2)
  check("a missing score ranks as nothing passed",
    rankRepairs([shape(1, undefined, 100), shape(2, 0.5, 900)])[0]?.card.worker === 2)
  check("score and size tied, the lower worker slot wins",
    rankRepairs([shape(3, 1, 100), shape(1, 1, 100)])[0]?.card.worker === 1)
  const order = [shape(1, 0, 10), shape(2, 1, 10)]
  rankRepairs(order)
  check("ranking does not disturb the caller's list", order[0]?.card.worker === 1, order.map((r) => r.card.worker))

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-replay-"))
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lab-replay-scratch-"))
  const worktrees: string[] = []
  try {
    git(root, "init", "-q", ".")
    git(root, "-c", "user.name=t", "-c", "user.email=t@localhost", "config", "core.hooksPath", "/dev/null")
    await fs.writeFile(path.join(root, "a.ts"), CLEAN)
    git(root, "add", "a.ts")
    git(root, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "clean")
    const base = git(root, "rev-parse", "HEAD").trim()

    // The task's regression, as the catalogue stores it: clean code in, bug out.
    await fs.writeFile(path.join(root, "a.ts"), BUGGED)
    const regression = git(root, "diff", "--", "a.ts")
    await fs.writeFile(path.join(root, "a.ts"), CLEAN)
    const task: LabTask = { id: "T-1", title: "width is zero", commit: base, files: ["a.ts"], regression, tests: [] }
    check("the regression is a real patch", regression.includes("-  return text.length") && regression.includes("+  return 0"), regression)

    const open = async (name: string) => {
      const directory = path.join(root, name)
      worktrees.push(directory)
      git(root, "worktree", "add", "--detach", directory, base)
      return directory
    }

    const candidate = await open("candidate")
    await enterBugState(candidate, scratch, task)
    check("the bug is in the candidate's index, not only in its files",
      git(candidate, "diff", "--cached", "--name-only").trim() === "a.ts", git(candidate, "status", "--porcelain"))

    // What the model hands back, as a whole-file rewrite would be.
    await fs.writeFile(path.join(candidate, "a.ts"), FIXED)
    const patch = await candidateDiff(candidate, task)
    check("the candidate patch is relative to the bug", patch.includes("-  return 0") && patch.includes("+  return trimmed.length"), patch)
    check("the candidate patch is not the whole fix against clean code", !patch.includes("return text.length"), patch)

    const arena = await open("arena")
    await applyPatch(arena, scratch, task.regression, task, true)
    let rejected = ""
    try {
      await applyPatch(arena, scratch, patch, task, true)
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error)
    }
    check("the arena replays the candidate patch onto the same bug", rejected === "", rejected)
    check("the arena ends with the candidate's own file",
      rejected === "" && (await fs.readFile(path.join(arena, "a.ts"), "utf8")) === FIXED,
      rejected === "" ? await fs.readFile(path.join(arena, "a.ts"), "utf8") : rejected)

    // A patch that wanders outside the scope must still be refused on the way in.
    const stray = regression.replace(/a\.ts/g, "b.ts")
    let refused = ""
    try {
      await applyPatch(arena, scratch, stray, { ...task, files: ["a.ts"] }, true)
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    check("a patch outside the task's files is refused", refused.includes("outside the task scope"), refused)

    /*
     * The other contract — the model writes the diff itself. What the card records has to be the
     * patch the arena replays, not the summary `applyPatch` answers with, or an accepted candidate
     * cannot be replayed later. A hand-written diff stands in for the model's reply here.
     */
    const hand = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " export const width = (text: string): number => {",
      "-  return 0",
      "+  const trimmed = text.trim()",
      "+  return trimmed.length",
      " }",
      "",
    ].join("\n")
    const second = await open("candidate2")
    await enterBugState(second, scratch, task)
    await applyPatch(second, scratch, hand, task)
    const recorded = await candidateDiff(second, task)
    check("a hand-written patch is recorded as a diff, not a summary", recorded.startsWith("diff --git"), recorded.slice(0, 120))
    check("the recorded diff still describes the fix", recorded.includes("+  return trimmed.length"), recorded)
    const arena2 = await open("arena2")
    await applyPatch(arena2, scratch, task.regression, task, true)
    let replay = ""
    try {
      await applyPatch(arena2, scratch, recorded, task, true)
    } catch (error) {
      replay = error instanceof Error ? error.message : String(error)
    }
    check("an accepted candidate can be replayed from what was recorded", replay === "", replay)

    /*
     * The person's own git config must not be able to change the shape of a recorded diff. With
     * `diff.noprefix = true` git answers `--- a/a.ts` as `--- a/a.ts` minus its prefix, so the
     * header agreement rule rejects every candidate on that machine, and `diff.external` hands the
     * diff to a GUI tool and leaves stdout empty — which reads as "the patch changed nothing". Both
     * are ordinary settings on a developer box, and neither has anything to do with the candidate.
     */
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "lab-gitconfig-"))
    const personalConfig = path.join(configHome, "config")
    await fs.writeFile(
      personalConfig,
      "[diff]\n\tnoprefix = true\n" + (process.platform === "win32" ? "" : "\texternal = /bin/true\n"),
    )
    const savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    try {
      process.env.GIT_CONFIG_GLOBAL = personalConfig
      let shaped = ""
      let shapedError = ""
      try {
        shaped = await candidateDiff(second, task)
      } catch (error) {
        shapedError = error instanceof Error ? error.message.split("\n")[0] : String(error)
      }
      check("a personal gitconfig cannot reshape a recorded diff", shaped.includes("--- a/a.ts") && shaped.includes("+++ b/a.ts"), { shapedError, shaped: shaped.slice(0, 120) })
    } finally {
      if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig
      await fs.rm(configHome, { recursive: true, force: true })
    }
  } finally {
    for (const directory of worktrees) {
      try {
        git(root, "worktree", "remove", "--force", directory)
      } catch {
        // A checkout that never got created has nothing to remove.
      }
    }
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(scratch, { recursive: true, force: true })
  }
}
