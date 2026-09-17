import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { resolvePath } from "./fs-util"
import { guardAppData } from "./app-data"
import { namesAskingFile } from "../permission"
import { collectMutationTargets, scanCommand } from "./bash-scan"
import { mainWorktreeRoots } from "../session/worktree"
import { ABORTED_TOOL } from "../provider/history"
import { repositoryRoot, tryGit } from "../git"
import { gitBash, which, windowsPath } from "../shell-path"
import { mergeConflictNotice } from "./merge-conflict"

const DEFAULT_TIMEOUT = 120_000

/** What a command declaring itself interactive is answered with, since there is no terminal to hand over. */
export const INTERACTIVE_REFUSAL = [
  "This environment has no interactive terminal, so the command was not run and nothing was changed.",
  "Run it without interaction instead: pass its confirmation flag (-y, --yes, -Force, -Confirm:$false), feed the answers in through a pipe, or use an equivalent command that needs no input.",
].join(" ")
/** How much output comes back inline when the call does not say, in MiMo's approximate tokens of four bytes. */
const DEFAULT_MAX_OUTPUT_TOKENS = 30_000
/** How much of the latest output the card shows while the command works. */
export const PREVIEW_CHARS = 30_000
/** How often the card's live output is refreshed at most, so a chatty command does not keep the main process busy. */
export const PROGRESS_EVERY_MS = 100
/** How long a stopped command is given to close its pipes before the result is put together without them. */
const CLOSE_GRACE_MS = 3_000
/** The longest delay a timer takes; anything larger would fire at once. */
const LONGEST_TIMER = 2 ** 31 - 1

/**
 * What the console writes text in, when it is not UTF-8.
 *
 * Asked of the system once rather than assumed: a Chinese Windows answers 936,
 * a Japanese one 932. Guessing here would be trading one wrong decoding for
 * another. Anything unrecognised, and the fallback is not used at all.
 */
const consoleEncoding = (() => {
  let resolved: string | undefined
  let asked = false
  const CODEPAGES: Record<string, string> = {
    "437": "windows-1252",
    "932": "shift_jis",
    "936": "gbk",
    "949": "euc-kr",
    "950": "big5",
    "1250": "windows-1250",
    "1251": "windows-1251",
    "1252": "windows-1252",
    "1253": "windows-1253",
    "1254": "windows-1254",
    "1255": "windows-1255",
    "1256": "windows-1256",
  }
  return () => {
    if (asked) return resolved
    asked = true
    if (process.platform !== "win32") return resolved
    try {
      const answer = execFileSync("chcp.com", { windowsHide: true }).toString("latin1")
      const page = /(\d{3,5})/.exec(answer)?.[1]
      const encoding = page ? CODEPAGES[page] : undefined
      if (encoding) {
        new TextDecoder(encoding)
        resolved = encoding
      }
    } catch {
      resolved = undefined
    }
    return resolved
  }
})()

/** What one command's output is decoded as, decided once and shared by its two pipes. */
export interface OutputEncoding {
  encoding?: string
}

/**
 * One pipe's bytes as text, decoded as a stream.
 *
 * The encoding is decided once per command, at the first character that is
 * not ASCII: UTF-8 when the bytes read as UTF-8, and the console's own
 * encoding when they do not - every native tool on a Chinese Windows writes
 * GBK. Until then nothing has been seen that the two would decode differently.
 * After that the decoder carries a character split across two chunks over to
 * the next one, so a chunk that ends half way through a character never flips
 * the decision, and nothing decoded is ever decoded again.
 */
export class OutputDecoder {
  private decoder: InstanceType<typeof TextDecoder> | undefined
  private held = Buffer.alloc(0)

  constructor(private readonly choice: OutputEncoding) {}

