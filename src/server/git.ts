import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Just enough git to review what a turn did.
 *
 * Shelling out rather than linking a library: the user's git is the one that
 * knows about their config, hooks and worktrees, and this only ever asks it
 * questions the CLI answers plainly.
 */

/** How one file differs from HEAD, in the vocabulary the review speaks. */
export type GitChangeKind = "added" | "deleted" | "modified"

export interface GitChange {
  path: string
  kind: GitChangeKind
}

export interface GitStatus {
  /** Whether git itself is available on this machine. */
  installed: boolean
  /** Whether the project directory is inside a repository. */
  repo: boolean
  branch?: string
  /** Paths changed in the working tree, relative to the project directory. */
  changed: string[]
  /** The same files, carrying the letter git already reported for each. */
  entries: GitChange[]
}

/**
 * The repository root, which is not always the project directory.
 *
 * git reports and accepts paths relative to the root, so a project opened on a
 * subdirectory would list files it then could not diff or revert - the review
 * showed the file, showed no changes, and "discard" quietly did nothing.
 */
async function toplevel(directory: string): Promise<string> {
  const out = await git(directory, ["rev-parse", "--show-toplevel"])
  return out.trim()
}

/**
 * The project directory as the filesystem really spells it.
 *
 * macOS keeps /var, /tmp and /etc as symlinks into /private, and git always
 * answers with the resolved path. Comparing git's answer against the path the
 * app was handed then makes every file in the repository look like it sits
 * outside it - the review pane listed nothing, and diff and discard failed with
 * "outside repository". Both sides are resolved before they are ever compared.
 */
async function realDirectory(directory: string): Promise<string> {
  return fs.realpath(directory).catch(() => path.resolve(directory))
}

/**
 * A project-relative or absolute path, spelled the way git will spell it.
 *
 * The file itself may not exist yet, so only its parent is resolved.
 */
async function locate(directory: string, file: string): Promise<string> {
  const absolute = path.resolve(directory, file)
  const parent = await fs.realpath(path.dirname(absolute)).catch(() => path.dirname(absolute))
  return path.join(parent, path.basename(absolute))
}

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd: directory,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

/**
 * Where this branch left the one it grew from.
 *
 * Reviewing a branch means reviewing everything on it, not only what is still
 * uncommitted - so the comparison point is the merge base with whichever
 * branch the repository treats as its trunk, not that branch's current tip.
 */
async function branchBase(root: string): Promise<string | undefined> {
  const remote = (await git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => "")).trim()
  const candidates = remote && remote !== "origin/HEAD" ? [remote] : []
  for (const name of ["main", "master", "develop", "trunk"]) {
    const found = (await git(root, ["rev-parse", "--verify", "--quiet", name]).catch(() => "")).trim()
    if (found) candidates.push(name)
  }
  for (const candidate of candidates) {
    const base = (await git(root, ["merge-base", "HEAD", candidate]).catch(() => "")).trim()
    // A branch is not its own base; that would report no changes at all.
    const head = (await git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim()
    if (base && base !== head) return base
  }
  return undefined
}

/** `git diff --name-status`, in the shape the review already speaks. */
async function committed(root: string, directory: string, base: string): Promise<GitChange[]> {
  const out = await git(root, ["diff", "--name-status", base]).catch(() => "")
  const entries: GitChange[] = []
  for (const line of out.split("\n")) {
    if (!line.trim()) continue
    const columns = line.split("\t")
    const code = columns[0] ?? ""
    // A rename carries both paths; the new one is what there is to look at.
    const raw = columns.length > 2 ? columns[2] : columns[1]
    if (!raw) continue
    const relative = path.relative(directory, path.resolve(root, raw)).split(path.sep).join("/")
    if (!relative || relative.startsWith("..")) continue
    entries.push({ path: relative, kind: classify(code.slice(0, 2)) })
  }
  return entries
}

export type StatusScope = "worktree" | "branch"

