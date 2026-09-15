import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import * as git from "../git"

const run = promisify(execFile)

/** The most files one card asks about; rows past it keep the counts the turn's tools recorded. */
const MAX_FILES = 200

/**
 * The edited-files card's "as the files stand now", which is what MiMo counts
 * and reviews: each of a turn's files diffed against the repository, one patch
 * per file so the card can put each back on its own row. Outside a repository
 * there is nothing to compare with, and the card keeps the diffs the turn's own
 * tools recorded.
 *
 * A path that leaves the project is answered with nothing: an untracked file
 * is diffed against /dev/null, which would print any file the path reached.
 */
export async function turnFileDiffs(
  directory: string,
  files: string[],
): Promise<{ repo: boolean; files: { path: string; patch: string }[] }> {
  const repo = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: directory, windowsHide: true })
    .then(({ stdout }) => stdout.trim() === "true")
    .catch(() => false)
  if (!repo) return { repo: false, files: [] }

  const root = path.resolve(directory)
  const out: { path: string; patch: string }[] = []
  for (const file of files.slice(0, MAX_FILES)) {
    const relative = path.relative(root, path.resolve(root, file))
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      out.push({ path: file, patch: "" })
      continue
    }
    out.push({ path: file, patch: await git.diff(directory, file).catch(() => "") })
  }
  return { repo: true, files: out }
}