  write(chunk: Buffer): string {
    if (this.decoder) return this.decoder.decode(chunk, { stream: true })
    const bytes = this.held.length ? Buffer.concat([this.held, chunk]) : chunk
    if (this.choice.encoding) return this.settle(this.choice.encoding, bytes)
    let probe: string
    try {
      // Strict, and streaming: an incomplete character at the end is not an error, an invalid byte is.
      probe = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
    } catch {
      return this.settle((this.choice.encoding = consoleEncoding() ?? "utf-8"), bytes)
    }
    if (/[^\x00-\x7f]/.test(probe)) return this.settle((this.choice.encoding = "utf-8"), bytes)
    // All ASCII so far: one byte a character, and whatever is left is the start of one not yet complete.
    this.held = Buffer.from(bytes.subarray(probe.length))
    return probe
  }

  /** What is left once the pipe has closed. */
  end(): string {
    if (this.decoder) return this.decoder.decode()
    const rest = this.held
    this.held = Buffer.alloc(0)
    return rest.length ? new TextDecoder().decode(rest) : ""
  }

  private settle(encoding: string, bytes: Buffer): string {
    this.decoder = new TextDecoder(encoding)
    this.held = Buffer.alloc(0)
    return this.decoder.decode(bytes, { stream: true })
  }
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8")

/** The start of `text` within `maxBytes`, cut on a character boundary. */
function headWithin(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8")
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString("utf8")
}

/** The end of `text` within `maxBytes`: whole lines from the bottom, or the tail of the last line when even that one is too long. */
function tailWithin(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (byteLength(text) <= maxBytes) return { text, cut: false }
  const lines = text.split("\n")
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = byteLength(lines[i]) + (kept.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (kept.length === 0) {
        const buffer = Buffer.from(lines[i], "utf8")
        let start = Math.max(0, buffer.length - maxBytes)
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
        kept.unshift(buffer.subarray(start).toString("utf8"))
      }
      break
    }
    kept.unshift(lines[i])
    bytes += size
  }
  return { text: kept.join("\n"), cut: true }
}

/*
 * Makes PowerShell speak UTF-8 in both directions.
 *
 * Windows PowerShell emits its own messages in the console's codepage - 936 on
 * a Chinese install - and this app reads the pipe as UTF-8, so every error it
 * raised arrived as replacement characters, and the model reading the output
 * could not see what went wrong. The other direction matters as much:
 * `$OutputEncoding` is what PowerShell 5.1 pipes text to a native program in,
 * and it defaults to ASCII, so `"说明" | git commit -F -` committed question
 * marks. Both are set to UTF-8 without a byte order mark, as MiMo sets them.
 */
const POWERSHELL_UTF8 = "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; "
/** cmd's equivalent: switch the console to the UTF-8 code page, quietly. */
const CMD_UTF8 = "chcp 65001>nul 2>nul & "

/** How a script is handed to one shell. */
export interface ShellCall {
  command: string
  args: (script: string) => string[]
  powershell: boolean
  /** A shell that reads POSIX paths, whose `/tmp` has to be asked of cygpath. */
  posix: boolean
  /** cmd takes its command line exactly as written, as Node's own `shell` option passes it. */
  verbatim: boolean
}

/** The name a shell is known by: no folder, no extension, lower case. */
function shellName(file: string): string {
  if (process.platform === "win32") return path.win32.parse(windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

const POSIX_SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"])
/** Shells MiMo will not take from `SHELL` for running commands. */
const NOT_FROM_ENV = new Set(["fish", "nu"])

function callFor(file: string): ShellCall {
  const name = shellName(file)
  if (name === "powershell" || name === "pwsh") {
    return {
      command: file,
      args: (script) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8 + script],
      powershell: true,
      posix: false,
      verbatim: false,
    }
  }
  if (process.platform === "win32" && name === "cmd") {
    return { command: file, args: (script) => ["/d", "/s", "/c", `"${CMD_UTF8}${script}"`], powershell: false, posix: false, verbatim: true }
  }
  // Every other shell is handed the script with -c, as Node's `shell` option hands it: no login profile to read first.
  return { command: file, args: (script) => ["-c", script], powershell: false, posix: POSIX_SHELLS.has(name), verbatim: false }
}

/** A named shell made into something that can be started: a bare name looked up on PATH, a POSIX bash path made git's bash. */
function located(file: string): string {
  if (process.platform !== "win32") return file
  const shell = windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && shellName(shell) === "bash") return gitBash() ?? shell
    return shell
  }
  return which(shell) ?? shell
}

