import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { resolvePath } from "./fs-util"

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT = 60_000

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
 * Text from a command's bytes.
 *
 * UTF-8 when the bytes are UTF-8, and the console's own encoding when they are
 * not. The question is put strictly - a fatal decoder that throws - because
 * asking loosely and looking for replacement characters cannot tell a stream
 * that is not UTF-8 from one that is and legitimately contains U+FFFD.
 */
function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    const encoding = consoleEncoding()
    if (!encoding) return bytes.toString("utf8")
    try {
      return new TextDecoder(encoding).decode(bytes)
    } catch {
      return bytes.toString("utf8")
    }
  }
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

function shell(chosen?: string): { command: string; args: (script: string) => string[] } {
  const name = (chosen ?? "").trim()
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? ""

  if (base === "cmd.exe" || base === "cmd") {
    return { command: name, args: (script) => ["/d", "/s", "/c", script] }
  }
  if (base === "powershell.exe" || base === "pwsh.exe" || base === "pwsh" || base === "powershell") {
    return {
      command: name,
      args: (script) => ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8 + script],
    }
  }
  if (base && base !== "") {
    // bash, zsh, sh, fish and git-bash all take -lc.
    if (/^(bash|zsh|sh|fish|dash|ksh)(\.exe)?$/.test(base)) {
      return { command: name, args: (script) => ["-lc", script] }
    }
  }

  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: (script) => ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8 + script],
    }
  }
  return { command: process.env.SHELL || "/bin/bash", args: (script) => ["-lc", script] }
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
    "Run a shell command in the project directory and return its combined output. Use the dedicated read, edit, glob, and grep tools for file work instead of shelling out - they are faster and give better output. Reach for bash for builds, tests, package managers, and version control.",
  permission: "bash",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run" },
      description: { type: "string", description: "Short present-tense description of what this does, e.g. 'Run unit tests'" },
      cwd: { type: "string", description: "Working directory, relative to the project root" },
      timeout: { type: "number", description: `Milliseconds before the command is killed, default ${DEFAULT_TIMEOUT}` },
    },
    required: ["command", "description"],
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

    const cwd = input.cwd ? await resolvePath(context, String(input.cwd)) : context.directory
    const timeout = Math.min(MAX_TIMEOUT, Number(input.timeout ?? DEFAULT_TIMEOUT))

    await context.permissions.ask({
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "bash",
      title: String(input.description ?? "Run command"),
      subject: command,
      preview: command,
    })

    const { command: bin, args } = shell(context.shell)

    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args(command), {
        cwd,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", TERM: "dumb", NO_COLOR: "1" },
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
       * Bytes first, text at the end.
       *
       * `chunk.toString("utf8")` was wrong twice over. A character split across
       * two chunks decodes as two broken halves, which is a matter of timing
       * and so appears at random. And a command that does not write UTF-8 -
       * every native tool on a Chinese Windows writes the console codepage -
       * decodes to replacement characters throughout. Holding the bytes lets
       * the encoding be decided once, when all of them are in hand.
       *
       * The whole buffer is decoded again on each chunk rather than appended
       * to, which is what keeps a split character from ever being visible -
       * including while the command is still running.
       */
      const chunks: Buffer[] = []
      let seen = 0
      let output = ""
      let truncated = false
      let settled = false

      const append = (chunk: Buffer) => {
        if (truncated) return
        const room = MAX_OUTPUT - seen
        const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
        chunks.push(kept)
        seen += kept.byteLength
        if (kept.byteLength < chunk.byteLength) truncated = true
        output = decode(Buffer.concat(chunks))
        context.progress(output)
      }

      child.stdout.on("data", append)
      child.stderr.on("data", append)

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        stop(child)
        reject(new ToolError(`Command timed out after ${timeout}ms:\n${output}`))
      }, timeout)

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

        const body = output.trim() || "(no output)"
        const suffix = truncated ? `\n\n(output truncated at ${MAX_OUTPUT} bytes)` : ""
        resolve({
          // A non-zero exit is information for the model, not a tool failure -
          // it needs to see the output to decide what to do next.
          output: code === 0 ? body + suffix : `Exit code ${code}\n\n${body}${suffix}`,
          title: String(input.description ?? command),
          metadata: { command, cwd, exit: code, truncated },
        })
      })
    })
  },
}
