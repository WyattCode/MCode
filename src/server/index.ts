import { createServer, type Server } from "node:http"
import path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import type { ClientFrame, ServerFrame } from "@shared/protocol"
import { narrowcastSession } from "@shared/protocol"
import { codeOf, paramsOf } from "@shared/errors"
import { isBlockedPort } from "@shared/blocked-ports"
import { Storage, pruneQuarantined } from "./storage"
import { Bus } from "./bus"
import { Config } from "./config"
import type { SecretBox } from "./credential-file"
import { AuthManager } from "./auth/manager"
import { Permissions } from "./permission"
import { SessionStore } from "./session/store"
import { migrateCheckpoints } from "./session/checkpoint-migrate"
import { CHECKPOINT_PACK_EVERY_MS, CHECKPOINT_PACK_FIRST_MS } from "./session/snapshot"
import { ARTIFACT_SETTLE_MS, ArtifactStore } from "./artifact/store"
import { readStorageLayout } from "./storage-layout"
import { projectDirectoriesOf } from "@shared/projects"
import { Lab } from "./lab"
import { SessionRunner } from "./session/runner"
import { Shells } from "./shell"
import { stopBashCommands, prewarmBashShell } from "./tool/bash"
import { McpServers } from "./mcp"
import { createSampler } from "./mcp-sampling"
import { handle } from "./handlers"
import { onGitWaiting } from "./git-queue"
import { bindDesktopSettings } from "./tool/desktop-settings"
import { bindMemoryWrites, startHistory, stopHistory } from "./history/service"
import { migrateMemoryLayout } from "./memory/migrate"
import { pruneSkillTrash, watchSkillProblems } from "./skill"
import { startScheduler } from "./cron/start"
import { startAutomations } from "./automation/start"
import { protectAppData } from "./tool/app-data"
import { frameForWindow } from "./config-view"
import { newSocketSecret, refusalOf, SOCKET_PROTOCOL } from "./socket-guard"
import { ModelCatalog, shippedCatalog } from "./provider/models-dev"
import { closeAllApps, closeAppOf } from "./tool/app"
import { stopLookout } from "./appdrive/windows"

export interface Runtime {
  storage: Storage
  bus: Bus
  config: Config
  auth: AuthManager
  permissions: Permissions
  sessions: SessionStore
  runner: SessionRunner
  lab?: Lab
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
  /** The system's secure storage for the saved keys (L12-3); the desktop app passes Electron's safeStorage. */
  secrets?: SecretBox
  /** The installed application directory; omitted for development builds. */
  installationDirectory?: string
}

/** How many ports the system is asked for before the backend gives up on one a browser accepts. */
const LISTEN_ATTEMPTS = 20

/**
 * Listens on a free port the window is allowed to connect to: port 0, closed
 * and asked for again while the system's answer is one a browser refuses
 * (blocked-ports.ts). The port is the server's own from the start, so nothing
 * can take it between choosing and listening; the tries are bounded, and a
 * listen that fails rejects instead of leaving the start waiting.
 */
export async function listenForWindow(server: Server, host: string, refused: (port: number) => boolean = isBlockedPort, attempts = LISTEN_ATTEMPTS): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.off("listening", listening)
        reject(error)
      }
      const listening = () => {
        server.off("error", failed)
        resolve()
      }
      server.once("error", failed)
      server.once("listening", listening)
      server.listen(0, host)
    })
    const bound = server.address()
    const port = typeof bound === "object" && bound ? bound.port : 0
    if (port && !refused(port)) return port
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  throw new Error(`no port a browser accepts after ${attempts} tries`)
}

/**
 * Boots the backend and binds it to a loopback WebSocket.
 *
 * The OS picks a free port (one a browser does not refuse, listenForWindow), which
 * is then handed to the renderer through the preload bridge - nothing is hardcoded, so several instances can
 * run side by side. The socket is bound to 127.0.0.1 only: this speaks for the
 * user's filesystem and must never be reachable from the network.
 */
