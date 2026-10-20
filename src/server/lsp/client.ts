import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

/** A diagnostic as the language server publishes it (LSP `Diagnostic`). */
export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  /** 1 error, 2 warning, 3 information, 4 hint. */
  severity?: number
  code?: number | string
  message: string
  source?: string
}

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer?: NodeJS.Timeout
}

interface Waiter {
  uri: string
  since: number
  resolve: (value: LspDiagnostic[] | undefined) => void
  timer: NodeJS.Timeout
}

interface DiagnosticEntry {
  diagnostics: LspDiagnostic[]
  at: number
}

/** No honest LSP message approaches this; anything larger is a hostile or broken peer. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

/** Absolute path to a `file://` URI. */
export function pathToUri(file: string): string {
  return pathToFileURL(file).toString()
}

/** A `file://` URI back to an absolute path. */
export function uriToPath(uri: string): string {
  return fileURLToPath(uri)
}

/**
 * A minimal language-server client: it spawns a server over stdio and speaks
 * JSON-RPC 2.0 with `Content-Length` framing. Enough to open a file and read
 * the diagnostics it publishes; nothing more.
 */
export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly rootUri: string
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private dead = false
  private cleanedUp = false
  private readonly pending = new Map<number | string, Pending>()
  private readonly waiters: Waiter[] = []
  private readonly diagnostics = new Map<string, DiagnosticEntry>()
  private readonly versions = new Map<string, number>()

  constructor(options: { command: string; args: string[]; cwd: string; rootUri: string }) {
    this.rootUri = options.rootUri
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue
      env[key] = value
    }
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child.stdin.on("error", () => undefined)
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk))
    this.child.stderr.on("data", () => undefined)
    this.child.on("exit", (code) => this.onExit(code))
    this.child.on("error", () => this.onExit(null))
  }

  /** Whether the server process has gone. */
  isDead(): boolean {
    return this.dead
  }

  /** The root this client was started for, as a URI. */
  getRootUri(): string {
    return this.rootUri
  }

  private onExit(code: number | null): void {
    if (this.dead) return
    this.dead = true
    const reason = new Error(`language server exited (${code ?? "signal"})`)
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
    this.cleanup()
  }

  /** Send a request and await its result; rejects on timeout, error response or exit. */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 10000): Promise<T> {
    if (this.dead) return Promise.reject(new Error("language server is not running"))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`language server request ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  /** Send a notification; nothing comes back. */
  notify(method: string, params: unknown): void {
    if (this.dead) return
    this.send({ jsonrpc: "2.0", method, params })
  }

  /** The handshake: `initialize`, then the `initialized` notification. */
  async initialize(rootPath: string, initializationOptions?: Record<string, unknown>): Promise<void> {
    const uri = pathToUri(rootPath)
    const params: Record<string, unknown> = {
      processId: process.pid,
      clientInfo: { name: "mcode", version: "1.0.0" },
      rootUri: uri,
      rootPath,
      workspaceFolders: [{ uri, name: rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath }],
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
          synchronization: { didSave: true },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: {},
          references: {},
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
        },
      },
    }
    if (initializationOptions) params.initializationOptions = initializationOptions
    await this.request("initialize", params, 15000)
    this.notify("initialized", {})
  }

  /** `didOpen` the first time, `didChange` (full text) after, then `didSave`. */
  openOrChange(file: string, text: string, languageId: string): void {
    const uri = pathToUri(file)
    const version = this.versions.get(uri)
    if (version === undefined) {
      this.versions.set(uri, 1)
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } })
    } else {
      const next = version + 1
      this.versions.set(uri, next)
      this.notify("textDocument/didChange", { textDocument: { uri, version: next }, contentChanges: [{ text }] })
    }
    this.notify("textDocument/didSave", { textDocument: { uri }, text })
  }

  /** The diagnostics cached for a URI, if any. */
  currentDiagnostics(uri: string): LspDiagnostic[] | undefined {
    return this.diagnostics.get(uri)?.diagnostics
  }

  /** When the cached diagnostics for a URI were published (0 if never). */
  diagnosticsAt(uri: string): number {
    return this.diagnostics.get(uri)?.at ?? 0
  }

  /**
   * Resolves with the next publish for `uri` after `since` (a timestamp), or
   * the cached set if it is already newer, or `undefined` on timeout.
   */
  waitForDiagnostics(uri: string, since: number, timeoutMs: number): Promise<LspDiagnostic[] | undefined> {
    const cached = this.diagnostics.get(uri)
    if (cached && cached.at > since) return Promise.resolve(cached.diagnostics)
    if (this.dead) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer)
        if (index !== -1) this.waiters.splice(index, 1)
        resolve(undefined)
      }, timeoutMs)
      timer.unref?.()
      this.waiters.push({ uri, since, resolve, timer })
    })
  }

  /** `shutdown` (2s), then `exit`, then a kill after 1s if it is still there. */
  async shutdown(): Promise<void> {
    if (this.dead) {
      this.cleanup()
      return
    }
    try {
      await this.request("shutdown", null, 2000)
    } catch {
      // a server that will not answer shutdown is killed below anyway
    }
    try {
      this.notify("exit", null)
    } catch {
      // ignore
    }
    try {
      this.child.stdin.end()
    } catch {
      // ignore
    }
    await this.waitForExit(1500)
    this.cleanup()
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.dead) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = () => {
        if (settled) return
        settled = true
        this.child.removeListener("exit", onExit)
        this.child.removeListener("error", onError)
        if (timer) clearTimeout(timer)
        resolve()
      }
      const onExit = () => finish()
      const onError = () => finish()
      this.child.once("exit", onExit)
      this.child.once("error", onError)
      timer = setTimeout(() => {
        if (!this.dead) {
          try {
            this.child.kill("SIGKILL")
          } catch {
            // already gone
          }
          this.onExit(null)
        }
        finish()
      }, timeoutMs)
    })
  }

  private cleanup(): void {
    if (this.cleanedUp) return
    this.cleanedUp = true
    try {
      this.child.stdin.end()
    } catch {
      // ignore
    }
    try {
      this.child.stdin.destroy()
    } catch {
      // ignore
    }
    try {
      this.child.stdout.destroy()
    } catch {
      // ignore
    }
    try {
      this.child.stderr.destroy()
    } catch {
      // ignore
    }
    try {
      this.child.unref()
    } catch {
      // ignore
    }
  }

  private send(message: unknown): void {
    if (this.dead) return
    const body = Buffer.from(JSON.stringify(message), "utf8")
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii")
    this.child.stdin.write(Buffer.concat([header, body]))
  }

  /**
   * Accumulate bytes and pull out whole messages. Handles several messages in
   * one chunk, a header split across chunks, and a body that has not fully
   * arrived - all by byte length, never by character count.
   */
  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString("ascii")
      let length = -1
      for (const line of header.split("\r\n")) {
        const colon = line.indexOf(":")
        if (colon === -1) continue
        if (line.slice(0, colon).trim().toLowerCase() === "content-length") {
          length = Number.parseInt(line.slice(colon + 1).trim(), 10)
        }
      }
      const bodyStart = headerEnd + 4
      if (!Number.isFinite(length) || length < 0) {
        // No usable length: drop the header block and resynchronise.
        this.buffer = this.buffer.subarray(bodyStart)
        continue
      }
      if (length > MAX_MESSAGE_BYTES) {
        // A declared length no honest server sends would let the buffer grow
        // without bound; drop the connection rather than the process.
        this.buffer = Buffer.alloc(0)
        try {
          this.child.kill("SIGKILL")
        } catch {
          // already gone
        }
        this.onExit(null)
        return
      }
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.subarray(bodyStart, bodyStart + length)
      this.buffer = this.buffer.subarray(bodyStart + length)
      let message: RpcMessage
      try {
        message = JSON.parse(body.toString("utf8")) as RpcMessage
      } catch {
        continue
      }
      this.handleMessage(message)
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (!message || typeof message !== "object") return
    if (message.method !== undefined && message.id !== undefined) {
      void this.answerRequest(message.id, message.method, message.params)
      return
    }
    if (message.method !== undefined) {
      this.handleNotification(message.method, message.params)
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result)
    }
  }

  /** Server-to-client requests: answer the few we know, and null for the rest. */
  private answerRequest(id: number | string, method: string, params: unknown): void {
    let result: unknown = null
    if (method === "workspace/configuration") {
      const items = (params as { items?: unknown[] } | undefined)?.items
      result = Array.isArray(items) ? items.map(() => null) : []
    }
    this.send({ jsonrpc: "2.0", id, result })
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics") return
    const payload = params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined
    const uri = payload?.uri
    if (!uri) return
    const entry: DiagnosticEntry = { diagnostics: Array.isArray(payload?.diagnostics) ? payload!.diagnostics! : [], at: Date.now() }
    this.diagnostics.set(uri, entry)
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!
      // Strictly-older only: a publish stamped the same millisecond as `since`
      // must still be delivered, or the waiter waits out its full timeout.
      if (waiter.uri !== uri || entry.at < waiter.since) continue
      clearTimeout(waiter.timer)
      this.waiters.splice(i, 1)
      waiter.resolve(entry.diagnostics)
    }
  }
}
