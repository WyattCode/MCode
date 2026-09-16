import pkg from "../../package.json"
import os from "node:os"
import { existsSync } from "node:fs"
import path from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { Bus } from "./bus"
import type { Config } from "./config"
import type { Storage } from "./storage"
import { randomBytes } from "node:crypto"
import {
  McpAuthStore,
  McpOAuthProvider,
  UnauthorizedError,
  auth,
  ensureCallbackServer,
  openInBrowser,
  waitForCallback,
  wwwAuthenticateParams,
} from "./mcp-oauth"
import type { Attachment, McpServerConfig, McpServerState, McpStatus } from "@shared/protocol"
import { redactString } from "@shared/mcp-redact"
import { ToolError, type ToolDefinition } from "./tool/types"
import { resolveServers, type ResolvedServer } from "./mcp-sources"
import { windowsLaunch } from "./mcp-launch"
import { probeTools, type ProbeResult } from "./mcp-probe"

/**
 * Talks to Model Context Protocol servers, and offers their tools to the agent.
 *
 * MCP is JSON-RPC 2.0 with a handshake, so this speaks it directly rather than
 * pulling in an SDK. A local server is a child process exchanging
 * newline-delimited frames on its pipes; a remote one is reached the way MiMo's
 * engine reaches it - Streamable HTTP first, then the older HTTP+SSE transport
 * when that fails. Either way the server may send requests and notifications
 * of its own, which are answered here: a ping, a sampling request, and a
 * changed tool list.
 */

type JsonRpcId = number | string

interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

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
 * A refusal a server-initiated request is answered with, carrying its JSON-RPC
 * code - MiMo answers a declined sampling request with -1, a malformed one with
 * the protocol's invalid-params code.
 */
export class McpRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "McpRequestError"
  }
}

/** Answers one `sampling/createMessage` a server sent, with the result the protocol expects. */
export type McpSampler = (input: {
  server: string
  params: Record<string, unknown>
  /** The conversation whose tool call last reached the server, which is where approval is asked. */
  sessionID?: string
  signal: AbortSignal
}) => Promise<Record<string, unknown>>

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
 * How a server's name and a tool's or prompt's name are made safe to join.
 *
 * MiMo's engine replaces everything outside `[a-zA-Z0-9_-]` with `_` in both
 * halves. A tool name is then `server_tool`, which has to survive a provider's
 * own `^[a-zA-Z0-9_-]+$` check - a server called "my.docs" would otherwise
 * make every request of the turn fail. A prompt is `server:prompt`, typeable
 * as a slash command.
 */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function promptCommandName(client: string, prompt: string): string {
  return `${sanitizeMcpName(client)}:${sanitizeMcpName(prompt)}`
}

export function mcpToolName(client: string, tool: string): string {
  return `${sanitizeMcpName(client)}_${sanitizeMcpName(tool)}`
}

/**
 * A server's input schema as MiMo's engine hands it to the model: always an
 * object, always with properties, and closed to keys it did not declare.
 */
export function mcpToolSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const declared = schema ?? {}
  return { ...declared, type: "object", properties: declared.properties ?? {}, additionalProperties: false }
}

/** Connecting and listing a server's tools get this long, unless its config sets `timeout` (MiMo's engine). */
const CONNECT_TIMEOUT = 30_000
/** A call to a server with no `timeout` of its own: the MCP SDK's default request timeout, which MiMo leaves in place. */
const CALL_TIMEOUT = 60_000

/** The version MiMo's MCP SDK offers in the handshake; a server answers with the one it speaks. */
const PROTOCOL_VERSION = "2025-11-25"

/** JSON-RPC's codes for a method this client does not answer and a failure while answering. */
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

interface McpContent {
  type?: string
  text?: string
  /** base64, on an image or audio block. */
  data?: string
  mimeType?: string
  uri?: string
  name?: string
  title?: string
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string }
}

/** A name for a picture or a sound a server answered with; it has no file of its own. */
function mcpAttachmentName(kind: string, mime: string, at: number): string {
  const extension = /\/([a-z0-9.+-]+)$/i.exec(mime)?.[1]?.replace(/^x-/, "") ?? "bin"
  return `mcp-${kind}-${at}.${extension}`
}

interface McpToolResult {
  content?: McpContent[]
  structuredContent?: unknown
  isError?: boolean
}

function serializedIn(output: string, serialized: string): boolean {
  const value = output.replaceAll("\r\n", "\n").trim()
  return value === serialized || value.startsWith(`${serialized}\n`) || value.endsWith(`\n${serialized}`) || value.includes(`\n${serialized}\n`)
}

/**
 * A tool result as text for the model, laid out as MiMo's engine lays it out:
 * text parts and embedded resource text joined by blank lines, a resource link
 * as its name and address, and structured content appended as JSON unless the
 * text already carries it.
 *
 * MiMo attaches images, audio and binary resources to the result, and so does
 * this: each rides on the result with its bytes, since a server's answer has no
 * file behind it. One a model cannot read becomes a line saying so when the
 * request is built, so nothing is dropped without a word.
 */
