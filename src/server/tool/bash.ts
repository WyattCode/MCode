import { spawn, type ChildProcess } from "node:child_process"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { resolvePath } from "./fs-util"

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT = 60_000

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
/** macOS has defaulted to zsh since Catalina; every other unix still ships bash. */
function defaultShell(): string {
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"
}

function shell(chosen?: string): { command: string; args: (script: string) => string[] } {
  const name = (chosen ?? "").trim()
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? ""

  if (base === "cmd.exe" || base === "cmd") {
    return { command: name, args: (script) => ["/d", "/s", "/c", script] }
  }
  if (base === "powershell.exe" || base === "pwsh.exe" || base === "pwsh" || base === "powershell") {
    return { command: name, args: (script) => ["-NoProfile", "-NonInteractive", "-Command", script] }
  }
  if (base && base !== "") {
    // bash, zsh, sh, fish and git-bash all take -lc.
    if (/^(bash|zsh|sh|fish|dash|ksh)(\.exe)?$/.test(base)) {
      return { command: name, args: (script) => ["-lc", script] }
    }
  }

  if (process.platform === "win32") {
    return { command: "powershell.exe", args: (script) => ["-NoProfile", "-NonInteractive", "-Command", script] }
  }
  // -l so a GUI-launched app still sees the user's PATH: macOS hands a bundle
  // launched from Finder only /usr/bin:/bin:/usr/sbin:/sbin, so anything under
  // /opt/homebrew or a version manager is invisible until the profile is read.
  return { command: process.env.SHELL || defaultShell(), args: (script) => ["-lc", script] }
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
      signal: context.signal,
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

      let output = ""
      let truncated = false
      let settled = false

      const append = (chunk: Buffer) => {
        if (truncated) return
        const text = chunk.toString("utf8")
        if (output.length + text.length > MAX_OUTPUT) {
          output += text.slice(0, MAX_OUTPUT - output.length)
          truncated = true
        } else {
          output += text
        }
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
        const suffix = truncated ? `\n\n(output truncated at ${MAX_OUTPUT} characters)` : ""
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