/** The shell used when nothing names one: MiMo's order, the newer PowerShell first on Windows. */
function platformShell(): string {
  if (process.platform === "win32") return which("pwsh.exe") ?? which("powershell.exe") ?? gitBash() ?? process.env.COMSPEC ?? "cmd.exe"
  if (process.platform === "darwin") return "/bin/zsh"
  return which("bash") ?? "/bin/sh"
}

let defaultShell: { key: string; file: string } | undefined

/**
 * The shell a command runs in, and how a script is handed to it.
 *
 * The app's own setting wins; then `SHELL` from the environment, unless it
 * names fish or nu; then the platform's preference - pwsh, Windows
 * PowerShell, git's bash, COMSPEC on Windows. The PATH lookup is remembered
 * until PATH or SHELL changes.
 */
export function shell(chosen?: string): ShellCall {
  const configured = (chosen ?? "").trim()
  if (configured) return callFor(located(configured))
  const fromEnv = process.env.SHELL?.trim() ?? ""
  const key = `${fromEnv}\0${process.env.PATH ?? process.env.Path ?? ""}`
  if (defaultShell?.key !== key) {
    const file = fromEnv && !NOT_FROM_ENV.has(shellName(fromEnv)) ? located(fromEnv) : platformShell()
    defaultShell = { key, file }
  }
  return callFor(defaultShell.file)
}

/**
 * The folder a command asked to run in.
 *
 * On Windows a POSIX spelling is turned into a drive path first - `/c/Users`
 * had resolved to `D:\c\Users` - and a POSIX shell is asked where the rest,
 * such as `/tmp`, really is.
 */
async function workdirOf(text: string, call: ShellCall, resolve: (target: string) => Promise<string>): Promise<string> {
  if (process.platform === "win32" && call.posix && text.startsWith("/") && windowsPath(text) === text) {
    const answer = await new Promise<string>((done) =>
      execFile(call.command, ["-c", 'cygpath -w -- "$1"', "_", text], { windowsHide: true, timeout: 5_000 }, (_err, stdout) => done(String(stdout ?? ""))),
    )
    const file = answer.split(/\r?\n/)[0]?.trim()
    if (file) return resolve(file)
  }
  return resolve(windowsPath(text))
}

/**
 * Who a commit made by a command is by, as the project's repository says.
 *
 * MiMo sets git's author and committer from the project's own config, so a
 * command that commits in another repository still commits as the person this
 * project knows. Asked once per project folder.
 */
const identities = new Map<string, Promise<{ name?: string; email?: string }>>()

function gitIdentity(directory: string): Promise<{ name?: string; email?: string }> {
  let known = identities.get(directory)
  if (!known) {
    known = repositoryRoot(directory)
      .then(async (root) => {
        if (!root) return {}
        const [name, email] = await Promise.all([tryGit(root, ["config", "user.name"]), tryGit(root, ["config", "user.email"])])
        return { name: name.out.trim() || undefined, email: email.out.trim() || undefined }
      })
      .catch(() => ({}))
    identities.set(directory, known)
  }
  return known
}

/** The identity as environment variables, only where the environment does not already set them. */
export async function gitIdentityEnv(directory: string): Promise<Record<string, string>> {
  const { name, email } = await gitIdentity(directory)
  const env: Record<string, string> = {}
  if (name && !process.env.GIT_AUTHOR_NAME) env.GIT_AUTHOR_NAME = name
  if (email && !process.env.GIT_AUTHOR_EMAIL) env.GIT_AUTHOR_EMAIL = email
  if (name && !process.env.GIT_COMMITTER_NAME) env.GIT_COMMITTER_NAME = name
  if (email && !process.env.GIT_COMMITTER_EMAIL) env.GIT_COMMITTER_EMAIL = email
  return env
}