export async function status(directory: string, scope: StatusScope = "worktree"): Promise<GitStatus> {
  try {
    await run("git", ["--version"], { windowsHide: true })
  } catch {
    return { installed: false, repo: false, changed: [], entries: [] }
  }

  const dir = await realDirectory(directory)

  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")
  if (inside.trim() !== "true") return { installed: true, repo: false, changed: [], entries: [] }

  // A fresh repository has no HEAD yet, so the branch lookup is allowed to fail.
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim()

  const root = await toplevel(dir).catch(() => dir)

  const porcelain = await git(dir, ["status", "--porcelain=v1", "-uall"]).catch(() => "")
  const entries = porcelain
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      /*
       * The first two columns are the index and worktree letters. They used to
       * be sliced off and thrown away, which is why the review could list a
       * file but never say whether it had been added, deleted or edited.
       */
      const codes = line.slice(0, 2)
      const rest = line.slice(3).trim()
      // A rename reads as "old -> new"; the new path is the one to show.
      const raw = (rest.includes(" -> ") ? rest.split(" -> ")[1] : rest).replace(/^"|"$/g, "")
      // Reported relative to the root; the rest of the app speaks in paths
      // relative to the project, and so does the tool metadata it is matched to.
      const relative = path.relative(dir, path.resolve(root, raw)).split(path.sep).join("/")
      return { path: relative, kind: classify(codes) }
    })
    .filter((entry) => entry.path && !entry.path.startsWith(".."))

  /*
   * Branch scope adds what is already committed on this branch. The working
   * tree wins on any file in both, because how a file stands right now is
   * what someone about to revert it needs to be told.
   */
  let all = entries
  if (scope === "branch") {
    const base = await branchBase(root)
    if (base) {
      const seen = new Set(entries.map((entry) => entry.path))
      all = [
        ...entries,
        ...(await committed(root, dir, base)).filter((entry) => !seen.has(entry.path)),
      ].sort((a, b) => a.path.localeCompare(b.path))
    }
  }

  return {
    installed: true,
    repo: true,
    branch: branch || undefined,
    changed: all.map((entry) => entry.path),
    entries: all,
  }
}

/**
 * The two status columns, reduced to the one word the review shows.
 *
 * "??" is an untracked file, which to someone reading a turn is an addition
 * however git files it. Anything with a D in either column is a deletion; a
 * rename lands as modified, since what is on screen is the file at its new
 * path with its old content beside it.
 */
function classify(codes: string): GitChangeKind {
  if (codes === "??" || codes.includes("A")) return "added"
  if (codes.includes("D")) return "deleted"
  return "modified"
}

export async function init(directory: string): Promise<GitStatus> {
  await git(directory, ["init"])
  return status(directory)
}

/**
 * The working-tree patch for one file, including files git has never seen -
 * without --no-index a new file shows as nothing at all, which is exactly the
 * case someone reviewing a turn cares about most.
 */
export async function diff(
  directory: string,
  file: string,
  context?: number,
  scope: StatusScope = "worktree",
): Promise<string> {
  // Clamped rather than trusted: this number reaches a command line.
  const lines = Math.max(0, Math.min(100_000, Math.round(context ?? 3)))
  const unified = `-U${lines}`
  const dir = await realDirectory(directory)
  const absolute = await locate(dir, file)
  const root = await toplevel(dir).catch(() => dir)
  const inRepo = path.relative(root, absolute).split(path.sep).join("/")

  const tracked = await git(root, ["ls-files", "--error-unmatch", "--", inRepo])
    .then(() => true)
    .catch(() => false)

  /*
   * In branch scope the comparison runs from where the branch started, so a
   * file whose change was committed an hour ago still shows what it was -
   * against the working tree it would look untouched.
   */
  const base = scope === "branch" ? await branchBase(root) : undefined

  const patch = tracked
    ? await git(root, base ? ["diff", unified, base, "--", inRepo] : ["diff", unified, "--", inRepo]).catch(
        () => "",
      )
    : await git(root, ["diff", "--no-index", unified, "--", "/dev/null", inRepo]).catch(
        (error: { stdout?: string }) => error.stdout ?? "",
      )

  /*
   * Handed back whole.
   *
   * This used to clip at 15,000 bytes and append "...", and that made two
   * numbers on screen wrong rather than merely approximate. Everything the
   * panel says about a patch is counted from the patch text itself - the
   * +/- pair in the file header, and the changed-line figure in the large-diff
   * guard's message - so a fully rewritten 900-line file reported "1,371
   * changed lines" against a real 1,800, and the "..." was silently read as a
   * context line. A guard whose own message understates the thing it is
   * guarding against is worse than no guard, because the reader has no reason
   * to distrust it.
   *
   * Neither of the two repairs the brief offered is what the reference does:
   * it does not truncate at all, and it does not count from the rendered text
   * either. Its diff arrives from its API as a record carrying `additions` and
   * `deletions` as numbers beside the file's before and after text, and its
   * guard reads `diff.additions + diff.deletions` (main-8t-QUXax.js @5170005) -
   * so the count cannot drift from the payload however large the payload is.
   * Carrying a true size beside a clipped patch here would mean widening the
   * `git.diff` response, which is protocol; saying "truncated" in the message
   * would mean a string the reference has never written. Not clipping is the
   * one repair that is entirely inside this file and is also what the
   * reference's own arrangement amounts to.
   *
   * What bounds this now is the `maxBuffer` on the git call above: 8MB of
   * patch, past which git's own output is refused and the caller sees an empty
   * patch. The renderer is protected by the guard rather than by the wire -
   * over 500 changed lines it declines to parse or draw anything until the
   * reader asks, which is the reference's arrangement exactly.
   */
  return patch
}

