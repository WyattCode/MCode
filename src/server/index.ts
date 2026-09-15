import path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import type { ClientFrame, ServerFrame } from "@shared/protocol"
import { Storage } from "./storage"
import { Bus } from "./bus"
import { Config } from "./config"
import { AuthManager } from "./auth/manager"
import { Permissions } from "./permission"
import { SessionStore } from "./session/store"
import { projectDirectoriesOf } from "@shared/projects"
import { SessionRunner } from "./session/runner"
import { Shells } from "./shell"
import { McpServers } from "./mcp"
import { handle } from "./handlers"
import { bindDesktopSettings } from "./tool/desktop-settings"

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
  close(): Promise<void>
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
  // Hand edits to config.json take effect without reopening the app, as MiMo's do.
  config.watch()
  // The desktop settings tools change settings through this config's own patch path.
  bindDesktopSettings(config)

  const permissions = new Permissions(bus, config)
  const sessions = new SessionStore(storage, bus)
  // Before the socket opens, so the first window already reads a filled project list.
  await config.migrateProjects(projectDirectoriesOf(await sessions.list()))
  const runner = new SessionRunner(sessions, bus, config, permissions, auth, storage)
  const shells = new Shells(bus)
  const mcp = new McpServers(bus, config, storage)
  runner.useMcp(mcp)

  const runtime: Runtime = { storage, bus, config, auth, permissions, sessions, runner, shells, mcp }

  /*
   * Connecting is not awaited: a server that hangs on start would otherwise
   * hold the whole backend, and the window has nothing to show until the
   * socket is up anyway. Status arrives on the bus as each one answers.
   */
  void mcp.sync()

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
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
    async close() {
      await shells.closeAll()
      mcp.close()
      for (const client of clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
