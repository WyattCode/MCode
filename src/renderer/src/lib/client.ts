import type { ClientFrame, Request, RequestOf, RequestType, ResponseMap, ServerEvent, ServerFrame } from "@shared/protocol"
import { t } from "./i18n"
import { socketProtocols } from "@shared/socket-auth"

type EventHandler = (event: ServerEvent) => void

interface Waiter {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  /** False while the payload waits in the queue for the socket to open. */
  sent: boolean
  /** Gives up on a queued payload that the socket never came back to send. */
  expiry?: ReturnType<typeof setTimeout>
}

/**
 * How long a request made while the socket is down waits for it to reopen.
 *
 * The reconnect notice promises the message goes out once the service is back,
 * so a queued request is not failed by the next refused reconnect attempt, only
 * after this long - and it leaves the queue then, so a request the reader was
 * told had failed is never sent afterwards.
 */
export const QUEUED_REQUEST_TIMEOUT_MS = 30_000

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
  /** Requests made while the socket was down, in order, until it opens. */
  private queue: { id: string; payload: string }[] = []
  /** Overridable so a test need not wait out the real bound. */
  queueTimeout = QUEUED_REQUEST_TIMEOUT_MS
  private counter = 0
  private closed = false
  private retry = 0

  readonly state = { connected: false }

  /** Told whenever the socket opens or drops, so the window can resync. */
  private onState?: (connected: boolean) => void

  watch(handler: (connected: boolean) => void): void {
    this.onState = handler
  }

  /** The backend this app started, on the port it was told at boot - the only place this window connects to. */
  readonly server: string

  constructor(
    port: number,
    private readonly secret: string,
  ) {
    this.server = `ws://127.0.0.1:${port}`
  }

  connect(): void {
    if (this.closed) return
    // The launch secret proves this window belongs to the app.
    const socket = new WebSocket(this.server, socketProtocols(this.secret))
    this.socket = socket

    socket.addEventListener("open", () => {
      this.state.connected = true
      this.onState?.(true)
      this.retry = 0
      for (const { id, payload } of this.queue.splice(0)) {
        const waiter = this.waiters.get(id)
        if (!waiter) continue
        clearTimeout(waiter.expiry)
        waiter.sent = true
        socket.send(payload)
      }
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
      /*
       * A failure the backend named is phrased here rather than repeated.
       *
       * These rejections are shown as the body of a notice, so the backend's
       * own English sentence used to surface verbatim in a translated
       * interface - the same fault the socket-close path below was fixed for.
       * The sentence comes from the tables; the raw text stays on the error
       * for anything that logs it.
       */
      else waiter.reject(frame.errorCode ? Object.assign(new Error(t(frame.errorCode, frame.errorParams)), { code: frame.errorCode }) : new Error(frame.error))
    })

    socket.addEventListener("close", () => {
      this.state.connected = false
      this.onState?.(false)
      if (this.closed) return
      /*
       * A request the socket carried will never be answered by a socket that is
       * gone, so its waiter fails now. A request still in the queue was never
       * sent: it stays pending for the reopen (or its expiry), which is what
       * the reconnect notice tells the reader. Failing it here too reported a
       * send as failed and then delivered it on reconnect.
       *
       * The sentence comes from the language tables - these rejections are the
       * body of a notice (`notifyFailure(t("common.requestFailed"), err.message)`)
       * - and names the local service, not the reader's network: this socket
       * is loopback.
       */
      for (const [id, waiter] of this.waiters) {
        if (!waiter.sent) continue
        this.waiters.delete(id)
        waiter.reject(new Error(t("error.backendLost")))
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
      const waiter: Waiter = { resolve: resolve as (value: unknown) => void, reject, sent: false }
      this.waiters.set(id, waiter)
      if (this.socket?.readyState === WebSocket.OPEN) {
        waiter.sent = true
        this.socket.send(payload)
        return
      }
      this.queue.push({ id, payload })
      waiter.expiry = setTimeout(() => {
        this.queue = this.queue.filter((entry) => entry.id !== id)
        this.waiters.delete(id)
        reject(new Error(t("error.backendLost")))
      }, this.queueTimeout)
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
