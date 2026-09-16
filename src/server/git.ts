import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { BranchState, CheckoutResult, CommitResult, CommitState, GitFileLines, GitSummary, PushResult } from "@shared/protocol"
import { hasGithubRemote } from "./pull-request"

const run = promisify(execFile)

/**
 * Just enough git to review what a turn did.
 *
 * Shelling out rather than linking a library: the user's git is the one that
 * knows about their config, hooks and worktrees, and this only ever asks it
 * questions the CLI answers plainly.
 */

/** How one file differs from HEAD, in the vocabulary the review speaks. */
export type GitChangeKind = "added" | "deleted" | "modified" | "renamed"

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
 * A git command that is allowed to fail, for the places that ask a question
 * whose answer may be "no" - is this file tracked, does this patch apply.
 */
export async function tryGit(directory: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(directory, args) }
  } catch {
    return { ok: false, out: "" }
  }
}

/**
 * The repository the folder sits in, or nothing when it is not in one.
 *
 * Answers for a folder that does not exist yet by walking up to the first one
 * that does, as MiMo's does, so a file the turn created and something has
 * since deleted still finds its repository.
 */
export async function repositoryRoot(directory: string): Promise<string | undefined> {
  let at = path.resolve(directory)
  for (let depth = 0; depth < 64; depth++) {
    const exists = await fs
      .stat(at)
      .then((stats) => stats.isDirectory())
      .catch(() => false)
    if (exists) break
    const up = path.dirname(at)
    if (up === at) return undefined
    at = up
  }
  const answer = await tryGit(at, ["rev-parse", "--show-toplevel"])
  const root = answer.out.split(/\r?\n/)[0]?.trim()
  return answer.ok && root ? path.resolve(root) : undefined
}

/** Whether git has this file in the index, which decides what taking a change back may use. */
export async function isTracked(root: string, file: string): Promise<boolean> {
  return (await tryGit(root, ["ls-files", "--error-unmatch", "--", file])).ok
}

/** `git checkout -- <file>`: MiMo's last resort when a patch will not go back on. */
export async function checkoutFile(root: string, file: string): Promise<boolean> {
  return (await tryGit(root, ["checkout", "--", file])).ok
}

/**
 * `git apply` of a patch held in a temporary file, with MiMo's own flags.
 *
 * `--recount` lets a patch whose counts drifted still apply, and
 * `--ignore-whitespace` covers the line endings a file picks up on the way
 * through an editor.
 */
