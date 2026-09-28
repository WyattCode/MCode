/**
 * A Chrome DevTools Protocol connection, as small as the app tool needs.
 *
 * One socket to a browser's endpoint (Chrome, Edge, or an Electron app started
 * with a debugging port); pages are reached through it with flattened target
 * sessions, so every page shares the socket and is addressed by session id.
 * Node's own WebSocket carries it, so there is no dependency to ship.
 */

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`)
    this.name = "CdpError"
  }
}

interface Waiting {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class Cdp {
  private next = 1
  private readonly waiting = new Map<number, Waiting>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private ended = false

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.receive(String(event.data)))
    socket.addEventListener("close", () => this.end(new Error("the connection to the app closed")))
    socket.addEventListener("error", () => this.end(new Error("the connection to the app failed")))
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error(`no answer from ${url} within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        resolve(new Cdp(socket))
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error(`could not connect to ${url}`))
      })
    })
  }

  get closed(): boolean {
    return this.ended
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.ended) return Promise.reject(new CdpError(method, "the connection to the app is closed"))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new CdpError(method, `no answer within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.waiting.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    if (this.ended) return
    this.socket.close()
    this.end(new Error("the connection to the app was closed"))
  }

  private receive(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message.id === "number") {
      const waiting = this.waiting.get(message.id)
      if (!waiting) return
      this.waiting.delete(message.id)
      if (message.error) waiting.reject(new CdpError(waiting.method, message.error.message ?? "failed"))
      else waiting.resolve(message.result ?? {})
      return
    }
    if (message.method) {
      const event: CdpEvent = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId }
      for (const listener of this.listeners) listener(event)
    }
  }

  private end(error: Error): void {
    if (this.ended) return
    this.ended = true
    for (const waiting of this.waiting.values()) waiting.reject(new CdpError(waiting.method, error.message))
    this.waiting.clear()
  }
}

/** The browser-level socket of a Chromium listening on `port` - Chrome, Edge, or an Electron app. */
export async function browserSocketURL(port: number, timeoutMs = 5_000): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined)
  if (!response?.ok) throw new Error(`nothing is listening for DevTools on port ${port}`)
  const version = (await response.json()) as { webSocketDebuggerUrl?: string }
  if (!version.webSocketDebuggerUrl) throw new Error(`port ${port} answers, but not as a DevTools endpoint`)
  return version.webSocketDebuggerUrl
}
