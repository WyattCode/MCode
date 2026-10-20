import { WebSocketServer, type WebSocket } from "ws"
import { createServer, type Server } from "node:http"
import { REMOTE_PROTOCOL_PREFIX } from "@shared/socket-auth"
import type { ClientFrame, Request, ServerEvent, ServerFrame } from "@shared/protocol"
import { handle } from "../handlers"
import { sameSecret } from "../socket-guard"
import { isBlockedPort } from "@shared/blocked-ports"
import { frameForWindow } from "../config-view"
import { cockpitHtml } from "./cockpit-html"
import type { Runtime } from "../index"

/** Shells a phone opens are owned by the gateway, not by any window. */
const REMOTE_SHELL_OWNER = { remote: true }

/**
 * MCode Remote's gateway (docs/remote-design.md): a paired phone's window onto
 * this machine.
 *
 * It is just one more Bus subscriber - the same posture the window's own
 * socket takes (see the comment there) - plus a frame buffer so a phone that
 * lost signal resumes by cursor instead of missing what happened. Its own
 * socket never touches the backend's loopback one: the backend keeps speaking
 * only to 127.0.0.1, and the gateway dials nothing - it listens on the
 * address the operator chose and asks for a pairing token in the WebSocket
 * handshake's subprotocol list, the one field a phone can set, never in a
 * URL.
 *
 * Frames a phone sends:
 *  - `{ kind: "request", id, request }` - the same Request union a window
 *    sends, answered by the same `handle`, with the shell owner "remote".
 *  - `{ kind: "remote.resume", cursor }` - replays buffered events after the
 *    cursor; an unknown or too-old cursor is answered with a fresh welcome.
 *  - `{ kind: "remote.ping" }` - answered `{ kind: "remote.pong" }`.
 *
 * Frames a phone receives:
 *  - `{ kind: "remote.welcome", eventId }` - the cursor to resume from.
 *  - `{ kind: "remote.event", eventId, event }` - one Bus event. Terminal
 *    streams (`shell.data`, `shell.exit`) are held back: they belong to the
 *    window that owns the shell, and a phone neither renders nor wants them.
 */

/** Events kept so a reconnecting phone can resume. Oldest dropped past this. */
const BUFFER_LIMIT = 2000

/** Frames a phone may send past the standard request envelope. */
interface RemoteResume {
  kind: "remote.resume"
  cursor: number
}
interface RemotePing {
  kind: "remote.ping"
}
type RemoteClientFrame = ClientFrame | RemoteResume | RemotePing

export interface RemoteGatewayOptions {
  /** The address to bind: "0.0.0.0" for the LAN, loopback for tests. */
  host: string
  /** TCP port; 0 picks a free one. */
  port: number
  /** The pairing token a phone presents in its subprotocol list. */
  token: string
}

export interface RemoteGateway {
  port: number
  close(): Promise<void>
}

interface BufferedEvent {
  eventId: number
  json: string
}

function tokenFromProtocols(protocols: string): string | undefined {
  for (const protocol of protocols.split(",")) {
    const name = protocol.trim()
    if (name.startsWith(REMOTE_PROTOCOL_PREFIX)) return name.slice(REMOTE_PROTOCOL_PREFIX.length)
  }
  return undefined
}

