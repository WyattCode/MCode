import path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import type { ClientFrame, ServerFrame } from "@shared/protocol"
import { codeOf } from "@shared/errors"
import { Storage } from "./storage"
import { Bus } from "./bus"
import { Config } from "./config"
import { AuthManager } from "./auth/manager"
import { Permissions } from "./permission"
import { SessionStore } from "./session/store"
import { migrateCheckpoints } from "./session/checkpoint-migrate"
import { ArtifactStore } from "./artifact/store"
import { projectDirectoriesOf } from "@shared/projects"
import { SessionRunner } from "./session/runner"
import { Shells } from "./shell"
import { stopBashCommands } from "./tool/bash"
import { McpServers } from "./mcp"
import { createSampler } from "./mcp-sampling"
import { handle } from "./handlers"
import { bindDesktopSettings } from "./tool/desktop-settings"
import { startHistory, stopHistory } from "./history/service"
import { startScheduler } from "./cron/start"
import { startAutomations } from "./automation/start"

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
  /** Produced files, kept rather than worked out again; absent if the store could not be opened. */
  artifacts?: ArtifactStore
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
  // The "always" approvals this profile has remembered, so a restart does not ask again.
  await permissions.load(storage)
  const sessions = new SessionStore(storage, bus)
  // Each conversation's own access level; a side chat or subagent runs at the level of the conversation it belongs to.
  permissions.useSessions(async (sessionID) => {
    let session = await sessions.get(sessionID)
    for (let depth = 0; session && depth < 5; depth++) {
      const owner = session.parentID ?? session.sideOf
      if (!owner) break
      session = await sessions.get(owner)
    }
    return session?.access
  })
  // Before the socket opens, so the first window already reads a filled project list.
  await config.migrateProjects(projectDirectoriesOf(await sessions.list()))
  const runner = new SessionRunner(sessions, bus, config, permissions, auth, storage)
  /*
   * Undo's own housekeeping, in the background so the window is not held up by
   * it: an existing profile's inline undo bodies move into the projects'
   * checkpoint stores, and stores belonging to no conversation any more are
   * swept. Both are safe to run at every launch - the first only converts what
   * is still in the old shape, the second only removes what nothing names.
   */
  // Produced files, kept in a store of their own so they outlive their conversations.
  const artifacts = ArtifactStore.open(path.join(dataDirectory, "storage", "artifacts.db"))
  void (async () => {
    try {
      await migrateCheckpoints(storage, runner.checkpoints, config)
      await runner.checkpoints.sweep((await sessions.list()).map((session) => session.directory))
      // Brings the store up to date with the transcripts and re-checks what is still on disk.
      await artifacts?.reconcile(await sessions.list(), (id) => sessions.messages(id))
    } catch {
      // Housekeeping must never be the reason the app fails to open.
    }
  })()
  // history: the search index beside the store, filled in the background.
  const history = startHistory(dataDirectory, sessions, storage, bus)
  // cron: scheduled prompts fire into their conversations while the app runs.
  const scheduler = startScheduler(runner, sessions, config, bus)
  // automation: MiMo's scheduled tasks, kept in the data folder and run while the app is open.
  const automations = startAutomations(dataDirectory, runner, sessions, config, bus)
  const shells = new Shells(bus)
  const mcp = new McpServers(bus, config, storage)
  mcp.useSampling(createSampler({ config, auth, permissions }))
  runner.useMcp(mcp)

  const runtime: Runtime = { storage, bus, config, auth, permissions, sessions, runner, shells, mcp, artifacts }

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
          // Named where it can be, so the window says it in the reader's language.
          ...(codeOf(err) ? { errorCode: codeOf(err) } : {}),
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
      // The model's own commands go with the terminals: both are children this
      // process started, and neither has a window left to stop it.
      stopBashCommands()
      await shells.closeAll()
      mcp.close()
      await scheduler.stop()
      await automations.stop()
      stopHistory(history)
      artifacts?.close()
      for (const client of clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
