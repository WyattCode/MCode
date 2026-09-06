/**
 * The undo recorder, exercised against a real git.
 *
 * It exists because of what the recorder costs when it is pointed at a folder
 * that is not a repository: `git add -A` hashes and stores every file it can
 * see, with no .gitignore to stop it. Two projects on the machine this was
 * found on showed the price - 7.9s per turn to stage a 182 MB C server, and a
 * 44 GB undo store for another folder, holding 1.4 GB blobs of game data over
 * and over. The reference refuses the same way, with `if (vcs !== "git")`.
 *
 * So: a project outside git must leave no shadow repository behind, and one
 * inside git must still record and read back.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { Snapshots } from "@server/session/snapshot"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-snapshot-check-"))
const store = path.join(root, "store")
await fs.mkdir(store, { recursive: true })

async function record(name: string, asRepo: boolean) {
  const project = path.join(root, name)
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, "a.txt"), "before", "utf8")
  if (asRepo) execFileSync("git", ["init", "-q"], { cwd: project })

  const recording = new Snapshots(store).begin(project)
  await recording.ready()
  await fs.writeFile(path.join(project, "a.txt"), "after", "utf8")
  const done = await recording.finish()
  return { done, shadows: (await fs.readdir(store).catch(() => [])).length }
}

const problems: string[] = []

const plain = await record("plain", false)
if (plain.shadows !== 0) problems.push(`a project outside git left ${plain.shadows} shadow repository(ies) behind`)
if (!plain.done.unavailable) problems.push("a project outside git was not told why the turn went unrecorded")
if (plain.done.files.length !== 0) problems.push("a project outside git recorded files anyway")

const repo = await record("repo", true)
if (repo.done.unavailable) problems.push(`a git project failed to record: ${repo.done.unavailable}`)
if (repo.done.files.length !== 1) problems.push(`a git project recorded ${repo.done.files.length} files, expected 1`)
// The recorder reports absolute paths, which is what restoring them needs.
const recorded = repo.done.files[0]?.path ?? ""
if (path.basename(recorded) !== "a.txt" || !path.isAbsolute(recorded))
  problems.push(`a git project recorded ${recorded || "nothing"}, expected an absolute path to a.txt`)

await fs.rm(root, { recursive: true, force: true })

if (problems.length) {
  console.error(`FAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log("undo records inside git and stays out of everything else.")
