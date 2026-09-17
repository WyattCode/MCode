import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { AssistantMessage, ChatLink, ChatTaskStatus, Message, MessageSource, SessionInfo, TextPart } from "@shared/protocol"
import type { Bus } from "../bus"
import type { SessionStore } from "./store"
import type { Storage } from "../storage"

/*
 * session chat: one conversation messaging another, as MiMo's session-chat
 * tools do.
 *
 * A message runs a real turn in the target, visible there and marked with where
 * it came from. Each target takes one message at a time, in order: a message to
 * a conversation that is working waits until it stops. The reply is the
 * target's last message of that turn, and goes back either to the tool call
 * still waiting for it or - when the call did not wait - into the caller as a
 * marked message of its own, which runs a turn there.
 *
 * Nothing here is stored. A queue is only as long-lived as the app, which is how
 * long the turns it is waiting on live.
 */

/** Chained calls (A to B to C...) stop here, so two conversations cannot keep each other going. */
export const CHAT_HOPS = 5
/** How long a waiting call waits for its reply before it lets go. */
export const CHAT_WAIT_MS = 120_000
/** The most contacts listed or offered as candidates. */
export const CONTACTS_MAX = 50

/**
 * What the runner lends: whether a turn is running, making a conversation, and
 * `prompt` - the same path a typed message and a subagent's follow-up take, the
 * message marked with its source (`inbox`) as the subagents' inbox marks one.
 */
export interface ChatTurns {
  isRunning(sessionID: string): boolean
  prompt(input: { sessionID: string; text: string; inbox: MessageSource }): Promise<string>
  create(input: { directory: string; title: string }): Promise<SessionInfo>
}

export interface ChatContact {
  id: string
  title: string
  busy: boolean
  purpose?: string
  task?: string
  taskStatus?: ChatTaskStatus
  workspace: string
  updated: number
}

export type ChatOutcome = { ok: true; reply: string } | { ok: false; error: string }

export type TalkResult =
  | { status: "replied"; title: string; reply: string }
  /** Queued behind other work, or sent without waiting; the reply comes back as a message. */
  | { status: "queued"; busy: boolean }
  /** Waited the full time while the target was still working; the reply comes back as a message. */
  | { status: "switched" }
  /** Never reached the target. */
  | { status: "refused"; error: string; candidates?: ChatContact[] }
  /** Reached it, but its turn gave nothing back. */
  | { status: "failed"; error: string }
  | { status: "stopped" }

export type ChatChange = { ok: true; session: SessionInfo } | { ok: false; error: string }

/*
 * What the model reads from these tools is in Chinese, as MiMo's session chat
 * speaks to its model (the user's 2026-09-17 decision), in this app's own words.
 */
const SELF = "不能给当前会话自己发消息。"
const HOPS = `会话之间的连续调用已达到 ${CHAT_HOPS} 跳上限，为避免循环已拒绝。请根据已有结果直接作答，不要再调用其他会话。`
const GONE = "目标会话已不存在，可能已被删除。"
/** What the caller is told about a message whose turn the app outlived. */
const INTERRUPTED = "对方会话处理这条消息时应用被关闭了，所以没有收到回复。如果仍然需要，请重新发送。"
/** Where the queue is kept between runs. */
const QUEUE_KEY = "chat-queue"
/** Older than this and a message is not delivered on a later start: it is no longer what anyone asked for. */
const RESTORE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const TIMEOUT = `对方在 ${CHAT_WAIT_MS / 1000} 秒内没能开始处理这条消息。请稍后再试，或改用 mode "async" 发送。`

interface Entry {
  target: string
  targetTitle: string
  from: string
  fromTitle: string
  text: string
  hop: number
  kind: "request" | "reply"
  state: "waiting" | "running"
  /** The message the target's turn was started with, where its reply is looked for. */
  messageID?: string
  /** The sender was deleted: nothing to link back to and nowhere to deliver a reply. */
  fromGone?: boolean
  /** When it joined the queue, so a restart can leave a stale message alone. */
  at?: number
  /** A waiting call has had its answer, or there never was one waiting. */
  settled: boolean
  resolve?: (result: TalkResult) => void
  onReply?: (outcome: ChatOutcome) => void
  timer?: ReturnType<typeof setTimeout>
  release?: () => void
}

