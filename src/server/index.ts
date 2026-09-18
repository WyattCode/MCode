import path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import type { ClientFrame, ServerFrame } from "@shared/protocol"
import { narrowcastSession } from "@shared/protocol"
import { codeOf, paramsOf } from "@shared/errors"
import { Storage } from "./storage"
import { Bus } from "./bus"
import { Config } from "./config"
import { AuthManager } from "./auth/manager"
import { Permissions } from "./permission"
import { SessionStore } from "./session/store"
import { migrateCheckpoints } from "./session/checkpoint-migrate"
import { ArtifactStore } from "./artifact/store"
import { readStorageLayout } from "./storage-layout"
import { projectDirectoriesOf } from "@shared/projects"
import { SessionRunner } from "./session/runner"
import { Shells } from "./shell"
import { stopBashCommands } from "./tool/bash"
import { McpServers } from "./mcp"
import { createSampler } from "./mcp-sampling"
import { handle } from "./handlers"
import { onGitWaiting } from "./git-queue"
import { bindDesktopSettings } from "./tool/desktop-settings"
import { bindMemoryWrites, startHistory, stopHistory } from "./history/service"
import { migrateMemoryLayout } from "./memory/migrate"
import { watchSkillProblems } from "./skill"
import { startScheduler } from "./cron/start"
import { startAutomations } from "./automation/start"
import { protectAppData } from "./tool/app-data"
import { frameForWindow } from "./config-view"
import { newSocketSecret, refusalOf, SOCKET_PROTOCOL } from "./socket-guard"
import { ModelCatalog, shippedCatalog } from "./provider/models-dev"

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
  /** This launch's socket secret; handed only to the app's own window, never logged. */
  secret: string
  close(): Promise<void>
}

/** The largest frame a window may send (N11-38): well above any attachment the tools take, below a size that would stall the thread parsing it. */
export const MAX_FRAME_BYTES = 100 * 1024 * 1024

export interface BackendOptions {
  /** Browser origins allowed to connect: the renderer page's own. None means only non-browser clients. */
  origins?: readonly string[]
}

/**
 * Boots the backend and binds it to a loopback WebSocket.
 *
 * Port 0 lets the OS pick a free port, which is then handed to the renderer
 * through the preload bridge - nothing is hardcoded, so several instances can
 * run side by side. The socket is bound to 127.0.0.1 only: this speaks for the
 * user's filesystem and must never be reachable from the network.
 */
