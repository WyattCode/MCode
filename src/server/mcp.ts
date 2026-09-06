import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { Bus } from "./bus"
import type { Config } from "./config"
import type { McpServerConfig, McpServerState, McpStatus } from "@shared/protocol"
import { ToolError, type ToolDefinition } from "./tool/types"

/**
 * Talks to Model Context Protocol servers, and offers their tools to the agent.
 *
 * MCP is JSON-RPC 2.0 with a handshake, so this speaks it directly rather than
 * pulling in an SDK - the whole surface used here is initialize, tools/list and
 * tools/call. A local server is a child process exchanging newline-delimited
 * frames on its pipes; a remote one is an HTTP endpoint that answers a POST.
 */

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/**
 * One prompt a server offers, which the composer reaches as a slash command.
 *
 * The reference lists these next to tools and turns each into a command whose
 * template is the prompt's messages (node-BBwF64dM.js @32868300). `arguments`
 * is what the slash line fills in: the reference asks for the prompt with
 * `$1`, `$2` … in place of each declared argument and lets the command runner
 * substitute the words that were typed.
 */
export interface McpPrompt {
  name: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
}

/** A prompt as it is offered to the composer, with the server that owns it. */
export interface McpPromptRef extends McpPrompt {
  client: string
}

/**
 * How a server's name and a prompt's name are joined into one word.
 *
 * Verbatim the reference's `sanitize` at node-BBwF64dM.js @22772862 -
 * `value.replace(/[^a-zA-Z0-9_-]/g, "_")` - which it applies to both halves
 * before joining them with a colon (@22770881). The colon is what makes an MCP
 * prompt typeable as `/server:prompt`, and it is deliberately not the
 * underscore this file uses for tool names: the reference uses different
 * separators for the two, and a tool name has to survive a provider's own
 * `^[a-zA-Z0-9_-]+$` check while a command name never leaves this app.
 */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function promptCommandName(client: string, prompt: string): string {
  return `${sanitizeMcpName(client)}:${sanitizeMcpName(prompt)}`
}

/** How long any one call is given before it is abandoned. */
const CALL_TIMEOUT = 60_000
/** The handshake gets less: a server that cannot greet is not going to work. */
const CONNECT_TIMEOUT = 15_000

const PROTOCOL_VERSION = "2024-11-05"

/**
 * How to start a command on this platform.
 *
 * Windows cannot exec a .cmd or .bat directly - npx and most published servers
 * are exactly that - so those go through cmd.exe. What it must not do is hand
 * the shell a concatenated string: this project lives under a path with a
 * space in it, and unquoted arguments would cut the path in half. Each part is
 * quoted here and passed verbatim, so the shell does no splitting of its own.
 */