/** One queued message as it is kept on disk; the promises and timers a live entry holds cannot be. */
interface StoredEntry {
  target: string
  targetTitle: string
  from: string
  fromTitle: string
  text: string
  hop: number
  kind: "request" | "reply"
  state: "waiting" | "running"
  at: number
}

/** Who can be messaged: conversations the side column lists, not subagents, side chats or archived ones. */
function listed(session: SessionInfo): boolean {
  return !session.parentID && !session.sideOf && !session.archived
}

/**
 * What a model is told in front of a message from another conversation, in the
 * request only: the transcript keeps the words as they were sent.
 */
export function chatHeader(source: MessageSource): string {
  return source.direction === "reply"
    ? `【跨会话消息｜会话「${source.from}」（contact_id ${source.sessionID}）对本会话所发消息的回复】`
    : `【跨会话消息｜来自会话「${source.from}」（contact_id ${source.sessionID}）】本回合的最终回复会作为答复发回给它。`
}

/** The history a model is sent, with each chat message carrying its header; a subagent's follow-up is left alone. */
export function withChatHeaders(history: Message[]): Message[] {
  return history.map((message) =>
    message.role === "user" && message.inbox?.sessionID ? { ...message, text: `${chatHeader(message.inbox)}\n\n${message.text}` } : message,
  )
}

