import { spawn } from "node:child_process"
import pkg from "../../package.json"
import type { McpServerConfig, McpToolInfo } from "@shared/protocol"
import { windowsLaunch } from "./mcp-launch"

/**
 * The settings page's 工具 list, as MiMo's desktop gets it: a connection of
 * its own, apart from the ones conversations use, so a server that is
 * switched off or failed still lists its tools or says exactly why it cannot.
 * No sign-in is attempted and no second transport is tried; the whole
 * exchange has fifteen seconds, and a paged list is followed.
 */

export const PROBE_TIMEOUT_MS = 15_000
/** Requests after the handshake: a local server is asked for at most eleven pages, a remote one ten. */
const LOCAL_LAST_ID = 12
const REMOTE_PAGES = 10

export type ProbeResult = { tools: McpToolInfo[] } | { error: string }

interface Frame {
  id?: unknown
  result?: { tools?: unknown; nextCursor?: unknown }
  error?: { message?: string }
}

const request = (id: number, method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params })
const notification = (method: string) => JSON.stringify({ jsonrpc: "2.0", method, params: {} })
const initialize = (id: number) =>
  request(id, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "MCode", version: pkg.version } })

function toolsOf(result: Frame["result"]): McpToolInfo[] {
  const listed = Array.isArray(result?.tools) ? result.tools : []
  return listed
    .filter((tool): tool is { name: string; description?: unknown } => Boolean(tool) && typeof (tool as { name?: unknown }).name === "string")
    .map((tool) => ({ name: tool.name, ...(typeof tool.description === "string" && tool.description ? { description: tool.description } : {}) }))
}

function cursorOf(result: Frame["result"]): string | undefined {
  return typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

/** The answer to `id` among whatever frames arrived, if it is there. */
function answerTo(frames: unknown[], id: number): Frame | undefined {
  for (const frame of frames) {
    if (frame && typeof frame === "object" && (frame as Frame).id === id) return frame as Frame
  }
  return undefined
}

function failure(frame: Frame): string | undefined {
  return frame.error ? (frame.error.message ?? "error") : undefined
}

async function probeLocal(config: McpServerConfig, cwd: string | undefined, timeoutMs: number): Promise<ProbeResult> {
  const [command, ...args] = config.command ?? []
  if (!command) return { error: "no command configured" }
  const launch = windowsLaunch(command, args)
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: { ...process.env, ...(config.environment ?? {}) },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim,
  })
  return new Promise<ProbeResult>((resolve) => {
    let done = false
    let buffer = ""
    let stage: "init" | "tools" = "init"
    let id = 2
    const tools: McpToolInfo[] = []
    const finish = (result: ProbeResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ error: `no answer within ${seconds(timeoutMs)}` }), timeoutMs)
    const write = (line: string) => {
      if (!child.stdin.writable) return
      child.stdin.write(line + "\n", () => {})
    }
    child.stdin.on("error", () => {})
    child.on("error", (error) => finish({ error: error.message }))
    child.on("exit", (code) => finish({ error: `the server exited (code ${code ?? "?"}) before it answered` }))
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let index = buffer.indexOf("\n")
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const frames = Array.isArray(parsed) ? parsed : [parsed]
        if (stage === "init") {
          const answer = answerTo(frames, 1)
          if (!answer) continue
          const wrong = failure(answer)
          if (wrong !== undefined) return finish({ error: `initialize: ${wrong}` })
          stage = "tools"
          write(notification("notifications/initialized"))
          write(request(id, "tools/list"))
          continue
        }
        const answer = answerTo(frames, id)
        if (!answer) continue
        const wrong = failure(answer)
        if (wrong !== undefined) return finish({ error: `tools/list: ${wrong}` })
        tools.push(...toolsOf(answer.result))
        const cursor = cursorOf(answer.result)
        if (!cursor || id >= LOCAL_LAST_ID) return finish({ tools })
        id++
        write(request(id, "tools/list", { cursor }))
      }
    })
    write(initialize(1))
  })
}

/** Frames from a response body that is JSON, or server-sent events carrying JSON. */
async function framesOf(response: Response, id: number): Promise<Frame | undefined> {
  const type = response.headers.get("content-type") ?? ""
  if (type.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (value) text += decoder.decode(value, { stream: true })
        const frames = text
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .flatMap((line) => {
            try {
              const parsed: unknown = JSON.parse(line.slice(5).trim())
              return Array.isArray(parsed) ? parsed : [parsed]
            } catch {
              return []
            }
          })
        const answer = answerTo(frames, id)
        if (answer || done) return answer
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }
  const parsed: unknown = await response.json().catch(() => undefined)
  return answerTo(Array.isArray(parsed) ? parsed : [parsed], id)
}

async function probeRemote(config: McpServerConfig, signal: AbortSignal): Promise<ProbeResult> {
  const url = config.url
  if (!url) return { error: "no url configured" }
  const base = { ...(config.headers ?? {}), "content-type": "application/json", accept: "application/json, text/event-stream" }
  const post = (body: string, extra: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { ...base, ...extra }, body, signal })
  const opened = await post(initialize(1))
  if (!opened.ok) {
    await opened.body?.cancel().catch(() => {})
    const legacy = opened.status === 404 || opened.status === 405 ? " (the server may only speak the older SSE transport)" : ""
    return { error: `initialize HTTP ${opened.status}${legacy}` }
  }
  const session = opened.headers.get("mcp-session-id")
  const extra: Record<string, string> = session ? { "mcp-session-id": session } : {}
  const greeting = await framesOf(opened, 1)
  if (!greeting) return { error: "initialize: no answer" }
  const refused = failure(greeting)
  if (refused !== undefined) return { error: `initialize: ${refused}` }
  await post(notification("notifications/initialized"), extra)
    .then((response) => response.body?.cancel())
    .catch(() => {})
  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  for (let page = 0, id = 2; page < REMOTE_PAGES; page++, id++) {
    const response = await post(request(id, "tools/list", cursor ? { cursor } : {}), extra)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { error: `tools/list HTTP ${response.status}` }
    }
    const answer = await framesOf(response, id)
    if (!answer) return { error: "tools/list: no answer" }
    const wrong = failure(answer)
    if (wrong !== undefined) return { error: `tools/list: ${wrong}` }
    tools.push(...toolsOf(answer.result))
    cursor = cursorOf(answer.result)
    if (!cursor) break
  }
  return { tools }
}

export async function probeTools(config: McpServerConfig, options: { cwd?: string; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  try {
    if (config.type === "remote") {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await probeRemote(config, controller.signal)
      } finally {
        clearTimeout(timer)
      }
    }
    if (config.type === "local") return await probeLocal(config, options.cwd, timeoutMs)
    return { error: "unsupported server config" }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { error: `no answer within ${seconds(timeoutMs)}` }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