/** Throws away every uncommitted change to one file. */
export async function revert(directory: string, file: string): Promise<void> {
  const dir = await realDirectory(directory)
  const absolute = await locate(dir, file)
  const root = await toplevel(dir).catch(() => dir)
  const inRepo = path.relative(root, absolute).split(path.sep).join("/")

  // Refuse to touch anything outside the project, however the path was spelled.
  const inProject = path.relative(dir, absolute)
  if (inProject.startsWith("..") || path.isAbsolute(inProject)) {
    throw new Error(`Refusing to revert outside the project: ${file}`)
  }

  const tracked = await git(root, ["ls-files", "--error-unmatch", "--", inRepo])
    .then(() => true)
    .catch(() => false)
  if (tracked) await git(root, ["checkout", "--", inRepo])
  else await git(root, ["clean", "-f", "--", inRepo])
}

/** One checkout of a repository, as `git worktree list` reports it. */
export interface Worktree {
  /** Absolute path of the checkout. */
  directory: string
  /** Branch name, or a short SHA when the checkout is detached. */
  branch?: string
  /** The repository's own checkout, which cannot be removed. */
  main: boolean
}

/**
 * The checkouts this repository has.
 *
 * A workspace in this app is a git worktree: a second directory on its own
 * branch, sharing the repository's history. That is what lets two sessions
 * work on the same project without treading on each other's files.
 */
export async function worktrees(directory: string): Promise<Worktree[]> {
  let stdout: string
  try {
    ;({ stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: directory }))
  } catch {
    return []
  }

  const out: Worktree[] = []
  let current: Partial<Worktree> = {}
  const flush = () => {
    if (current.directory) out.push({ ...current, main: out.length === 0 } as Worktree)
    current = {}
  }
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush()
      current.directory = line.slice(9).trim()
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "")
    } else if (line.startsWith("HEAD ")) {
      current.branch = current.branch ?? line.slice(5).trim().slice(0, 7)
    }
  }
  flush()
  return out
}

/**
 * Adds a checkout beside the repository, on a branch of its own.
 *
 * The directory is a sibling rather than a child: a worktree inside the
 * repository would show up in its own file listings and searches, which is
 * confusing at best and gets committed at worst.
 */
export async function addWorktree(
  directory: string,
  name: string,
): Promise<{ directory: string; branch: string }> {
  const safe = name.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!safe) throw new Error("a workspace needs a name")

  const root = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: directory })).stdout.trim()
  const target = path.join(path.dirname(root), `${path.basename(root)}-${safe}`)

  // A branch that already exists is checked out rather than recreated, which
  // is what makes this safe to run twice.
  const exists = await run("git", ["rev-parse", "--verify", safe], { cwd: root }).then(
    () => true,
    () => false,
  )
  const args = exists
    ? ["worktree", "add", target, safe]
    : ["worktree", "add", "-b", safe, target]
  await run("git", args, { cwd: root })
  return { directory: target, branch: safe }
}

/** Removes a checkout, leaving its branch behind. */
export async function removeWorktree(directory: string, target: string): Promise<void> {
  await run("git", ["worktree", "remove", target, "--force"], { cwd: directory })
}
