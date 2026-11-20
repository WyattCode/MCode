import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { validateHooks, validateProjectHooks, type HookConfig, type HookEvent, type HooksListing } from "@shared/hooks"
import { repositoryRoot } from "../git"
import type { Permissions } from "../permission"
import { simpleCommands } from "../tool/bash-scan"
import { ToolError } from "../tool/types"

const OUTPUT_BYTES = 4096
const DEFAULT_TIMEOUT_MS = 10_000

type HookSnapshot = HooksListing & {
  projectRoot?: string
  events: Record<HookEvent, HookConfig[]>
}

interface HookCall {
  sessionID: string
  messageID: string
  callID: string
  tool: string
  args: Record<string, unknown>
  signal: AbortSignal
}

interface ShellResult {
  code?: number | null
  stdout?: string
  stderr?: string
  problem?: string
}

export class HookEngine {
  constructor(
    private readonly permissions: Permissions,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  async snapshot(directory: string | undefined, globalHooks: unknown, projectNames?: Record<string, string>): Promise<HookSnapshot> {
    const global = validateHooks(globalHooks, "config.json")
    const projectRoot = directory ? (await repositoryRoot(directory)) ?? directory : undefined
    const project = projectRoot ? await projectHooks(projectRoot) : validateHooks(undefined, ".mcode/hooks.json")
    return {
      projectRoot,
      groups: [
        { scope: "global", rows: global.rows },
        { scope: "plugin", rows: [] },
        ...(projectRoot ? [{ scope: "project" as const, name: projectNames?.[projectRoot] ?? path.basename(projectRoot), rows: project.rows }] : []),
      ],
      events: {
        PreToolUse: [...global.events.PreToolUse, ...project.events.PreToolUse],
        PostToolUse: [...global.events.PostToolUse, ...project.events.PostToolUse],
      },
    }
  }

  async before(snapshot: HookSnapshot, call: HookCall): Promise<void> {
    await this.run("PreToolUse", snapshot, call)
  }

  async after(snapshot: HookSnapshot, call: HookCall, output: string): Promise<string> {
    const notes = await this.run("PostToolUse", snapshot, call, output)
    return notes.length ? [output, ...notes].join("\n") : output
  }

  private async run(event: HookEvent, snapshot: HookSnapshot, call: HookCall, output?: string): Promise<string[]> {
    const notes: string[] = []
    for (const hook of snapshot.events[event]) {
      if (call.signal.aborted) break
      if (hook.matcher !== "*" && hook.matcher.toLowerCase() !== call.tool.toLowerCase()) continue
      const patterns = [hook.command, ...simpleCommands(hook.command, false).map(({ source }) => source)]
      if (!await this.permissions.allowHook(event, hook.command, patterns, { ...call, directory: snapshot.projectRoot })) continue
      if (call.signal.aborted) break

      const payload = JSON.stringify({
        event, tool: call.tool, args: call.args, sessionKey: call.sessionID, projectRoot: snapshot.projectRoot ?? null,
        ...(output === undefined ? {} : { resultPreview: preview(output) }),
      })
      const result = await shell(hook, event, call, snapshot.projectRoot, payload)
      if (call.signal.aborted) break
      if (event === "PreToolUse" && result.code === 2) {
        throw new ToolError(result.stderr?.split(/\r?\n/, 1)[0]?.trim() || "Blocked by a PreToolUse hook.")
      }
      if (result.problem || result.code !== 0) {
        const detail = result.problem ?? `exit ${result.code ?? "by signal"}`
        this.log(`[hooks] ${event} ${call.tool}: ${detail}${result.stderr?.trim() ? ` — ${result.stderr.trim()}` : ""}`)
      }
      const note = result.stdout?.trim().replace(/[\r\n]+/g, " ")
      if (event === "PostToolUse" && note) notes.push(`hook: ${note}`)
    }
    return notes
  }
}

async function projectHooks(root: string) {
  const source = path.join(root, ".mcode", "hooks.json")
  let text: string
  try {
    text = await fs.readFile(source, "utf8")
  } catch (error) {
    const empty = validateHooks(undefined, source)
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") empty.rows.push({ source, reason: "read" })
    return empty
  }
  try {
    return validateProjectHooks(JSON.parse(text), source)
  } catch {
    const empty = validateHooks(undefined, source)
    empty.rows.push({ source, reason: "json" })
    return empty
  }
}

function preview(value: string): string {
  // At most 4096 UTF-16 units are needed to find the first 4096 UTF-8 bytes.
  const bytes = Buffer.from(value.slice(0, OUTPUT_BYTES))
  if (bytes.length <= OUTPUT_BYTES) return bytes.toString()
  let end = OUTPUT_BYTES
  while ((bytes[end] & 0xc0) === 0x80) end--
  return bytes.toString("utf8", 0, end)
}

function shell(hook: HookConfig, event: HookEvent, call: HookCall, cwd: string | undefined, payload: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32"
    const executable = windows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : "/bin/sh"
    const child = spawn(executable, windows ? ["/d", "/s", "/c", `"${hook.command}"`] : ["-c", hook.command], {
      cwd, windowsHide: true, windowsVerbatimArguments: windows, detached: !windows,
      env: { ...process.env, MCODE_HOOK_EVENT: event, MCODE_HOOK_TOOL: call.tool },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = Buffer.alloc(OUTPUT_BYTES)
    const stderr = Buffer.alloc(OUTPUT_BYTES)
    let out = 0
    let err = 0
    child.stdout.on("data", (data: Buffer) => { out += data.copy(stdout, out) })
    child.stderr.on("data", (data: Buffer) => { err += data.copy(stderr, err) })
    // A hook may exit or ignore stdin before the entire payload has been sent.
    child.stdin.on("error", () => {})
    child.stdin.end(payload)

    function settle(result: ShellResult) {
      clearTimeout(timer)
      call.signal.removeEventListener("abort", abort)
      resolve(result)
    }
    function stop(problem: string) {
      if (child.pid !== undefined) {
        try {
          if (windows) {
            const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" })
            killer.on("error", () => child.kill())
            killer.unref()
          } else {
            process.kill(-child.pid, "SIGKILL")
          }
        } catch {
          child.kill()
        }
      }
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      settle({ problem, stderr: stderr.toString("utf8", 0, err) })
    }
    const abort = () => stop("aborted")
    const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs}ms`), timeoutMs)
    call.signal.addEventListener("abort", abort, { once: true })
    child.once("error", (error) => settle({ problem: error.message }))
    child.once("close", (code) => settle({ code, stdout: stdout.toString("utf8", 0, out), stderr: stderr.toString("utf8", 0, err) }))
    if (call.signal.aborted) abort()
  })
}