export async function startRemoteGateway(runtime: Runtime, options: RemoteGatewayOptions): Promise<RemoteGateway> {
  if (options.port && isBlockedPort(options.port)) throw new Error(`port ${options.port} is one browsers refuse`)
  if (!options.token) throw new Error("a pairing token is required")

  // The cockpit page (and nothing else): the phone's browser opens it, keeps
  // its token in localStorage, and dials the same port as WebSocket.
  const http: Server = createServer((req, res) => {
    const url = req.url || "/"
    if (url === "/" || url === "/cockpit" || url.startsWith("/cockpit?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(cockpitHtml)
      return
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  })
  const wss = new WebSocketServer({
    server: http,
    // Phones are not browsers: no Origin check. The pairing token is the whole gate.
    verifyClient: ({ req }, done) => {
      const protocols = typeof req.headers["sec-websocket-protocol"] === "string" ? req.headers["sec-websocket-protocol"] : ""
      const offered = tokenFromProtocols(protocols)
      if (offered !== undefined && sameSecret(offered, options.token)) return done(true)
      console.warn(
        `[remote] refused a connection (offered ${offered === undefined ? "no subprotocol" : `token len ${offered.length} prefix ${offered.slice(0, 4)}`}; expected len ${options.token.length})`,
      )
      done(false, 401)
    },
    maxPayload: 8 * 1024 * 1024,
  })

  /** Monotone id of the last event the bus produced since the gateway started. */
  let lastEventId = 0
  /** Recent events, for resume. A phone whose cursor falls out of here re-syncs from a fresh session.list. */
  const buffer: BufferedEvent[] = []

  const unsubscribe = runtime.bus.subscribe((event: ServerEvent) => {
    /*
     * Terminal streams belong to the window that owns the shell. A phone can
     * now open one of its own (the composer's 打开终端), and that one's output
     * is for it - so it goes out live, to every phone, but is never buffered:
     * a resume replays conversation events, and replaying a terminal's whole
     * scrollback into a fresh pane would duplicate what `shell.attach` just
     * gave it.
     */
    if (event.type === "shell.data" || event.type === "shell.exit") {
      if (runtime.shells.ownerOf(event.shellID) !== REMOTE_SHELL_OWNER) return
      lastEventId += 1
      const json = JSON.stringify({ kind: "remote.event", eventId: lastEventId, event })
      for (const client of phones) {
        if (client.readyState === client.OPEN) client.send(json)
      }
      return
    }
    lastEventId += 1
    // Same masking the window gets: no unmasked secrets leave the backend.
    const frame = frameForWindow({ kind: "event", event })
    const json = JSON.stringify({ kind: "remote.event", eventId: lastEventId, event: (frame as { event: ServerEvent }).event })
    buffer.push({ eventId: lastEventId, json })
    if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT)
    const payload = json
    for (const client of phones) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  })

  const phones = new Set<WebSocket>()
  /** Which events each phone has confirmed; used to drop what every phone has seen. */
  const confirmed = new Map<WebSocket, number>()
  /** Drop the buffered events every connected phone has already received. */
  const trimBuffer = () => {
    if (confirmed.size === 0) return
    let min = Infinity
    for (const value of confirmed.values()) min = Math.min(min, value)
    const keep = buffer.findIndex((entry) => entry.eventId > min)
    if (keep > 0) buffer.splice(0, keep)
  }

  wss.on("connection", (socket: WebSocket) => {
    phones.add(socket)
    confirmed.set(socket, lastEventId)
    socket.send(JSON.stringify({ kind: "remote.welcome", eventId: lastEventId }))

    socket.on("error", (error) => console.warn(`[remote] a phone's connection failed: ${error.message}`))
    socket.on("close", () => {
      phones.delete(socket)
      confirmed.delete(socket)
    })

    socket.on("message", async (raw) => {
      let frame: RemoteClientFrame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (frame.kind === "remote.ping") {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ kind: "remote.pong", eventId: lastEventId }))
        return
      }

      if (frame.kind === "remote.resume") {
        const cursor = typeof frame.cursor === "number" && Number.isFinite(frame.cursor) ? frame.cursor : undefined
        if (cursor === undefined || cursor < (buffer.length ? buffer[0].eventId : lastEventId)) {
          // The cursor is older than the buffer holds (or malformed): say so, and the phone re-syncs itself.
          confirmed.set(socket, lastEventId)
          trimBuffer()
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ kind: "remote.resync", eventId: lastEventId }))
          return
        }
        const from = buffer.findIndex((entry) => entry.eventId > cursor)
        if (from >= 0) {
          for (let i = from; i < buffer.length; i++) {
            if (socket.readyState === socket.OPEN) socket.send(buffer[i].json)
          }
        }
        confirmed.set(socket, lastEventId)
        trimBuffer()
        return
      }

      if (frame.kind !== "request") return
      const reply = (body: Record<string, unknown>) => {
        // frameForWindow masks the secrets a response would otherwise carry
        // (config and provider payloads) - a phone gets the same shape a window does.
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frameForWindow(body as ServerFrame)))
      }
      try {
        const request: Request = frame.request
        const data = await handle(runtime, request, REMOTE_SHELL_OWNER)
        reply({ kind: "response", id: frame.id, ok: true, data })
      } catch (err) {
        reply({ kind: "response", id: frame.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  })

  const listenAt = options.host === "loopback" ? "127.0.0.1" : options.host
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject)
    http.listen(options.port, listenAt, () => resolve())
  })
  // Listen succeeded, so the once-reject above is spent; keep a standing
  // handler or a later server error (say EMFILE) would crash the process.
  http.on("error", (error) => console.warn(`[remote] gateway server error: ${error.message}`))
  const address = http.address()
  const boundPort = typeof address === "object" && address ? address.port : options.port

  return {
    port: boundPort,
    async close() {
      unsubscribe()
      for (const client of phones) client.close()
      phones.clear()
      confirmed.clear()
      // A browser keeps keep-alive sockets open, which would hold http.close's
      // callback forever; bound the wait so shutdown cannot hang.
      const bounded = (closing: Promise<void>) => Promise.race([closing, new Promise<void>((resolve) => setTimeout(resolve, 2000))])
      await bounded(new Promise<void>((resolve) => wss.close(() => resolve())))
      http.closeIdleConnections()
      await bounded(new Promise<void>((resolve) => http.close(() => resolve())))
    },
  }
}
