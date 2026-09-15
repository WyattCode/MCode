import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { resolvePath } from "./fs-util"
import { scanCommand } from "./bash-scan"

const DEFAULT_TIMEOUT = 120_000
/** How much output comes back inline when the call does not say, in MiMo's approximate tokens of four bytes. */
const DEFAULT_MAX_OUTPUT_TOKENS = 30_000
/** How much of the latest output the card shows while the command works. */
const PREVIEW_CHARS = 30_000
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
      resolved = page ? CODEPAGES[page] : undefined
    } catch {
      resolved = undefined
    }
    return resolved
  }
})()

/**
 * The encoding a command's bytes are in: UTF-8 when they are UTF-8, and the
 * console's own encoding when they are not. The question is put strictly - a
 * fatal decoder that throws - because asking loosely and looking for
 * replacement characters cannot tell a stream that is not UTF-8 from one that
 * is and legitimately contains U+FFFD.
 */
function encodingOf(bytes: Buffer): string {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return "utf-8"
  } catch {
    const encoding = consoleEncoding()
    if (!encoding) return "utf-8"
    try {
      new TextDecoder(encoding)
      return encoding
    } catch {
      return "utf-8"
    }
  }
}

function decode(bytes: Buffer): string {
  return new TextDecoder(encodingOf(bytes)).decode(bytes)
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

/**
 * Commands whose whole purpose is to be hard to undo. These are refused
 * outright rather than merely prompted for: an approval dialog trains people
 * to click through, and there is no good reason for the agent to reach for
 * these shapes on its own.
 */
const REFUSED: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rR][a-z]*f|\brm\s+-fr\b/, reason: "recursive force delete" },
  { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: "filesystem format" },
  { pattern: /\bdd\b[^|]*\bof=\/dev\/(sd|nvme|hd|disk)/, reason: "raw disk write" },
  { pattern: />\s*\/dev\/(sd|nvme|hd|disk)[a-z0-9]*/, reason: "raw disk write" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/, reason: "host power control" },
]

/**
 * The shell a command runs in, and how a script is handed to it.
 *
 * A chosen shell is honoured where the flags are known; anything else falls
 * back to the platform default rather than guessing at an argument form, since
 * getting that wrong runs the script as a filename.
 */
/*
 * Makes PowerShell write UTF-8.
 *
 * Windows PowerShell emits its own messages in the console's codepage - 936 on
 * a Chinese install - and this app reads the pipe as UTF-8, so every error it
 * raised arrived as replacement characters. That is worse than ugly: the model
 * reading the output cannot see what went wrong, so it does not fix the script,
 * it flails. Measured on the real failure: as bytes it is GBK, and the same
 * command with this prefix comes back as UTF-8 the first time.
 */
const POWERSHELL_UTF8 = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "

