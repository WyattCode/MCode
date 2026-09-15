import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { AssistantMessage, ChatLink, ChatTaskStatus, Message, MessageSource, SessionInfo, TextPart } from "@shared/protocol"
import type { Bus } from "../bus"
import type { SessionStore } from "./store"

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

const SELF = "A session cannot message itself."
const HOPS = `This chain of calls between sessions has reached its limit of ${CHAT_HOPS} hops, so it was refused to prevent a loop. Answer with what you already have instead of calling another session.`
const GONE = "The target session no longer exists; it may have been deleted."
const TIMEOUT = `The target could not start on the message within ${CHAT_WAIT_MS / 1000}s. Try again later, or send it with mode "async".`

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
  /** A waiting call has had its answer, or there never was one waiting. */
  settled: boolean
  resolve?: (result: TalkResult) => void
  onReply?: (outcome: ChatOutcome) => void
  timer?: ReturnType<typeof setTimeout>
  release?: () => void
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
    ? `[Session chat] The reply from the session "${source.from}" (contact_id ${source.sessionID}) to a message this session sent it.`
    : `[Session chat] A message from the session "${source.from}" (contact_id ${source.sessionID}). Your final message in this turn is sent back to it as the reply.`
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
  if (last?.error) return { ok: false, error: `The other session's turn failed: ${last.error}` }
  if (last?.finish === "aborted") return { ok: false, error: "The other session's turn was stopped before it replied." }
  return { ok: false, error: "The other session's turn ended without a text reply." }
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
    if (!message) return { status: "refused", error: "The message is empty." }
    const caller = await this.store.get(input.from)
    if (!caller || !listed(caller)) return { status: "refused", error: "Only a conversation in the side column can message other sessions." }

    const everyone = (await this.store.list()).filter(listed)
    const others = everyone.filter((session) => session.id !== caller.id)
    const offered = () => others.slice(0, CONTACTS_MAX).map((session) => this.contactOf(session))
    let target: SessionInfo | undefined
    const id = input.contactID?.trim()
    if (id) {
      if (id === caller.id) return { status: "refused", error: SELF }
      target = others.find((session) => session.id === id)
      if (!target) return { status: "refused", error: `No contact has the id ${id}. Open contacts to see who is there.`, candidates: offered() }
    } else {
      const name = input.contact?.trim() ?? ""
      if (!name) return { status: "refused", error: "Name the contact by its exact title, or give its contact_id." }
      const named = everyone.filter((session) => session.title.trim() === name)
      const matches = named.filter((session) => session.id !== caller.id)
      if (!named.length) return { status: "refused", error: `No contact is titled "${name}". Open contacts to see who is there.`, candidates: offered() }
      if (!matches.length) return { status: "refused", error: SELF }
      if (matches.length > 1) {
        return {
          status: "refused",
          error: `Several sessions are titled "${name}". Retry with the contact_id of the one you mean.`,
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
    if (!name || !purpose || !workspace) return { ok: false, error: "name, purpose and workspace are all required." }
    if (!isAbsolute(workspace)) return { ok: false, error: "workspace must be the absolute path of an existing folder." }
    const found = await stat(workspace).catch(() => undefined)
    if (!found?.isDirectory()) return { ok: false, error: `workspace does not exist or is not a folder: ${workspace}` }
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
    if (!session || !listed(session)) return { ok: false, error: `No session has the id ${id}.` }
    if (input.name !== undefined && !input.name.trim()) return { ok: false, error: "name cannot be empty." }
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
    })
  }

  private enqueue(entry: Entry): void {
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
        this.finish(head, { ok: false, error: exists ? `The message could not be delivered: ${describe(failure)}` : GONE })
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
      text: outcome.ok ? outcome.reply : `(No reply could be fetched) ${outcome.error}`,
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
