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
import { projectName } from "../lib/project"
import { projectsByRecency } from "@shared/projects"
import { availableModels, fallbackModel, modelAvailable } from "@shared/model-fallback"
import type { ChatLink } from "@shared/protocol"
import { notice, notify, notifyFailure } from "../lib/toast"
import { findModel, withoutLatest } from "../lib/model"
import { noteRunEnded, noteToolWrites } from "../lib/ai-touch"
import { endOfficeWatches } from "../lib/annotation-fx"
import { readLegacyMessage } from "@shared/subagent"
import { isScheduledPrompt } from "@shared/scheduled"
import { returnFileNotices, takeFileNotices } from "../lib/file-notices"

export const useApp = defineStore("app", () => {
  const client = shallowRef<Client>()
  const connected = ref(false)
  /** Down long enough to be worth saying so, rather than mid-restart. */
  const offline = ref(false)
  let offlineTimer: ReturnType<typeof setTimeout> | undefined
  /* The notice that says the connection is coming back, and the beat it waits first. */
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const RECONNECT_TOAST = "app-reconnect"
  const RECONNECT_DELAY = 400
  const platform = ref("")
  const version = ref("")
  /** Loopback port the agent server bound to; shown in the server popover. */
  const port = ref(0)

  const sessions = ref<SessionInfo[]>([])
  const currentID = ref<string>()
  const messages = ref<Message[]>([])
  /** The conversation switched to whose messages have not arrived; MiMo shows 正在加载对话… meanwhile. */
  const loadingID = ref<string>()
  /**
   * Sessions with a turn in flight.
   *
   * A turn belongs to its session, not to the window, so this is keyed by id -
   * and cleared by the id the event names rather than the one on screen, which
   * may have moved on by the time the turn ends.
   */
  const running = ref(new Set<string>())
  /** session chat: each conversation's messages in flight with others, as the server last reported them. */
  const chatLinks = shallowRef<Record<string, ChatLink[]>>({})
  const chatLinksOf = (sessionID: string): ChatLink[] => chatLinks.value[sessionID] ?? []
  /*
   * When each running turn began, as far as this window saw it, and the last
   * turn to end on its own with how long it took - which is what decides
   * whether it was long enough to chime for. A stopped or failed turn is
   * dropped from the clock rather than reported.
   */
  const turnStarted = new Map<string, number>()
  const finished = ref<{ sessionID: string; elapsed: number }>()
  /* automation: conversations whose running turn is a scheduled task's run, and the last run the user should be told about. */
  const automationRuns = ref(new Set<string>())
  const automationNotice = ref<{ sessionID: string; at: number }>()
  /**
   * Bumped whenever the window comes back into focus, as MiMo's shell bumps its
   * `fsNonce`.
   *
   * Anything reading the working tree - the review tab - takes it as part of
   * what it reads on, so coming back from an editor re-reads the files rather
   * than waiting for the conversation to move.
   */
  const fsNonce = ref(0)
  const bumpFsNonce = () => (fsNonce.value += 1)
  /**
   * What the home screen's next task works in, when the reader has said.
   *
   * MiMo's 不使用项目 and its project pick are navigation state, so they outlive
   * the home screen: opening a conversation and coming back finds the same
   * answer. Held here rather than in HomeHero, which is unmounted the moment a
   * conversation opens - which is how an explicit 不使用项目 used to be
   * forgotten, and the next message fell back into the last project.
   */
  const homeProject = ref<string>()

  /** Starts the clock on turns not seen beginning, and forgets the ones no longer running. */
  function clockTurns(ids: Iterable<string>) {
    const now = Date.now()
    const live = new Set(ids)
    for (const id of live) if (!turnStarted.has(id)) turnStarted.set(id, now)
    for (const id of [...turnStarted.keys()]) if (!live.has(id)) turnStarted.delete(id)
  }
  const busy = computed(() => (currentID.value ? running.value.has(currentID.value) : false))
  /**
   * Conversations whose earlier message is being edited or retried: truncated,
   * then sent again. As in MiMo, the composer refuses a send into one until the
   * replacement has gone out, so a new message cannot land in between.
   */
  const replacing = ref(new Set<string>())
  function markReplacing(sessionID: string, on: boolean) {
    const next = new Set(replacing.value)
    if (on) next.add(sessionID)
    else next.delete(sessionID)
    replacing.value = next
  }
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
  /*
   * MiMo keeps every side chat tab mounted with its own transcript, and several
   * can stream at once, so each loaded side conversation keeps its messages and
   * error here by id. `sideID` is the one the box on show speaks for.
   */
  const sideID = ref<string>()
  const sideTranscripts = ref<Record<string, Message[]>>({})
  const sideErrors = ref<Record<string, string | undefined>>({})
  const sidePartIndexes = new Map<string, Map<string, { messageID: string; index: number }>>()
  const sideMessages = computed<Message[]>(() => (sideID.value ? sideTranscripts.value[sideID.value] ?? [] : []))
  const sideError = computed(() => (sideID.value ? sideErrors.value[sideID.value] : undefined))
  const side = computed(() => sideSessions.value.find((session) => session.id === sideID.value))
  const sideBusy = computed(() => (sideID.value ? running.value.has(sideID.value) : false))
  /*
   * subagents: the subagents' own conversations. Like side chats, no list shows
   * them; their transcripts load into the side transcripts by id, so the 子智能体
   * tab draws one with the side chat's stream.
   */
  const subagentSessions = ref<SessionInfo[]>([])
  /** subagents: conversations sent a notice while idle, whose next reply is a turn the server started. */
  const noticeWoken = new Set<string>()
  const isSubagent = (sessionID: string) => subagentSessions.value.some((session) => session.id === sessionID)
  /** subagents: the conversation a subagent works for, or the session itself; its questions queue there. */
  function rootOf(sessionID: string): string {
    let id = sessionID
    for (let depth = 0; depth < 8; depth++) {
      const parent = subagentSessions.value.find((session) => session.id === id)?.parentID
      if (!parent) break
      id = parent
    }
    return id
  }
  const isSide = (sessionID: string) => sideSessions.value.some((session) => session.id === sessionID) || isSubagent(sessionID)
  const sideMessagesOf = (sessionID?: string): Message[] => (sessionID ? sideTranscripts.value[sessionID] ?? [] : [])
  const sideErrorOf = (sessionID?: string) => (sessionID ? sideErrors.value[sessionID] : undefined)
  const sideSessionOf = (sessionID?: string) =>
    sideSessions.value.find((session) => session.id === sessionID) ?? subagentSessions.value.find((session) => session.id === sessionID)
  const sideBusyOf = (sessionID?: string) => (sessionID ? running.value.has(sessionID) : false)
  function sideStreamingOf(sessionID?: string): AssistantMessage | undefined {
    if (!sideBusyOf(sessionID)) return undefined
    const list = sideMessagesOf(sessionID)
    const last = list[list.length - 1]
    return last?.role === "assistant" ? last : undefined
  }

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
  /*
   * A queue per session, oldest first. Tools can ask while another question is
   * still up, and keeping only the latest stranded the earlier one: the server
   * went on waiting for an answer to a request nothing on screen showed.
   */
  const pendingPermissions = ref(new Map<string, PermissionRequest[]>())
  const permission = computed(() =>
    currentID.value ? pendingPermissions.value.get(currentID.value)?.[0] : undefined,
  )
  /** How many requests the current session has waiting, the one shown included. */
  const permissionQueue = computed(() =>
    currentID.value ? (pendingPermissions.value.get(currentID.value)?.length ?? 0) : 0,
  )

  function groupPermissions(requests: PermissionRequest[]) {
    const grouped = new Map<string, PermissionRequest[]>()
    for (const request of [...requests].sort((a, b) => a.time - b.time)) {
      // subagents: a subagent's request waits with the conversation it works for.
      const key = rootOf(request.sessionID)
      grouped.set(key, [...(grouped.get(key) ?? []), request])
    }
    return grouped
  }

  /** Takes one answered request out of its session's queue. */
  function dropPermission(requestID: string) {
    for (const [sessionID, queue] of pendingPermissions.value) {
      if (!queue.some((request) => request.id === requestID)) continue
      const next = new Map(pendingPermissions.value)
      const rest = queue.filter((request) => request.id !== requestID)
      if (rest.length) next.set(sessionID, rest)
      else next.delete(sessionID)
      pendingPermissions.value = next
      return
    }
  }

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
    held.delete(sessionID)
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

  /*
   * The transcripts of the conversations left most recently, newest last.
   *
   * MiMo keeps every conversation's messages in its store once they are read
   * (`msgsByConvo`), so coming back to one draws what it already has and
   * refreshes it in place; this app emptied the list and read the whole
   * conversation again on every switch, which on a 150-turn one meant the
   * loading line and 580ms before anything was back. The copies here follow
   * the same message events the open conversation does, so they are current
   * when they are shown, and the read that follows only replaces one that
   * turned out to differ.
   */
  const HELD_MAX = 8
  const held = new Map<string, Message[]>()

  function hold(sessionID: string | undefined) {
    if (!sessionID || loadingID.value === sessionID || !messages.value.length) return
    held.delete(sessionID)
    held.set(sessionID, messages.value)
    while (held.size > HELD_MAX) {
      const oldest = held.keys().next().value
      if (oldest === undefined) break
      held.delete(oldest)
    }
  }

  /** What a transcript looks like, cheaply: enough to tell whether a fresh read changed anything. */
  function transcriptKey(list: readonly Message[]): string {
    return list
      .map((message) =>
        message.role === "user"
          ? `${message.id}:${message.text.length}:${message.attachments?.length ?? 0}`
          : `${message.id}:${message.finish ?? ""}:${message.time.completed ?? ""}:${message.error ?? ""}:${message.reverted ? 1 : 0}:` +
            message.parts.map((part) => `${part.id}${part.type === "tool" ? part.status : part.type === "text" || part.type === "reasoning" ? part.text.length : ""}`).join(","),
      )
      .join("|")
  }

  function reindex(message: Message) {
    if (message.role !== "assistant") return
    message.parts.forEach((part, index) => partIndex.set(part.id, { messageID: message.id, index }))
  }

  function sideReindex(sessionID: string, message: Message) {
    if (message.role !== "assistant") return
    let index = sidePartIndexes.get(sessionID)
    if (!index) sidePartIndexes.set(sessionID, (index = new Map()))
    const into = index
    message.parts.forEach((part, at) => into.set(part.id, { messageID: message.id, index: at }))
  }

  function forgetSideTranscript(sessionID: string) {
    const transcripts = { ...sideTranscripts.value }
    delete transcripts[sessionID]
    sideTranscripts.value = transcripts
    const errors = { ...sideErrors.value }
    delete errors[sessionID]
    sideErrors.value = errors
    sidePartIndexes.delete(sessionID)
  }

  function setSideError(sessionID: string, message: string | undefined) {
    sideErrors.value = { ...sideErrors.value, [sessionID]: message }
  }

  function apply(event: ServerEvent) {
    switch (event.type) {
      case "session.updated": {
        // subagents: kept apart from every list; one that has just been made is already working.
        if (event.session.parentID) {
          const at = subagentSessions.value.findIndex((session) => session.id === event.session.id)
          if (at === -1) subagentSessions.value.push(event.session)
          else subagentSessions.value[at] = event.session
          // Its record says whether a turn of it is under way; one stored before the record had that is judged by its age.
          const state = event.session.subagent?.status
          const working = state ? state === "running" : at === -1 && Date.now() - event.session.created < 60_000
          if (working !== running.value.has(event.session.id)) {
            const next = new Set(running.value)
            if (working) next.add(event.session.id)
            else next.delete(event.session.id)
            running.value = next
          }
          break
        }
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
        // subagents: goes with its transcript, and nothing else.
        if (isSubagent(event.sessionID)) {
          subagentSessions.value = subagentSessions.value.filter((session) => session.id !== event.sessionID)
          if (running.value.delete(event.sessionID)) running.value = new Set(running.value)
          forgetSideTranscript(event.sessionID)
          break
        }
        if (sideSessions.value.some((session) => session.id === event.sessionID)) {
          sideSessions.value = sideSessions.value.filter((session) => session.id !== event.sessionID)
          if (sideID.value === event.sessionID) closeSide()
          forgetSideTranscript(event.sessionID)
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
      // session chat: always the whole picture, so it replaces what was there.
      case "session.chatLinks":
        chatLinks.value = event.links
        break
      case "session.reverted":
        // A held copy cannot be shortened by events, so one that lost messages is read again when it is next opened.
        held.delete(event.sessionID)
        if (event.sessionID === currentID.value) void reread(event.sessionID)
        break
      case "message.updated": {
        // subagents: a saved subagent call from before the actor rename reads as an actor call.
        event.message = readLegacyMessage(event.message)
        /*
         * subagents: news of background subagents can wake an idle conversation,
         * a turn the window did not send. It is marked busy when that turn's
         * first reply arrives, so the working marks and Stop show as for any turn.
         */
        {
          const message = event.message
          // cron, automation: a scheduled prompt starts a turn nobody sent from this window; it shows working, is timed and notifies like one.
          if (message.role === "user" && !message.steered && !running.value.has(message.sessionID) && (message.inbox?.automationID || isScheduledPrompt(message.text))) {
            running.value = new Set(running.value).add(message.sessionID)
            turnStarted.set(message.sessionID, Date.now())
          }
          if (message.role === "user" && message.notices?.length && !message.steered) noticeWoken.add(message.sessionID)
          else if (message.role === "assistant" && !message.finish && !message.time.completed && noticeWoken.delete(message.sessionID) && !running.value.has(message.sessionID)) {
            running.value = new Set(running.value).add(message.sessionID)
          }
        }
        noteToolWrites(
          event.message,
          (sessions.value.find((session) => session.id === event.message.sessionID) ?? sideSessions.value.find((session) => session.id === event.message.sessionID))?.directory,
        )
        {
          // Every loaded side chat follows its own conversation, on show or not.
          const list = sideTranscripts.value[event.message.sessionID]
          if (list) {
            const at = list.findIndex((message) => message.id === event.message.id)
            if (at === -1) list.push(event.message)
            else list[at] = event.message
            sideReindex(event.message.sessionID, event.message)
            break
          }
        }
        {
          // A conversation left a moment ago keeps following its own messages, so coming back shows them as they are.
          const kept = held.get(event.message.sessionID)
          if (kept) {
            const at = kept.findIndex((message) => message.id === event.message.id)
            if (at === -1) kept.push(event.message)
            else kept[at] = event.message
          }
        }
        if (event.message.sessionID !== currentID.value) break
        const index = messages.value.findIndex((message) => message.id === event.message.id)
        if (index === -1) messages.value.push(event.message)
        else messages.value[index] = event.message
        reindex(event.message)
        break
      }
      case "message.delta": {
        if (sideTranscripts.value[event.sessionID]) {
          const location = sidePartIndexes.get(event.sessionID)?.get(event.partID)
          const message = location && sideTranscripts.value[event.sessionID]?.find((candidate) => candidate.id === location.messageID)
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
      case "automation.run": {
        const runs = new Set(automationRuns.value)
        if (event.phase === "started") runs.add(event.sessionID)
        else {
          runs.delete(event.sessionID)
          if (event.notify) automationNotice.value = { sessionID: event.sessionID, at: Date.now() }
        }
        automationRuns.value = runs
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
        // subagents: its end is its parent's business; no chime, unread dot or history for it.
        if (isSubagent(event.sessionID)) {
          if (running.value.delete(event.sessionID)) running.value = new Set(running.value)
          break
        }
        noteRunEnded(event.sessionID)
        endOfficeWatches(event.sessionID)
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
        // subagents: shown in its own transcript in the 子智能体 tab, nowhere else.
        if (isSubagent(event.sessionID)) {
          if (running.value.delete(event.sessionID)) running.value = new Set(running.value)
          setSideError(event.sessionID, event.error)
          break
        }
        noteRunEnded(event.sessionID)
        endOfficeWatches(event.sessionID)
        running.value.delete(event.sessionID)
        turnStarted.delete(event.sessionID)
        noteError(event.sessionID, event.error)
        // The banner is only for the session on screen; the record is kept for
        // all of them, so the sidebar can mark the ones that went wrong.
        if (event.sessionID === currentID.value) error.value = event.error
        if (isSide(event.sessionID)) setSideError(event.sessionID, event.error)
        break
      case "permission.requested": {
        // subagents: filed under the conversation a subagent works for, so its dock and its row show it.
        const key = rootOf(event.request.sessionID)
        const queue = pendingPermissions.value.get(key) ?? []
        if (queue.some((request) => request.id === event.request.id)) break
        const next = new Map(pendingPermissions.value)
        next.set(key, [...queue, event.request])
        pendingPermissions.value = next
        break
      }
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
      case "permission.resolved":
        dropPermission(event.requestID)
        break
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

    const instance = new Client(bootstrap.port, bootstrap.secret)
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
      /*
       * And said out loud in the meantime. Frames raised while the socket is
       * down are queued rather than refused, so without this a message sent in
       * the gap looked like nothing happened at all - until either it suddenly
       * went, or the whole screen became the boot overlay. MiMo says the same
       * thing here: the connection is coming back, and what you sent will go
       * the moment it is. Held a beat so a restart that is over in a blink
       * shows nothing.
       */
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      if (up) notice.dismiss(RECONNECT_TOAST)
      else if (booted) {
        reconnectTimer = setTimeout(() => {
          notice.warning(t("error.connectionRecovering"), { id: RECONNECT_TOAST, duration: 0, closable: false })
        }, RECONNECT_DELAY)
      }
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

    const settings = await instance.request({ type: "config.get" })
    config.value = settings.config
    /*
     * MiMo's CONFIG_INVALID, said rather than only noted.
     *
     * A settings file that would not parse was recorded in the backend and
     * nowhere else: the app opened on the defaults and the reader was left to
     * work out for themselves where their settings had gone. The damaged file
     * is kept, so the notice stays up until it is dismissed.
     */
    if (settings.unreadable) notice.warning(t("error.configInvalid"), { duration: 0 })
    else if (settings.fromNewerVersion) notice.warning(t("error.configNewer"), { duration: 0 })
    providers.value = (await instance.request({ type: "provider.list" })).providers
    const listed = await instance.request({ type: "session.list" })
    // subagents: listed apart from both, as their own conversations are.
    subagentSessions.value = listed.sessions.filter((session) => session.parentID)
    sessions.value = listed.sessions.filter((session) => !session.sideOf && !session.parentID)
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
    pendingPermissions.value = groupPermissions(listed.permissions)
    chatLinks.value = listed.chatLinks ?? {}
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

  /* Where that list stands, so MiMo's slash menu can say loading or failed rather than "no commands". */
  const commandsState = ref<"idle" | "loading" | "ready" | "failed">("idle")

  /* MiMo's background load tries once more this long after a failure. */
  const COMMAND_RETRY_MS = 1500

  /**
   * Re-reads the commands a project offers.
   *
   * Asked per directory because two of the three sources are the project's own
   * files. A refused or missing answer is a failure, not an empty list: the
   * menu says so, asks again the next time it opens, and a failed read is tried
   * once more after a moment on its own.
   */
  async function refreshCommands(directory?: string, retry = true) {
    const where = directory ?? current.value?.directory ?? config.value?.directory
    if (!where) {
      commands.value = []
      commandsFor = undefined
      commandsState.value = "idle"
      return
    }
    commandsFor = where
    commandsState.value = "loading"
    const result = await client.value
      ?.request({ type: "command.list", directory: where })
      .catch(() => undefined)
    // A second refresh may have overtaken this one; the newer answer wins.
    if (commandsFor !== where) return
    if (!result) {
      commands.value = []
      commandsState.value = "failed"
      if (retry) {
        setTimeout(() => {
          if (commandsFor === where && commandsState.value === "failed") void refreshCommands(where, false)
        }, COMMAND_RETRY_MS)
      }
      return
    }
    commands.value = result.commands
    commandsState.value = "ready"
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
      subagentSessions.value = listed.sessions.filter((session) => session.parentID)
      sessions.value = listed.sessions.filter((session) => !session.sideOf && !session.parentID)
      sideSessions.value = listed.sessions.filter((session) => session.sideOf)
      running.value = new Set(listed.running)
      clockTurns(listed.running)
      summarising.value = new Set(listed.compacting)
      // The same replay as on boot: a socket that dropped missed anything
      // published while it was down, a permission request included.
      pendingPermissions.value = groupPermissions(listed.permissions)
      chatLinks.value = listed.chatLinks ?? {}
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
    /*
     * MiMo switches at once: the conversation clicked is the one on screen,
     * saying 正在加载对话… until its messages arrive, and nothing of the one left
     * stays to be clicked. Opening the one already on screen again (a resync)
     * keeps what it shows. A failed read leaves the line up, as MiMo's does.
     */
    if (currentID.value !== sessionID) {
      hold(currentID.value)
      // Coming back to one still held draws it at once, as MiMo does; the read below refreshes it.
      const kept = held.get(sessionID)
      held.delete(sessionID)
      currentID.value = sessionID
      partIndex.clear()
      error.value = undefined
      if (kept) {
        loadingID.value = undefined
        messages.value = kept
        messages.value.forEach(reindex)
      } else {
        loadingID.value = sessionID
        messages.value = []
      }
    }
    const result = await api().request({ type: "session.get", sessionID })
    // Left for another conversation while this one was read: its answer is not shown.
    if (currentID.value !== sessionID) return
    loadingID.value = undefined
    if (unseen.value.has(sessionID)) {
      const next = new Set(unseen.value)
      next.delete(sessionID)
      unseen.value = next
    }
    track(sessionID)
    recent.value = [sessionID, ...recent.value.filter((id) => id !== sessionID)].slice(0, 50)
    const fresh = result.messages.map(readLegacyMessage)
    // Replaced only when the read differs from what is on show: an identical list would be drawn again for nothing.
    if (transcriptKey(fresh) !== transcriptKey(messages.value)) {
      messages.value = fresh
      partIndex.clear()
      messages.value.forEach(reindex)
    }
    error.value = undefined
    noteError(sessionID, undefined)
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
    messages.value = result.messages.map(readLegacyMessage)
    partIndex.clear()
    messages.value.forEach(reindex)
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
    // Known to be empty, so it opens straight onto its hero rather than a loading line.
    hold(currentID.value)
    currentID.value = result.session.id
    messages.value = []
    partIndex.clear()
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
  /*
   * MiMo names a branch off a reply 「{title} (分支)」 and keeps the title for
   * 在新对话中继续; `here` is the reply's own toast, 已从此处创建分支, where the
   * others say they branched the current conversation. A failure says so.
   */
  async function forkFrom(messageID: string, how: { titleSuffix?: boolean; here?: boolean } = {}) {
    if (!currentID.value) return undefined
    const result = await api()
      .request({
        type: "session.fork",
        sessionID: currentID.value,
        messageID,
        ...(how.titleSuffix ? { titleSuffix: true } : {}),
      })
      .catch(() => undefined)
    if (!result) {
      notifyFailure(t("stream.forkFailed"))
      return undefined
    }
    const { session } = result
    // Same guard as create(): the session.updated event usually lands first.
    if (!sessions.value.some((entry) => entry.id === session.id)) sessions.value.unshift(session)
    await open(session.id)
    notify(how.here ? t("stream.forkedFromHere") : t("stream.forkedFromCurrent"))
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
   * MiMo's edit and retry: the messages from this one on are deleted, and no
   * file moves.
   *
   * Taken off the list here as well as on the server. No event says messages
   * left, and a reread racing the resend that follows could come back without
   * the question just sent.
   */
  async function truncate(sessionID: string, messageID: string) {
    const result = await api().request({ type: "session.revert", sessionID, messageID, files: false })
    const at = sessions.value.findIndex((entry) => entry.id === result.session.id)
    if (at >= 0) sessions.value[at] = result.session
    if (sessionID === currentID.value) {
      const cut = messages.value.findIndex((message) => message.id === messageID)
      if (cut >= 0) {
        messages.value = messages.value.slice(0, cut)
        partIndex.clear()
        messages.value.forEach(reindex)
      }
      history.value = result.history
    }
    // A side chat keeps its transcript by id, loaded whether or not its tab is the one on show.
    const sideList = sideTranscripts.value[sessionID]
    if (sideList) {
      const cut = sideList.findIndex((message) => message.id === messageID)
      if (cut >= 0) {
        const kept = sideList.slice(0, cut)
        sideTranscripts.value = { ...sideTranscripts.value, [sessionID]: kept }
        sidePartIndexes.delete(sessionID)
        kept.forEach((message) => sideReindex(sessionID, message))
      }
    }
  }

  /*
   * MiMo's search result: go to a message in the open conversation and flash
   * it. The stream carries it out; this records the ask with when it was made,
   * so asking for the same message twice still reads as a change.
   */
  const revealRequest = ref<{ id: string; at: number }>()
  function revealMessage(id: string) {
    revealRequest.value = { id, at: Date.now() }
  }

  /*
   * The edited-files card's current diff, one patch per file. Kept per set of
   * paths, as MiMo keeps its figures, so a transcript of many cards asks once
   * for each; 审阅 asks afresh.
   */
  function askTurnDiff(directory: string, files: string[]) {
    return api().request({ type: "git.diffFiles", directory, files })
  }
  const turnDiffs = new Map<string, ReturnType<typeof askTurnDiff>>()
  function turnDiff(directory: string, files: string[], fresh = false) {
    const key = [directory, ...[...files].sort()].join("\n")
    const kept = fresh ? undefined : turnDiffs.get(key)
    if (kept) return kept
    const asked = askTurnDiff(directory, files)
    turnDiffs.delete(key)
    turnDiffs.set(key, asked)
    if (turnDiffs.size > 64) turnDiffs.delete(turnDiffs.keys().next().value as string)
    asked.catch(() => turnDiffs.delete(key))
    return asked
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

  /**
   * Which project the side column files a conversation under, as MiMo's
   * `moveToProject` does. Nothing else moves - not the transcript, and not the
   * folder it works in - so the project's commands are still the right ones.
   */
  async function move(sessionID: string, directory: string) {
    await api().request({ type: "session.move", sessionID, directory })
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

  /* The row menu's other half, as MiMo toggles it: the finished-while-away and the failed mark both go. */
  function markRead(sessionID: string) {
    if (unseen.value.has(sessionID)) {
      const next = new Set(unseen.value)
      next.delete(sessionID)
      unseen.value = next
    }
    if (sessionErrors.value.has(sessionID)) noteError(sessionID, undefined)
  }

  /** Returns false when the message was not accepted, so the draft can survive. */
  /* `to` names a side chat; without it the message goes to the open conversation. */
  async function send(
    text: string,
    attachments: Attachment[] = [],
    to?: string,
    annotations: import("@shared/protocol").Annotation[] = [],
    /* What a slash command named, for the turn this starts only. */
    command?: { agent?: import("@shared/protocol").AgentName; model?: import("@shared/protocol").ModelRef },
  ): Promise<boolean> {
    const target = to ?? currentID.value
    // An attachment, or a place pointed at, with no words is still something to answer.
    if (!target || (!text.trim() && !attachments.length && !annotations.length)) return false
    const onSide = isSide(target)
    const report = (message: string | undefined) => {
      if (onSide) setSideError(target, message)
      else error.value = message
    }
    report(undefined)
    noteError(target, undefined)

    /*
     * MiMo's 暂无可用模型: a conversation whose model no connected provider
     * serves is not sent. It is said as a notice rather than in the transcript,
     * the model list is asked for again, and the draft stays.
     */
    const chosen = (onSide ? sideSessionOf(target) : sessions.value.find((session) => session.id === target))?.model
    const provider = providers.value.find((entry) => entry.id === chosen?.provider)
    if (!chosen || !provider?.configured) {
      notifyFailure(t("model.none"))
      void refreshProviders().catch(() => undefined)
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
    // Documents the user changed since the last message go with this one, for the model to read first.
    const fileNotices = onSide ? [] : takeFileNotices(target)
    try {
      await api().request({
        type: "session.prompt",
        sessionID: target,
        text,
        attachments,
        ...(annotations.length ? { annotations } : {}),
        ...(fileNotices.length ? { fileNotices } : {}),
        ...(command?.agent ? { agent: command.agent } : {}),
        ...(command?.model ? { model: command.model } : {}),
      })
      return true
    } catch (err) {
      returnFileNotices(target, fileNotices)
      if (!joined) {
        running.value.delete(target)
        turnStarted.delete(target)
      }
      report(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /*
   * 停止, with MiMo's persistence behind it: three attempts, 400 ms apart.
   *
   * The backend's own stop cannot fail - it is a synchronous abort on a runner
   * it already holds - so the only exposed part is getting the request there.
   * A socket dropping at the moment of the press used to leave the turn running
   * with nothing said anywhere, because every call site let the promise go.
   */
  const ABORT_TRIES = 3
  const ABORT_GAP = 400

  async function abort(to?: string) {
    const target = to ?? currentID.value
    if (!target) return
    // Before the request: the idle that follows a stop may arrive ahead of its answer.
    turnStarted.delete(target)
    let failure: unknown
    for (let attempt = 1; attempt <= ABORT_TRIES; attempt++) {
      try {
        await api().request({ type: "session.abort", sessionID: target })
        running.value.delete(target)
        return
      } catch (err) {
        failure = err
        if (attempt < ABORT_TRIES) await new Promise((resolve) => setTimeout(resolve, ABORT_GAP))
      }
    }
    // The turn is still running, and stays marked so; what the reader must not have is silence.
    notifyFailure(t("error.abortFailed"), failure instanceof Error ? failure.message : String(failure))
  }

  /**
   * 继续: the interrupted last turn runs on with no new message.
   *
   * False when the server would not carry it on, so the box can say so. Marked
   * running before the request, as a send is, because the turn's first events
   * can arrive ahead of the answer.
   */
  async function resume(to?: string): Promise<boolean> {
    const target = to ?? currentID.value
    if (!target || running.value.has(target)) return false
    if (isSide(target)) setSideError(target, undefined)
    else error.value = undefined
    noteError(target, undefined)
    running.value.add(target)
    turnStarted.set(target, Date.now())
    try {
      await api().request({ type: "session.resume", sessionID: target })
      return true
    } catch {
      running.value.delete(target)
      turnStarted.delete(target)
      return false
    }
  }

  /** The request whose answer is in flight, so the panel can disable itself. */
  const responding = ref<string>()

  /** Takes one turn's file changes back out of the project; the card turns into its reverted form on the message update. */
  async function revertTurn(sessionID: string, messageIDs: string[]) {
    return api().request({ type: "session.revertTurn", sessionID, messageIDs })
  }

  async function respond(response: PermissionResponse, reason?: string) {
    const request = permission.value
    if (!request || responding.value === request.id) return
    responding.value = request.id
    try {
      const said = response === "reject" ? reason?.trim() : undefined
      await api().request({
        type: "permission.respond",
        requestID: request.id,
        response,
        ...(said ? { reason: said } : {}),
      })
      dropPermission(request.id)
    } catch (err) {
      // The request stays up: the tool is still waiting on an answer, and
      // clearing it here would strand the turn with nothing on screen.
      notifyFailure(t("perm.failed"), err instanceof Error ? err.message : String(err))
    } finally {
      if (responding.value === request.id) responding.value = undefined
    }
  }

  /** MiMo's per-conversation access level; the home screen's chip changes the default instead. */
  async function setAccess(sessionID: string, access: "ask" | "auto" | "full") {
    await api().request({ type: "session.access", sessionID, access })
  }

  /** MiMo's effort is one app-wide level: every conversation, and the next, runs at it. */
  async function setEffort(effort: Effort) {
    await patchConfig({ effort })
  }

  async function setModel(model: ModelRef, to?: string) {
    const target = to ?? currentID.value
    if (!target) return
    await api().request({ type: "session.model", sessionID: target, model })
    // A side chat's model is its own; the default follows the open conversation.
    if (!isSide(target)) await patchConfig({ model, smart: false })
  }

  /** Puts a conversation on Smart, and makes Smart the start for the next one. */
  async function setSmart(to?: string) {
    const target = to ?? currentID.value
    if (!target) return
    await api().request({ type: "session.smart", sessionID: target })
    if (!isSide(target)) await patchConfig({ smart: true })
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

  /* MiMo's shortcut: voice input flips between 智能编辑 and 快速输入. */
  async function toggleVoiceMode() {
    await patchConfig({ voiceMode: (config.value?.voiceMode ?? "smart") === "fast" ? "smart" : "fast" })
  }

  /*
   * MiMo's shortcut for 编排 (compose) mode: on or off for the open
   * conversation, or - from the home screen (`home`) - for the next task. As
   * the plus menu's switch does, turning it on leaves plan mode.
   */
  async function toggleComposeMode(home = false) {
    const session = home ? undefined : current.value
    const before = modeOf(session?.id)
    const next = !(session ? (session.staged ?? false) : (config.value?.staged ?? false))
    if (next && (session?.agent ?? config.value?.agent) === "plan") {
      if (session) await setAgent("build")
      else await patchConfig({ agent: "build" })
    }
    if (session) await setStaged(next)
    else await patchConfig({ staged: next })
    announceMode(before, session?.id)
  }

  /*
   * MiMo's switch notices (store:composer): said once a pick has landed, never
   * for a change the app made by itself. What was in force is read first, so
   * picking it again says nothing.
   */

  /** The model a conversation, a side chat or (without an id) the next task is on; Smart is its own pick. */
  function modelPick(to?: string): string {
    const session = to ? (isSide(to) ? sideSessionOf(to) : sessions.value.find((entry) => entry.id === to)) : undefined
    const smart = session ? session.smart : config.value?.smart
    const model = session?.model ?? config.value?.model
    return smart ? "smart" : model ? `${model.provider}/${model.model}` : ""
  }

  function announceModel(before: string, chosen: ModelRef | "smart") {
    if ((chosen === "smart" ? "smart" : `${chosen.provider}/${chosen.model}`) === before) return
    const name = chosen === "smart" ? t("model.smart") : (findModel(providers.value, chosen)?.name ?? chosen.model)
    notify(t("toast.modelPrefix", { name }))
  }

  function announceAccess(level: "ask" | "auto" | "full") {
    const key = level === "full" ? "composer.access.fullItem" : level === "auto" ? "composer.access.auto" : "composer.access.ask"
    notify(t("toast.permPrefix", { perm: t(key) }))
  }

  /* MiMo's three modes, one at a time: 计划 is the plan agent, 编排 is staged, anything else builds. */
  function modeOf(sessionID?: string): "build" | "plan" | "compose" {
    const session = sessionID ? sessions.value.find((entry) => entry.id === sessionID) : undefined
    const agent = session ? session.agent : (config.value?.agent ?? "build")
    const staged = session ? (session.staged ?? false) : (config.value?.staged ?? false)
    return agent === "plan" ? "plan" : staged ? "compose" : "build"
  }

  function announceMode(before: "build" | "plan" | "compose", sessionID?: string) {
    const after = modeOf(sessionID)
    if (after === before) return
    const label = after === "plan" ? "composer.planMode" : after === "compose" ? "composer.staged" : "composer.buildMode"
    notify(t("toast.switchedMode", { mode: t(label) }))
  }

  /*
   * MiMo's pref writer: tried twice, and a second failure is said, naming the
   * keys. The config on screen is only ever the server's answer, so a change
   * that was not saved falls back to the value that was. `quiet` is for callers
   * that say their own failure.
   */
  async function patchConfig(patch: Partial<AppConfig>, options: { quiet?: boolean } = {}) {
    let failure: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        config.value = (await api().request({ type: "config.set", patch })).config
        return
      } catch (err) {
        failure = err
      }
    }
    if (!options.quiet) notifyFailure(t("toast.prefSaveFailed", { key: Object.keys(patch).join(", ") }))
    throw failure
  }

  /* The project list the side column, the home picker and move-to-project read, most recent first. */
  const projects = computed(() => projectsByRecency(config.value, sessions.value))

  /**
   * MiMo's project add: onto the list with no conversation. `used` makes it the
   * latest pick, so it heads the list; `switched` says the caller makes it the
   * current project, which is the only time MiMo's "already exists, switched to
   * it" is true here. `silent` says nothing at all.
   */
  async function addProject(directory: string, options: { used?: boolean; switched?: boolean; silent?: boolean } = {}) {
    const result = await api().request({ type: "project.add", directory, ...(options.used ? { used: true } : {}) })
    config.value = result.config
    if (options.silent || (result.existed && !options.switched)) return
    const name = projectName(directory, result.config.projectNames)
    notify(t(result.existed ? "side.projectExists" : "side.projectAdded", { name }))
  }

  /** MiMo's remove: off the list, conversations kept. */
  async function removeProjects(directories: string[]) {
    if (!directories.length) return
    config.value = (await api().request({ type: "project.remove", directories })).config
    notify(directories.length > 1 ? t("side.projectsRemoved", { count: directories.length }) : t("side.projectRemoved"))
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
    const chosen = config.value?.model

    // Nothing to do when the current pick still works and no move was asked for.
    const preferReady = Boolean(prefer && providers.value.some((entry) => entry.id === prefer && entry.configured && entry.models.length))
    if ((!prefer || !preferReady) && modelAvailable(providers.value, chosen)) return

    const ref = fallbackModel(availableModels(providers.value), preferReady ? prefer : undefined)
    if (!ref) return
    await patchConfig({ model: ref })
    // An open session keeps its own model, so it has to be moved explicitly; the others follow on their next turn.
    const open = currentID.value ? sessions.value.find((entry) => entry.id === currentID.value) : undefined
    if (open && !modelAvailable(providers.value, open.model)) await api().request({ type: "session.model", sessionID: open.id, model: ref })
    else if (open && preferReady) await api().request({ type: "session.model", sessionID: open.id, model: ref })
  }

  /**
   * The model a conversation runs on, as the window shows it: its own while
   * that is still there, otherwise the app's - which is what its next turn
   * will move to (MiMo's conversations follow the global model once theirs
   * has gone).
   */
  function shownModel(ref: ModelRef | undefined): ModelRef | undefined {
    if (ref && modelAvailable(providers.value, ref)) return ref
    return config.value?.model?.model ? config.value.model : ref
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
    protocol?: "openai" | "anthropic"
  }) {
    providers.value = (await api().request({ type: "provider.addCustom", ...entry })).providers
    await ensureUsableModel()
  }

  async function removeCustomProvider(provider: string) {
    providers.value = (await api().request({ type: "provider.removeCustom", provider })).providers
  }

  /** Saves an edited custom provider under its own id; a blank key keeps the one held. */
  async function updateCustomProvider(entry: {
    id: string
    name: string
    baseURL: string
    apiKey: string
    headers?: Record<string, string>
    models: CustomModel[]
    protocol?: "openai" | "anthropic"
  }) {
    providers.value = (await api().request({ type: "provider.updateCustom", ...entry })).providers
    await ensureUsableModel()
  }

  /** Copies a custom provider under a free id, and answers that id. */
  async function copyCustomProvider(provider: string, name: string): Promise<string> {
    const result = await api().request({ type: "provider.copyCustom", provider, name })
    providers.value = result.providers
    return result.id
  }

  /** The turn currently streaming, if any - used to anchor the scroll. */
  /**
   * Opens a side chat beside a conversation: a new, numbered conversation in
   * the same project that no list shows. An empty one this conversation already
   * has is taken up again rather than leaving a trail of blank ones behind.
   */
  async function openSide(parentID: string, taken: string[] = []) {
    const parent = sessions.value.find((session) => session.id === parentID)
    if (!parent) return
    // A conversation another open chat tab holds is that tab's, even while it is still empty.
    const previous = sideSessions.value
      .filter((session) => session.sideOf === parentID && !taken.includes(session.id))
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
    if (!sideTranscripts.value[chosen.id]) sideTranscripts.value = { ...sideTranscripts.value, [chosen.id]: [] }
    setSideError(chosen.id, undefined)
    sideID.value = chosen.id
    return chosen.id
  }

  /**
   * Reads a side conversation that already exists into its own transcript,
   * once: after that its events keep it current whether or not it is on show.
   */
  async function loadSide(sessionID: string) {
    if (sideTranscripts.value[sessionID]) return
    const result = await api().request({ type: "session.get", sessionID }).catch(() => undefined)
    if (!result || sideTranscripts.value[sessionID]) return
    sidePartIndexes.delete(sessionID)
    const read = result.messages.map(readLegacyMessage)
    read.forEach((message) => sideReindex(sessionID, message))
    sideTranscripts.value = { ...sideTranscripts.value, [sessionID]: read }
  }

  /** subagents: reads a subagent's transcript, for the 子智能体 tab; false when it could not be read. */
  async function loadSubagent(sessionID: string): Promise<boolean> {
    await loadSide(sessionID)
    return Boolean(sideTranscripts.value[sessionID])
  }

  /**
   * subagents: a slash command marked `subtask`, run as a subagent in the open
   * conversation. The line as typed is the message; marked running before the
   * request, as a send is, because the turn's first events can arrive first.
   */
  async function subtask(text: string, command: { description: string; prompt: string }): Promise<boolean> {
    const target = currentID.value
    if (!target) return false
    error.value = undefined
    noteError(target, undefined)
    const joined = running.value.has(target)
    running.value.add(target)
    if (!joined) turnStarted.set(target, Date.now())
    try {
      await api().request({ type: "session.subtask", sessionID: target, text, description: command.description, prompt: command.prompt })
      return true
    } catch (err) {
      if (!joined) {
        running.value.delete(target)
        turnStarted.delete(target)
      }
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  /**
   * Shows a side conversation that already exists: the one a right panel chat
   * tab holds, coming back to it after another tab or another conversation.
   */
  async function showSide(sessionID: string) {
    sideID.value = sessionID
    await loadSide(sessionID)
  }

  function closeSide() {
    sideID.value = undefined
  }

  const sideStreaming = computed<AssistantMessage | undefined>(() => sideStreamingOf(sideID.value))

  const streaming = computed<AssistantMessage | undefined>(() => {
    if (!busy.value) return undefined
    const last = messages.value[messages.value.length - 1]
    return last?.role === "assistant" ? last : undefined
  })

  /*
   * The tray's 配置切换 answers with a toast, as MiMo's does. The window
   * applies the pick; this only names it. MiMo adds "active in your next chat",
   * which MCode leaves out because the switch applies at once.
   */
  if (typeof window !== "undefined" && window.mcode?.onTrayProfile) {
    window.mcode.onTrayProfile((key) => {
      const cut = key.indexOf("/")
      if (cut <= 0) return
      const provider = providers.value.find((entry) => entry.id === key.slice(0, cut))
      const model = provider?.models.find((entry) => entry.id === key.slice(cut + 1))
      notice.success(t("tray.switched", { name: model ? withoutLatest(model.name || model.id) : key.slice(cut + 1) }))
    })
  }

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
    closeTab,
    messages,
    loadingID,
    busy,
    replacing,
    markReplacing,
    compacting,
    error,
    config,
    providers,
    commands,
    commandsState,
    refreshCommands,
    toggleVoiceMode,
    toggleComposeMode,
    permission,
    permissionQueue,
    revertTurn,
    responding,
    pendingPermissions,
    unseen,
    unread,
    failed,
    markAllRead,
    running,
    // session chat
    chatLinks,
    chatLinksOf,
    finished,
    automationRuns,
    automationNotice,
    clearPermission,
    reopenTab,
    recent,
    forkFrom,
    isPinned,
    togglePinned,
    streaming,
    side,
    sideID,
    // subagents
    subagentSessions,
    rootOf,
    loadSubagent,
    subtask,
    sideMessages,
    sideBusy,
    sideStreaming,
    sideError,
    sideMessagesOf,
    sideErrorOf,
    sideSessionOf,
    sideBusyOf,
    sideStreamingOf,
    openSide,
    loadSide,
    showSide,
    closeSide,
    start,
    open,
    create,
    remove,
    rename,
    move,
    markUnread,
    markRead,
    archive,
    compact,
    history,
    refreshHistory,
    undo,
    redo,
    truncate,
    turnDiff,
    revealRequest,
    revealMessage,
    revertedAt,
    rolledBack,
    visible,
    systemPrompt,
    send,
    abort,
    resume,
    respond,
    setModel,
    setSmart,
    setEffort,
    setAccess,
    setAgent,
    setStaged,
    patchConfig,
    fsNonce,
    bumpFsNonce,
    homeProject,
    modelPick,
    announceModel,
    announceAccess,
    modeOf,
    announceMode,
    projects,
    addProject,
    removeProjects,
    setDefaultServer,
    setProviderEndpoint,
    setApiKey,
    authState,
    workspaceInfo,
    gitStatus,
    gitInit,
    gitDiff,
    gitRevert,
    beginAuth,
    cancelAuth,
    signOut,
    ensureUsableModel,
    shownModel,
    discoverModels,
    addCustomProvider,
    removeCustomProvider,
    updateCustomProvider,
    copyCustomProvider,
  }
})