export function mcpToolOutput(result: McpToolResult): { output: string; isError: boolean; attachments: Attachment[] } {
  const text: string[] = []
  const attachments: Attachment[] = []
  for (const item of result.content ?? []) {
    if (item.type === "text") text.push(item.text ?? "")
    else if (item.type === "image" || item.type === "audio") {
      const mime = item.mimeType ?? (item.type === "image" ? "image/png" : "audio/wav")
      if (item.data) attachments.push({ path: mcpAttachmentName(item.type, mime, attachments.length + 1), mime, data: item.data })
      else text.push(`[${mime} ${item.type} left out: the server sent no data with it]`)
    } else if (item.type === "resource_link") {
      const name = item.title ?? item.name ?? ""
      const uri = (item.uri ?? "").trim()
      if (/^data:/i.test(uri)) {
        const inline = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,/i.exec(uri)
        text.push(inline ? `${name}: [inline ${inline[1]} resource left out]` : `${name}: [data URI omitted]`)
      } else text.push(`${name}: ${uri}`)
    } else if (item.type === "resource" && item.resource) {
      if (typeof item.resource.text === "string") text.push(item.resource.text)
      if (typeof item.resource.blob === "string") {
        const mime = item.resource.mimeType ?? "application/octet-stream"
        attachments.push({ path: item.resource.uri || mcpAttachmentName("resource", mime, attachments.length + 1), mime, data: item.resource.blob })
      }
    }
  }
  const textOutput = text.join("\n\n")
  if (result.structuredContent === undefined) return { output: textOutput, isError: result.isError ?? false, attachments }
  const structured = JSON.stringify(result.structuredContent)
  const pretty = JSON.stringify(result.structuredContent, null, 2)
  const already = serializedIn(textOutput, structured) || serializedIn(textOutput, pretty)
  const visible = text.some((entry) => entry.trim().length > 0)
  const output = already ? textOutput : visible ? `${textOutput}\n\nStructured content:\n${structured}` : structured
  return { output, isError: result.isError ?? false, attachments }
}

/**
 * Reads a server-sent event stream, handing over each event's name and its
 * joined data lines as the blank line that ends it arrives - so a request the
 * server sends in the middle of a long answer is seen while the answer waits.
 */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let event = ""
  let data: string[] = []
  const line = (text: string) => {
    if (text === "") {
      if (data.length) onEvent(event || "message", data.join("\n"))
      event = ""
      data = []
      return
    }
    if (text.startsWith(":")) return
    const colon = text.indexOf(":")
    const field = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? "" : text.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n")
    while (index !== -1) {
      line(buffer.slice(0, index).replace(/\r$/, ""))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
    }
  }
  if (buffer) line(buffer.replace(/\r$/, ""))
  line("")
}

/** What a connection asks of the servers' owner. */
interface ConnectionHooks {
  /** Where a local server starts: the project, as MiMo's engine starts it in its instance directory. */
  cwd?: () => string | undefined
  /** Set when the entry cannot be started at all; connecting reports it as the failure. */
  invalid?: string
  /** The server said its tools changed, and the new list is in. */
  toolsChanged?: () => void
  sample?: McpSampler
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
  /** The conversation whose tool call last reached this server; sampling asks there, as MiMo's does. */
  activeSession?: string
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
  /** How a remote server is spoken to: Streamable HTTP, or the older HTTP+SSE once that failed. */
  private transport: "stdio" | "http" | "sse" = "stdio"
  /** HTTP+SSE: the address the event stream named for posting messages. */
  private endpoint?: URL
  /** Requests and event streams in flight, cut off when the connection closes. */
  private readonly streams = new Set<AbortController>()
  /** Requests the server sent that are still being answered. */
  private readonly serving = new Map<JsonRpcId, AbortController>()
  private protocolVersion?: string

