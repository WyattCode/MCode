import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type {
  BranchState,
  CheckoutResult,
  CommitResult,
  CommitState,
  GitChange,
  GitChangeKind,
  GitFileLines,
  GitStatus,
  GitSummary,
  PushResult,
  Worktree,
} from "@shared/protocol"
import {
  PUSH_TIMEOUT_MS,
  WORKTREE_LIST_TIMEOUT_MS,
  displayLetter,
  nulFields,
  parsePorcelain,
  runGit,
  timedOut,
  type PorcelainEntry,
} from "./git-process"
import { hasGithubRemote } from "./pull-request"
import { serialisedWrite } from "./git-queue"

/**
 * Just enough git to review what a turn did.
 *
 * Shelling out rather than linking a library: the user's git is the one that
 * knows about their config, hooks and worktrees, and this only ever asks it
 * questions the CLI answers plainly. Every call goes through `runGit`, which
 * fixes the environment, the path quoting and the timeout.
 */

const git = runGit

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

/** How often a write that met another's index.lock is tried again, and how long apart. */
const LOCK_RETRIES = 4
const LOCK_PAUSE_MS = 250

/**
 * `git checkout -- <file>`: MiMo's last resort when a patch will not go back on.
 *
 * In the repository's write queue (N11-14), and a failure that is only
 * another git holding index.lock - a terminal, an editor, a hook - is waited
 * out a few times rather than counted as a file that could not be put back
 * (N11-13).
 */
export async function checkoutFile(root: string, file: string): Promise<boolean> {
  return serialisedWrite(root, root, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await git(root, ["checkout", "--", file])
        return true
      } catch (err) {
        if (attempt >= LOCK_RETRIES || !/index\.lock/i.test(outputOf(err))) return false
        await new Promise((resolve) => setTimeout(resolve, LOCK_PAUSE_MS * (attempt + 1)))
      }
    }
  })
}

/**
 * `git apply` of a patch held in a temporary file, with MiMo's own flags.
 *
 * `--recount` lets a patch whose counts drifted still apply, and
 * `--ignore-whitespace` covers the line endings a file picks up on the way
 * through an editor.
 */
export async function applyPatch(root: string, patch: string, reverse: boolean): Promise<boolean> {
  return serialisedWrite(root, root, () => applyPatchNow(root, patch, reverse))
}

async function applyPatchNow(root: string, patch: string, reverse: boolean): Promise<boolean> {
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

/**
 * The folder as the file system itself spells it.
 *
 * git answers every question about paths in the physical spelling of a folder,
 * but callers hand over whatever string they were given - a Windows 8.3 short
 * name (`C:\Users\RUNNER~1\...`), a link or a junction, a folder opened under
 * `/var` while git says `/private/var`. Comparing git's answer against such a
 * string by text reads one folder as two places: the review listed nothing,
 * and diffs walked out of the repository as a chain of `../`. Measured on the
 * Windows battery, run 44933235897: the same temp folder arrived as
 * `RUNNER~1` from the environment and as `runneradmin` from git.
 */
async function canonicalDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  return fs.realpath(resolved).catch(() => resolved)
}