/**
 * The commands running right now, so quitting can end them.
 *
 * A command's children were registered nowhere: the only paths that ended one
 * were the turn's abort listener and its own timeout, and quitting aborts no
 * turn. So a build or a dev server the model started carried on after the app
 * was gone, with no window left to stop it, and the next start found the port
 * taken with no explanation. The pty terminals were already swept at quit;
 * this is the same sweep for the other kind of child.
 */
const live = new Set<ChildProcess>()

/** Ends every command still running, with the process tree under it. */
export function stopBashCommands(): void {
  for (const child of [...live]) {
    live.delete(child)
    stop(child)
  }
}

/** How many are running, for the checks. */
export function liveBashCommands(): number {
  return live.size
}

/**
 * Ends a command and everything it started.
 *
 * A shell that has launched a server is the ordinary case for a command that
 * has to be interrupted, and signalling the shell alone leaves that server
 * running. Windows offers no process groups, so its tree is walked by taskkill;
 * elsewhere the child leads a group that can be signalled as a whole.
 *
 * Failures are swallowed on purpose: by the time this runs the process may have
 * exited on its own, and there is nothing useful to say about that.
 */
function stop(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill("SIGKILL"))
    } catch {
      child.kill("SIGKILL")
    }
    return
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

export const BashTool: ToolDefinition = {
  name: "bash",
  description: [
    "Run a shell command in the project and return what it printed.",
    "",
    "What it is for",
    "Builds, tests, type checkers, linters, package managers and version control. For work on files themselves, use read, edit, write, glob and grep instead: they are faster, they do not depend on which utilities this machine has, and their output is shaped for you to act on. Reaching for `cat`, `find`, `grep`, `sed` or `type` here is almost always the slower way round.",
    "",
    "Running it",
    "- Set workdir to choose where the command runs. Do not begin the command with `cd`: each call starts a fresh shell, so a `cd` does not carry to the next one.",
    "- A command is stopped after two minutes unless timeout allows longer. Give a long build or test run the time it needs rather than letting it be killed half way.",
    "- Output past about 30,000 tokens comes back with its middle left out and the whole of it saved to a file the result names, which you can then grep or read in parts.",
    "- The command gets no one to type at it. Anything that would stop for a password or a y/N prompt simply ends, so pass what it needs on the command line - a --yes flag, an environment variable - instead.",
    "- Quote paths that contain spaces, and prefer a command that fails loudly to one that hides its exit code behind a pipe.",
    "",
    "Version control",
    "- Commit only when the user asks. Finishing a piece of work is not by itself a reason to commit it.",
    "- Before committing, look at what you are about to commit - the status and the diff - and write the message from what actually changed, in the style the project's own recent history uses. Do not commit files that were already dirty when the turn began unless the user meant them.",
    "- Never push unless the user asks, and never force-push over a shared branch.",
    "- Do not skip hooks or bypass signing to make a commit succeed. A hook that fails is telling you something; fix the cause or report it.",
    "- Do not rewrite history that has already been pushed, and do not reset or checkout over uncommitted work without saying so first.",
    "",
    "Pull requests",
    "Open one only when asked. Push the branch first, target the repository's default branch unless the user names another, and write the description from the whole set of commits on the branch rather than the last one.",
  ].join("\n"),
  permission: "bash",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run" },
      timeout: { type: "number", description: `Milliseconds before the command is stopped, ${DEFAULT_TIMEOUT} when left out` },
      max_output_tokens: {
        type: "integer",
        description: `Roughly how many tokens of output come back in the result, ${DEFAULT_MAX_OUTPUT_TOKENS} when left out; past that the middle is left out and the whole output saved to a file`,
      },
      workdir: { type: "string", description: "Folder to run the command in, the project root when left out" },
      interactive: {
        type: "boolean",
        description:
          "Whether the command waits for someone to type - a password, a y/N prompt. This app cannot hand its terminal over, so such a command gets no input and ends; give it what it needs on the command line instead",
      },
      description: { type: "string", description: "What the command does, in five to ten words, e.g. 'Run unit tests'" },
    },
    required: ["command", "description"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const command = String(input.command).trim()
    if (!command) throw new ToolError("command is empty")

    const timeout = input.timeout === undefined ? DEFAULT_TIMEOUT : Number(input.timeout)
    if (!Number.isFinite(timeout) || timeout < 0) throw new ToolError(`timeout has to be a number of milliseconds, zero or more: ${String(input.timeout)}`)
    const maxTokens = input.max_output_tokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : Number(input.max_output_tokens)
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new ToolError(`max_output_tokens has to be a positive whole number: ${String(input.max_output_tokens)}`)
    const description = typeof input.description === "string" ? input.description : ""

    /*
     * A command that says it waits for input is answered rather than run.
     *
     * `interactive` was in the schema and consumed nowhere: stdin is closed, so
     * such a command sat until the 120,000 ms timeout killed it, and the model
     * was told only that it had timed out. The user waited two minutes for
     * nothing and neither of them learnt what to do differently. MiMo answers
     * this case at once, with exit code 1 and a sentence naming the ways out,
     * which is what is written here in this app's own words.
     */
    if (input.interactive === true) {
      return {
        output: INTERACTIVE_REFUSAL,
        title: description || command,
        metadata: { command, cwd: context.directory, exit: 1, description, truncated: false, interactive: true },
      }
    }

    const call = shell(context.shell)
    const { command: bin, args, powershell } = call
    const cwd = input.workdir ? await workdirOf(String(input.workdir), call, (target) => resolvePath(context, target)) : context.directory
    // A folder that is not there would otherwise surface as "spawn powershell.exe ENOENT", which reads as a missing shell.
    if (!(await fs.stat(cwd).catch(() => undefined))?.isDirectory()) throw new ToolError(`workdir does not exist or is not a folder: ${cwd}`)

    /*
     * MiMo's order: folders outside the project that the command's file
     * arguments name are asked about first; then a command that deletes gets a
     * question of its own, listing what it deletes, asked every time and never
     * remembered - unless everything it deletes is in the temp folder; anything
     * else is one question whose "always" keeps each command's prefix. A bare
     * `cd` asks nothing. There is no list of commands refused outright, as
     * MiMo has none: a delete is what its own question is for.
     */
    const scan = await scanCommand(command, cwd, context.directory, powershell)
    /*
     * MiMo's auto-worktree notice reads a command's result rather than its
     * arguments: the tool records which repository main worktrees this command
     * would write to, and the runner raises the notice for one that then
     * exited cleanly.
     */
    const mutations = collectMutationTargets(command, cwd, powershell)
    // A command that would write into the app's own data folder is refused like a write tool's call.
    for (const target of mutations.written) {
      await guardAppData(target, "write")
      // An alternate data stream (`> notes.txt:hidden`) is a place no listing or diff shows (round 8, X19).
      if (process.platform === "win32" && target.slice(path.parse(target).root.length).includes(":")) {
        throw new ToolError(`Refused: ${target} names an alternate data stream (a colon after the drive), which commands here may not write.`)
      }
    }
    const worktreeHits = await mainWorktreeRoots(mutations.paths)
    // The saved sign-ins are not read through a shell either.
    for (const file of scan.files) await guardAppData(file, "read")
    for (const dir of scan.dirs) await resolvePath(context, dir)
    const question = {
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "bash" as const,
      directory: context.directory,
      title: description || "Run command",
      subject: command,
      preview: command,
      // A `.env` named on the line asks where its bucket would allow it, as a read of one does.
      patternAsks: namesAskingFile(command),
    }
    if (scan.deletes.length && !scan.tempOnlyDeletes) {
      await context.permissions.ask({ ...question, patterns: scan.deletes, always: [], forced: true })
    } else if (scan.patterns.length) {
      await context.permissions.ask({ ...question, patterns: scan.patterns, always: scan.always, forced: false })
    }

    const identity = await gitIdentityEnv(context.directory)

    return await new Promise((resolve, reject) => {
      /*
       * No stdin, as the reference spawns it (`stdin: "ignore"`). The command
       * arrives as an argument, so the shell never reads stdin itself - but an
       * open pipe here is inherited by everything the command starts, and a
       * PowerShell in that tree that hits a cmdlet missing a mandatory parameter
       * prompts for it on stdin. The user's screen had exactly that: a nested
       * `powershell -Command "... Test-Path $_ ..."`, whose `$_` the outer shell
       * expanded to nothing inside the double quotes, so the inner one asked for
       * a Path and waited the whole 120s for an answer that could not come. With
       * a closed handle the prompt fails at once and the command reports its
       * error. Measured under Electron in scripts/tool-check-nested-electron.cjs:
       * 8,035ms to the timeout with a pipe, 379ms without one.
       */
      const child = spawn(bin, args(command), {
        cwd,
        env: {
          ...process.env,
          GIT_PAGER: "cat",
          PAGER: "cat",
          TERM: "dumb",
          NO_COLOR: "1",
          // As MiMo sets it: Python on Windows otherwise writes the console codepage, or fails on a character it cannot encode.
          ...(process.platform === "win32" ? { PYTHONIOENCODING: "utf-8" } : {}),
          ...identity,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: call.verbatim,
        /*
         * Its own process group, so stopping the command can signal everything
         * the command started rather than only the shell. Windows has no groups
         * to join and treats this flag as "outlive the parent", which is the
         * opposite of what is wanted here.
         */
        detached: process.platform !== "win32",
      })

      // Held only while it runs: quitting ends what is still in here.
      live.add(child)
      child.once("exit", () => live.delete(child))
      const closed = new Promise<void>((done) => {
        child.once("close", () => done())
        child.once("error", () => done())
      })

      /*
       * MiMo's accounting, over the decoded text and measured in its UTF-8
       * bytes. The result shows `budget` bytes: the first half of it from the
       * very start of the output and the rest from the end. Twice that much of
       * the latest output is held, and once the output passes the budget the
       * whole of it goes to a file instead of memory.
       */
      const budget = maxTokens * 4
      const keep = budget * 2
      const half = Math.floor(budget / 2)
      let first = ""
      let firstFull = false
      const recent: { text: string; size: number }[] = []
      let recentBytes = 0
      let total = 0
      let dropped = false
      let unsaved: string[] | undefined = context.toolOutputs ? [] : undefined
      let unsavedBytes = 0
      let saved: Promise<string | undefined> | undefined
      let queued = ""
      let flushing: Promise<void> | undefined
      let latest = ""
      let latestCut = false
      let progressTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      // Once the result is being put together nothing more is taken in, so a late write cannot overwrite it.
      let sealed = false
      const encoding: OutputEncoding = {}
      const pipes = [new OutputDecoder(encoding), new OutputDecoder(encoding)]

      const flush = async () => {
        const file = await saved
        while (queued) {
          const text = queued
          queued = ""
          if (file) await fs.appendFile(file, text, "utf8").catch(() => {})
        }
        flushing = undefined
      }

      const report = () => {
        progressTimer = undefined
        if (!sealed) context.progress(latestCut ? `...\n\n${latest}` : latest)
      }

      const take = (text: string) => {
        if (!text) return
        const size = byteLength(text)
        total += size
        if (!firstFull) {
          const joined = first + text
          first = headWithin(joined, half)
          firstFull = first.length < joined.length
        }
        recent.push({ text, size })
        recentBytes += size
        while (recentBytes > keep && recent.length > 1) {
          recentBytes -= recent.shift()!.size
          dropped = true
        }
        latest += text
        if (latest.length > PREVIEW_CHARS) {
          latest = latest.slice(-PREVIEW_CHARS)
          // A pair split at the cut would draw as a stray half character.
          if (/^[\udc00-\udfff]/.test(latest)) latest = latest.slice(1)
          latestCut = true
        }
        if (unsaved) {
          unsaved.push(text)
          unsavedBytes += size
          if (unsavedBytes > budget) {
            const all = unsaved.join("")
            unsaved = undefined
            saved = context.toolOutputs!.save(all).catch(() => undefined)
          }
        } else if (saved) {
          queued += text
          flushing ??= flush()
        }
        progressTimer ??= setTimeout(report, PROGRESS_EVERY_MS)
      }

      child.stdout.on("data", (chunk: Buffer) => {
        if (!sealed) take(pipes[0].write(chunk))
      })
      child.stderr.on("data", (chunk: Buffer) => {
        if (!sealed) take(pipes[1].write(chunk))
      })

      /** Takes in what the pipes still held and stops taking anything more. */
      const seal = () => {
        if (sealed) return
        for (const pipe of pipes) take(pipe.end())
        sealed = true
        if (progressTimer) clearTimeout(progressTimer)
        progressTimer = undefined
      }

      const finish = async (code: number | null, expired: boolean) => {
        seal()
        const file = saved ? await saved : undefined
        while (flushing) await flushing
        const raw = recent.map((item) => item.text).join("")
        const end = tailWithin(raw, budget)
        const cut = dropped || end.cut
        let output = end.text
        if (cut && file) {
          const suffix = tailWithin(raw, Math.max(0, budget - byteLength(first))).text
          const shown = byteLength(first) + byteLength(suffix)
          output = `The output was cut: about ${Math.ceil(total / 4)} tokens in all.\n\n${first}\n… about ${Math.ceil(Math.max(0, total - shown) / 4)} tokens left out …\n${suffix}`
        }
        if (!output) output = "(no output)"
        /*
         * A command that ran out of time is not a failure of the tool, as MiMo
         * has it: what it printed comes back, with a note saying it was stopped.
         * The exit code stays in the metadata, where MiMo keeps it too.
         */
        if (expired) {
          output += `\n\n(The command was stopped when it ran past its ${timeout} ms timeout. If it needs longer and is not waiting for input, run it again with a larger timeout.)`
        }
        // A merge or rebase this left stopped on conflicts: the note says to back out and hand the conflict over.
        output += await mergeConflictNotice(cwd, command, output)
        if (cut && file) output += `\n\nThe whole output is saved at ${file}`
        resolve({
          output,
          title: description || command,
          metadata: {
            command,
            cwd,
            exit: code,
            description,
            truncated: cut,
            ...(cut && file ? { outputPath: file } : {}),
            ...(worktreeHits.length ? { mainWorktreeHits: worktreeHits } : {}),
          },
        })
      }

      /** Stops the command and waits a little for its pipes to close, so what it printed on the way out is kept. */
      const halt = async () => {
        stop(child)
        let grace: ReturnType<typeof setTimeout> | undefined
        await Promise.race([closed, new Promise<void>((done) => (grace = setTimeout(done, CLOSE_GRACE_MS)))])
        clearTimeout(grace)
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        context.signal.removeEventListener("abort", onAbort)
        void halt().then(() => finish(null, true))
      }, Math.min(LONGEST_TIMER, timeout + 100))

      /*
       * Stopped by the user. What the command printed so far stays on the card,
       * brought up to date first; the runner marks the call interrupted, and
       * that output is what the model is then handed, as MiMo hands it.
       */
      const onAbort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void halt().then(() => {
          seal()
          context.progress(latestCut ? `...\n\n${latest}` : latest)
          reject(new ToolError(ABORTED_TOOL))
        })
      }
      context.signal.addEventListener("abort", onAbort, { once: true })

      child.on("error", (err) => {
        if (settled) return
        settled = true
        sealed = true
        if (progressTimer) clearTimeout(progressTimer)
        clearTimeout(timer)
        context.signal.removeEventListener("abort", onAbort)
        reject(new ToolError(`Failed to start command: ${err.message}`))
      })

      child.on("close", (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.signal.removeEventListener("abort", onAbort)
        void finish(code, false)
      })
    })
  },
}
