import { execFile } from "node:child_process"

/**
 * How this app runs git against the user's own repositories.
 *
 * Every call goes through here so the four rules MiMo applies to its own git
 * calls hold everywhere, not only where someone remembered them:
 *
 * - `GIT_OPTIONAL_LOCKS=0`: a status that only reads must not take
 *   `index.lock` and write the index back. The info card and the review tab
 *   ask on every message and every focus, and each of those used to rewrite
 *   the index under a commit or rebase the user was running in a terminal.
 * - `LC_ALL=C`: the failure codes below are read from git's English wording,
 *   which a translated git would not print.
 * - `core.quotepath=false`: a path with non-ASCII characters comes back as
 *   itself rather than as a quoted string of octal escapes. Callers that parse
 *   paths also ask for NUL-separated output, which needs no unquoting at all.
 * - a timeout, 15 seconds unless the call says otherwise: a hook waiting on a
 *   pinentry, a credential prompt or a network drive would otherwise leave a
 *   request that never answers and a card that spins for ever.
 *
 * And never a console window: the packaged app has no console of its own, so
 * on Windows each git process would flash one.
 */

export const GIT_TIMEOUT_MS = 15_000
export const WORKTREE_LIST_TIMEOUT_MS = 10_000
export const PUSH_TIMEOUT_MS = 60_000

const MAX_BUFFER = 8 * 1024 * 1024

export interface GitRunOptions {
  /** Milliseconds before the process is stopped; `GIT_TIMEOUT_MS` when left out. */
  timeout?: number
  /** Variables added to the environment on top of the fixed ones. */
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

/** The failure a git call rejects with: Node's own error, with what git printed and whether time ran out. */
export interface GitFailure extends Error {
  stdout?: string
  stderr?: string
  code?: number | string
  killed?: boolean
  timedOut?: boolean
}

export function gitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extra }
}

/** The arguments that go before every subcommand. */
export const GIT_PREFIX: readonly string[] = ["-c", "core.quotepath=false"]

/** Runs git in `directory` and answers with its standard output, or rejects with a `GitFailure`. */
export function runGit(directory: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
  const timeout = options.timeout ?? GIT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...GIT_PREFIX, ...args],
      {
        cwd: directory,
        windowsHide: true,
        timeout,
        maxBuffer: options.maxBuffer ?? MAX_BUFFER,
        env: gitEnvironment(options.env),
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout)
          return
        }
        const failure = error as GitFailure
        failure.stdout = stdout
        failure.stderr = stderr
        // A process stopped by the timeout reports only a signal; say what happened instead.
        if (failure.killed && timeout > 0) {
          failure.timedOut = true
          failure.message = `git ${args[0] ?? ""} timed out after ${Math.round(timeout / 1000)}s`
          failure.stderr = failure.message
        }
        reject(failure)
      },
    )
  })
}

/** Whether a rejection was the timeout. */
export function timedOut(err: unknown): boolean {
  return Boolean((err as GitFailure | undefined)?.timedOut)
}

/** The NUL-separated fields of `-z` output, the empty tail dropped. */
export function nulFields(out: string): string[] {
  const fields = out.split("\0")
  if (fields.length && fields[fields.length - 1] === "") fields.pop()
  return fields
}

/** One entry of `git status --porcelain=v1 -z`, paths relative to the repository root. */
export interface PorcelainEntry {
  /** The index column. */
  staged: string
  /** The working-tree column. */
  work: string
  untracked: boolean
  path: string
  /** Where a rename or copy came from. */
  from?: string
}

/**
 * Reads `status --porcelain=v1 -z`.
 *
 * Each entry is `XY path`, and a rename or copy is followed by one more field
 * holding the path it came from - which is why this cannot be a plain split.
 * Nothing is trimmed: a path may begin or end with a space.
 */
export function parsePorcelain(out: string): PorcelainEntry[] {
  const fields = nulFields(out)
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (field.length < 4) continue
    const staged = field[0]
    const work = field[1]
    const entry: PorcelainEntry = { staged, work, untracked: staged === "?" && work === "?", path: field.slice(3) }
    if (/[RC]/.test(staged) || /[RC]/.test(work)) {
      const from = fields[i + 1]
      if (from !== undefined) entry.from = from
      i += 1
    }
    entries.push(entry)
  }
  return entries
}

/** The letter MiMo's review shows: the working-tree column, else the index column; an untracked path is an addition. */
export function displayLetter(entry: Pick<PorcelainEntry, "staged" | "work" | "untracked">): string {
  if (entry.untracked) return "A"
  return entry.work !== " " && entry.work !== "" ? entry.work : entry.staged
}
