import type { ClientFrame, Request, RequestOf, RequestType, ResponseMap, ServerEvent, ServerFrame } from "@shared/protocol"

type EventHandler = (event: ServerEvent) => void

interface Waiter {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

/**
 * Typed WebSocket client.
 *
 * Requests are promises correlated by id; events go to subscribers. The socket
 * is to a loopback backend inside the same app, so a drop means the backend is
 * restarting rather than a flaky network - reconnect quickly and keep the UI
 * honest about the state in the meantime.
 */
export class Client {
  private socket?: WebSocket
  private readonly waiters = new Map<string, Waiter>()
  private readonly handlers = new Set<EventHandler>()
  private queue: string[] = []
  private counter = 0
  private closed = false
  private retry = 0

  readonly state = { connected: false }

  /** Told whenever the socket opens or drops, so the window can resync. */
  private onState?: (connected: boolean) => void

  watch(handler: (connected: boolean) => void): void {
    this.onState = handler
  }

  /**
   * Where to connect.
   *
   * Normally the backend this app started, on a port it was told at boot. A
   * server the user names instead takes its place: the protocol is the same
   * either way, so nothing above this line knows the difference.
   */
  private address: string

  constructor(
    private readonly port: number,
    /** Proves this is the app's own renderer rather than a page in a browser. */
    private readonly token: string,
  ) {
    this.address = `ws://127.0.0.1:${port}`
  }

  /** Only this app's own backend is given the token; see connect(). */
  private get isLocal(): boolean {
    return this.address === `ws://127.0.0.1:${this.port}`
  }

  /** Points at another server, and reconnects there. */
  useServer(url?: string): void {
    this.address = url?.trim() || `ws://127.0.0.1:${this.port}`
    this.retry = 0
    this.socket?.close()
  }

  get server(): string {
    return this.address
  }

  connect(): void {
    if (this.closed) return
    /*
     * Sent as a subprotocol: a WebSocket cannot carry custom headers, and a
     * query string would put the secret in logs and error reports. Only to the
     * local backend - the token is this process's own, and a server the user
     * names has no business being handed it.
     */
    const socket = this.isLocal ? new WebSocket(this.address, this.token) : new WebSocket(this.address)
    this.socket = socket

    socket.addEventListener("open", () => {
      this.state.connected = true
      this.onState?.(true)
      this.retry = 0
      for (const payload of this.queue.splice(0)) socket.send(payload)
    })

    socket.addEventListener("message", (event) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(event.data as string)
      } catch {
        return
      }
      if (frame.kind === "event") {
        for (const handler of this.handlers) handler(frame.event)
        return
      }
      const waiter = this.waiters.get(frame.id)
      if (!waiter) return
      this.waiters.delete(frame.id)
      if (frame.ok) waiter.resolve(frame.data)
      else waiter.reject(new Error(frame.error))
    })

    socket.addEventListener("close", () => {
      this.state.connected = false
      this.onState?.(false)
      if (this.closed) return
      // In-flight requests will never be answered by a socket that is gone.
      for (const [id, waiter] of this.waiters) {
        this.waiters.delete(id)
        waiter.reject(new Error("Lost connection to the backend"))
      }
      this.retry = Math.min(this.retry + 1, 5)
      setTimeout(() => this.connect(), this.retry * 250)
    })
  }

  request<T extends RequestType>(request: RequestOf<T>): Promise<ResponseMap[T]> {
    const id = `r${++this.counter}`
    const frame: ClientFrame = { kind: "request", id, request: request as Request }
    const payload = JSON.stringify(frame)

    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve: resolve as (value: unknown) => void, reject })
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(payload)
      else this.queue.push(payload)
    })
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close(): void {
    this.closed = true
    this.socket?.close()
  }
}