function lines(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * The branch a pull request would usually target, by name, found the way
 * MiMo's engine finds it.
 *
 * The main remote is origin, else the only remote, else upstream, else the
 * first listed. Its HEAD wins where it is set, that being what the host itself
 * calls default. Failing that, the branch `init.defaultBranch` names if the
 * repository has it, then main, then master.
 */
export async function defaultBranch(directory: string): Promise<string | undefined> {
  const remotes = lines((await tryGit(directory, ["remote"])).out)
  const primary = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : remotes.includes("upstream")
        ? "upstream"
        : remotes[0]
  if (primary) {
    const head = await tryGit(directory, ["symbolic-ref", `refs/remotes/${primary}/HEAD`])
    if (head.ok) {
      const ref = head.out.trim().replace(/^refs\/remotes\//, "")
      const name = ref.startsWith(`${primary}/`) ? ref.slice(primary.length + 1) : ""
      if (name) return name
    }
  }
  const local = lines((await tryGit(directory, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).out)
  const configured = (await tryGit(directory, ["config", "init.defaultBranch"])).out.trim()
  if (configured && local.includes(configured)) return configured
  if (local.includes("main")) return "main"
  if (local.includes("master")) return "master"
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

/**
 * Whether git runs at all, asked once per process: every status used to start
 * with a `git --version` of its own.
 */
let installed: Promise<boolean> | undefined

function gitInstalled(): Promise<boolean> {
  installed ??= new Promise((resolve) => {
    execFile("git", ["--version"], { windowsHide: true, timeout: 15_000 }, (error) => resolve(!error))
  }).then((found) => {
    // Not found is asked again next time: git may be installed while the app runs.
    if (!found) installed = undefined
    return found as boolean
  })
  return installed
}

/** A status entry's path relative to the project, keeping the slash that marks an untracked folder. */
function projectPath(root: string, directory: string, raw: string): string {
  const relative = path.relative(directory, path.resolve(root, raw)).split(path.sep).join("/")
  return relative && raw.endsWith("/") ? `${relative}/` : relative
}

function insideProject(relative: string): boolean {
  return Boolean(relative) && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)
}

/**
 * The project's changes against HEAD, as MiMo's review lists them.
 *
 * `status --porcelain=v1 -z` without `-uall`: an untracked folder is one row,
 * as MiMo has it, rather than every file under it - a `node_modules` nobody
 * ignored used to fill the list with thousands of rows and have each read.
 * The one exception is a project that sits inside an untracked folder, which
 * would otherwise report nothing at all; there the files are listed.
 *
 * A status git could not produce is said to be one, in `error`, rather than
 * read as a clean tree.
 */
export async function status(directory: string): Promise<GitStatus> {
  if (!(await gitInstalled())) return { installed: false, repo: false, changed: [], entries: [] }

  const inside = await git(directory, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")
  if (inside.trim() !== "true") return { installed: true, repo: false, changed: [], entries: [] }

  // A fresh repository has no HEAD yet, so the branch lookup is allowed to fail.
  const branch = (await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim()
  const base: GitStatus = { installed: true, repo: true, ...(branch ? { branch } : {}), changed: [], entries: [] }

  try {
    // git usually answers the root in its physical spelling already, but the
    // code must not depend on that: make it physical like everything else it
    // compares (P3-2 - `diff` has canonicalized `rootSeen` since G10-1; the
    // asymmetry left `status` trusting a rule git does not promise).
    const root = await canonicalDirectory(await toplevel(directory))
    // git and the project folder have to speak one spelling before any path is compared.
    const project = await canonicalDirectory(directory)
    let found = await changesUnder(root, project, ["status", "--porcelain=v1", "-z"])
    if (found.swallowed) {
      found = await changesUnder(root, project, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
    }
    return { ...base, changed: found.entries.map((entry) => entry.path), entries: found.entries }
  } catch (err) {
    return { ...base, error: errorText(err) }
  }
}

/** Status rows under the project, and whether an untracked folder swallowed the project whole. */
async function changesUnder(
  root: string,
  directory: string,
  args: string[],
): Promise<{ entries: GitChange[]; swallowed: boolean }> {
  const out = await git(directory, args)
  const entries: GitChange[] = []
  let swallowed = false
  for (const entry of parsePorcelain(out)) {
    const relative = projectPath(root, directory, entry.path)
    if (!insideProject(relative)) {
      if (entry.untracked && entry.path.endsWith("/") && isWithin(path.resolve(root, entry.path), directory)) swallowed = true
      continue
    }
    entries.push({ path: relative, kind: classify(entry), code: displayLetter(entry) })
  }
  return { entries, swallowed }
}

/** Whether `inner` is `outer` or somewhere below it. */
function isWithin(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner))
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * The two status columns, reduced to the one word the agent's context uses.
 *
 * An untracked path is an addition however git files it. Anything with a D in
 * either column is a deletion. A rename or copy is its own word.
 */
export function classify(entry: Pick<PorcelainEntry, "staged" | "work" | "untracked">): GitChangeKind {
  const codes = entry.staged + entry.work
  if (entry.untracked || codes.includes("A")) return "added"
  if (codes.includes("D")) return "deleted"
  if (codes.includes("R") || codes.includes("C")) return "renamed"
  return "modified"
}

/**
 * The working-tree patch for one file, including files git has never seen -
 * without --no-index a new file shows as nothing at all, which is exactly the
 * case someone reviewing a turn cares about most.
 */
export async function diff(directory: string, file: string): Promise<string> {
  const rootSeen = await toplevel(directory).catch(() => directory)
  // Both spellings made physical, or `inRepo` is a walk of `../` out of the
  // repository and an untracked diff of a tracked file follows it (G10-1,
  // measured on the Windows battery, run 44933235897).
  const [root, project] = await Promise.all([canonicalDirectory(rootSeen), canonicalDirectory(directory)])
  /*
   * A file handed over as an absolute path is placed physically only as the
   * second candidate (P2-2, second review): Git for Windows may record an
   * in-repository junction's file under the junction spelling, and resolving
   * the folder to its target before the index is asked would then look up a
   * name the index never held - a tracked change drawn as `--- /dev/null`.
   * The caller's own spelling gets the first look; the physical spelling
   * stands behind it for the spellings git files differently (a `/var`
   * folder, an 8.3 short name), and it is what an untracked diff reads from
   * disk. Only the folder can be asked - the file itself may be gone.
   */
  const caller = path.isAbsolute(file) ? file : path.resolve(project, file)
  const physical = path.isAbsolute(file)
    ? path.join(await canonicalDirectory(path.dirname(file)), path.basename(file))
    : caller
  const toRepo = (at: string) => path.relative(root, at).split(path.sep).join("/")
  const onDisk = toRepo(physical)
  let inRepo = onDisk
  let tracked = false
  for (const candidate of caller === physical ? [onDisk] : [toRepo(caller), onDisk]) {
    if (await git(root, ["ls-files", "--error-unmatch", "--", candidate]).then(() => true).catch(() => false)) {
      inRepo = candidate
      tracked = true
      break
    }
  }

  const untracked = () =>
    git(root, ["diff", "--no-index", "--", "/dev/null", inRepo]).catch(
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
  else {
    patch = await git(root, ["diff", "HEAD", "--", inRepo]).catch(() =>
      git(root, ["diff", "--", inRepo]).catch(() => ""),
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

/**
 * The checkouts this repository has, as MiMo reads `git worktree list`.
 *
 * The first entry is the repository's own checkout. A bare repository is not a
 * checkout anyone works in and is left out, and a detached checkout has no
 * branch to name.
 */
export async function worktrees(directory: string): Promise<Worktree[]> {
  let stdout: string
  try {
    stdout = await git(directory, ["worktree", "list", "--porcelain"], { timeout: WORKTREE_LIST_TIMEOUT_MS })
  } catch {
    return []
  }

  const out: Worktree[] = []
  let first = true
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    let directory = ""
    let branch = ""
    let detached = false
    let bare = false
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) directory = line.slice(9).trim()
      else if (line.startsWith("branch ")) branch = line.slice(7).trim().replace(/^refs\/heads\//, "")
      else if (line === "detached") detached = true
      else if (line === "bare") bare = true
    }
    if (!directory) continue
    const main = first
    first = false
    if (bare) continue
    out.push({ directory, main, ...(branch && !detached ? { branch } : {}) })
  }
  return out
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
  const branches = lines(await git(directory, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).catch(() => ""))
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

/** What git said, as MiMo passes it on: trimmed and cut at 300 characters, every line kept. */
function errorText(err: unknown): string {
  return stderrOf(err).trim().slice(0, 300)
}

function checkoutFailure(err: unknown): CheckoutResult {
  const text = stderrOf(err)
  if (/untracked working tree file/i.test(text) && /would be overwritten/i.test(text)) {
    return { ok: false, code: "untracked-overwrite" }
  }
  if (/local changes to the following files would be overwritten/i.test(text)) return { ok: false, code: "local-overwrite" }
  // As commit and push already do, and as MiMo does for a checkout too: the first 300 characters, every line of them.
  return { ok: false, error: errorText(err) }
}

const CONFLICT = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])

async function porcelain(directory: string): Promise<PorcelainEntry[]> {
  return parsePorcelain(await git(directory, ["status", "--porcelain=v1", "-z"]))
}

async function hasConflicts(directory: string): Promise<boolean> {
  const entries = await porcelain(directory).catch((): PorcelainEntry[] => [])
  return entries.some((entry) => CONFLICT.has(entry.staged + entry.work))
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
  // In the repository's write queue (N11-14); a folder that is not in one has nothing to queue behind.
  const root = await toplevel(directory).catch(() => directory)
  return serialisedWrite(root, directory, () => checkoutNow(directory, branch, options))
}

async function checkoutNow(
  directory: string,
  branch: string,
  options: { force?: boolean; create?: boolean },
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
    const entries = await porcelain(directory).catch((): PorcelainEntry[] => [])
    if (entries.length) return { ok: false, dirty: true }
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

// ------------------------------------------------------------ the info card

/** `git diff --numstat -z --no-renames` rows; a binary file reports "-" and counts as no lines. */
function numstat(out: string): GitFileLines[] {
  const rows: GitFileLines[] = []
  for (const field of nulFields(out)) {
    const first = field.indexOf("\t")
    const second = field.indexOf("\t", first + 1)
    if (first < 0 || second < 0) continue
    const file = field.slice(second + 1)
    if (!file) continue
    rows.push({
      path: file,
      additions: Number(field.slice(0, first)) || 0,
      deletions: Number(field.slice(first + 1, second)) || 0,
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
  let count = 0
  for (const byte of bytes) if (byte === 10) count += 1
  return bytes[bytes.length - 1] === 10 ? count : count + 1
}

/** The tree git compares against when a repository has no commit yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/**
 * What the info card's 变更 row says: how many files differ from HEAD under the
 * project, and by how many lines each.
 *
 * Counted from the review's own list, as MiMo counts it from its status rows,
 * so the count here and the list the row opens agree: an untracked folder is
 * one file and no lines, an untracked file is wholly added.
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
    if (changed.error !== undefined) return base
    const hasHead = await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
      () => true,
      () => false,
    )
    // --relative keeps both the paths and the comparison inside the project directory.
    const tracked = numstat(
      await git(directory, ["diff", "--numstat", "-z", "--no-renames", "--relative", hasHead ? "HEAD" : EMPTY_TREE]),
    )
    const counted = new Set(tracked.map((file) => file.path))
    const fresh = await Promise.all(
      changed.entries
        .filter((entry) => entry.kind === "added" && !counted.has(entry.path))
        .map(async (entry) => ({
          path: entry.path,
          additions: entry.path.endsWith("/") ? 0 : await untrackedLines(path.join(directory, entry.path)),
          deletions: 0,
        })),
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

async function remotes(root: string): Promise<string[]> {
  return lines(await git(root, ["remote"]).catch(() => ""))
}

/**
 * What the commit or push card needs to decide which of its buttons may be
 * pressed: the whole repository's state, since a commit takes in the whole
 * index whichever folder the project was opened on.
 *
 * Ahead and behind are counted against origin's branch of the same name and
 * nothing else, because that is the only place a push from the card goes.
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
    const entries = await porcelain(root)
    const staged = numstat(await git(root, ["diff", "--cached", "--numstat", "-z", "--no-renames"]).catch(() => ""))
    // symbolic-ref names the branch even before its first commit, and fails only when detached.
    const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim()
    const hasHead = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
      () => true,
      () => false,
    )
    const upstream = branch ? (await git(root, ["rev-parse", "--abbrev-ref", "@{u}"]).catch(() => "")).trim() : ""
    const hasOrigin = (await remotes(root)).includes("origin")
    const target = branch ? `refs/remotes/origin/${branch}` : ""
    const hasOriginBranch =
      Boolean(target && hasOrigin) &&
      (await git(root, ["show-ref", "--verify", "--quiet", target]).then(
        () => true,
        () => false,
      ))
    let ahead = 0
    let behind = 0
    if (hasOriginBranch && hasHead) {
      const counts = (await git(root, ["rev-list", "--left-right", "--count", `${target}...HEAD`]).catch(() => ""))
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
      hasStaged: entries.some((entry) => !entry.untracked && entry.staged !== " " && entry.staged !== "?"),
      stagedAdditions: staged.reduce((sum, file) => sum + file.additions, 0),
      stagedDeletions: staged.reduce((sum, file) => sum + file.deletions, 0),
      hasUpstream: Boolean(upstream),
      ahead,
      behind,
      hasOrigin,
      hasOriginBranch,
      changedPaths: entries.map((entry) => entry.path),
    }
  } catch (err) {
    return { ...blank, error: errorText(err) }
  }
}

/** Everything git said, since "nothing to commit" arrives on stdout rather than stderr. */
function outputOf(err: unknown): string {
  const stdout = (err as { stdout?: unknown })?.stdout
  return `${typeof stdout === "string" ? stdout : ""}\n${stderrOf(err)}`
}

export function commitFailure(err: unknown): CommitResult {
  if (timedOut(err)) return { ok: false, error: errorText(err) }
  const text = outputOf(err)
  if (/nothing (added )?to commit|no changes added to commit/i.test(text)) return { ok: false, code: "nothing-to-commit" }
  if (/please tell me who you are|author identity unknown|user\.name|user\.email/i.test(text)) {
    return { ok: false, code: "ident-missing" }
  }
  if (/(pre-commit|commit-msg|prepare-commit-msg) hook|hook (failed|declined|exited)/i.test(text)) {
    return { ok: false, code: "hook-rejected" }
  }
  // A hook or signing failure usually gives its reason on the second line, so all of it is kept.
  const stderr = (err as { stderr?: unknown })?.stderr
  const stdout = (err as { stdout?: unknown })?.stdout
  const said = typeof stderr === "string" && stderr.trim() ? stderr : typeof stdout === "string" && stdout.trim() ? stdout : stderrOf(err)
  return { ok: false, error: said.trim().slice(0, 300) }
}

/**
 * Commits, with everything in the working tree first when asked.
 *
 * The user's hooks and signing settings run as they would in a terminal;
 * nothing here skips them. Like every git call here the commit has 15 seconds,
 * as MiMo's does, so a hook that waits for input is stopped rather than left
 * spinning.
 */
export async function commit(directory: string, message: string, includeUnstaged: boolean): Promise<CommitResult> {
  const text = message.trim()
  if (!text) return { ok: false, error: "empty commit message" }
  let root: string
  try {
    root = await toplevel(directory)
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
  /*
   * In the repository's write queue (N11-14): `add -A` stages whatever is on
   * disk at that moment, so it must not run while a patch is being taken back
   * or a branch switched under it.
   */
  return serialisedWrite(root, directory, () => commitNow(root, text, includeUnstaged))
}

async function commitNow(root: string, text: string, includeUnstaged: boolean): Promise<CommitResult> {
  if (includeUnstaged) {
    try {
      await git(root, ["add", "-A"])
    } catch (err) {
      // What add said, as it said it: none of the commit's own codes apply.
      return { ok: false, error: errorText(err) }
    }
  }
  try {
    await git(root, ["commit", "-m", text])
    const hash = (await git(root, ["rev-parse", "--short", "HEAD"])).trim()
    return { ok: true, hash }
  } catch (err) {
    return commitFailure(err)
  }
}

export function pushFailure(err: unknown): PushResult {
  if (timedOut(err)) return { ok: false, error: errorText(err) }
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
  return { ok: false, error: errorText(err) }
}

/**
 * Pushes the checked-out branch, and only it, never forced, to the branch of
 * the same name on origin - whatever upstream the branch has configured.
 *
 * That is MiMo's rule, and the one that cannot surprise anyone: a branch made
 * from `origin/main` carries `main` as its upstream, and honouring that would
 * have written this branch's commits straight into the remote's main. Without
 * an upstream the push also sets origin's branch as one. Git is told not to
 * stop and ask for a password: there is no terminal for it to ask in, so a
 * push that needs one fails and says so instead of hanging.
 */
export async function push(directory: string): Promise<PushResult> {
  const root = await toplevel(directory).catch(() => directory)
  return serialisedWrite(root, directory, () => pushNow(directory))
}

async function pushNow(directory: string): Promise<PushResult> {
  try {
    const root = await toplevel(directory)
    const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim()
    /*
     * A code rather than a sentence, as every other refusal here answers with
     * one. This path returned the English "not on a branch" into an interface
     * that phrases `auth`, `rejected` and `no-remote` from its own tables, so a
     * detached HEAD was the one push failure a Chinese reader got in English.
     */
    if (!branch) return { ok: false, code: "detached" }
    if (!(await remotes(root)).includes("origin")) return { ok: false, code: "no-remote" }
    const upstream = (await git(root, ["rev-parse", "--abbrev-ref", "@{u}"]).catch(() => "")).trim()
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`
    const args = upstream ? ["push", "origin", refspec] : ["push", "-u", "origin", refspec]
    await pushToOrigin(root, args)
    return { ok: true }
  } catch (err) {
    return pushFailure(err)
  }
}

// Publish a verified object to a single remote branch without changing the checkout or its upstream.
export async function pushRef(directory: string, branch: string, head: string): Promise<PushResult> {
  const root = await toplevel(directory)
  return serialisedWrite(root, directory, async () => {
    try {
      await pushToOrigin(root, [
        "-c", "remote.origin.mirror=false", "push", "--no-follow-tags",
        "--recurse-submodules=no", "origin", `${head}:refs/heads/${branch}`,
      ])
      return { ok: true }
    } catch (error) {
      return pushFailure(error)
    }
  })
}

async function pushToOrigin(root: string, args: string[]): Promise<void> {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" }
  // Batch mode for ssh, unless the user already chose how git reaches ssh.
  const sshCommand = (await git(root, ["config", "--get", "core.sshCommand"]).catch(() => "")).trim()
  if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH && !sshCommand) env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes"
  await git(root, args, { timeout: PUSH_TIMEOUT_MS, env })
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