function windowsLaunch(command: string, args: string[]) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args, verbatim: false }
  }
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`
  const line = [command, ...args].map(quote).join(" ")
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true }
}

/**
 * One connection, in whichever transport its config asks for.
 *
 * A connection that fails keeps its error rather than throwing it away: the
 * dialog shows it under the server's name, which is the only place a user can
 * find out that a command was misspelled.
 */
class Connection {
  status: McpStatus = "disabled"
  error?: string
  tools: McpTool[] = []
  /*
   * What the handshake said the server can do. Kept because prompts are asked
   * for only when they were advertised: the reference guards its own listing
   * with `client.getServerCapabilities()?.prompts` (@22771700), and a server
   * that never mentioned prompts answers `prompts/list` with a JSON-RPC error
   * that would otherwise be reported as a broken connection.
   */
  private capabilities: Record<string, unknown> = {}

  private child?: ChildProcessWithoutNullStreams
  private buffer = ""
  /** Whatever the server printed, kept apart from the reason it failed. */
  private stderr = ""
  private nextID = 1
  private readonly pending = new Map<number, Pending>()
  private closed = false

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    this.closed = false
    this.status = "pending"
    this.error = undefined
    this.stderr = ""
    try {
      if (this.config.type === "remote") {
        if (!this.config.url) throw new Error("no url configured")
      } else {
        this.spawn()
      }
      const greeting = (await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "MCode", version: "0.1.0" },
      })) as { capabilities?: Record<string, unknown> }
      this.capabilities = greeting?.capabilities ?? {}
      // The spec wants this after initialize, and servers that follow it will
      // not answer anything else until they have seen it.
      this.notify("notifications/initialized")
      const listed = (await this.request("tools/list", {})) as { tools?: McpTool[] }
      this.tools = listed?.tools ?? []
      this.status = "connected"
    } catch (err) {
      this.status = this.looksLikeAuth(err) ? "needs_auth" : "failed"
      const reason = err instanceof Error ? err.message : String(err)
      const printed = this.stderr.trim()
      this.error = printed ? `${reason}: ${printed}` : reason
      this.stop()
    }
  }

  /** A 401 is a different problem from a crash, and the dialog says so. */
  private looksLikeAuth(err: unknown) {
    const text = err instanceof Error ? err.message : String(err)
    return /\b401\b|unauthor/i.test(text)
  }

  disable(): void {
    this.stop()
    this.status = "disabled"
    this.error = undefined
    this.tools = []
    this.capabilities = {}
  }

  stop(): void {
    this.closed = true
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error("connection closed"))
    }
    this.pending.clear()
    this.child?.kill()
    this.child = undefined
    this.buffer = ""
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name: tool, arguments: args })) as {
      content?: { type: string; text?: string }[]
      isError?: boolean
    }
    const text = (result?.content ?? [])
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
      .join("\n")
      .trim()
    if (result?.isError) throw new ToolError(text || "the MCP server reported an error")
    return text || "(no output)"
  }

  /** The prompts this server offers, or nothing if it never claimed to have any. */
  async prompts(): Promise<McpPrompt[]> {
    if (this.status !== "connected" || !this.capabilities.prompts) return []
    const listed = (await this.request("prompts/list", {})) as { prompts?: McpPrompt[] }
    return listed?.prompts ?? []
  }

  /**
   * One prompt's messages, flattened to the text a slash command sends.
   *
   * The join is the reference's: `messages.map(m => m.content.type === "text"
   * ? m.content.text : "").join("\n")` (@32868400). A non-text part becomes an
   * empty line rather than being dropped, because that is what the reference
   * does and because the blank keeps the remaining messages apart.
   */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const result = (await this.request("prompts/get", { name, arguments: args })) as {
      messages?: { content?: { type?: string; text?: string } }[]
    }
    return (result?.messages ?? [])
      .map((message) => (message.content?.type === "text" ? (message.content.text ?? "") : ""))
      .join("\n")
  }

  private spawn() {
    const [command, ...args] = this.config.command ?? []
    if (!command) throw new Error("no command configured")
    const launch = windowsLaunch(command, args)
    const child = spawn(launch.command, launch.args, {
      env: { ...process.env, ...(this.config.environment ?? {}) },
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
    })
    this.child = child

    /*
     * Every handler below checks that it still owns the connection. A killed
     * process reports its exit a tick or two later, and by then a toggle may
     * already have started a replacement - without this, switching a server
     * off and on again leaves the new child marked dead by the old one.
     */
    const mine = () => this.child === child

    child.stdout.on("data", (chunk: Buffer) => {
      if (mine()) this.absorb(chunk.toString("utf8"))
    })
    /*
     * Servers use stderr for logging, not for answers. Keeping only the tail
     * means a crash still explains itself without a chatty server filling
     * memory with startup noise.
     */
    child.stderr.on("data", (chunk: Buffer) => {
      if (!mine()) return
      this.stderr += chunk.toString("utf8")
      if (this.stderr.length > 2000) this.stderr = this.stderr.slice(-2000)
    })
    child.on("error", (err) => {
      if (mine()) this.fail(err.message)
    })
    child.on("close", (code) => {
      if (this.closed || !mine()) return
      this.fail(`process exited${code === null ? "" : ` with code ${code}`}`)
    })
  }

  private fail(message: string) {
    this.status = "failed"
    const printed = this.stderr.trim()
    this.error = printed ? `${message}: ${printed}` : message
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(message))
    }
    this.pending.clear()
  }

  /** Frames are newline-delimited, and a chunk can hold any fraction of one. */
  private absorb(text: string) {
    this.buffer += text
    let index = this.buffer.indexOf("\n")
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.receive(line)
      index = this.buffer.indexOf("\n")
    }
  }

  private receive(line: string) {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return // Not a frame: some servers print banners on stdout.
    }
    if (typeof message.id !== "number") return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message ?? "MCP error"))
    else entry.resolve(message.result)
  }

  private notify(method: string, params: Record<string, unknown> = {}) {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params })
    if (this.config.type === "remote") {
      void this.post(frame).catch(() => {})
      return
    }
    this.child?.stdin.write(frame + "\n")
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextID
    this.nextID += 1
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params })

    if (this.config.type === "remote") {
      const body = await this.post(frame, method === "initialize")
      const message = JSON.parse(body) as { result?: unknown; error?: { message?: string } }
      if (message.error) throw new Error(message.error.message ?? "MCP error")
      return message.result
    }

    if (!this.child) throw new Error("not connected")
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, method === "initialize" ? CONNECT_TIMEOUT : CALL_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin.write(frame + "\n", (err) => {
        if (!err) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  private async post(frame: string, handshake = false): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      handshake ? CONNECT_TIMEOUT : CALL_TIMEOUT,
    )
    try {
      const response = await fetch(this.config.url!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.config.headers ?? {}),
        },
        body: frame,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      /*
       * Streamable HTTP may answer as server-sent events even for a single
       * reply, in which case the JSON is on the last data: line.
       */
      if (text.startsWith("event:") || text.includes("\ndata:")) {
        const data = text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
        return data[data.length - 1] ?? "{}"
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}

export class McpServers {
  private readonly connections = new Map<string, Connection>()
  /*
   * What the configuration looked like at the last sync. Config changes arrive
   * for every setting there is - a theme, a font - and reconnecting servers
   * because someone picked a colour would be absurd.
   */
  private fingerprint = ""

  constructor(
    private readonly bus: Bus,
    private readonly config: Config,
  ) {
    this.bus.subscribe((event) => {
      if (event.type !== "config.updated") return
      if (JSON.stringify(event.config.mcpServers ?? {}) === this.fingerprint) return
      void this.sync()
    })
  }

  /**
   * Brings connections in line with the configuration.
   *
   * Servers already connected are left alone: reconnecting on every config
   * change would drop a working session because an unrelated server was
   * renamed.
   */
  async sync(): Promise<void> {
    const configured = this.config.get().mcpServers ?? {}
    this.fingerprint = JSON.stringify(configured)

    for (const [name, connection] of [...this.connections]) {
      if (!configured[name]) {
        connection.stop()
        this.connections.delete(name)
      }
    }

    const work: Promise<void>[] = []
    for (const [name, entry] of Object.entries(configured)) {
      const wanted = entry.enabled !== false
      let connection = this.connections.get(name)
      if (!connection) {
        connection = new Connection(name, entry)
        this.connections.set(name, connection)
      }
      if (!wanted) {
        if (connection.status !== "disabled") connection.disable()
        continue
      }
      if (connection.status === "connected" || connection.status === "pending") continue
      work.push(connection.connect())
    }

    this.publish()
    await Promise.all(work)
    this.publish()
  }

  /** Flips one server on or off, and reconnects or drops it to match. */
  async toggle(name: string): Promise<void> {
    const servers = { ...(this.config.get().mcpServers ?? {}) }
    const entry = servers[name]
    if (!entry) return
    servers[name] = { ...entry, enabled: entry.enabled === false }
    await this.config.set({ mcpServers: servers })
    await this.sync()
  }

  list(): McpServerState[] {
    const configured = this.config.get().mcpServers ?? {}
    return Object.keys(configured)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const connection = this.connections.get(name)
        return {
          name,
          status: connection?.status ?? "disabled",
          error: connection?.error,
          tools: connection?.tools.length ?? 0,
        }
      })
  }

  private publish(): void {
    this.bus.publish({ type: "mcp.status", servers: this.list() })
  }

  /**
   * Every connected server's prompts, keyed the way a slash command names one.
   *
   * The reference builds exactly this map - `sanitize(client) + ":" +
   * sanitize(prompt.name)` against `{...prompt, client}` (@22770881) - and its
   * command service walks it to add one command per prompt. A server that
   * cannot be asked is skipped rather than failing the whole list: one broken
   * server must not empty the slash menu.
   */
  async prompts(): Promise<Record<string, McpPromptRef>> {
    const out: Record<string, McpPromptRef> = {}
    for (const [name, connection] of this.connections) {
      let listed: McpPrompt[] = []
      try {
        listed = await connection.prompts()
      } catch {
        continue
      }
      for (const prompt of listed) {
        out[promptCommandName(name, prompt.name)] = { ...prompt, client: name }
      }
    }
    return out
  }

  /** One prompt's text, with `$1`, `$2` … standing in for its arguments. */
  async getPrompt(client: string, name: string, args: Record<string, string>): Promise<string> {
    const connection = this.connections.get(client)
    if (!connection) return ""
    return connection.getPrompt(name, args)
  }

  /**
   * The tools every connected server offers, named for the agent.
   *
   * The server name is part of the tool name because two servers may well both
   * offer "search", and the model has to be able to tell them apart.
   */
  tools(): ToolDefinition[] {
    const out: ToolDefinition[] = []
    for (const [name, connection] of this.connections) {
      if (connection.status !== "connected") continue
      for (const tool of connection.tools) {
        out.push({
          name: `${name}_${tool.name}`,
          description: tool.description ?? `${tool.name} from the ${name} MCP server`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          // One bucket for all of them: approving a server's tools once is the
          // decision a user is actually making.
          permission: "mcp",
          execute: async (input, context) => {
            /*
             * An MCP server is code this app did not write, reached over a
             * pipe or a socket, and a call hands it whatever the model chose
             * to pass. That is worth asking about - and the approval is
             * remembered per server, because trusting one is the decision a
             * user is actually making.
             */
            await context.permissions.ask({
              signal: context.signal,
              sessionID: context.sessionID,
              messageID: context.messageID,
              callID: context.callID,
              kind: "mcp",
              title: `${name}: ${tool.name}`,
              subject: JSON.stringify(input),
              preview: JSON.stringify(input, null, 2),
              scope: `mcp:${name}`,
            })
            const output = await connection.call(tool.name, input)
            return { output, title: `${name}: ${tool.name}` }
          },
        })
      }
    }
    return out
  }

  close(): void {
    for (const [, connection] of this.connections) connection.stop()
    this.connections.clear()
  }
}