export async function applyPatch(root: string, patch: string, reverse: boolean): Promise<boolean> {
  const file = path.join(os.tmpdir(), `mcode-revert-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`)
  try {
    await fs.writeFile(file, patch, "utf8")
    const args = ["apply", ...(reverse ? ["--reverse"] : []), "-p1", "--recount", "--whitespace=nowarn", "--ignore-whitespace", file]
    return (await tryGit(root, args)).ok
  } catch {
    return false
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
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

/**
 * The last few commits, subject line only.
 *
 * For the agent's opening context rather than for the review: what a project
 * has been doing lately is the cheapest available hint about how its commits
 * are written and what part of it is currently being worked on.
 */
export async function recentCommits(directory: string, count = 5): Promise<string[]> {
  const out = await git(directory, [
    "log",
    "--max-count=" + Math.max(1, Math.min(20, count)),
    "--pretty=format:%h %s",
  ]).catch(() => "")
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * The branch a pull request would usually target, by name.
 *
 * `branchBase` answers with a merge-base commit, which is what a diff needs;
 * this answers with the trunk's own name, which is what the model needs to be
 * told before it opens a pull request against the wrong branch. The remote's
 * HEAD wins where it is set, that being what the host itself calls default;
 * failing that, the first conventional name the repository actually has.
 */
export async function defaultBranch(directory: string): Promise<string | undefined> {
  const remote = (await tryGit(directory, ["rev-parse", "--abbrev-ref", "origin/HEAD"])).out.trim()
  if (remote && remote !== "origin/HEAD") return remote.replace(/^origin\//, "")
  for (const name of ["main", "master", "develop", "trunk"]) {
    if ((await tryGit(directory, ["rev-parse", "--verify", "--quiet", name])).out.trim()) return name
  }
  return undefined
}

/**
 * Who git will attribute a commit to here.
 *
 * The name only. Git also knows the address, and MiMo prints what its own
 * helper returns, but an email in every request is more of the user than the
 * model needs to write a commit.
 */
export async function gitUser(directory: string): Promise<string | undefined> {
  return (await tryGit(directory, ["config", "user.name"])).out.trim() || undefined
}

export type StatusScope = "worktree" | "branch"

export async function status(directory: string, scope: StatusScope = "worktree"): Promise<GitStatus> {
  try {
    await run("git", ["--version"], { windowsHide: true })
  } catch {
    return { installed: false, repo: false, changed: [], entries: [] }
  }

  const inside = await git(directory, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")
  if (inside.trim() !== "true") return { installed: true, repo: false, changed: [], entries: [] }

  // A fresh repository has no HEAD yet, so the branch lookup is allowed to fail.
  const branch = (await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim()

  const root = await toplevel(directory).catch(() => directory)

  const porcelain = await git(directory, ["status", "--porcelain=v1", "-uall"]).catch(() => "")
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
      const relative = path.relative(directory, path.resolve(root, raw)).split(path.sep).join("/")
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
        ...(await committed(root, directory, base)).filter((entry) => !seen.has(entry.path)),
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
 * however git files it. Anything with a D in either column is a deletion. A
 * rename or copy is its own word, as MiMo draws it: a purple R.
 */
export function classify(codes: string): GitChangeKind {
  if (codes === "??" || codes.includes("A")) return "added"
  if (codes.includes("D")) return "deleted"
  if (codes.includes("R") || codes.includes("C")) return "renamed"
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
  const absolute = path.resolve(directory, file)
  const root = await toplevel(directory).catch(() => directory)
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

  const untracked = () =>
    git(root, ["diff", "--no-index", unified, "--", "/dev/null", inRepo]).catch(
      (error: { stdout?: string }) => error.stdout ?? "",
    )

  /*
   * The working tree against HEAD, as MiMo's gitDiff asks, so a change that is
   * only staged still shows: index against worktree drew it as no diff at all.
   * A repository with no commit yet has no HEAD, and falls back to the plain
   * diff; a file staged into such a repository is still new against nothing.
   */
  let patch: string
  if (!tracked) patch = await untracked()
  else if (base) patch = await git(root, ["diff", unified, base, "--", inRepo]).catch(() => "")
  else {
    patch = await git(root, ["diff", unified, "HEAD", "--", inRepo]).catch(() =>
      git(root, ["diff", unified, "--", inRepo]).catch(() => ""),
    )
    if (!patch.trim()) {
      const hasHead = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false)
      if (!hasHead) patch = await untracked()
    }
  }

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
  const absolute = path.resolve(directory, file)
  const root = await toplevel(directory).catch(() => directory)
  const inRepo = path.relative(root, absolute).split(path.sep).join("/")

  // Refuse to touch anything outside the project, however the path was spelled.
  const inProject = path.relative(path.resolve(directory), absolute)
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

/**
 * The repository's local branches and the one checked out, as the home
 * screen's branch chip needs them. A repository with no commit yet, or one on
 * a detached HEAD, has no branch to show.
 */
export async function branchState(directory: string): Promise<BranchState> {
  const inside = (await git(directory, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim()
  if (inside !== "true") return { repo: false, detached: false, branches: [] }
  const head = (await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim()
  const branches = (await git(directory, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const detached = !head || head === "HEAD"
  return { repo: true, detached, ...(detached ? {} : { branch: head }), branches }
}

/**
 * Why a new branch name would be refused, before git is asked: MiMo's own
 * rules, which are git's check-ref-format rules for a branch.
 */
export function branchNameProblem(name: string, existing: string[]): "empty" | "exists" | "invalid" | undefined {
  const trimmed = name.trim()
  if (!trimmed) return "empty"
  if (existing.includes(trimmed)) return "exists"
  if (
    /[\s~^:?*[\\]/.test(trimmed) ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("@{") ||
    trimmed.includes("//") ||
    trimmed.startsWith("-") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".lock") ||
    trimmed === "@"
  ) {
    return "invalid"
  }
  return undefined
}

function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr
  if (typeof stderr === "string" && stderr.trim()) return stderr
  return err instanceof Error ? err.message : String(err)
}

function checkoutFailure(err: unknown): CheckoutResult {
  const text = stderrOf(err)
  if (/untracked working tree file/i.test(text) && /would be overwritten/i.test(text)) {
    return { ok: false, code: "untracked-overwrite" }
  }
  if (/local changes to the following files would be overwritten/i.test(text)) return { ok: false, code: "local-overwrite" }
  const line = text.split("\n").map((entry) => entry.trim()).find(Boolean) ?? ""
  return { ok: false, error: line.replace(/^(error|fatal):\s*/i, "") }
}

async function hasConflicts(directory: string): Promise<boolean> {
  const porcelain = await git(directory, ["status", "--porcelain"]).catch(() => "")
  return porcelain.split("\n").some((line) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(line))
}

/**
 * Switches the checkout to another local branch, or makes a new one and
 * switches to it, the way MiMo's branch chip does.
 *
 * An ordinary switch over uncommitted work stops and says so, so the reader can
 * decide; forced, it carries the work across with `--merge`, which may leave
 * conflict markers behind - the switch has still happened then, and says that
 * it conflicted. A branch already checked out in another worktree is not
 * switched to here; its worktree is named instead, since git refuses to have
 * one branch in two checkouts.
 */
export async function checkout(
  directory: string,
  branch: string,
  options: { force?: boolean; create?: boolean } = {},
): Promise<CheckoutResult> {
  const name = branch.trim()
  const state = await branchState(directory)
  if (!state.repo) return { ok: false, error: "not a git repository" }

  if (options.create) {
    const problem = branchNameProblem(name, state.branches)
    if (problem === "exists") return { ok: false, code: "branch-exists" }
    if (problem) return { ok: false, code: "branch-invalid" }
    try {
      await git(directory, ["checkout", "-b", name])
      return { ok: true, branch: name }
    } catch (err) {
      return checkoutFailure(err)
    }
  }

  if (!state.branches.includes(name)) return { ok: false, error: `no local branch named ${name}` }
  if (name === state.branch) return { ok: true, branch: name }

  const root = path.resolve(await toplevel(directory).catch(() => directory))
  const elsewhere = (await worktrees(directory)).find(
    (tree) => tree.branch === name && path.resolve(tree.directory) !== root,
  )
  if (elsewhere) {
    const target = path.resolve(elsewhere.directory)
    return { ok: false, worktree: { directory: target, name: path.basename(target) } }
  }

  if (!options.force) {
    const porcelain = await git(directory, ["status", "--porcelain"]).catch(() => "")
    if (porcelain.split("\n").some((line) => line.trim())) return { ok: false, dirty: true }
  }

  try {
    await git(directory, options.force ? ["checkout", "--merge", name] : ["checkout", name])
  } catch (err) {
    // A merge that stopped on conflicts has still switched; anything else has not.
    if (options.force && (await branchState(directory)).branch === name) {
      return { ok: true, branch: name, conflicts: true }
    }
    return checkoutFailure(err)
  }
  return { ok: true, branch: name, ...(options.force && (await hasConflicts(directory)) ? { conflicts: true } : {}) }
}

/** Removes a checkout, leaving its branch behind. */
export async function removeWorktree(directory: string, target: string): Promise<void> {
  await run("git", ["worktree", "remove", target, "--force"], { cwd: directory })
}

// ------------------------------------------------------------ the info card

/** `git diff --numstat` rows; a binary file reports "-" and counts as no lines. */
function numstat(out: string): GitFileLines[] {
  const rows: GitFileLines[] = []
  for (const line of out.split("\n")) {
    const columns = line.split("\t")
    if (columns.length < 3) continue
    rows.push({
      path: columns.slice(2).join("\t").trim(),
      additions: Number(columns[0]) || 0,
      deletions: Number(columns[1]) || 0,
    })
  }
  return rows
}

/** Files larger than this are counted as changed but not read for their lines. */
const LINE_COUNT_LIMIT = 4 * 1024 * 1024

/** Lines in a file git has never seen, the way a diff against nothing counts them. */
async function untrackedLines(file: string): Promise<number> {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat?.isFile() || stat.size === 0 || stat.size > LINE_COUNT_LIMIT) return 0
  const bytes = await fs.readFile(file)
  // A NUL early on is how git itself decides a file is binary.
  if (bytes.subarray(0, 8000).includes(0)) return 0
  let lines = 0
  for (const byte of bytes) if (byte === 10) lines += 1
  return bytes[bytes.length - 1] === 10 ? lines : lines + 1
}

/** The tree git compares against when a repository has no commit yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/**
 * What the info card's 变更 row says: how many files differ from HEAD under the
 * project, and by how many lines each.
 *
 * Scoped to the project directory, as the review is, so the count here and the
 * list the row opens agree. Untracked files count as wholly added.
 */
export async function summary(directory: string): Promise<GitSummary> {
  const none: GitSummary = { repo: false, ok: false, detached: false, fileCount: 0, additions: 0, deletions: 0, files: [] }
  const inside = (await git(directory, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim()
  if (inside !== "true") return none
  const head = (await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim()
  const detached = !head || head === "HEAD"
  // Local only: reads the remotes' addresses, never contacts them.
  const github = hasGithubRemote(await git(directory, ["remote", "-v"]).catch(() => ""))
  const base: GitSummary = { ...none, repo: true, detached, github, ...(detached ? {} : { branch: head }) }
  try {
    const changed = await status(directory)
    const hasHead = await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
      () => true,
      () => false,
    )
    // --relative keeps both the paths and the comparison inside the project directory.
    const tracked = numstat(await git(directory, ["diff", "--numstat", "--relative", hasHead ? "HEAD" : EMPTY_TREE]))
    const others = (await git(directory, ["ls-files", "--others", "--exclude-standard"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    const fresh = await Promise.all(
      others.map(async (file) => ({ path: file, additions: await untrackedLines(path.join(directory, file)), deletions: 0 })),
    )
    const files = [...tracked, ...fresh]
    return {
      ...base,
      ok: true,
      fileCount: changed.entries.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files,
    }
  } catch {
    return base
  }
}

/** Every path `git status` reports, relative to the repository root. */
function porcelainPaths(porcelain: string): { staged: boolean; path: string }[] {
  return porcelain
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const rest = line.slice(3)
      const raw = rest.includes(" -> ") ? (rest.split(" -> ")[1] ?? rest) : rest
      return { staged: line[0] !== " " && line[0] !== "?", path: raw.replace(/^"|"$/g, "") }
    })
}

async function remotes(root: string): Promise<string[]> {
  return (await git(root, ["remote"]).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * What the commit or push card needs to decide which of its buttons may be
 * pressed: the whole repository's state, since a commit takes in the whole
 * index whichever folder the project was opened on.
 */
export async function commitState(directory: string): Promise<CommitState> {
  const blank: CommitState = {
    ok: false,
    isDetached: false,
    hasHead: false,
    hasChanges: false,
    hasStaged: false,
    stagedAdditions: 0,
    stagedDeletions: 0,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
    hasOrigin: false,
    hasOriginBranch: false,
    changedPaths: [],
  }
  try {
    const root = await toplevel(directory)
    const entries = porcelainPaths(await git(root, ["status", "--porcelain=v1", "-uall"]))
    const staged = numstat(await git(root, ["diff", "--cached", "--numstat"]).catch(() => ""))
    // symbolic-ref names the branch even before its first commit, and fails only when detached.
    const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim()
    const hasHead = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
      () => true,
      () => false,
    )
    const upstream = branch
      ? (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "")).trim()
      : ""
    const hasOrigin = (await remotes(root)).includes("origin")
    const hasOriginBranch =
      Boolean(branch && hasOrigin) &&
      (await git(root, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).then(
        () => true,
        () => false,
      ))
    // Measured against what a push would update: the upstream when one is set, else origin's branch of that name.
    const against = upstream || (hasOriginBranch ? `origin/${branch}` : "")
    let ahead = 0
    let behind = 0
    if (against && hasHead) {
      const counts = (await git(root, ["rev-list", "--left-right", "--count", `${against}...HEAD`]).catch(() => ""))
        .trim()
        .split(/\s+/)
      behind = Number(counts[0]) || 0
      ahead = Number(counts[1]) || 0
    }
    return {
      ok: true,
      ...(branch ? { branch } : {}),
      isDetached: !branch,
      hasHead,
      hasChanges: entries.length > 0,
      hasStaged: entries.some((entry) => entry.staged),
      stagedAdditions: staged.reduce((sum, file) => sum + file.additions, 0),
      stagedDeletions: staged.reduce((sum, file) => sum + file.deletions, 0),
      hasUpstream: Boolean(upstream),
      ...(upstream ? { upstream } : {}),
      ahead,
      behind,
      hasOrigin,
      hasOriginBranch,
      changedPaths: entries.map((entry) => entry.path),
    }
  } catch (err) {
    return { ...blank, error: stderrOf(err) }
  }
}

/** Everything git said, since "nothing to commit" arrives on stdout rather than stderr. */
function outputOf(err: unknown): string {
  const stdout = (err as { stdout?: unknown })?.stdout
  return `${typeof stdout === "string" ? stdout : ""}\n${stderrOf(err)}`
}

function firstLine(text: string): string {
  const line = text.split("\n").map((entry) => entry.trim()).find(Boolean) ?? ""
  return line.replace(/^(error|fatal):\s*/i, "")
}

export function commitFailure(err: unknown): CommitResult {
  const text = outputOf(err)
  if (/nothing (added )?to commit|no changes added to commit/i.test(text)) return { ok: false, code: "nothing-to-commit" }
  if (/please tell me who you are|author identity unknown|user\.name|user\.email/i.test(text)) {
    return { ok: false, code: "ident-missing" }
  }
  if (/(pre-commit|commit-msg|prepare-commit-msg) hook|hook (failed|declined|exited)/i.test(text)) {
    return { ok: false, code: "hook-rejected" }
  }
  return { ok: false, error: firstLine(stderrOf(err)) }
}

/**
 * Commits, with everything in the working tree first when asked.
 *
 * The user's hooks and signing settings run as they would in a terminal; nothing
 * here skips them.
 */
export async function commit(directory: string, message: string, includeUnstaged: boolean): Promise<CommitResult> {
  const text = message.trim()
  if (!text) return { ok: false, error: "empty commit message" }
  try {
    const root = await toplevel(directory)
    if (includeUnstaged) await git(root, ["add", "-A"])
    await git(root, ["commit", "-m", text])
    const hash = (await git(root, ["rev-parse", "--short", "HEAD"])).trim()
    return { ok: true, hash }
  } catch (err) {
    return commitFailure(err)
  }
}

export function pushFailure(err: unknown): PushResult {
  const text = outputOf(err)
  if (
    /authentication failed|permission denied \(publickey|could not read (username|password)|terminal prompts disabled|host key verification failed|returned error: 40[13]|HTTP 40[13]/i.test(
      text,
    )
  ) {
    return { ok: false, code: "auth" }
  }
  if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(text)) return { ok: false, code: "rejected" }
  if (/no configured push destination|does not appear to be a git repository/i.test(text)) return { ok: false, code: "no-remote" }
  if ((err as { killed?: boolean })?.killed) return { ok: false, error: "timed out" }
  return { ok: false, error: firstLine(stderrOf(err)) }
}

const PUSH_TIMEOUT_MS = 60_000

/**
 * Pushes the checked-out branch, and only it, never forced.
 *
 * With an upstream configured the branch goes exactly there. Without one it is
 * published to origin under its own name and that becomes its upstream, which
 * is what MiMo's button does for a new branch. Git is told not to stop and ask
 * for a password: there is no terminal for it to ask in, so a push that needs
 * one fails and says so instead of hanging.
 */
export async function push(directory: string): Promise<PushResult> {
  try {
    const root = await toplevel(directory)
    const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim()
    if (!branch) return { ok: false, error: "not on a branch" }
    const known = await remotes(root)
    const remote = (await git(root, ["config", "--get", `branch.${branch}.remote`]).catch(() => "")).trim()
    const merge = (await git(root, ["config", "--get", `branch.${branch}.merge`]).catch(() => "")).trim()
    let args: string[]
    if (remote && known.includes(remote) && merge.startsWith("refs/heads/")) {
      args = ["push", remote, `refs/heads/${branch}:${merge}`]
    } else {
      if (!known.includes("origin")) return { ok: false, code: "no-remote" }
      args = ["push", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`]
    }
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    // Batch mode for ssh, unless the user already chose how git reaches ssh.
    const sshCommand = (await git(root, ["config", "--get", "core.sshCommand"]).catch(() => "")).trim()
    if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !sshCommand) env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes"
    await run("git", args, { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: PUSH_TIMEOUT_MS, env })
    return { ok: true }
  } catch (err) {
    return pushFailure(err)
  }
}

// ------------------------------------------------------ commit message text

/** How long the model is given before the card falls back to its own wording. */
export const COMMIT_MESSAGE_TIMEOUT_MS = 8_000
const MESSAGE_PATHS = 50
const MESSAGE_DIFFS = 5
const MESSAGE_DIFF_LINES = 200
const MESSAGE_MAX = 200

export const COMMIT_MESSAGE_SYSTEM = [
  "You name a set of code changes for a git history.",
  "Answer with one subject line of at most 72 characters and nothing else - no body, no quotes, no markdown, no full stop at the end.",
  "Start with a conventional prefix (feat:, fix:, docs:, refactor:, test:, chore:) only when the diff makes the kind of change obvious.",
  "Keep file, function and identifier names exactly as they are spelled.",
  "Write in the language the changed code's own comments and text are written in.",
].join(" ")

/** The changed paths and the start of their diffs, as the model is shown them. */
export function commitMessagePrompt(paths: readonly string[], diffs: readonly string[]): string {
  const listed = paths.slice(0, MESSAGE_PATHS)
  const more = paths.length > listed.length ? [`... and ${paths.length - listed.length} more`] : []
  const lines = diffs.join("\n").split("\n").slice(0, MESSAGE_DIFF_LINES)
  return [`Changed files (${paths.length}):`, ...listed.map((file) => `- ${file}`), ...more, "", "Diff:", ...lines].join("\n")
}

/** Reads the model's answer down to one usable line, or nothing. */
export function cleanCommitMessage(raw: string): string {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "")
  const line = withoutThinking
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean)
  const text = (line ?? "").replace(/^["'`“”]+/, "").replace(/["'`“”]+$/, "").trim()
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 3)}...` : text
}

/** What a commit is called when no model answered: MiMo's `update …` rule. */
export function fallbackCommitMessage(paths: readonly string[]): string {
  const clean = paths.map((entry) => String(entry || "").trim()).filter(Boolean)
  if (!clean.length) return "update"
  if (clean.length === 1) {
    const segments = clean[0].split("/").filter(Boolean)
    return `update ${segments[segments.length - 1] || clean[0]}`
  }
  const tops = new Set(clean.map((entry) => (entry.includes("/") ? entry.split("/")[0] : "")))
  const [only] = [...tops]
  return tops.size === 1 && only ? `update ${only}/ (${clean.length} files)` : `update ${clean.length} files`
}

/** The prompt for a repository's pending changes; paths are relative to its root. */
export async function commitMessageInput(directory: string, paths: readonly string[]): Promise<string> {
  const root = await toplevel(directory).catch(() => directory)
  const diffs: string[] = []
  for (const file of paths.slice(0, MESSAGE_DIFFS)) {
    const patch = await diff(root, file).catch(() => "")
    if (patch) diffs.push(patch)
  }
  return commitMessagePrompt(paths, diffs)
}
