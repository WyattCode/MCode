import { defineStore } from "pinia"
import { computed, reactive, ref, shallowRef, watch } from "vue"
import type { Attachment, AgentName,
  AppConfig,
  AuthMethodKind,
  AssistantMessage,
  CommandInfo,
  CustomModel,
  Effort,
  McpServerState,
  Message,
  ModelRef,
  PermissionRequest,
  PermissionResponse,
  ProviderStatus,
  ServerEvent,
  SessionInfo,
} from "@shared/protocol"
import { Client } from "../lib/client"
import { t } from "../lib/i18n"
import { notify, notifyFailure } from "../lib/toast"

/** One reviewer's remark, against a file and a line in its diff. */
export interface ReviewNote {
  id: string
  file: string
  line: number
  text: string
  created: number
}

export const useApp = defineStore("app", () => {
  const client = shallowRef<Client>()
  const connected = ref(false)
  /** Down long enough to be worth saying so, rather than mid-restart. */
  const offline = ref(false)
  let offlineTimer: ReturnType<typeof setTimeout> | undefined
  const platform = ref("")
  const version = ref("")
  /** Loopback port the agent server bound to; shown in the server popover. */
  const port = ref(0)

  const sessions = ref<SessionInfo[]>([])
  const currentID = ref<string>()
  const messages = ref<Message[]>([])
  /**
   * Sessions with a turn in flight.
   *
   * A turn belongs to its session, not to the window, so this is keyed by id -
   * and cleared by the id the event names rather than the one on screen, which
   * may have moved on by the time the turn ends.
   */
  const running = ref(new Set<string>())
  /*
   * When each running turn began, as far as this window saw it, and the last
   * turn to end on its own with how long it took - which is what decides
   * whether it was long enough to chime for. A stopped or failed turn is
   * dropped from the clock rather than reported.
   */
  const turnStarted = new Map<string, number>()
  const finished = ref<{ sessionID: string; elapsed: number }>()

  /** Starts the clock on turns not seen beginning, and forgets the ones no longer running. */
  function clockTurns(ids: Iterable<string>) {
    const now = Date.now()
    const live = new Set(ids)
    for (const id of live) if (!turnStarted.has(id)) turnStarted.set(id, now)
    for (const id of [...turnStarted.keys()]) if (!live.has(id)) turnStarted.delete(id)
  }
  const busy = computed(() => (currentID.value ? running.value.has(currentID.value) : false))
  /** Sessions whose transcript is being summarised right now. */
  const summarising = ref(new Set<string>())
  /**
   * Whether this session is being summarised.
   *
   * Its own flag rather than part of `busy`, because the transcript has to
   * say something during a compaction that follows a refusal - and a
   * refusal is exactly when it would otherwise say nothing at all.
   */
  const compacting = computed(() => (currentID.value ? summarising.value.has(currentID.value) : false))
  const error = ref<string>()

  /*
   * Side chats: conversations started beside the open one, in the side column.
   * They are kept apart from `sessions` so that no list - the side column, the
   * tabs, the palette, the home screen - ever shows one, and they carry their
   * own transcript so the open conversation and the side chat never share one.
   */
  const sideSessions = ref<SessionInfo[]>([])
  const sideID = ref<string>()
  const sideMessages = ref<Message[]>([])
  const sideError = ref<string>()
  const sidePartIndex = new Map<string, { messageID: string; index: number }>()
  const side = computed(() => sideSessions.value.find((session) => session.id === sideID.value))
  const sideBusy = computed(() => (sideID.value ? running.value.has(sideID.value) : false))

  const config = ref<AppConfig>()
  const providers = ref<ProviderStatus[]>([])
  /**
   * The commands a slash can reach that this window did not define.
   *
   * The reference keeps the same list beside its own UI commands and merges the
   * two in the composer (main-8t-QUXax.js @4533850, `[...custom, ...builtin]`),
   * which is why they are kept apart here too: an entry from a project's files,
   * an MCP prompt or a skill is typed and templated, while a UI command is
   * chosen and run.
   *
   * It lives on the store rather than in the composer because the composer is
   * unmounted on the home screen and rebuilt per session, and re-asking the
   * server on every mount would put a round trip in front of the first slash.
   */
  const commands = ref<CommandInfo[]>([])
  /**
   * Permission requests waiting on an answer, by session.
   *
   * Kept for every session rather than only the one on screen: a background
   * conversation blocked on approval used to be invisible, which looked like
   * the model had simply stopped.
   */
  const pendingPermissions = ref(new Map<string, PermissionRequest>())
  const permission = computed(() =>
    currentID.value ? pendingPermissions.value.get(currentID.value) : undefined,
  )

  /**
   * Sessions that finished a turn while the user was looking elsewhere.
   *
   * Cleared by opening the session, which is what "read" means here - there is
   * no per-message tracking, because the question a tab has to answer is only
   * "did something happen while I was away".
   */
  const unseen = ref(new Set<string>())

  /**
   * The last failure per session, kept for every session rather than only the
   * one on screen. A turn that fails while you are reading somewhere else has
   * to still be findable when you come back to it.
   */
  const sessionErrors = ref(new Map<string, string>())

  function noteError(sessionID: string, reason: string | undefined) {
    const next = new Map(sessionErrors.value)
    if (reason) next.set(sessionID, reason)
    else next.delete(sessionID)
    sessionErrors.value = next
  }

  /** Whether a session is asking for attention, for the dot on its tab. */
  function unread(sessionID: string): boolean {
    return (
      pendingPermissions.value.has(sessionID) ||
      sessionErrors.value.has(sessionID) ||
      unseen.value.has(sessionID)
    )
  }

  /**
   * Clears every "something happened here" mark at once - the priority
   * filter's mark-all-read. Finished and failed turns both count as unread
   * here, so both marks go.
   */
  function markAllRead() {
    unseen.value = new Set()
    sessionErrors.value = new Map()
  }

  /** Whether a session's last turn ended badly, for the dot on its row. */
  function failed(sessionID: string): boolean {
    return sessionErrors.value.has(sessionID)
  }

  /** Drops a session's pending request, wherever the answer came from. */
  function clearPermission(sessionID?: string) {
    const target = sessionID ?? currentID.value
    if (!target || !pendingPermissions.value.has(target)) return
    const next = new Map(pendingPermissions.value)
    next.delete(target)
    pendingPermissions.value = next
  }

  const current = computed(() => sessions.value.find((session) => session.id === currentID.value))

  /**
   * Sessions with a tab in the title bar, in the order they are drawn.
   *
   * Held as its own list rather than read off `sessions`: which conversations
   * exist and which the user still wants to hand are different questions, and
   * a project with forty sessions would otherwise arrive as forty tabs.
   */
  const tabs = ref<string[]>([])

  /**
   * Tabs the user has pinned, which sort to the front of the strip.
   *
   * Held in config rather than in memory so a pinned tab is still pinned
   * tomorrow, which is the whole reason to pin one.
   */
  const pinned = computed(() => new Set(config.value?.pinnedTabs ?? []))

  function isPinned(sessionID: string) {
    return pinned.value.has(sessionID)
  }

  /* A new pin goes to the end of 置顶, as MiMo adds it, and a toast says what happened. */
  async function togglePinned(sessionID: string) {
    const next = new Set(pinned.value)
    const was = next.has(sessionID)
    if (was) next.delete(sessionID)
    else next.add(sessionID)
    await patchConfig({ pinnedTabs: [...next] })
    notify(t(was ? "side.unpinnedToast" : "side.pinnedToast"))
  }

  /** Recently closed tabs, newest last, for Ctrl+Shift+T. */
  const closedTabs = ref<{ sessionID: string; at: number }[]>([])

  /**
   * Conversations, the most recently viewed first, for Ctrl+Tab.
   *
   * In memory only: the order things were looked at in belongs to this sitting,
   * not to something worth restoring tomorrow.
   */
  const recent = ref<string[]>([])

  /**
   * Puts back the last tab that was closed.
   *
   * Sessions outlive their tabs, so this is only about the strip - but a
   * session that has since been deleted has nothing to come back to, and is
   * skipped rather than reopened as a blank.
   */
  async function reopenTab(): Promise<boolean> {
    while (closedTabs.value.length) {
      const entry = closedTabs.value.pop()!
      if (!entry || tabs.value.includes(entry.sessionID)) continue
      if (!sessions.value.some((session) => session.id === entry.sessionID)) continue
      tabs.value.splice(Math.min(entry.at, tabs.value.length), 0, entry.sessionID)
      rememberTabs()
      await open(entry.sessionID)
      return true
    }
    return false
  }

  /** The same list as rows to draw, with ids no longer on disk left out. */
  const tabSessions = computed(() =>
    tabs.value
      .map((id) => sessions.value.find((session) => session.id === id))
      .filter((session): session is SessionInfo => Boolean(session)),
  )

  /**
   * Written back to config so the set survives a restart.
   *
   * Failures are swallowed: a tab that does not come back next launch is a
   * smaller problem than an error banner over a click that otherwise worked.
   */
  function rememberTabs() {
    if (!config.value) return
    void patchConfig({ openTabs: [...tabs.value] }).catch(() => {})
  }

  /** Gives a session a tab, if it has not got one already. */
  function track(sessionID: string) {
    if (tabs.value.includes(sessionID)) return
    tabs.value.push(sessionID)
    rememberTabs()
  }

  /**
   * Takes the tab away, and moves on if it was the open one.
   *
   * The neighbour to the right is preferred, which is where the eye already is
   * after closing something; the left one is taken only at the end of the row.
   */
  function closeTab(sessionID: string) {
    const at = tabs.value.indexOf(sessionID)
    if (at === -1) return
    // Remembered so it can be brought back, with the place it sat in: a tab
    // reopened at the far end of the strip is not the tab that was closed.
    closedTabs.value.push({ sessionID, at })
    if (closedTabs.value.length > 20) closedTabs.value.shift()
    tabs.value.splice(at, 1)
    rememberTabs()
    if (currentID.value !== sessionID) return
    const next = tabs.value[at] ?? tabs.value[at - 1]
    if (next) void open(next)
    else currentID.value = undefined
  }

  /**
   * Moves a tab to a new place in the row.
   *
   * The order is the user's, not the sessions' - which is why it is stored
   * rather than derived, and why dragging one tab past another has to be
   * written back the same way opening one is.
   */
  function moveTab(sessionID: string, to: number) {
    const from = tabs.value.indexOf(sessionID)
    if (from === -1) return
    const target = Math.max(0, Math.min(tabs.value.length - 1, to))
    if (from === target) return
    tabs.value.splice(from, 1)
    tabs.value.splice(target, 0, sessionID)
    rememberTabs()
  }

  /** Drops tabs for sessions that are gone, wherever they went. */
  function forgetTab(sessionID: string) {
    const at = tabs.value.indexOf(sessionID)
    if (at === -1) return
    tabs.value.splice(at, 1)
    rememberTabs()
  }

  /**
   * Drops every trace of a session that no longer exists.
   *
   * Seven collections here are keyed by session id and only two of them were
   * being cleared, so a long-lived window accumulated entries nothing could
   * reach - a slow leak rather than anything on screen. Reopening a closed tab
   * was never at risk: it already skips an entry whose session has gone.
   */
  function forgetSession(sessionID: string) {
    forgetTab(sessionID)
    closedTabs.value = closedTabs.value.filter((entry) => entry.sessionID !== sessionID)

    if (running.value.delete(sessionID)) running.value = new Set(running.value)
    turnStarted.delete(sessionID)
    if (unseen.value.has(sessionID)) {
      const next = new Set(unseen.value)
      next.delete(sessionID)
      unseen.value = next
    }
    if (pendingPermissions.value.has(sessionID)) {
      const next = new Map(pendingPermissions.value)
      next.delete(sessionID)
      pendingPermissions.value = next
    }
    noteError(sessionID, undefined)
    if (notes.value.has(sessionID)) {
      const next = new Map(notes.value)
      next.delete(sessionID)
      notes.value = next
    }
  }

  // -------------------------------------------------------------------------
  // Review notes
  // -------------------------------------------------------------------------

  /**
   * A remark against one line of a diff.
   *
   * These are the reviewer's working notes, not part of the conversation: they
   * are written while reading a change and are meant to be handed to the model
   * in one go. Kept in the window rather than on disk for that reason - once
   * they have been sent they have served their purpose.
   */
  const notes = ref(new Map<string, ReviewNote[]>())

  /** The notes on the open session, oldest first. */
  const sessionNotes = computed(() => (currentID.value ? (notes.value.get(currentID.value) ?? []) : []))

  function addNote(file: string, line: number, text: string) {
    const session = currentID.value
    const body = text.trim()
    if (!session || !body) return
    const list = notes.value.get(session) ?? []
    notes.value.set(session, [
      ...list,
      { id: `n${Date.now()}${list.length}`, file, line, text: body, created: Date.now() },
    ])
    // A Map is not deeply reactive on its own; replacing it is what redraws.
    notes.value = new Map(notes.value)
  }

  function removeNote(id: string) {
    const session = currentID.value
    if (!session) return
    notes.value.set(session, (notes.value.get(session) ?? []).filter((note) => note.id !== id))
    notes.value = new Map(notes.value)
  }

  function clearNotes() {
    const session = currentID.value
    if (!session) return
    notes.value.delete(session)
    notes.value = new Map(notes.value)
  }

  /** Puts the row back on boot, minus anything deleted while the app was shut. */
  function restoreTabs() {
    const alive = (config.value?.openTabs ?? []).filter((id) =>
      sessions.value.some((session) => session.id === id),
    )
    tabs.value = alive
  }

  /**
   * Fast path for streaming: text arrives as deltas keyed by part id, so the
   * part is found by index instead of rescanning the transcript per token.
   */
  const partIndex = reactive(new Map<string, { messageID: string; index: number }>())

  function reindex(message: Message) {
    if (message.role !== "assistant") return
    message.parts.forEach((part, index) => partIndex.set(part.id, { messageID: message.id, index }))
  }

  function sideReindex(message: Message) {
    if (message.role !== "assistant") return
    message.parts.forEach((part, index) => sidePartIndex.set(part.id, { messageID: message.id, index }))
  }

  function apply(event: ServerEvent) {
    switch (event.type) {
      case "session.updated": {
        if (event.session.sideOf) {
          const at = sideSessions.value.findIndex((session) => session.id === event.session.id)
          if (at === -1) sideSessions.value.push(event.session)
          else sideSessions.value[at] = event.session
          break
        }
        const existing = sessions.value.findIndex((session) => session.id === event.session.id)
        if (existing === -1) sessions.value.unshift(event.session)
        else sessions.value[existing] = event.session
        sessions.value.sort((a, b) => b.updated - a.updated)
        break
      }
      case "session.deleted": {
        if (sideSessions.value.some((session) => session.id === event.sessionID)) {
          sideSessions.value = sideSessions.value.filter((session) => session.id !== event.sessionID)
          if (sideID.value === event.sessionID) closeSide()
          break
        }
        const removed = sessions.value.find((session) => session.id === event.sessionID)
        sessions.value = sessions.value.filter((session) => session.id !== event.sessionID)
        forgetSession(event.sessionID)
        if (currentID.value === event.sessionID) {
          /*
           * Within the same project, and never an archived one. Taking whatever
           * sat at the top of the list meant deleting a session could drop the
           * user into a different project entirely, or into an archived session
           * that the workspace then immediately left again.
           */
          const next = sessions.value.find(
            (session) => session.directory === removed?.directory && !session.archived,
          )
          currentID.value = next?.id
          if (next) void open(next.id)
          else messages.value = []
        }
        break
      }
      /*
       * Messages have left the transcript, which is the one change no
       * incremental event can describe: everything else here either adds a
       * message or replaces one, so a window holding the old list would go on
       * showing rolled back turns that are no longer on disk. Read again.
       */
      case "session.reverted":
        if (event.sessionID === currentID.value) void reread(event.sessionID)
        break
      case "message.updated": {
        if (event.message.sessionID === sideID.value) {
          const at = sideMessages.value.findIndex((message) => message.id === event.message.id)
          if (at === -1) sideMessages.value.push(event.message)
          else sideMessages.value[at] = event.message
          sideReindex(event.message)
          break
        }
        if (event.message.sessionID !== currentID.value) break
        const index = messages.value.findIndex((message) => message.id === event.message.id)
        if (index === -1) messages.value.push(event.message)
        else messages.value[index] = event.message
        reindex(event.message)
        break
      }
      case "message.delta": {
        if (event.sessionID === sideID.value) {
          const location = sidePartIndex.get(event.partID)
          const message = location && sideMessages.value.find((candidate) => candidate.id === location.messageID)
          if (location && message?.role === "assistant") {
            const part = message.parts[location.index]
            if (part?.type === "text" || part?.type === "reasoning") part.text += event.text
          }
          break
        }
        if (event.sessionID !== currentID.value) break
        const location = partIndex.get(event.partID)
        if (!location) break
        const message = messages.value.find((candidate) => candidate.id === location.messageID)
        if (message?.role !== "assistant") break
        const part = message.parts[location.index]
        if (part?.type === "text" || part?.type === "reasoning") part.text += event.text
        break
      }
      case "session.compacting": {
        // A new Set each time, so the computed that reads it actually changes.
        const next = new Set(summarising.value)
        if (event.active) next.add(event.sessionID)
        else next.delete(event.sessionID)
        summarising.value = next
        break
      }
      case "session.idle": {
        running.value.delete(event.sessionID)
        const began = turnStarted.get(event.sessionID)
        turnStarted.delete(event.sessionID)
        if (began !== undefined) finished.value = { sessionID: event.sessionID, elapsed: Date.now() - began }
        if (event.sessionID === currentID.value) void refreshHistory(event.sessionID)
        // A turn that ended somewhere the user is not looking is the thing the
        // unread dot exists to report.
        else if (tabs.value.includes(event.sessionID)) {
          unseen.value = new Set(unseen.value).add(event.sessionID)
        }
        break
      }
      case "session.error":
        running.value.delete(event.sessionID)
        turnStarted.delete(event.sessionID)
        noteError(event.sessionID, event.error)
        // The banner is only for the session on screen; the record is kept for
        // all of them, so the sidebar can mark the ones that went wrong.
        if (event.sessionID === currentID.value) error.value = event.error
        if (event.sessionID === sideID.value) sideError.value = event.error
        break
      case "permission.requested":
        pendingPermissions.value.set(event.request.sessionID, event.request)
        pendingPermissions.value = new Map(pendingPermissions.value)
        break
      /*
       * MCP health, kept here rather than in whichever panel asked for it.
       *
       * Two surfaces need it now - the title bar's status light and the panel
       * behind it - and a panel that only exists while it is open cannot be
       * where a light in the bar reads its colour from.
       */
      case "mcp.status": {
        /*
         * A server that just finished connecting brings its prompts with it,
         * and those are slash commands. Compared rather than refreshed on
         * every event: this fires twice per sync by design (once before the
         * connections are attempted and once after), and each refresh costs
         * one round trip per prompt.
         */
        const connected = (servers: McpServerState[]) =>
          servers
            .filter((server) => server.status === "connected")
            .map((server) => server.name)
            .join(",")
        const changed = connected(mcpServers.value) !== connected(event.servers)
        mcpServers.value = event.servers
        if (changed && commandsFor) void refreshCommands(commandsFor)
        break
      }
      case "permission.resolved": {
        for (const [sessionID, request] of pendingPermissions.value) {
          if (request.id !== event.requestID) continue
          pendingPermissions.value.delete(sessionID)
          pendingPermissions.value = new Map(pendingPermissions.value)
          break
        }
        break
      }
      case "config.updated": {
        /*
         * Some config lives inside the provider list too - an endpoint override
         * and a custom provider both change what `provider.list` returns. Only
         * updating the config left the settings page showing the endpoint that
         * had just been replaced.
         */
        const before = config.value
        config.value = event.config
        const affectsProviders =
          JSON.stringify(before?.providerEndpoints) !== JSON.stringify(event.config.providerEndpoints) ||
          /*
           * Removing a custom provider now leaves `customProviders` byte for
           * byte what it was - the record survives and the id joins
           * `disabledProviders` instead, which is the reference's own
           * `disconnect()` (dialog-settings-r1qwJsHg.js:1223) - so without this
           * line a second window listening to `config.updated` never learns
           * that a provider went away. The window that did the removing is
           * fine either way, because it sets the list from the RPC response.
           */
          JSON.stringify(before?.disabledProviders) !== JSON.stringify(event.config.disabledProviders) ||
          JSON.stringify(before?.customProviders) !== JSON.stringify(event.config.customProviders)
        if (before && affectsProviders) void refreshProviders()
        // A command written into the config document is a slash command, so the
        // menu has to hear about it the same way the provider list does.
        if (
          before &&
          commandsFor &&
          JSON.stringify(before.commands) !== JSON.stringify(event.config.commands)
        ) {
          void refreshCommands(commandsFor)
        }
        break
      }
      case "auth.completed":
        providers.value = event.providers
        authState.value = { provider: event.provider, stage: "done" }
        void ensureUsableModel(event.provider)
        break
      case "auth.failed":
        authState.value = { provider: event.provider, stage: "failed", message: event.message }
        break
    }
  }

  async function start() {
    const bootstrap = await window.mcode.bootstrap()
    platform.value = bootstrap.platform
    version.value = bootstrap.version
    port.value = bootstrap.port

    // A retry after a failed boot would otherwise leave the previous socket
    // reconnecting in the background, racing the new one for the same events.
    client.value?.close()

    const instance = new Client(bootstrap.port)
    client.value = instance
    instance.on(apply)
    /*
     * Events that arrive while the socket is down are gone; a turn that ended
     * during the gap would leave its session looking busy forever. So the
     * window asks again rather than assuming what it missed.
     */
    instance.watch((up) => {
      const returning = up && connected.value === false && booted
      connected.value = up
      if (returning) void resync()
      /*
       * Held back a moment before it is admitted to. The socket drops briefly
       * whenever the backend restarts, and a window that announced every one of
       * those would cry wolf; a server that is genuinely not there stays down
       * far longer than this.
       */
      if (offlineTimer !== undefined) {
        clearTimeout(offlineTimer)
        offlineTimer = undefined
      }
      if (up) offline.value = false
      else offlineTimer = setTimeout(() => (offline.value = true), 2500)
    })
    /*
     * A chosen server is read from the browser's own storage rather than from
     * config: config lives on the server, and asking it where to connect would
     * require being connected already.
     */
    /*
     * A default outranks the address last connected to: it is the answer to
     * "where should this app start", where the other is only a record of where
     * it happened to finish.
     */
    const stored = localStorage.getItem("mcode.defaultServerURL") ?? localStorage.getItem("mcode.serverURL")
    if (stored) instance.useServer(stored)
    instance.connect()

    // Poll briefly for the first open rather than racing the socket.
    //
    // Bounded: an unbounded wait left the window blank and silent for good when
    // the backend failed to start, with nothing on screen to explain it.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15_000
      const timer = setInterval(() => {
        if (instance.state.connected) {
          clearInterval(timer)
          resolve()
          return
        }
        if (Date.now() > deadline) {
          clearInterval(timer)
          reject(new Error(t("error.backend")))
        }
      }, 20)
    })
    connected.value = true

    config.value = (await instance.request({ type: "config.get" })).config
    providers.value = (await instance.request({ type: "provider.list" })).providers
    const listed = await instance.request({ type: "session.list" })
    sessions.value = listed.sessions.filter((session) => !session.sideOf)
    sideSessions.value = listed.sessions.filter((session) => session.sideOf)
    running.value = new Set(listed.running)
    clockTurns(listed.running)
    summarising.value = new Set(listed.compacting)
    /*
     * Questions a tool is still parked on.
     *
     * A permission is published as an event, and an event that arrived while
     * this window was not listening is gone. So a window that reloads - or one
     * opened after the question was asked - saw a session reporting itself busy
     * with nothing on screen to explain it, and the only way out was Stop,
     * which denies the question and kills the turn. The list answers with them
     * for the same reason it answers with which sessions are running.
     */
    pendingPermissions.value = new Map(listed.permissions.map((request) => [request.sessionID, request]))
    restoreTabs()
    booted = true
    /*
     * Everything the first screen reads has now arrived.
     *
     * The home screen used to wait on the socket and the config, which is two
     * round trips too early: the provider list and the session list are still
     * in flight at that point, so it drew itself with no sessions and then
     * filled in - a flash of "no sessions yet" on every launch of an app that
     * had plenty.
     */
    ready.value = true

    // The status light reads this, so it is fetched at boot rather than when
    // some panel that shows it first happens to be opened.
    void loadMcp()

    // A default left pointing at a provider whose key was since removed would
    // fail on the first prompt with no hint as to why.
    await ensureUsableModel()

    // No session is opened on boot: the launcher is the entry point, and a
    // project is chosen there. Auto-creating one would skip past it.
  }

  function api() {
    const instance = client.value
    if (!instance) throw new Error("Not connected")
    return instance
  }

  /** Set once the first load is done, so the opening connect is not a return. */
  let booted = false

  /**
   * Whether the first screen has everything it needs.
   *
   * Distinct from , which says only that the socket is open. A
   * surface that draws an empty state has to wait for this instead, or it shows
   * the empty state before the answer arrives.
   */
  const ready = ref(false)

  /** Every MCP server the backend knows about, and how each one is doing. */
  const mcpServers = ref<McpServerState[]>([])

  /**
   * The worst thing currently true of the runtime.
   *
   * The light in the title bar showed only whether the socket was up, so an MCP
   * server that failed to start said nothing anywhere except inside a dialog
   * nobody had a reason to open.
   */
  const runtimeStatus = computed<"down" | "attention" | "warning" | "ok">(() => {
    if (!connected.value) return "down"
    if (mcpServers.value.some((entry) => entry.status === "needs_auth")) return "attention"
    if (mcpServers.value.some((entry) => entry.status === "failed")) return "warning"
    return "ok"
  })

  /** Asks for the MCP list; the status events keep it current afterwards. */
  async function loadMcp() {
    const result = await client.value?.request({ type: "mcp.list" }).catch(() => undefined)
    if (result) mcpServers.value = result.servers
  }

  /** Which directory the command list was last asked about. */
  let commandsFor: string | undefined

  /**
   * Re-reads the commands a project offers.
   *
   * Asked per directory because two of the three sources are the project's own
   * files. `?? []` rather than a throw on an unknown response: `command.list`
   * has no case in the server's request switch yet (that line is handed back),
   * and until it does the request resolves to undefined - the menu should then
   * show this app's own commands and nothing else, not fail to open.
   */
  async function refreshCommands(directory?: string) {
    const where = directory ?? current.value?.directory ?? config.value?.directory
    if (!where) {
      commands.value = []
      commandsFor = undefined
      return
    }
    commandsFor = where
    const result = await client.value
      ?.request({ type: "command.list", directory: where })
      .catch(() => undefined)
    // A second refresh may have overtaken this one; the newer answer wins.
    if (commandsFor !== where) return
    commands.value = result?.commands ?? []
  }

  /**
   * Reloads what a dropped socket may have left behind.
   *
   * The session list carries which sessions are mid-turn; the open one is read
   * again because its transcript may have grown while nothing was listening.
   */
  async function resync() {
    try {
      const listed = await api().request({ type: "session.list" })
      sessions.value = listed.sessions.filter((session) => !session.sideOf)
      sideSessions.value = listed.sessions.filter((session) => session.sideOf)
      running.value = new Set(listed.running)
      clockTurns(listed.running)
      summarising.value = new Set(listed.compacting)
      // The same replay as on boot: a socket that dropped missed anything
      // published while it was down, a permission request included.
      pendingPermissions.value = new Map(listed.permissions.map((request) => [request.sessionID, request]))
      if (currentID.value) await open(currentID.value)
    } catch {
      // A socket that dropped again; the next open will bring another attempt.
    }
  }

  async function open(sessionID: string) {
    /*
     * Cleared before the round trip, not after: leaving the previous session's
     * depth in place offered an undo that belonged to a different conversation
     * for as long as the request took.
     */
    history.value = { undo: 0, redo: 0 }
    void refreshHistory(sessionID)
    const result = await api().request({ type: "session.get", sessionID })
    currentID.value = sessionID
    if (unseen.value.has(sessionID)) {
      const next = new Set(unseen.value)
      next.delete(sessionID)
      unseen.value = next
    }
    track(sessionID)
    recent.value = [sessionID, ...recent.value.filter((id) => id !== sessionID)].slice(0, 50)
    messages.value = result.messages
    partIndex.clear()
    result.messages.forEach(reindex)
    error.value = undefined
    noteError(sessionID, undefined)
    clearPermission(sessionID)
    /*
     * Two of the three command sources are files under the session's own
     * directory, so the list belongs to the project rather than to the app.
     * Skipped when the directory has not moved: opening a sibling session in
     * the same project must not re-read every skill on disk.
     */
    const where = result.session.directory
    if (where && where !== commandsFor) void refreshCommands(where)
  }

  /**
   * Reads a session's transcript again, in place.
   *
   * Unlike opening it, this changes nothing about where the reader is: no tab
   * is tracked, no error cleared, no unread mark dropped. It exists because a
   * transcript can now get shorter, and the answer arriving for a session the
   * reader has already left has to be dropped rather than shown.
   */
  async function reread(sessionID: string) {
    const result = await api()
      .request({ type: "session.get", sessionID })
      .catch(() => undefined)
    if (!result || currentID.value !== sessionID) return
    messages.value = result.messages
    partIndex.clear()
    result.messages.forEach(reindex)
  }

  async function create(directory?: string, options: { scratch?: boolean } = {}) {
    const result = await api().request({
      type: "session.create",
      directory,
      ...(options.scratch ? { scratch: true } : {}),
    })
    // The session.updated event usually lands before this response, so only
    // insert if it did not - otherwise the list gets a duplicate row.
    if (!sessions.value.some((session) => session.id === result.session.id)) {
      sessions.value.unshift(result.session)
    }
    await open(result.session.id)
    return result.session
  }

  /**
   * A second conversation that starts where this one stood at a message.
   *
   * The new session carries everything up to and including that message, which
   * is what the reference's `POST /session/{id}/fork` does. It used to seed a
   * blank session with the one sentence and nothing else - so a question asked
   * twenty turns in arrived in the fork with none of what made it worth asking,
   * and the model answered it cold.
   */
  async function forkFrom(messageID: string) {
    if (!currentID.value) return undefined
    const { session } = await api().request({
      type: "session.fork",
      sessionID: currentID.value,
      messageID,
    })
    // Same guard as create(): the session.updated event usually lands first.
    if (!sessions.value.some((entry) => entry.id === session.id)) sessions.value.unshift(session)
    await open(session.id)
    return session
  }

  async function remove(sessionID: string) {
    await api().request({ type: "session.delete", sessionID })
  }

  /** Archived sessions stay on disk but leave the sidebar, rail and palette. */
  /**
   * Summarises the conversation so the model can keep going in a smaller
   * context. The transcript is untouched; only what gets sent changes.
   */
  /** How many turns the open session can take back, and put back. */
  const history = ref<{ undo: number; redo: number }>({ undo: 0, redo: 0 })

  async function refreshHistory(sessionID: string) {
    history.value = (await api().request({ type: "session.history", sessionID })).history
  }

  /**
   * Puts back the files the last turn changed.
   *
   * The transcript is left alone: the conversation still happened, and hiding
   * it would leave no record of what was undone.
   */
  async function undo(sessionID: string) {
    const result = await api().request({ type: "session.undo", sessionID })
    history.value = result.history
    return result.files
  }

  /**
   * Where the conversation has been rolled back to, if it has been.
   *
   * The messages from here on are still held - that is what makes putting them
   * back possible - so everything that renders the conversation has to know
   * where the line falls rather than trusting the length of the list.
   */
  const revertedAt = computed(() => current.value?.revert?.messageID)

  /**
   * The messages that are rolled back, oldest first.
   *
   * Only the user's own: one of theirs and the replies it drew are one entry as
   * far as putting them back goes, and their words are what makes an entry
   * recognisable in a list.
   */
  const rolledBack = computed(() => {
    const boundary = revertedAt.value
    if (!boundary) return []
    const at = messages.value.findIndex((message) => message.id === boundary)
    if (at < 0) return []
    return messages.value.slice(at).filter((message) => message.role === "user")
  })

  /** The conversation as it now stands, with anything rolled back left out. */
  const visible = computed(() => {
    const boundary = revertedAt.value
    if (!boundary) return messages.value
    const at = messages.value.findIndex((message) => message.id === boundary)
    return at < 0 ? messages.value : messages.value.slice(0, at)
  })

  /**
   * Rolls the conversation back to a message, or puts back what was rolled
   * back when given none.
   *
   * The server decides where the boundary actually lands, because the project
   * can only be returned to points a turn was recorded at - so the answer is
   * read back from the session it returns rather than assumed here.
   */
  async function revert(sessionID: string, messageID?: string) {
    const result = await api().request({ type: "session.revert", sessionID, messageID })
    const at = sessions.value.findIndex((entry) => entry.id === result.session.id)
    if (at >= 0) sessions.value[at] = result.session
    history.value = result.history
    return result.files
  }

  async function redo(sessionID: string) {
    const result = await api().request({ type: "session.redo", sessionID })
    history.value = result.history
    return result.files
  }

  async function compact(sessionID: string) {
    // No flag of its own: the server says when a summary starts and stops, for
    // this and for the automatic one alike, and the button reads that.
    const { session } = await api().request({ type: "session.compact", sessionID })
    const at = sessions.value.findIndex((entry) => entry.id === session.id)
    if (at >= 0) sessions.value[at] = session
    return session
  }

  /**
   * The instructions this session's turns are given before anything is said.
   *
   * Asked for rather than held, because it is assembled per request from the
   * agent, the project's own files and the machine it is running on, and it is
   * only ever wanted by the one panel that shows it.
   */
  async function systemPrompt(sessionID: string) {
    return (await api().request({ type: "session.systemPrompt", sessionID })).prompt
  }

  async function archive(sessionID: string, archived: boolean) {
    await api().request({ type: "session.archive", sessionID, archived })
    if (archived && currentID.value === sessionID) {
      const next = sessions.value.find((entry) => entry.id !== sessionID && !entry.archived)
      currentID.value = next?.id
      if (next) await open(next.id)
      else messages.value = []
    }
  }

  /*
   * Archiving reaches the store from the project panel, the command palette and
   * the Settings list, and only one of those used to step out of the session it
   * had just archived. The result was a transcript still on screen for a
   * session the sidebar reported as gone. The rule belongs in one place: the
   * workspace never stays inside an archived session, however it got archived.
   */
  watch(
    () => sessions.value.find((session) => session.id === currentID.value)?.archived,
    (archived) => {
      if (!archived) return
      currentID.value = undefined
      messages.value = []
    },
  )

  async function rename(sessionID: string, title: string) {
    await api().request({ type: "session.rename", sessionID, title })
  }

  /** Which project a conversation belongs to. The transcript does not move. */
  async function move(sessionID: string, directory: string) {
    await api().request({ type: "session.move", sessionID, directory })
    if (directory !== commandsFor && currentID.value === sessionID) void refreshCommands(directory)
  }

  /*
   * Marked unread by hand, which is the one way into this set that is not an
   * answer arriving while the reader was somewhere else. Opening the session
   * clears it again, as it always did.
   */
  function markUnread(sessionID: string) {
    if (unseen.value.has(sessionID)) return
    unseen.value = new Set(unseen.value).add(sessionID)
  }

  /** Returns false when the message was not accepted, so the draft can survive. */
  /* `to` names a side chat; without it the message goes to the open conversation. */
  async function send(text: string, attachments: Attachment[] = [], to?: string): Promise<boolean> {
    const target = to ?? currentID.value
    // An attachment with no words is still something to answer.
    if (!target || (!text.trim() && !attachments.length)) return false
    const onSide = target === sideID.value
    const report = (message: string | undefined) => {
      if (onSide) sideError.value = message
      else error.value = message
    }
    report(undefined)
    noteError(target, undefined)

    // Caught here rather than in the backend so it can be said in the user's
    // language - the server has no idea which one that is.
    const chosen = (onSide ? side.value : sessions.value.find((session) => session.id === target))?.model
    const provider = providers.value.find((entry) => entry.id === chosen?.provider)
    if (provider && !provider.configured) {
      report(t("error.noProvider", { name: provider.name }))
      return false
    }

    /*
     * Whether this message is starting the work or joining work already under
     * way. A message can now be sent into a turn that is running, and if that
     * one is refused the turn it was aimed at is still going - so the flag has
     * to be left alone. Clearing it regardless put an idle composer in front of
     * a model that was still writing.
     */
    const joined = running.value.has(target)
    running.value.add(target)
    if (!joined) turnStarted.set(target, Date.now())
    try {
      await api().request({ type: "session.prompt", sessionID: target, text, attachments })
      return true
    } catch (err) {
      if (!joined) {
        running.value.delete(target)
        turnStarted.delete(target)
      }
      report(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  async function abort(to?: string) {
    const target = to ?? currentID.value
    if (!target) return
    // Before the request: the idle that follows a stop may arrive ahead of its answer.
    turnStarted.delete(target)
    await api().request({ type: "session.abort", sessionID: target })
    running.value.delete(target)
  }

  /** The request whose answer is in flight, so the panel can disable itself. */
  const responding = ref<string>()

  async function respond(response: PermissionResponse) {
    const request = permission.value
    if (!request || responding.value === request.id) return
    responding.value = request.id
    try {
      await api().request({ type: "permission.respond", requestID: request.id, response })
      clearPermission(request.sessionID)
    } catch (err) {
      // The request stays up: the tool is still waiting on an answer, and
      // clearing it here would strand the turn with nothing on screen.
      notifyFailure(t("perm.failed"), err instanceof Error ? err.message : String(err))
    } finally {
      if (responding.value === request.id) responding.value = undefined
    }
  }

  /** Undefined clears it, which is how a session goes back to the default. */
  async function setEffort(effort?: Effort) {
    if (!currentID.value) return
    await api().request({ type: "session.effort", sessionID: currentID.value, effort })
  }

  async function setModel(model: ModelRef, to?: string) {
    const target = to ?? currentID.value
    if (!target) return
    await api().request({ type: "session.model", sessionID: target, model })
    // A side chat's model is its own; the default follows the open conversation.
    if (target !== sideID.value) await patchConfig({ model, smart: false })
  }

  /** Puts a conversation on Smart, and makes Smart the start for the next one. */
  async function setSmart(to?: string) {
    const target = to ?? currentID.value
    if (!target) return
    await api().request({ type: "session.smart", sessionID: target })
    if (target !== sideID.value) await patchConfig({ smart: true })
  }

  /**
   * Applies the agent to the open session, and remembers it for the next one.
   *
   * The turn takes its agent from the session, so writing only the config left
   * the choice with nothing to act on.
   */
  async function setAgent(agent: AgentName) {
    if (currentID.value) {
      const result = await api().request({ type: "session.agent", sessionID: currentID.value, agent })
      const at = sessions.value.findIndex((entry) => entry.id === result.session.id)
      if (at >= 0) sessions.value[at] = result.session
    }
    await patchConfig({ agent })
  }

  /*
   * Staged mode, the same shape as the agent: set on the open conversation if
   * there is one, and written as the default either way so the next
   * conversation starts where this choice left off.
   */
  async function setStaged(staged: boolean) {
    if (currentID.value) {
      const result = await api().request({ type: "session.staged", sessionID: currentID.value, staged })
      const at = sessions.value.findIndex((entry) => entry.id === result.session.id)
      if (at >= 0) sessions.value[at] = result.session
    }
    await patchConfig({ staged })
  }

  async function patchConfig(patch: Partial<AppConfig>) {
    config.value = (await api().request({ type: "config.set", patch })).config
  }

  /**
   * Remembers which saved server to connect to at launch.
   *
   * Mirrored into the browser own storage for the same reason the current
   * address is: the next launch has to know where to connect before it has a
   * connection to ask. An id with no server behind it clears the choice rather
   * than being written, so a deleted row cannot send the next launch at an
   * address that is gone.
   */
  async function setDefaultServer(id: string) {
    const entry = config.value?.servers?.find((row) => row.id === id)
    if (entry) localStorage.setItem("mcode.defaultServerURL", entry.url)
    else localStorage.removeItem("mcode.defaultServerURL")
    await patchConfig({ defaultServer: entry ? id : "" })
  }

  /**
   * Points the default - and the open session - at a model that can actually
   * run. Connecting a provider otherwise changes nothing visible: the composer
   * shows the session's model, and that session was created against whatever
   * default was in place beforehand.
   */
  async function ensureUsableModel(prefer?: string) {
    const usable = (id: string) => providers.value.find((entry) => entry.id === id)?.configured
    const chosen = config.value?.model

    // Nothing to do when the current pick already works and no move was asked for.
    if (!prefer && chosen && usable(chosen.provider)) return

    const target =
      providers.value.find((entry) => entry.id === prefer && entry.configured && entry.models.length) ??
      providers.value.find((entry) => entry.configured && entry.models.length)
    const model = target?.models[0]
    if (!target || !model) return

    const ref = { provider: target.id, model: model.id }
    await patchConfig({ model: ref })
    // An open session keeps its own model, so it has to be moved explicitly.
    if (currentID.value) await api().request({ type: "session.model", sessionID: currentID.value, model: ref })
  }

  /**
   * Subscription login progress. The browser flow finishes minutes later on a
   * server event rather than when its request returns, so the UI needs somewhere
   * to read the outcome from.
   */
  const authState = ref<{
    provider: string
    stage: "starting" | "waiting" | "done" | "failed"
    url?: string
    userCode?: string
    message?: string
  }>()

  /** Wipes keys, subscriptions, preferences and history, then reopens setup. */
  async function resetEverything() {
    const result = await api().request({ type: "app.reset" })
    config.value = result.config
    providers.value = result.providers
    sessions.value = []
    tabs.value = []
    currentID.value = undefined
    messages.value = []
    // Otherwise a device code from the login that was just wiped would still be
    // sitting on the fresh onboarding screen.
    authState.value = undefined
    pendingPermissions.value = new Map()
    unseen.value = new Set()
  }

  async function gitStatus(directory: string, scope?: "worktree" | "branch") {
    return api().request({ type: "git.status", directory, scope })
  }

  async function gitInit(directory: string) {
    return api().request({ type: "git.init", directory })
  }

  async function gitDiff(
    directory: string,
    file: string,
    context?: number,
    scope?: "worktree" | "branch",
  ) {
    return (await api().request({ type: "git.diff", directory, file, context, scope })).patch
  }

  async function gitRevert(directory: string, file: string) {
    return api().request({ type: "git.revert", directory, file })
  }

  /** Facts about a directory, straight from disk. */
  async function workspaceInfo(directory: string) {
    return api().request({ type: "workspace.info", directory })
  }

  async function beginAuth(provider: string, method: AuthMethodKind) {
    authState.value = { provider, stage: "starting" }
    try {
      const result = await api().request({ type: "auth.begin", provider, method })
      authState.value = { provider, stage: "waiting", url: result.url, userCode: result.userCode }
      return result
    } catch (error) {
      authState.value = undefined
      throw error
    }
  }

  function cancelAuth(provider: string) {
    authState.value = undefined
    void api().request({ type: "auth.cancel", provider })
  }

  async function signOut(provider: string) {
    providers.value = (await api().request({ type: "auth.signOut", provider })).providers
    await ensureUsableModel()
  }

  /** Re-reads the provider list, which carries config-derived fields. */
  async function refreshProviders() {
    providers.value = (await api().request({ type: "provider.list" })).providers
  }

  /**
   * Records where a provider's API lives, if that is not where it lives now.
   *
   * Called before connecting rather than after: the server checks a local
   * runtime is reachable as part of connecting, and it has to check the
   * address the user actually typed.
   */
  async function setProviderEndpoint(provider: string, url: string) {
    const trimmed = url.trim()
    const current = providers.value.find((entry) => entry.id === provider)
    if (!trimmed || trimmed === current?.baseURL) return
    await patchConfig({
      providerEndpoints: { ...(config.value?.providerEndpoints ?? {}), [provider]: trimmed },
    })
  }

  async function setApiKey(provider: string, apiKey: string) {
    providers.value = (await api().request({ type: "provider.auth", provider, apiKey })).providers
    if (apiKey) await ensureUsableModel(provider)
    else await ensureUsableModel()
  }

  /** Re-reads an OpenAI-compatible provider's model list; returns the count. */
  async function discoverModels(provider: string) {
    const result = await api().request({ type: "provider.discover", provider })
    providers.value = result.providers
    await ensureUsableModel()
    return result.count
  }

  /**
   * Adds an OpenAI-compatible provider by base URL.
   *
   * Takes the whole form rather than three strings: the id is the user's own,
   * the models are typed in because nothing discovers them for a custom
   * provider, and the headers are the only way to reach an endpoint that
   * authenticates with anything other than a bearer token.
   */
  async function addCustomProvider(entry: {
    id: string
    name: string
    baseURL: string
    apiKey: string
    headers?: Record<string, string>
    models: CustomModel[]
  }) {
    providers.value = (await api().request({ type: "provider.addCustom", ...entry })).providers
    await ensureUsableModel()
  }

  async function removeCustomProvider(provider: string) {
    providers.value = (await api().request({ type: "provider.removeCustom", provider })).providers
  }

  /** The turn currently streaming, if any - used to anchor the scroll. */
  /**
   * Opens a side chat beside a conversation: a new, numbered conversation in
   * the same project that no list shows. An empty one this conversation already
   * has is taken up again rather than leaving a trail of blank ones behind.
   */
  async function openSide(parentID: string) {
    const parent = sessions.value.find((session) => session.id === parentID)
    if (!parent) return
    const previous = sideSessions.value
      .filter((session) => session.sideOf === parentID)
      .sort((a, b) => b.updated - a.updated)[0]
    let chosen: SessionInfo | undefined
    if (previous) {
      const got = await api().request({ type: "session.get", sessionID: previous.id }).catch(() => undefined)
      if (got && !got.messages.length) chosen = previous
    }
    if (!chosen) {
      const created = await api().request({
        type: "session.create",
        directory: parent.directory,
        title: t("side.chatNumbered", { n: sideSessions.value.length + 1 }),
        sideOf: parentID,
      })
      chosen = created.session
      if (!sideSessions.value.some((session) => session.id === created.session.id)) sideSessions.value.push(created.session)
    }
    sideID.value = chosen.id
    sideError.value = undefined
    sideMessages.value = []
    sidePartIndex.clear()
  }

  function closeSide() {
    sideID.value = undefined
    sideMessages.value = []
    sideError.value = undefined
    sidePartIndex.clear()
  }

  const sideStreaming = computed<AssistantMessage | undefined>(() => {
    if (!sideBusy.value) return undefined
    const last = sideMessages.value[sideMessages.value.length - 1]
    return last?.role === "assistant" ? last : undefined
  })

  const streaming = computed<AssistantMessage | undefined>(() => {
    if (!busy.value) return undefined
    const last = messages.value[messages.value.length - 1]
    return last?.role === "assistant" ? last : undefined
  })

  return {
    client,
    connected,
    ready,
    mcpServers,
    runtimeStatus,
    loadMcp,
    offline,
    platform,
    version,
    port,
    sessions,
    currentID,
    current,
    tabs,
    tabSessions,
    closeTab,
    moveTab,
    sessionNotes,
    addNote,
    removeNote,
    clearNotes,
    messages,
    busy,
    compacting,
    error,
    config,
    providers,
    commands,
    refreshCommands,
    permission,
    responding,
    pendingPermissions,
    unseen,
    unread,
    failed,
    markAllRead,
    running,
    finished,
    clearPermission,
    reopenTab,
    recent,
    forkFrom,
    isPinned,
    togglePinned,
    streaming,
    side,
    sideID,
    sideMessages,
    sideBusy,
    sideStreaming,
    sideError,
    openSide,
    closeSide,
    start,
    open,
    create,
    remove,
    rename,
    move,
    markUnread,
    archive,
    compact,
    history,
    refreshHistory,
    undo,
    redo,
    revert,
    revertedAt,
    rolledBack,
    visible,
    systemPrompt,
    send,
    abort,
    respond,
    setModel,
    setSmart,
    setEffort,
    setAgent,
    setStaged,
    patchConfig,
    setDefaultServer,
    setProviderEndpoint,
    setApiKey,
    authState,
    workspaceInfo,
    gitStatus,
    gitInit,
    gitDiff,
    gitRevert,
    resetEverything,
    beginAuth,
    cancelAuth,
    signOut,
    ensureUsableModel,
    discoverModels,
    addCustomProvider,
    removeCustomProvider,
  }
})