  /** A remote server's sign-in, unless its config turns OAuth off. */
  private readonly provider?: McpOAuthProvider
  /** The session a Streamable HTTP server handed out, sent back on every request. */
  private sessionID?: string
  /** A 401 after this connection already signed in once is not answered by signing in again. */
  private signedIn = false
  /** What the last 401 named, for finishing the sign-in it started. */
  private resourceMetadataUrl?: URL
  private scope?: string

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    auth?: McpAuthStore,
    /** Where the authorization address goes when signing in needs the reader; a plain connect only notes it. */
    onRedirect?: (url: URL) => void,
    private readonly hooks: ConnectionHooks = {},
  ) {
    if (config.type === "remote" && config.url && config.oauth !== false && auth) {
      const oauth = typeof config.oauth === "object" ? config.oauth : {}
      this.provider = new McpOAuthProvider(name, config.url, oauth, onRedirect ?? (() => {}), auth)
    }
  }

  /** Finishes a sign-in with the code the callback brought back. */
  async finishAuth(code: string): Promise<void> {
    if (!this.provider) throw new UnauthorizedError("No auth provider")
    const result = await auth(this.provider, {
      serverUrl: this.config.url!,
      authorizationCode: code,
      resourceMetadataUrl: this.resourceMetadataUrl,
      scope: this.scope,
    })
    if (result !== "AUTHORIZED") throw new UnauthorizedError("Failed to authorize")
  }

  async connect(): Promise<void> {
    this.closed = false
    this.status = "pending"
    this.error = undefined
    this.stderr = ""
    this.sessionID = undefined
    this.signedIn = false
    this.protocolVersion = undefined
    try {
      if (this.hooks.invalid) throw new Error(`invalid config: ${this.hooks.invalid}`)
      if (this.config.type === "remote") {
        if (!this.config.url) throw new Error("no url configured")
        await this.connectRemote()
      } else {
        this.transport = "stdio"
        this.spawn()
        await this.handshake()
      }
      this.status = "connected"
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const printed = this.stderr.trim()
      this.status = "failed"
      this.error = printed ? `${reason}: ${printed}` : reason
      /*
       * As MiMo's engine sorts it: a server that wants a sign-in waits for
       * 授权, except one that cannot register a client, which needs a client
       * id written into its config first.
       */
      if (this.provider && (err instanceof UnauthorizedError || reason.includes("OAuth"))) {
        if (reason.includes("registration") || reason.includes("client_id")) {
          this.error = "Server does not support dynamic client registration. Please provide clientId in config."
        } else {
          this.status = "needs_auth"
          this.error = undefined
        }
      }
      this.stop()
    }
  }

  /**
   * MiMo's order for a remote server: Streamable HTTP, then HTTP+SSE. A server
   * that asked for a sign-in is not tried a second way - signing in is the answer.
   */
  private async connectRemote(): Promise<void> {
    this.transport = "http"
    try {
      await this.handshake()
      return
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (err instanceof UnauthorizedError || (this.provider && reason.includes("OAuth"))) throw err
      this.cut()
      this.sessionID = undefined
      this.protocolVersion = undefined
    }
    this.transport = "sse"
    await this.openLegacyStream()
    await this.handshake()
  }

  private async handshake(): Promise<void> {
    const timeout = this.config.timeout ?? CONNECT_TIMEOUT
    const greeting = (await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        // Sampling is offered, as MiMo's client offers it; each request is still decided per server.
        capabilities: { sampling: {} },
        clientInfo: { name: "MCode", version: pkg.version },
      },
      { timeout },
    )) as { capabilities?: Record<string, unknown>; protocolVersion?: unknown }
    this.capabilities = greeting?.capabilities ?? {}
    if (typeof greeting?.protocolVersion === "string") this.protocolVersion = greeting.protocolVersion
    // The spec wants this after initialize, and servers that follow it will
    // not answer anything else until they have seen it.
    this.notify("notifications/initialized")
    if (this.transport === "http") void this.openServerStream()
    this.tools = await this.listTools(timeout)
  }

  private async listTools(timeout = this.config.timeout ?? CONNECT_TIMEOUT): Promise<McpTool[]> {
    const listed = (await this.request("tools/list", {}, { timeout })) as { tools?: McpTool[] }
    return listed?.tools ?? []
  }

  /** Whether a request is still going either way, which keeps an idle project's servers open. */
  busy(): boolean {
    return this.pending.size > 0 || this.serving.size > 0
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
    this.cut()
    this.child?.kill()
    this.child = undefined
    this.buffer = ""
  }

  /** Settles everything waiting on this connection and closes its streams, without deciding its status. */
  private cut(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error("connection closed"))
    }
    this.pending.clear()
    for (const controller of this.streams) controller.abort()
    this.streams.clear()
    for (const [, controller] of this.serving) controller.abort()
    this.serving.clear()
    this.endpoint = undefined
  }

  /**
   * One tool call. The turn's Stop reaches the server as a cancellation, and a
   * call with no answer inside the server's `timeout` - or a minute, without
   * one - is given up on.
   */
  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ output: string; attachments: Attachment[] }> {
    // A call that timed out or lost its server is a failure the model reads, not a crash of the app.
    const result = (await this.request("tools/call", { name: tool, arguments: args }, { timeout: this.config.timeout ?? CALL_TIMEOUT, signal }).catch(
      (err: unknown) => {
        throw err instanceof ToolError ? err : new ToolError(err instanceof Error ? err.message : String(err))
      },
    )) as McpToolResult
    const { output, isError, attachments } = mcpToolOutput(result ?? {})
    if (isError) throw new ToolError(output || "the MCP server reported an error")
    return { output: output || "(no output)", attachments }
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
      // In the project, so a server told `.` - server-filesystem, say - looks where the user works.
      cwd: this.hooks.cwd?.(),
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
      if (line) this.receiveText(line)
      index = this.buffer.indexOf("\n")
    }
  }

  /** A frame, a batch of frames, or - some servers print banners on stdout - not a frame at all. */
  private receiveText(text: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (message && typeof message === "object") this.receive(message as JsonRpcMessage)
    }
  }

  /*
   * A message with a method is the server speaking first - a request when it
   * carries an id, a notification when it does not. Only one without a method
   * is a reply, so a server's own request that happens to reuse the id of a
   * call still waiting is answered, not mistaken for that call's result.
   */
  private receive(message: JsonRpcMessage) {
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) void this.serve(message.id, message.method, message.params ?? {})
      else this.notified(message.method, message.params ?? {})
      return
    }
    if (typeof message.id !== "number") return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message ?? "MCP error"))
    else entry.resolve(message.result)
  }

  private notified(method: string, params: Record<string, unknown>) {
    // MiMo refetches a server's tools when it says they changed, and the next request offers the new list.
    if (method === "notifications/tools/list_changed") {
      if (this.status !== "connected") return
      void this.listTools().then(
        (tools) => {
          if (this.status !== "connected") return
          this.tools = tools
          this.hooks.toolsChanged?.()
        },
        () => {},
      )
      return
    }
    if (method === "notifications/cancelled") {
      const id = params.requestId
      if (typeof id === "number" || typeof id === "string") this.serving.get(id)?.abort()
    }
  }

  /** Answers a request the server sent: a ping, a sampling request, or that the method is not one this client has. */
  private async serve(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const controller = new AbortController()
    this.serving.set(id, controller)
    try {
      let result: unknown
      if (method === "ping") result = {}
      else if (method === "sampling/createMessage" && this.hooks.sample) {
        result = await this.hooks.sample({ server: this.name, params, sessionID: this.activeSession, signal: controller.signal })
      } else throw new McpRequestError(METHOD_NOT_FOUND, "Method not found")
      await this.send({ jsonrpc: "2.0", id, result })
    } catch (err) {
      const code = err instanceof McpRequestError ? err.code : INTERNAL_ERROR
      const message = err instanceof Error ? err.message : String(err)
      const data = err instanceof McpRequestError && err.data !== undefined ? { data: err.data } : {}
      await this.send({ jsonrpc: "2.0", id, error: { code, message, ...data } }).catch(() => {})
    } finally {
      this.serving.delete(id)
    }
  }

  private notify(method: string, params: Record<string, unknown> = {}) {
    void this.send({ jsonrpc: "2.0", method, params }).catch(() => {})
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const id = this.nextID
    this.nextID += 1
    const timeout = options.timeout ?? CALL_TIMEOUT
    const signal = options.signal
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ToolError("The MCP call was stopped"))
        return
      }
      const settle = () => {
        const entry = this.pending.get(id)
        if (!entry) return undefined
        this.pending.delete(id)
        clearTimeout(entry.timer)
        signal?.removeEventListener("abort", onAbort)
        return entry
      }
      // Stopped or given up on, the server is told, as the MCP SDK tells it, so it can stop working too.
      const onAbort = () => {
        if (!settle()) return
        this.notify("notifications/cancelled", { requestId: id, reason: "The turn was stopped" })
        reject(new ToolError("The MCP call was stopped"))
      }
      const timer = setTimeout(() => {
        if (!settle()) return
        this.notify("notifications/cancelled", { requestId: id, reason: `Timed out after ${timeout}ms` })
        reject(new Error(`${method} timed out`))
      }, timeout)
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      this.send({ jsonrpc: "2.0", id, method, params }, timeout).catch((err: unknown) => {
        if (!settle()) return
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  /** Puts one frame on the wire; a reply that comes back in the response body is received from there. */
  private async send(message: JsonRpcMessage, timeout = CALL_TIMEOUT): Promise<void> {
    const frame = JSON.stringify(message)
    if (this.transport === "stdio") {
      const child = this.child
      if (!child) throw new Error("not connected")
      await new Promise<void>((resolve, reject) => child.stdin.write(frame + "\n", (err) => (err ? reject(err) : resolve())))
      return
    }
    if (this.transport === "sse") {
      if (!this.endpoint) throw new Error("not connected")
      const { response, release } = await this.open(this.endpoint, "POST", { "content-type": "application/json" }, frame, timeout)
      await response.body?.cancel().catch(() => {})
      release()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return
    }
    const { response, release } = await this.open(
      new URL(this.config.url!),
      "POST",
      { "content-type": "application/json", accept: "application/json, text/event-stream" },
      frame,
      timeout,
    )
    try {
      const session = response.headers.get("mcp-session-id")
      if (session) this.sessionID = session
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${response.status}`)
      }
      if (response.status === 202 || !response.body) return
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        await readEvents(response.body, (_event, data) => this.receiveText(data))
        return
      }
      const text = await response.text()
      /*
       * Some servers answer as server-sent events without saying so in the
       * content type; the JSON is then on the data: lines.
       */
      if (!text.trimStart().startsWith("{") && !text.trimStart().startsWith("[") && /^(event|data):/m.test(text)) {
        for (const line of text.split("\n")) if (line.startsWith("data:")) this.receiveText(line.slice(5).trim())
        return
      }
      this.receiveText(text)
    } finally {
      release()
    }
  }

  /**
   * One HTTP request to a remote server, with its headers and its sign-in.
   *
   * The SDK transport's order: the stored token, the session, and then the
   * config's own headers, which win - an Authorization written there is what
   * gets sent. `release` ends the request's hold once its body has been read;
   * a request without `timeout` is an event stream that stays open.
   */
  private async open(
    url: URL,
    method: "GET" | "POST",
    base: Record<string, string>,
    body?: string,
    timeout?: number,
  ): Promise<{ response: Response; release: () => void }> {
    const controller = new AbortController()
    this.streams.add(controller)
    const timer = timeout === undefined ? undefined : setTimeout(() => controller.abort(), timeout)
    const release = () => {
      clearTimeout(timer)
      this.streams.delete(controller)
    }
    try {
      const headers = new Headers(base)
      const tokens = this.provider ? await this.provider.tokens() : undefined
      if (tokens) headers.set("authorization", `Bearer ${tokens.access_token}`)
      if (this.sessionID) headers.set("mcp-session-id", this.sessionID)
      if (this.transport === "http" && this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion)
      for (const [key, value] of Object.entries(this.config.headers ?? {})) headers.set(key, value)
      const response = await fetch(url, { method, headers, body, signal: controller.signal })
      if (response.status === 401 && this.provider) {
        await response.body?.cancel().catch(() => {})
        release()
        if (this.signedIn) throw new Error("Server returned 401 after successful authentication")
        const named = wwwAuthenticateParams(response)
        this.resourceMetadataUrl = named.resourceMetadataUrl
        this.scope = named.scope
        // Renews with the refresh token when there is one, or leaves the authorization address for 授权.
        const result = await auth(this.provider, {
          serverUrl: this.config.url!,
          resourceMetadataUrl: this.resourceMetadataUrl,
          scope: this.scope,
        })
        if (result !== "AUTHORIZED") throw new UnauthorizedError()
        this.signedIn = true
        return this.open(url, method, base, body, timeout)
      }
      return { response, release }
    } catch (err) {
      release()
      throw err
    }
  }

  /** HTTP+SSE: opens the event stream and waits for the address it names for posting. */
  private async openLegacyStream(): Promise<void> {
    const url = new URL(this.config.url!)
    const { response, release } = await this.open(url, "GET", { accept: "text/event-stream" })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      release()
      throw new Error(`HTTP ${response.status}`)
    }
    const body = response.body
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the event stream named no endpoint")), this.config.timeout ?? CONNECT_TIMEOUT)
      readEvents(body, (event, data) => {
        if (event === "endpoint") {
          this.endpoint = new URL(data, url)
          clearTimeout(timer)
          resolve()
          return
        }
        this.receiveText(data)
      })
        .catch(() => {})
        .finally(() => {
          release()
          clearTimeout(timer)
          reject(new Error("the event stream closed"))
          if (!this.closed && this.transport === "sse" && this.status === "connected") this.fail("the event stream closed")
        })
    })
  }

  /** Streamable HTTP: the stream a server may speak first on; one without it answers 405, which is fine. */
  private async openServerStream(): Promise<void> {
    try {
      const { response, release } = await this.open(new URL(this.config.url!), "GET", { accept: "text/event-stream" })
      try {
        if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          await response.body?.cancel().catch(() => {})
          return
        }
        await readEvents(response.body, (_event, data) => this.receiveText(data))
      } finally {
        release()
      }
    } catch {
      // Closed with the connection, or never offered.
    }
  }
}

/** A project directory's servers: MiMo's engine keeps one set per instance directory. */
interface Group {
  directory: string
  /** Every server the directory is offered, in the order its config named them. */
  entries: ResolvedServer[]
  connections: Map<string, Connection>
  /** What each connection was made from, so an edited entry is told from an untouched one. */
  made: Map<string, string>
  /** Settles once the first round of connections has been tried. */
  ready: Promise<void>
  lastUsed: number
}

/** A group nobody has asked for in this long is closed, except the one the settings page shows. */
const IDLE_GROUP_MS = 30 * 60_000

function directoryKey(directory: string): string {
  const resolved = path.resolve(directory)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function madeFrom(entry: ResolvedServer): string {
  return JSON.stringify({ config: entry.config ?? null, invalid: entry.invalid ?? null })
}

export class McpServers {
  private readonly groups = new Map<string, Group>()
  /*
   * What the configuration looked like at the last look. Config changes arrive
   * for every setting there is - a theme, a font - and reconnecting servers
   * because someone picked a colour would be absurd.
   */
  private fingerprint = ""
  /*
   * MiMo's "next conversation" rule. A saved change only marks the servers
   * out of date; starting a conversation turns that into a pending reload,
   * which is carried out as soon as no turn is running anywhere - so a server
   * removed or edited never disappears from under a turn that is using it.
   */
  private dirty = false
  private pending = false
  private busy: () => boolean = () => false

  private readonly oauth?: McpAuthStore
  /** Servers whose sign-in is under way, so a second press does not start another. */
  private readonly authorizing = new Set<string>()
  private sampler?: McpSampler

  constructor(
    private readonly bus: Bus,
    private readonly config: Config,
    private readonly storage?: Storage,
    /** Where the project and Claude Code files are looked for; the home folder unless a check says otherwise. */
    private readonly home?: string,
  ) {
    this.oauth = storage ? new McpAuthStore(storage) : undefined
    this.fingerprint = JSON.stringify(this.config.get().mcpServers ?? {})
    this.bus.subscribe((event) => {
      if (event.type === "session.idle") {
        if (this.pending) void this.applyPending()
        return
      }
      if (event.type !== "config.updated") return
      const next = JSON.stringify(event.config.mcpServers ?? {})
      if (next === this.fingerprint) return
      this.fingerprint = next
      this.dirty = true
    })
  }

  /** Whether any turn is running; a pending reload waits until none is. */
  useBusy(busy: () => boolean): void {
    this.busy = busy
  }

  /**
   * A new conversation is starting: a configuration saved since the last one
   * is applied to every project's servers, now if nothing is running, else as
   * soon as the last running turn ends.
   */
  commitIfDirty(): Promise<void> {
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    this.pending = true
    return this.applyPending()
  }

  private async applyPending(): Promise<void> {
    if (!this.pending || this.busy()) return
    this.pending = false
    await this.refresh()
  }

  /**
   * The settings page's answer to a server it lists as on but the report does
   * not know yet - one added since the servers were last read: it is
   * connected now, in the directory the page reports on, as MiMo's page
   * registers it with its engine.
   */
  async register(name: string): Promise<void> {
    const stored = this.config.get().mcpServers?.[name]
    if (!stored) throw new Error(`no MCP server named ${name} is configured`)
    await this.ready(this.viewDirectory())
    const group = this.group()
    if (!group || group.connections.has(name)) return
    const [entry] = await resolveServers({ servers: { [name]: stored }, configFile: this.configFile(), home: this.home })
    if (!entry) throw new Error(`the MCP server ${name} has no type`)
    if (group.connections.has(name)) return
    group.entries = [...group.entries, entry]
    const connection = this.connection(group, entry)
    if (entry.config?.enabled === false) {
      this.publish()
      return
    }
    this.publish()
    await connection.connect()
    this.publish()
  }

  /** How a server's sampling requests are answered; the backend hands this over once the models are reachable. */
  useSampling(sampler: McpSampler): void {
    this.sampler = sampler
  }

  /** The file MCode's own list lives in; `{file:…}` there counts from its folder. */
  private configFile(): string {
    return this.storage?.fileOf("config") ?? path.join(os.homedir(), "config.json")
  }

  /** The directory the settings page reports on: where a new conversation starts, as MiMo reports its default one. */
  private viewDirectory(): string {
    const directory = this.config.get().directory
    return directory && existsSync(directory) ? directory : os.homedir()
  }

  private resolve(directory: string): Promise<ResolvedServer[]> {
    return resolveServers({ servers: this.config.get().mcpServers ?? {}, configFile: this.configFile(), directory, home: this.home })
  }

  private hooks(group: Group, invalid?: string): ConnectionHooks {
    return {
      // In the project, so a server told `.` - server-filesystem, say - looks where the user works.
      cwd: () => (existsSync(group.directory) ? group.directory : os.homedir()),
      ...(invalid ? { invalid } : {}),
      toolsChanged: () => this.publish(),
      sample: (input) => (this.sampler ? this.sampler(input) : Promise.reject(new McpRequestError(METHOD_NOT_FOUND, "Method not found"))),
    }
  }

  private connection(group: Group, entry: ResolvedServer): Connection {
    const config = entry.config ?? ({ type: "local" } as McpServerConfig)
    const connection = new Connection(entry.name, config, this.oauth, undefined, this.hooks(group, entry.invalid))
    group.connections.set(entry.name, connection)
    group.made.set(entry.name, madeFrom(entry))
    return connection
  }

  /** Brings a group's connections in line with `entries`: a changed entry is connected again with what it says now. */
  private async reconcile(group: Group, entries: ResolvedServer[]): Promise<void> {
    const wanted = new Set(entries.map((entry) => entry.name))
    for (const [name, connection] of [...group.connections]) {
      if (wanted.has(name)) continue
      connection.stop()
      group.connections.delete(name)
      group.made.delete(name)
    }
    group.entries = entries
    const work: Promise<void>[] = []
    for (const entry of entries) {
      const enabled = entry.config?.enabled !== false
      let connection = group.connections.get(entry.name)
      if (connection && group.made.get(entry.name) !== madeFrom(entry)) {
        connection.stop()
        connection = undefined
      }
      connection ??= this.connection(group, entry)
      if (!enabled) {
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

  /** A directory's servers, connected (or tried) before this settles. */
  async ready(directory: string): Promise<void> {
    this.sweep()
    const key = directoryKey(directory)
    let group = this.groups.get(key)
    if (!group) {
      const created: Group = { directory, entries: [], connections: new Map(), made: new Map(), ready: Promise.resolve(), lastUsed: Date.now() }
      created.ready = this.resolve(directory).then((entries) => this.reconcile(created, entries))
      this.groups.set(key, created)
      group = created
    }
    group.lastUsed = Date.now()
    await group.ready
  }

  /** At launch: the servers of the directory the settings page reports on. */
  start(): Promise<void> {
    return this.ready(this.viewDirectory())
  }

  /** Every group reads the configuration again: what changed or failed is connected again, what went is closed. */
  private async refresh(): Promise<void> {
    // Each group's `ready` is replaced at once, so a turn that starts meanwhile waits for the new set.
    await Promise.all(
      [...this.groups.values()].map((group) => {
        group.ready = group.ready
          .catch(() => {})
          .then(() => this.resolve(group.directory))
          .then((entries) => this.reconcile(group, entries))
        return group.ready
      }),
    )
  }

  /** Closes project groups nobody has used for a while; a call still running keeps its group. */
  private sweep(): void {
    const view = directoryKey(this.viewDirectory())
    const cutoff = Date.now() - IDLE_GROUP_MS
    for (const [key, group] of [...this.groups]) {
      if (key === view || group.lastUsed > cutoff) continue
      if ([...group.connections.values()].some((connection) => connection.busy())) continue
      for (const connection of group.connections.values()) connection.stop()
      this.groups.delete(key)
    }
  }

  private group(directory?: string): Group | undefined {
    const group = this.groups.get(directoryKey(directory ?? this.viewDirectory()))
    if (group) group.lastUsed = Date.now()
    return group
  }

  /** Flips one server on or off in the configuration. */
  async toggle(name: string): Promise<void> {
    const servers = { ...(this.config.get().mcpServers ?? {}) }
    const entry = servers[name]
    if (!entry) return
    servers[name] = { ...entry, enabled: entry.enabled === false }
    await this.config.set({ mcpServers: servers })
  }

  /**
   * MiMo's 授权, as its engine runs it: start the callback listener, keep a
   * fresh state, try the server with a provider that catches the authorization
   * address, open the browser on it, wait for the callback, check the state,
   * exchange the code, then connect again. A server that turns out to need no
   * sign-in is simply connected. Rejects with why when it cannot finish.
   */
  async authenticate(name: string): Promise<void> {
    const stored = this.config.get().mcpServers?.[name]
    if (!stored || stored.enabled === false) throw new Error(`MCP server ${name} not found or disabled`)
    const [resolved] = await resolveServers({ servers: { [name]: stored }, configFile: this.configFile(), home: this.home })
    const entry = resolved?.config
    if (!entry) throw new Error(resolved?.invalid ?? `MCP server ${name} not found or disabled`)
    if (entry.type !== "remote" || !entry.url) throw new Error(`MCP server ${name} is not a remote server`)
    if (entry.oauth === false) throw new Error(`MCP server ${name} has OAuth explicitly disabled`)
    if (!this.oauth) throw new Error("sign-in is not available")
    if (this.authorizing.has(name)) throw new Error("sign-in already in progress")
    this.authorizing.add(name)
    try {
      await this.signIn(name, entry, this.oauth)
    } finally {
      this.authorizing.delete(name)
    }
  }

  private async signIn(name: string, entry: McpServerConfig, store: McpAuthStore): Promise<void> {
    const oauth = typeof entry.oauth === "object" ? entry.oauth : undefined
    await ensureCallbackServer(oauth?.redirectUri)
    const state = randomBytes(32).toString("hex")
    await store.update(name, "oauthState", state)

    let address: URL | undefined
    const attempt = new Connection(
      name,
      entry,
      store,
      (url) => {
        address = url
      },
      {},
    )
    await attempt.connect()
    attempt.stop()
    if (attempt.status !== "connected") {
      if (attempt.status !== "needs_auth" || !address) {
        throw new Error(attempt.error ?? "the server did not ask for a sign-in")
      }
      const callback = waitForCallback(state, name)
      openInBrowser(address.toString())
      const code = await callback
      const kept = (await store.get(name))?.oauthState
      await store.clear(name, "oauthState")
      if (kept !== state) throw new Error("OAuth state mismatch - potential CSRF attack")
      await attempt.finishAuth(code)
      await store.clear(name, "codeVerifier")
    } else {
      await store.clear(name, "oauthState")
    }
    // Signed in: every project that has this server waiting on a sign-in connects again.
    await Promise.all(
      [...this.groups.values()].map(async (group) => {
        const connection = group.connections.get(name)
        if (!connection || connection.status === "connected" || connection.status === "disabled") return
        connection.stop()
        this.publish()
        await connection.connect()
        this.publish()
      }),
    )
  }

  list(): McpServerState[] {
    const group = this.group()
    if (!group) return []
    return group.entries.map((entry) => {
      const connection = group.connections.get(entry.name)
      return {
        name: entry.name,
        status: connection?.status ?? "disabled",
        // A failure may quote the address or the command it was started with; shown masked.
        error: connection?.error === undefined ? undefined : redactString(connection.error),
        tools: connection?.tools.length ?? 0,
      }
    })
  }

  /** The servers a directory's conversations are offered, by name. */
  names(directory: string): string[] {
    return (this.group(directory)?.entries ?? []).filter((entry) => entry.config?.enabled !== false).map((entry) => entry.name)
  }

  /**
   * One server's tools for the settings page, from a connection of their own
   * (see mcp-probe.ts) - so a server switched off or failed still answers.
   */
  async probe(name: string, timeoutMs?: number): Promise<ProbeResult> {
    const stored = this.config.get().mcpServers?.[name]
    if (!stored) return { error: "server not found" }
    const [entry] = await resolveServers({ servers: { [name]: stored }, configFile: this.configFile(), home: this.home })
    if (!entry) return { error: "unsupported server config" }
    if (!entry.config) return { error: redactString(`invalid config: ${entry.invalid}`) }
    const result = await probeTools(entry.config, { cwd: this.viewDirectory(), timeoutMs })
    // An error may quote the address or the command; shown masked, as the status is.
    return "error" in result ? { error: redactString(result.error) } : result
  }

  private publish(): void {
    this.bus.publish({ type: "mcp.status", servers: this.list() })
  }

  /**
   * Every connected server's prompts in a directory, keyed the way a slash
   * command names one.
   *
   * The reference builds exactly this map - `sanitize(client) + ":" +
   * sanitize(prompt.name)` against `{...prompt, client}` (@22770881) - and its
   * command service walks it to add one command per prompt. A server that
   * cannot be asked is skipped rather than failing the whole list: one broken
   * server must not empty the slash menu.
   */
  async prompts(directory?: string): Promise<Record<string, McpPromptRef>> {
    if (directory) await this.ready(directory)
    const out: Record<string, McpPromptRef> = {}
    for (const [name, connection] of this.group(directory)?.connections ?? []) {
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
  async getPrompt(client: string, name: string, args: Record<string, string>, directory?: string): Promise<string> {
    const connection = this.group(directory)?.connections.get(client)
    if (!connection) return ""
    return connection.getPrompt(name, args)
  }

  /**
   * The tools every connected server of a directory offers, named for the agent.
   *
   * The server name is part of the tool name because two servers may well both
   * offer "search", and the model has to be able to tell them apart.
   */
  tools(directory?: string): ToolDefinition[] {
    const out: ToolDefinition[] = []
    for (const [name, connection] of this.group(directory)?.connections ?? []) {
      if (connection.status !== "connected") continue
      for (const tool of connection.tools) {
        out.push({
          name: mcpToolName(name, tool.name),
          description: tool.description ?? "",
          parameters: mcpToolSchema(tool.inputSchema),
          // One bucket for all of them: approving a server's tools once is the
          // decision a user is actually making.
          permission: "mcp",
          server: name,
          execute: async (input, context) => {
            connection.activeSession = context.sessionID
            await context.permissions.ask({
              sessionID: context.sessionID,
              messageID: context.messageID,
              callID: context.callID,
              kind: "mcp",
              directory: context.directory,
              title: `${name}: ${tool.name}`,
              subject: JSON.stringify(input),
              preview: JSON.stringify(input, null, 2),
              scope: `mcp:${name}`,
            })
            const { output, attachments } = await connection.call(tool.name, input, context.signal)
            // MiMo hands a server's pictures and sounds to the model on the result itself.
            return { output, title: `${name}: ${tool.name}`, ...(attachments.length ? { attachments } : {}) }
          },
        })
      }
    }
    return out
  }

  close(): void {
    for (const group of this.groups.values()) for (const connection of group.connections.values()) connection.stop()
    this.groups.clear()
  }
}