export async function startBackend(dataDirectory: string, options: BackendOptions = {}): Promise<Backend> {
  const storage = new Storage(path.join(dataDirectory, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(dataDirectory, "credentials.json"))
  const auth = new AuthManager(config, bus)
  await config.load()
  // The model's file tools never write here: config.json there decides what starts at launch.
  protectAppData(dataDirectory)
  // Hand edits to config.json take effect without reopening the app, as MiMo's do.
  config.watch()
  // The desktop settings tools change settings through this config's own patch path.
  bindDesktopSettings(config)

  const permissions = new Permissions(bus, config)
  // The "always" approvals this profile has remembered, so a restart does not ask again.
  await permissions.load(storage)
  const sessions = new SessionStore(storage, bus)
  // Full access turned off by hand in config.json takes conversations off it at once, as the settings switch does.
  config.onReload(async (before, after) => {
    if (before.allowFullAccess && !after.allowFullAccess) await sessions.dropFullAccess()
  })
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
  await config.migrateRepositoryProjects()
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
  // A written or removed message may change what its conversation produced; the next listing reads it again.
  const unwatchArtifacts = sessions.watch((change) => {
    if (change.type === "message") artifacts?.touched(change.message.sessionID)
    else if (change.type === "message.removed") artifacts?.touched(change.sessionID)
  })
  void (async () => {
    try {
      /*
       * Which build's layout this profile holds. Read before anything is
       * migrated: a profile written by a newer build is left exactly as it is,
       * since this build cannot know what its documents mean.
       */
      const layout = await readStorageLayout(storage)
      if (layout.fromNewerVersion) return
      // memory: project memory moves to its repository's folder, once, with the old layout backed up.
      await config.migrateMemory(
        (await sessions.list()).map((session) => session.directory),
        (directories) => migrateMemoryLayout({ dataDirectory, directories }),
      )
      await migrateCheckpoints(storage, runner.checkpoints, config)
      await runner.checkpoints.sweep((await sessions.list()).map((session) => session.directory))
      // Temp files a killed write of an earlier run left in the storage folder (N11-30).
      const swept = await storage.sweepTemps()
      if (swept) console.info(`[storage] removed ${swept} temp file(s) an earlier run left behind`)
      // Brings the store up to date with the transcripts and re-checks what is still on disk.
      await artifacts?.reconcile(await sessions.list(), (id) => sessions.messages(id))
    } catch {
      // Housekeeping must never be the reason the app fails to open.
    }
  })()
  // history: the search index beside the store, filled in the background.
  const history = startHistory(dataDirectory, sessions, storage, bus)
  // skills: a SKILL.md that will not parse is said in the window, once per file, as MiMo reports one.
  watchSkillProblems((problem) => bus.publish({ type: "skill.problem", path: problem.path, message: problem.message }))
  // memory: config's memory.disableWrite, read at every write so a hand edit takes effect at once.
  bindMemoryWrites(() => config.get().memory?.disableWrite !== true)
  // cron: scheduled prompts fire into their conversations while the app runs.
  const scheduler = startScheduler(runner, sessions, config, bus)
  // automation: MiMo's scheduled tasks, kept in the data folder and run while the app is open.
  const automations = startAutomations(dataDirectory, runner, sessions, config, bus)
  /*
   * The models.dev catalog: the shipped copy (or a recent download) as soon as
   * it is read, then MiMo's refresh - now if the download is over five
   * minutes old, and hourly after. The window hears about what changes.
   */
  const catalog = new ModelCatalog({
    cacheFile: path.join(dataDirectory, "cache", "models.json"),
    shipped: shippedCatalog,
    source: process.env.MCODE_MODELS_URL || undefined,
    disabled: () => Boolean(process.env.MCODE_DISABLE_MODELS_FETCH),
    onError: (error) => console.warn("[models.dev] refresh failed:", error instanceof Error ? error.message : error),
  })
  catalog.subscribe(() => {
    config.useModelCatalog(catalog.get())
    bus.publish({ type: "providers.updated", providers: config.providers() })
  })
  let catalogClosed = false
  void catalog.load().then(() => {
    if (catalogClosed) return
    if (Object.keys(catalog.get()).length) {
      config.useModelCatalog(catalog.get())
      bus.publish({ type: "providers.updated", providers: config.providers() })
    }
    catalog.startRefresh()
  })

  const shells = new Shells(bus)
  const mcp = new McpServers(bus, config, storage)
  mcp.useSampling(createSampler({ config, auth, permissions }))
  runner.useMcp(mcp)
  mcp.useBusy(() => runner.busySessions().length > 0)
  mcp.useBusyDirectories(() => runner.busyDirectories())

  const runtime: Runtime = { storage, bus, config, auth, permissions, sessions, runner, shells, mcp, artifacts }

  /*
   * Connecting is not awaited: a server that hangs on start would otherwise
   * hold the whole backend, and the window has nothing to show until the
   * socket is up anyway. Status arrives on the bus as each one answers.
   */
  void mcp.start()

  /*
   * Bound to loopback, and still not open to whatever reaches loopback: every
   * handshake has to name this port, come from the app's own page (or from no
   * page at all) and carry this launch's secret. See socket-guard.ts.
   */
  const secret = newSocketSecret()
  let port = 0
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ req }, done) => {
      const origin = req.headers.origin
      const protocols = req.headers["sec-websocket-protocol"]
      const refusal = refusalOf(
        {
          host: req.headers.host,
          origin: typeof origin === "string" ? origin : undefined,
          protocols: typeof protocols === "string" ? protocols : undefined,
        },
        { port, secret, origins: options.origins ?? [] },
      )
      if (!refusal) return done(true)
      // The reason and the origin only; the offered protocols may hold a guess at the secret.
      console.warn(`[socket] refused a connection (${refusal}${refusal === "origin" ? `: ${String(origin)}` : ""})`)
      done(false, refusal === "secret" ? 401 : 403)
    },
    // The plain name is chosen, so the one carrying the secret is never sent back.
    handleProtocols: (protocols) => (protocols.has(SOCKET_PROTOCOL) ? SOCKET_PROTOCOL : false),
    /*
     * Stated rather than left to the library's default (N11-38). A frame from
     * the window past this - a request carrying attachments far beyond what
     * any tool accepts - closes the socket with 1009, and that is logged with
     * its reason below instead of being an unexplained reconnect.
     */
    maxPayload: MAX_FRAME_BYTES,
  })
  const clients = new Set<WebSocket>()
  // A git write queued behind another on the same repository says so, and the window shows it waiting (N11-14).
  onGitWaiting((directory, waiting) => bus.publish({ type: "git.waiting", directory, waiting }))

  /**
   * Which conversations each window is drawing, as it last said (N11-4).
   *
   * A window that has said nothing gets everything, which is what the checks
   * and any other client see.
   */
  const watching = new Map<WebSocket, Set<string>>()

  bus.subscribe((event) => {
    // Settings leave with their secrets masked (config-view.ts).
    const frame = frameForWindow({ kind: "event", event })
    const payload = JSON.stringify(frame)
    const only = narrowcastSession(event)
    /*
     * A terminal's output is for the window that owns it (N11-31). Every other
     * window used to receive it too, which was the whole terminal's contents
     * travelling to a window that never asked for it.
     */
    const shellOwner = event.type === "shell.data" || event.type === "shell.exit" ? shells.ownerOf(event.shellID) : undefined
    for (const client of clients) {
      if (client.readyState !== client.OPEN) continue
      if (shellOwner && shellOwner !== client) continue
      if (only !== undefined) {
        const declared = watching.get(client)
        if (declared && !declared.has(only)) continue
      }
      client.send(payload)
    }
  })

  /** A window saying which conversations it is drawing; see protocol's session.watch. */
  const watch = (socket: WebSocket, sessionIDs: readonly string[]) => {
    watching.set(socket, new Set(sessionIDs))
  }

  server.on("connection", (socket) => {
    clients.add(socket)
    socket.on("error", (error) => console.warn(`[socket] a window's connection failed: ${error.message}`))
    socket.on("close", () => {
      clients.delete(socket)
      watching.delete(socket)
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
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frameForWindow(response)))
      }

      try {
        if (frame.request.type === "session.watch") {
          watch(socket, frame.request.sessionIDs)
          reply({ kind: "response", id: frame.id, ok: true, data: {} })
          return
        }
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
          ...(paramsOf(err) ? { errorParams: paramsOf(err) } : {}),
        })
      }
    })
  })

  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  port = typeof address === "object" && address ? address.port : 0

  return {
    runtime,
    port,
    secret,
    async close() {
      // The model's own commands go with the terminals: both are children this
      // process started, and neither has a window left to stop it.
      stopBashCommands()
      catalogClosed = true
      catalog.stop()
      await shells.closeAll()
      await mcp.close()
      await scheduler.stop()
      await automations.stop()
      stopHistory(history)
      watchSkillProblems(undefined)
      unwatchArtifacts()
      artifacts?.close()
      for (const client of clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
