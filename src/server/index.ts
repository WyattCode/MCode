import path from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { WebSocketServer, type WebSocket } from "ws"
import type { ClientFrame, ServerFrame } from "@shared/protocol"
import { Storage } from "./storage"
import { Bus } from "./bus"
import { Config } from "./config"
import { AuthManager } from "./auth/manager"
import { Permissions } from "./permission"
import { SessionStore } from "./session/store"
import { SessionRunner } from "./session/runner"
import { Shells } from "./shell"
import { McpServers } from "./mcp"
import { handle } from "./handlers"

export interface Runtime {
  storage: Storage
  bus: Bus
  config: Config
  auth: AuthManager
  permissions: Permissions
  sessions: SessionStore
  runner: SessionRunner
  shells: Shells
  mcp: McpServers
}

export interface Backend {
  runtime: Runtime
  port: number
  /** Handed to the renderer over the preload bridge; see the note on auth below. */
  token: string
  close(): Promise<void>
}

/** Constant-time compare, so the token cannot be recovered a character at a time. */
function sameToken(offered: string, expected: string): boolean {
  const a = Buffer.from(offered)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Whether an Origin header could only have come from a web page.
 *
 * The renderer loads over file:// (or the dev server in development), so an
 * http(s) origin that is not the dev server is a page in a browser. The token
 * already stops it; this refuses the handshake before it is even considered.
 */
function foreignOrigin(origin: string | undefined): boolean {
  if (!origin || origin === "null" || origin.startsWith("file://")) return false
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) {
    try {
      if (origin === new URL(dev).origin) return false
    } catch {
      // A malformed dev URL is not a reason to admit the origin.
    }
  }
  return true
}

/**
 * Boots the backend and binds it to a loopback WebSocket.
 *
 * Port 0 lets the OS pick a free port, which is then handed to the renderer
 * through the preload bridge - nothing is hardcoded, so several instances can
 * run side by side. The socket is bound to 127.0.0.1 only: this speaks for the
 * user's filesystem and must never be reachable from the network.
 */
export async function startBackend(dataDirectory: string): Promise<Backend> {
  const storage = new Storage(path.join(dataDirectory, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(dataDirectory, "credentials.json"))
  const auth = new AuthManager(config, bus)
  await config.load()

  const permissions = new Permissions(bus, config)
  const sessions = new SessionStore(storage, bus)
  const runner = new SessionRunner(sessions, bus, config, permissions, auth, storage)
  const shells = new Shells(bus)
  const mcp = new McpServers(bus, config)
  runner.useMcp(mcp)

  const runtime: Runtime = { storage, bus, config, auth, permissions, sessions, runner, shells, mcp }

  /*
   * Connecting is not awaited: a server that hangs on start would otherwise
   * hold the whole backend, and the window has nothing to show until the
   * socket is up anyway. Status arrives on the bus as each one answers.
   */
  void mcp.sync()

  /*
   * Loopback is not, on its own, a boundary. A browser may open a WebSocket to
   * any origin without a preflight, and a page that guesses the port can reach
   * everything behind this socket - reading files, opening a shell, running
   * commands. So every connection must present a secret this process generates
   * at startup and only ever hands to its own renderer. It travels as a
   * subprotocol rather than in the URL: browsers cannot set request headers on
   * a WebSocket, and a query string ends up in logs and error reports.
   */
  const token = randomBytes(32).toString("hex")

  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ origin, req }, done) => {
      if (foreignOrigin(origin)) return done(false, 403, "Forbidden")
      const offered = String(req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((entry) => entry.trim())
      if (!offered.some((entry) => sameToken(entry, token))) return done(false, 401, "Unauthorized")
      done(true)
    },
    // Echoed back so the browser's handshake completes; the client already
    // knows it, so returning it tells an attacker nothing.
    handleProtocols: (protocols) => (protocols.has(token) ? token : false),
  })
  const clients = new Set<WebSocket>()

  bus.subscribe((event) => {
    const frame: ServerFrame = { kind: "event", event }
    const payload = JSON.stringify(frame)
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  })

  server.on("connection", (socket) => {
    clients.add(socket)
    socket.on("close", () => {
      clients.delete(socket)
      /*
       * A window that reloads never unmounts its terminal panes, so nothing on
       * that side closes their shells - the socket simply goes away. Sweeping
       * here is what keeps a reader who reloads from accumulating one orphaned
       * shell per terminal, running until the app quits.
       */
      shells.closeOwnedBy(socket)
    })

    /*
     * A permission request outlives the window that was asked. Closing a window
     * mid-prompt used to strand the tool on a promise nothing could settle: the
     * session stayed busy for the life of the process and refused every later
     * message. Replaying what is still parked lets a reopened window answer it.
     */
    for (const request of permissions.outstanding()) {
      const frame: ServerFrame = { kind: "event", event: { type: "permission.requested", request } }
      socket.send(JSON.stringify(frame))
    }

    socket.on("message", async (raw) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (frame.kind !== "request") return

      const reply = (response: ServerFrame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(response))
      }

      try {
        const data = await handle(runtime, frame.request, socket)
        reply({ kind: "response", id: frame.id, ok: true, data })
      } catch (err) {
        reply({
          kind: "response",
          id: frame.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  })

  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0

  return {
    runtime,
    port,
    token,
    async close() {
      shells.closeAll()
      mcp.close()
      for (const client of clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