export async function startBackend(dataDirectory: string, options: BackendOptions = {}): Promise<Backend> {
  const storage = new Storage(path.join(dataDirectory, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(dataDirectory, "credentials.json"), options.secrets, options.installationDirectory)
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
  // Plain-text keys are encrypted once the system can (L12-3); a failure is kept plain and tried next launch.
  await config.migrateCredentials()
  const runner = new SessionRunner(sessions, bus, config, permissions, auth, storage)
  /*
   * Undo's own housekeeping, in the background so the window is not held up by
   * it: an existing profile's inline undo bodies move into the projects'
   * checkpoint stores, and stores belonging to no conversation any more are
   * swept. Both are safe to run at every launch - the first only converts what
   * is still in the old shape, the second only removes what nothing names.
   */
  // Produced files, kept in a store of their own so they outlive their conversations.
  const artifacts = await ArtifactStore.open(path.join(dataDirectory, "storage", "artifacts.db"))
  /*
   * A written or removed message may change what its conversation produced.
   * The conversation is marked, and read again once its writes have paused -
   * MiMo's reconcile when a conversation settles (S13-3) - so a listing
   * seldom has anything left to read first.
   */
  let settleArtifacts: ReturnType<typeof setTimeout> | undefined
  const unwatchArtifacts = sessions.watch((change) => {
    if (change.type !== "message" && change.type !== "message.removed") return
    artifacts?.touched(change.type === "message" ? change.message.sessionID : change.sessionID)
    if (!artifacts) return
    if (settleArtifacts) clearTimeout(settleArtifacts)
    settleArtifacts = setTimeout(() => {
      settleArtifacts = undefined
      void sessions
        .list()
        .then((listed) => artifacts.reconcile(listed, (id) => sessions.messages(id)))
        .catch(() => undefined)
    }, ARTIFACT_SETTLE_MS)
    settleArtifacts.unref?.()
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
      /*
       * Turns the app was cut off in the middle of - a crash, a kill, a quit -
       * carry on, as OpenCode v2's server does at boot. After the checkpoint
       * migration, which the carried-on turn's undo records rely on.
       */
      const carried = await runner.resumeClaimed()
      if (carried.length) console.info(`[restart] carried on ${carried.length} turn(s) the app was cut off in`)
      /*
       * Conversations whose record would not read still own their stores
       * (L12-11) - and the list is read from disk again first.
       *
       * This pass deletes every store the list does not name, and the list it
       * had was this process's cache, filled at start-up and patched only by
       * this process's own writes. Another instance sharing the data directory
       * could open a conversation in a new project during the minutes this
       * housekeeping takes, and its whole checkpoint store - the bodies behind
       * every 撤销 in that conversation - was deleted here without a word
       * (R26-B1).
       */
      await runner.checkpoints.sweep(
        [...(await sessions.listFresh()).map((session) => session.directory), ...(await sessions.unreadableDirectories())],
        await sessions.unreadable(),
      )
      // Temp files a killed write of an earlier run left in the storage folder (N11-30).
      const swept = await storage.sweepTemps()
      if (swept) console.info(`[storage] removed ${swept} temp file(s) an earlier run left behind`)
      // Quarantined copies over 30 days old, beside every store; the newest of each document stays (L12-15).
      const pruned =
        (await pruneQuarantined(storage.directory, { recursive: true })) +
        (await pruneQuarantined(path.join(dataDirectory, "index"))) +
        (await pruneQuarantined(dataDirectory))
      if (pruned) console.info(`[storage] removed ${pruned} quarantined file(s) older than 30 days`)
      // Brings the store up to date with the transcripts and re-checks what is still on disk.
      await artifacts?.reconcile(await sessions.listFresh(), (id) => sessions.messages(id), { recheck: true })
      // What conversations gone without a word left in the artifact list goes too, as a delete takes it (the unreadable keep theirs).
      const forgotten = await artifacts?.forgetMissing(new Set([...(await sessions.listFresh()).map((session) => session.id), ...(await sessions.unreadable())]))
      if (forgotten) console.info(`[artifacts] forgot what ${forgotten} deleted conversation(s) left in the list`)
    } catch {
      // Housekeeping must never be the reason the app fails to open.
    }
  })()
  /*
   * Undo's checkpoint stores, packed a minute after start and hourly after, as
   * MiMo schedules its snapshot cleanup (L12-13) - never pruned, and never
   * holding the process open. Every live conversation's folder, unreadable
   * ones included.
   */
  let packing = false
  const packStores = async () => {
    if (packing) return
    packing = true
    try {
      const live = [...(await sessions.list()).map((session) => session.directory), ...(await sessions.unreadableDirectories())]
      const packed = await runner.checkpoints.pack(live)
      if (packed) console.info(`[snapshot] packed ${packed} checkpoint store(s)`)
    } catch {
      // Tried again next hour.
    } finally {
      packing = false
    }
  }
  let packEvery: ReturnType<typeof setInterval> | undefined
  const packFirst = setTimeout(() => {
    void packStores()
    packEvery = setInterval(() => void packStores(), CHECKPOINT_PACK_EVERY_MS)
    packEvery.unref?.()
  }, CHECKPOINT_PACK_FIRST_MS)
  packFirst.unref?.()
  // usage: the daily totals the usage page reads, built once from the transcripts if missing and kept up after each step.
  runner.usageDays.start()
  // history: the search index beside the store, filled in the background.
  const history = await startHistory(dataDirectory, sessions, storage, bus)
  // skills: uninstalled skills older than a week leave the trash, as MiMo's start-up sweep removes its own (L12-12).
  void pruneSkillTrash(storage.directory).then((removed) => {
    if (removed) console.info(`[skills] removed ${removed} uninstalled skill(s) older than a week from the trash`)
  }).catch((error) => console.warn(`[skills] the trash sweep failed: ${error instanceof Error ? error.message : String(error)}`))
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

  const runtime: Runtime = { storage, bus, config, auth, permissions, sessions, runner, shells, mcp, artifacts, lab: new Lab(storage, runner) }

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
  // Never one of the ports the window's own WebSocket would be refused on (blocked-ports.ts).
  const http = createServer()
  const port = await listenForWindow(http, "127.0.0.1")
  const server = new WebSocketServer({
    server: http,
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
  /* The artifacts page fills in while it is open, rather than only while the store is being built (R21-F4-35). */
  const unwatchArtifactChanges = artifacts?.onChanged((revision) => bus.publish({ type: "artifact.changed", revision }))

  /**
   * Which conversations each window is drawing, as it last said (N11-4).
   *
   * A window that has said nothing gets everything, which is what the checks
   * and any other client see.
   */
  const watching = new Map<WebSocket, Set<string>>()

  // A deleted conversation's app goes with it: the browser or program the app tool opened for it closes, an attached app is let go.
  bus.subscribe((event) => {
    if (event.type === "session.deleted") void closeAppOf(event.sessionID)
  })

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
      runtime.runner.releaseQueueEdits(socket)
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
        const data = await handle(runtime, frame.request, socket, (event) => reply({ kind: "event", event }))
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

  // The listening server's own errors reach the socket server; said here rather than thrown as unhandled.
  server.on("error", (error) => console.warn(`[socket] the window's socket failed: ${error.message}`))

  // Windows PowerShell cold start (~10–20s) paid here so the first bash tool call is warm (HANDOFF 续九).
  prewarmBashShell(config.get().shell)

  return {
    runtime,
    port,
    secret,
    async close() {
      // First: a turn the quit cuts off keeps its claim, so the next start carries it on.
      runner.closeTurns()
      const labClosed = runtime.lab?.close()
      // The model's own commands go with the terminals: both are children this
      // process started, and neither has a window left to stop it.
      stopBashCommands()
      catalogClosed = true
      catalog.stop()
      clearTimeout(packFirst)
      if (packEvery) clearInterval(packEvery)
      await Promise.all([shells.closeAll(), labClosed])
      // The browsers the app tool opened close with the app; apps it attached to are only let go.
      await closeAllApps()
      // And the one that watches shell commands for windows they opened.
      await stopLookout()
      await mcp.close()
      await scheduler.stop()
      await automations.stop()
      await stopHistory(history)
      await runner.usageDays.stop()
      watchSkillProblems(undefined)
      unwatchArtifacts()
      if (settleArtifacts) clearTimeout(settleArtifacts)
      unwatchArtifactChanges?.()
      await artifacts?.close()
      for (const client of clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
      /*
       * Last, so what the steps above saved is included (L12-6): an approval
       * or a setting made just before quit reaches the disk before the
       * process ends. Inside the main process's five-second bound on close.
       */
      await permissions.flush()
      config.unwatch()
      await config.drain()
      await storage.drain()
    },
  }
}