/** The reply a turn gave: the last reply after the message that started it, or why there is none. */
export function replyIn(messages: Message[], messageID?: string): ChatOutcome {
  let at = messageID ? messages.findIndex((message) => message.id === messageID) : -1
  if (at < 0) at = messages.map((message) => message.role === "user" && Boolean(message.inbox?.sessionID)).lastIndexOf(true)
  const last = messages
    .slice(at + 1)
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant")
  const text = (last?.parts ?? [])
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  if (text) return { ok: true, reply: text }
  if (last?.error) return { ok: false, error: `对方回合出错：${last.error}` }
  if (last?.finish === "aborted") return { ok: false, error: "对方回合在回复之前被停止了。" }
  return { ok: false, error: "对方回合已结束，但没有可以带回的文字回复。" }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

export class SessionChat {
  private readonly queues = new Map<string, Entry[]>()
  /** The hop count of the chat message each conversation is handling right now. */
  private readonly hops = new Map<string, number>()
  private announcing = false

  constructor(
    private readonly store: SessionStore,
    private readonly bus: Bus,
    private readonly turns: ChatTurns,
    private readonly waitMs = CHAT_WAIT_MS,
    /** Where the queue is kept, so a message in flight survives a quit. Absent in checks that do not need it. */
    private readonly storage?: Storage,
  ) {
    bus.subscribe((event) => {
      if (event.type === "session.idle") void this.turnEnded(event.sessionID)
      else if (event.type === "session.deleted") this.forget(event.sessionID)
    })
  }

  private contactOf(session: SessionInfo): ChatContact {
    return {
      id: session.id,
      title: session.title,
      busy: this.turns.isRunning(session.id),
      ...(session.chat?.purpose ? { purpose: session.chat.purpose } : {}),
      ...(session.chat?.task ? { task: session.chat.task } : {}),
      ...(session.chat?.taskStatus ? { taskStatus: session.chat.taskStatus } : {}),
      workspace: session.directory,
      updated: session.updated,
    }
  }

  /** Everyone the caller can message, most recently active first (the store lists that way). */
  async contacts(fromID: string): Promise<ChatContact[]> {
    const sessions = await this.store.list()
    return sessions
      .filter((session) => session.id !== fromID && listed(session))
      .slice(0, CONTACTS_MAX)
      .map((session) => this.contactOf(session))
  }

  async talk(input: {
    from: string
    contact?: string
    contactID?: string
    message: string
    mode: "sync" | "async"
    signal?: AbortSignal
  }): Promise<TalkResult> {
    const message = input.message.trim()
    if (!message) return { status: "refused", error: "消息不能为空。" }
    const caller = await this.store.get(input.from)
    if (!caller || !listed(caller)) return { status: "refused", error: "只有侧栏里的会话才能给其他会话发消息。" }

    const everyone = (await this.store.list()).filter(listed)
    const others = everyone.filter((session) => session.id !== caller.id)
    const offered = () => others.slice(0, CONTACTS_MAX).map((session) => this.contactOf(session))
    let target: SessionInfo | undefined
    const id = input.contactID?.trim()
    if (id) {
      if (id === caller.id) return { status: "refused", error: SELF }
      target = others.find((session) => session.id === id)
      if (!target) return { status: "refused", error: `没有 contact_id 为 ${id} 的联系人。可以先用 contacts 查看通讯录。`, candidates: offered() }
    } else {
      const name = input.contact?.trim() ?? ""
      if (!name) return { status: "refused", error: "请用联系人的完整标题或 contact_id 指明对方。" }
      const named = everyone.filter((session) => session.title.trim() === name)
      const matches = named.filter((session) => session.id !== caller.id)
      if (!named.length) return { status: "refused", error: `没有标题为「${name}」的联系人。可以先用 contacts 查看通讯录。`, candidates: offered() }
      if (!matches.length) return { status: "refused", error: SELF }
      if (matches.length > 1) {
        return {
          status: "refused",
          error: `有多个会话的标题都是「${name}」。请从候选中选出要找的那个，用它的 contact_id 重试。`,
          candidates: matches.map((session) => this.contactOf(session)),
        }
      }
      target = matches[0]
    }

    const hop = (this.hops.get(caller.id) ?? 0) + 1
    if (hop > CHAT_HOPS) return { status: "refused", error: HOPS }

    const entry: Entry = {
      target: target.id,
      targetTitle: target.title,
      from: caller.id,
      fromTitle: caller.title,
      text: message,
      hop,
      kind: "request",
      state: "waiting",
      settled: false,
    }
    const peer = { id: target.id, title: target.title }
    const busy = this.turns.isRunning(target.id) || (this.queues.get(target.id)?.length ?? 0) > 0
    if (input.mode === "async" || busy) {
      entry.settled = true
      entry.onReply = (outcome) => void this.replyTo(caller.id, peer, hop, outcome)
      this.enqueue(entry)
      return { status: "queued", busy }
    }
    if (input.signal?.aborted) return { status: "stopped" }

    return new Promise<TalkResult>((resolve) => {
      entry.resolve = resolve
      entry.timer = setTimeout(() => {
        if (entry.settled) return
        if (entry.state === "waiting") {
          this.remove(entry)
          this.settle(entry, { status: "refused", error: TIMEOUT })
          this.pump(entry.target)
          return
        }
        // Still working on it: its reply comes back as a message rather than being thrown away.
        entry.onReply = (outcome) => void this.replyTo(caller.id, peer, hop, outcome)
        this.settle(entry, { status: "switched" })
      }, this.waitMs)
      /*
       * The caller was stopped. A message not yet started is taken back; one
       * already running finishes there, with nobody waiting on its reply.
       */
      const stop = () => {
        if (entry.settled) return
        if (entry.state === "waiting") {
          this.remove(entry)
          this.pump(entry.target)
        }
        this.settle(entry, { status: "stopped" })
      }
      input.signal?.addEventListener("abort", stop, { once: true })
      entry.release = () => input.signal?.removeEventListener("abort", stop)
      this.enqueue(entry)
    })
  }

  async create(input: { name: string; purpose: string; workspace: string; task?: string }): Promise<ChatChange> {
    const name = input.name.trim()
    const purpose = input.purpose.trim()
    const workspace = input.workspace.trim()
    if (!name || !purpose || !workspace) return { ok: false, error: "name、purpose 和 workspace 都必须填写。" }
    if (!isAbsolute(workspace)) return { ok: false, error: "workspace 必须是一个已存在文件夹的绝对路径。" }
    const found = await stat(workspace).catch(() => undefined)
    if (!found?.isDirectory()) return { ok: false, error: `workspace 不存在或不是文件夹：${workspace}` }
    const task = input.task?.trim()
    const made = await this.turns.create({ directory: workspace, title: name })
    const session = await this.store.update(made.id, {
      chat: { purpose, ...(task ? { task } : {}), taskStatus: task ? "working" : "idle" },
    })
    return { ok: true, session }
  }

  async update(input: { contactID: string; name?: string; purpose?: string; task?: string; taskStatus?: ChatTaskStatus }): Promise<ChatChange> {
    const id = input.contactID.trim()
    const session = id ? await this.store.get(id) : undefined
    if (!session || !listed(session)) return { ok: false, error: `没有 id 为 ${id} 的会话。` }
    if (input.name !== undefined && !input.name.trim()) return { ok: false, error: "name 不能为空。" }
    const chat = { ...(session.chat ?? {}) }
    // An empty purpose or task clears it.
    if (input.purpose !== undefined) chat.purpose = input.purpose.trim() || undefined
    if (input.task !== undefined) chat.task = input.task.trim() || undefined
    if (input.taskStatus !== undefined) chat.taskStatus = input.taskStatus
    const kept = Object.fromEntries(Object.entries(chat).filter(([, value]) => value !== undefined)) as NonNullable<SessionInfo["chat"]>
    const updated = await this.store.update(session.id, {
      ...(input.name !== undefined ? { title: input.name.trim() } : {}),
      chat: kept,
    })
    return { ok: true, session: updated }
  }

  /** Every conversation's messages in flight, each seen from its own side. */
  links(): Record<string, ChatLink[]> {
    const out: Record<string, ChatLink[]> = {}
    const add = (sessionID: string, link: ChatLink) => (out[sessionID] ??= []).push(link)
    for (const [target, queue] of this.queues) {
      queue.forEach((entry, index) => {
        const phase = entry.state === "running" ? "running" : "queued"
        const queueAhead = entry.state === "running" ? 0 : index
        add(target, { peerID: entry.fromGone ? null : entry.from, peerTitle: entry.fromTitle, direction: "inbound", kind: entry.kind, phase, queueAhead })
        // The caller is waiting only while a reply is still coming its way.
        if (entry.kind === "request" && !entry.fromGone && (entry.onReply || !entry.settled)) {
          add(entry.from, { peerID: target, peerTitle: entry.targetTitle, direction: "outbound", kind: "request", phase, queueAhead })
        }
      })
    }
    return out
  }

  /** One broadcast per tick, however many things changed in it. */
  private announce(): void {
    if (this.announcing) return
    this.announcing = true
    queueMicrotask(() => {
      this.announcing = false
      this.bus.publish({ type: "session.chatLinks", links: this.links() })
      this.persist()
    })
  }

  /**
   * The queue as it stands, written where a later run can find it.
   *
   * The queue itself is memory - a waiting call cannot outlive the process it
   * is waiting in - but the fact that a message was in flight can, and used to
   * not: quit while B was answering and A's tool call died with the process,
   * with nothing on disk to say a message had ever been sent. Both sides were
   * left without a trace. Written from the one place every change already
   * passes through.
   */
  private persist(): void {
    if (!this.storage) return
    const entries: StoredEntry[] = []
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        entries.push({
          target: entry.target,
          targetTitle: entry.targetTitle,
          from: entry.from,
          fromTitle: entry.fromTitle,
          text: entry.text,
          hop: entry.hop,
          kind: entry.kind,
          state: entry.state,
          at: entry.at ?? Date.now(),
        })
      }
    }
    void this.storage.write(QUEUE_KEY, { entries }).catch(() => undefined)
  }

  /**
   * What was in flight when the app went away.
   *
   * A message that had not started yet is sent now - that is what the caller
   * asked for, and nothing else would ever send it. One that was already being
   * worked on cannot be resumed, so its caller is told, in the same marked
   * message an unwaited-for reply would have arrived in. Anything older than a
   * day is left alone: it is no longer what anyone meant to send.
   */
  async restore(): Promise<void> {
    if (!this.storage) return
    const saved = await this.storage.read<{ entries?: StoredEntry[] }>(QUEUE_KEY).catch(() => undefined)
    const entries = (saved?.entries ?? []).filter((entry) => entry && typeof entry.text === "string" && entry.target && entry.from)
    if (!entries.length) return
    // Taken off the file first: a delivery that fails must not be tried again on every start.
    await this.storage.write(QUEUE_KEY, { entries: [] }).catch(() => undefined)
    const now = Date.now()
    for (const stored of entries) {
      if (now - (stored.at ?? 0) > RESTORE_MAX_AGE_MS) continue
      const caller = await this.store.get(stored.from).catch(() => undefined)
      if (stored.state === "running") {
        if (caller && stored.kind === "request") {
          await this.replyTo(stored.from, { id: stored.target, title: stored.targetTitle }, stored.hop, { ok: false, error: INTERRUPTED })
        }
        continue
      }
      const target = await this.store.get(stored.target).catch(() => undefined)
      if (!target || !caller) continue
      const peer = { id: target.id, title: target.title }
      this.enqueue({
        target: target.id,
        targetTitle: target.title,
        from: caller.id,
        fromTitle: caller.title,
        text: stored.text,
        hop: stored.hop,
        kind: stored.kind,
        state: "waiting",
        at: stored.at,
        settled: true,
        // Nobody is waiting on a promise any more, so the reply comes back as a message, as an async call's does.
        ...(stored.kind === "request" ? { onReply: (outcome: ChatOutcome) => void this.replyTo(caller.id, peer, stored.hop, outcome) } : {}),
      })
    }
  }

  private enqueue(entry: Entry): void {
    entry.at ??= Date.now()
    const queue = this.queues.get(entry.target) ?? []
    queue.push(entry)
    this.queues.set(entry.target, queue)
    this.announce()
    this.pump(entry.target)
  }

  private remove(entry: Entry): void {
    const queue = this.queues.get(entry.target)
    if (!queue) return
    const at = queue.indexOf(entry)
    if (at >= 0) queue.splice(at, 1)
    if (!queue.length) this.queues.delete(entry.target)
    this.announce()
  }

  private settle(entry: Entry, result: TalkResult): void {
    if (entry.settled && !entry.resolve) return
    entry.settled = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.release?.()
    const resolve = entry.resolve
    entry.resolve = undefined
    resolve?.(result)
    this.announce()
  }

  private finish(entry: Entry, outcome: ChatOutcome): void {
    if (!entry.settled) {
      this.settle(entry, outcome.ok ? { status: "replied", title: entry.targetTitle, reply: outcome.reply } : { status: "failed", error: outcome.error })
    }
    entry.onReply?.(outcome)
    this.announce()
  }

  /** Starts the next message for a target that is free to take it. */
  private pump(target: string): void {
    const head = this.queues.get(target)?.[0]
    if (!head || head.state === "running" || this.turns.isRunning(target)) return
    head.state = "running"
    this.hops.set(target, head.hop)
    this.announce()
    this.turns
      .prompt({ sessionID: target, text: head.text, inbox: { from: head.fromTitle, sessionID: head.from, direction: head.kind } })
      .then((messageID) => {
        head.messageID = messageID
      })
      .catch(async (failure: unknown) => {
        // A target deleted just as its message started reads as gone, not as a delivery fault.
        const exists = await this.store.get(target).catch(() => undefined)
        if (this.queues.get(target)?.[0] !== head) return
        this.hops.delete(target)
        this.remove(head)
        this.finish(head, { ok: false, error: exists ? `消息没能送到对方会话：${describe(failure)}` : GONE })
        this.pump(target)
      })
  }

  /** A target's turn ended: its reply goes back, and the next message in line starts. */
  private async turnEnded(target: string): Promise<void> {
    const head = this.queues.get(target)?.[0]
    if (!head) return
    if (head.state === "running") {
      const messages = await this.store.messages(target).catch((): Message[] => [])
      if (this.queues.get(target)?.[0] !== head) return
      this.hops.delete(target)
      this.remove(head)
      this.finish(head, replyIn(messages, head.messageID))
    }
    this.pump(target)
  }

  /** A reply that nobody waited for arrives in the caller as a message of its own. */
  private async replyTo(callerID: string, peer: { id: string; title: string }, hop: number, outcome: ChatOutcome): Promise<void> {
    const caller = await this.store.get(callerID)
    if (!caller) return
    const next = hop + 1
    if (next > CHAT_HOPS) return
    this.enqueue({
      target: callerID,
      targetTitle: caller.title,
      from: peer.id,
      fromTitle: peer.title,
      text: outcome.ok ? outcome.reply : `（没能取回回复）${outcome.error}`,
      hop: next,
      kind: "reply",
      state: "waiting",
      settled: true,
    })
  }

  /** A deleted conversation: its own queue fails, and what it sent elsewhere has nowhere to come back to. */
  private forget(sessionID: string): void {
    const queue = this.queues.get(sessionID) ?? []
    this.queues.delete(sessionID)
    this.hops.delete(sessionID)
    for (const entry of queue) this.finish(entry, { ok: false, error: GONE })
    for (const list of this.queues.values()) {
      for (const entry of list) {
        if (entry.from !== sessionID) continue
        entry.fromGone = true
        entry.onReply = undefined
      }
    }
    this.announce()
  }
}