export function shellFor(chosen?: string): { command: string; args: (script: string) => string[]; powershell: boolean } {
  const name = (chosen ?? "").trim()
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? ""

  if (base === "cmd.exe" || base === "cmd") {
    return { command: name, args: (script) => ["/d", "/s", "/c", script], powershell: false }
  }
  if (base === "powershell.exe" || base === "pwsh.exe" || base === "pwsh" || base === "powershell") {
    return {
      command: name,
      args: (script) => ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8 + script],
      powershell: true,
    }
  }
  if (base && base !== "") {
    // bash, zsh, sh, fish and git-bash all take -lc.
    if (/^(bash|zsh|sh|fish|dash|ksh)(\.exe)?$/.test(base)) {
      return { command: name, args: (script) => ["-lc", script], powershell: false }
    }
  }

  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: (script) => ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8 + script],
      powershell: true,
    }
  }
  return { command: process.env.SHELL || "/bin/bash", args: (script) => ["-lc", script], powershell: false }
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
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
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
  description:
    "Run a shell command in the project and return what it printed. Use the read, edit, glob and grep tools for file work instead of shelling out - they are faster and give better output. Reach for bash for builds, tests, package managers and version control. Set workdir rather than starting the command with cd. A command is stopped after two minutes unless timeout gives it longer. Output past about 30,000 tokens (max_output_tokens) comes back with its middle left out, and the whole of it is saved to a file named in the result.",
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
    required: ["command"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const command = String(input.command).trim()
    if (!command) throw new ToolError("command is empty")

    for (const rule of REFUSED) {
      if (rule.pattern.test(command)) {
        throw new ToolError(
          `Refused: this command looks like a ${rule.reason}, which this tool will not run. If you genuinely need it, ask the user to run it themselves.`,
        )
      }
    }

    const timeout = input.timeout === undefined ? DEFAULT_TIMEOUT : Number(input.timeout)
    if (!Number.isFinite(timeout) || timeout < 0) throw new ToolError(`timeout has to be a number of milliseconds, zero or more: ${String(input.timeout)}`)
    const maxTokens = input.max_output_tokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : Number(input.max_output_tokens)
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new ToolError(`max_output_tokens has to be a positive whole number: ${String(input.max_output_tokens)}`)
    const description = typeof input.description === "string" ? input.description : ""

    const cwd = input.workdir ? await resolvePath(context, String(input.workdir)) : context.directory
    const { command: bin, args, powershell } = shellFor(context.shell)

    /*
     * MiMo's order: folders outside the project that the command's file
     * arguments name are asked about first; then a command that deletes gets a
     * question of its own, listing what it deletes, asked every time and never
     * remembered - unless everything it deletes is in the temp folder; anything
     * else is one question whose "always" keeps each command's prefix. A bare
     * `cd` asks nothing.
     */
    const scan = await scanCommand(command, cwd, context.directory, powershell)
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
    }
    if (scan.deletes.length && !scan.tempOnlyDeletes) {
      await context.permissions.ask({ ...question, patterns: scan.deletes, always: [], forced: true })
    } else if (scan.patterns.length) {
      await context.permissions.ask({ ...question, patterns: scan.patterns, always: scan.always, forced: false })
    }

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
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        /*
         * Its own process group, so stopping the command can signal everything
         * the command started rather than only the shell. Windows has no groups
         * to join and treats this flag as "outlive the parent", which is the
         * opposite of what is wanted here.
         */
        detached: process.platform !== "win32",
      })

      /*
       * MiMo's accounting, in bytes. The result shows `budget` bytes: the first
       * half of it from the very start of the output and the rest from the end.
       * Twice that much of the latest output is held, and once the output passes
       * the budget the whole of it goes to a file instead of memory.
       *
       * Bytes are held rather than text because a character can be split across
       * two chunks, and a command that does not write UTF-8 - every native tool
       * on a Chinese Windows writes the console codepage - has to be decoded as
       * a whole to be decoded at all.
       */
      const budget = maxTokens * 4
      const keep = budget * 2
      const head: Buffer[] = []
      let headBytes = 0
      const recent: Buffer[] = []
      let recentBytes = 0
      let total = 0
      let dropped = false
      let spill: Buffer[] | undefined = []
      let decoder: InstanceType<typeof TextDecoder> | undefined
      let saved: Promise<string | undefined> | undefined
      let settled = false

      const append = (chunk: Buffer) => {
        total += chunk.byteLength
        const room = Math.floor(budget / 2) - headBytes
        if (room > 0) {
          const part = chunk.subarray(0, room)
          head.push(part)
          headBytes += part.byteLength
        }
        recent.push(chunk)
        recentBytes += chunk.byteLength
        while (recentBytes > keep && recent.length > 1) {
          recentBytes -= recent.shift()!.byteLength
          dropped = true
        }
        if (spill) {
          spill.push(chunk)
          if (total > budget) {
            const all = Buffer.concat(spill)
            spill = undefined
            const outputs = context.toolOutputs
            if (outputs) {
              decoder = new TextDecoder(encodingOf(all))
              saved = outputs.save(decoder.decode(all, { stream: true })).catch(() => undefined)
            }
          }
        } else if (saved && decoder) {
          const text = decoder.decode(chunk, { stream: true })
          saved = saved.then(async (file) => {
            if (file) await fs.appendFile(file, text, "utf8").catch(() => {})
            return file
          })
        }
        const latest = decode(Buffer.concat(recent))
        context.progress(latest.length > PREVIEW_CHARS ? `...\n\n${latest.slice(-PREVIEW_CHARS)}` : latest)
      }

      child.stdout.on("data", append)
      child.stderr.on("data", append)

      const finish = async (code: number | null, expired: boolean) => {
        if (saved && decoder) {
          const rest = decoder.decode()
          if (rest) {
            saved = saved.then(async (file) => {
              if (file) await fs.appendFile(file, rest, "utf8").catch(() => {})
              return file
            })
          }
        }
        const file = saved ? await saved : undefined
        const raw = decode(Buffer.concat(recent))
        const end = tailWithin(raw, budget)
        const cut = dropped || end.cut
        let output = end.text
        if (cut && file) {
          const start = headWithin(decode(Buffer.concat(head)).replace(/�+$/, ""), Math.floor(budget / 2))
          const suffix = tailWithin(raw, Math.max(0, budget - byteLength(start))).text
          const shown = byteLength(start) + byteLength(suffix)
          output = `The output was cut: about ${Math.ceil(total / 4)} tokens in all.\n\n${start}\n… about ${Math.ceil(Math.max(0, total - shown) / 4)} tokens left out …\n${suffix}`
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
        if (cut && file) output += `\n\nThe whole output is saved at ${file}`
        resolve({
          output,
          title: description || command,
          metadata: { command, cwd, exit: code, description, truncated: cut, ...(cut && file ? { outputPath: file } : {}) },
        })
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        context.signal.removeEventListener("abort", onAbort)
        stop(child)
        void finish(null, true)
      }, Math.min(LONGEST_TIMER, timeout + 100))

      const onAbort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stop(child)
        reject(new ToolError("Command was aborted"))
      }
      context.signal.addEventListener("abort", onAbort, { once: true })

      child.on("error", (err) => {
        if (settled) return
        settled = true
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
