import type { AgentName, AssistantMessage, Message, ModelRef, SessionInfo, Usage } from "@shared/protocol"
import { Identifier } from "@shared/id"
import type { Storage } from "../storage"
import type { Bus } from "../bus"
import { newSlug } from "./plan"

export function emptyUsage(): Usage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

/**
 * Persistence and change notification for sessions and their messages.
 *
 * One file per message keeps writes small during streaming: an assistant turn
 * rewrites only its own document as parts land, instead of a whole transcript.
 */
/**
 * One turn's worth of file changes, as they stood before the turn ran.
 *
 * `content: null` means the file did not exist, which undo turns back into a
 * deletion rather than into an empty file.
 */
/** How many turns can be taken back before the oldest is dropped. */
const UNDO_DEPTH = 20

export interface SnapshotFile {
  /** Absolute path, so a snapshot survives a session being reopened elsewhere. */
  path: string
  /** What the file held, or null when it did not exist. */
  content: string | null
  /**
   * Set when `content` is base64 rather than text.
   *
   * Most of what a turn touches is source, and storing that as text keeps a
   * snapshot readable. A file whose bytes are not valid UTF-8 cannot go through
   * a string without every byte the decoder did not understand being replaced,
   * so those are kept encoded and written back as bytes.
   */
  base64?: boolean
}

export interface Snapshot {
  at: number
  files: SnapshotFile[]
  /**
   * The user messages this turn answered, in the order they were sent.
   *
   * A turn usually answers one, but a turn that was steered answers several,
   * and there is no state on disk in between them. Rolling the conversation
   * back to a message has to know which turn that message belongs to, and how
   * far that turn's own recording reaches, or the transcript would be cut at a
   * point the files were never returned to.
   */
  messages?: string[]
  /**
   * Why this turn cannot be taken back, when it cannot.
   *
   * An entry is filed even then, and undo refuses with this sentence rather
   * than skipping to the turn before. Reaching past a turn nobody can describe
   * would restore files to a state that never existed, and report a count for
   * it. A refusal the user can read is the honest end of that road.
   */
  blocked?: string
}

/**
 * One turn that a rollback has taken back off the project.
 *
 * It holds both halves of the swap, because a rollback has to be reversible in
 * one move: `snapshot` is the turn's own recording, which goes back on the undo
 * stack the moment the turn is restored, and `swapped` is what was on disk
 * immediately before the turn was taken back, which is what restoring writes.
 */
export interface RevertStep {
  /** The user message this turn began at, which is where the boundary sits. */
  messageID: string
  /** How far this turn's answers reach, so the boundary can clear all of it. */
  messages: string[]
  snapshot: Snapshot
  swapped: SnapshotFile[]
}

/** Everything a session remembers about the states its files have been in. */
export interface History {
  undo: Snapshot[]
  redo: Snapshot[]
  /**
   * The turns currently rolled back, in the order the conversation ran them.
   *
   * The first entry is the one nearest the still-visible conversation, so
   * restoring works from the front and rolling further back adds to it.
   */
  reverted: RevertStep[]
  /**
   * The newest message this session's file history can no longer reach past.
   *
   * The undo stack is finite, so the oldest turns are eventually dropped. Once
   * that has happened the project cannot be returned to any point at or before
   * the dropped turn's last message - and rolling the transcript back there
   * anyway would tell the reader their files had followed when they had not.
   */
  floor?: string
}

/** history: what changed in the store, for an index kept beside it. */
export type StoreChange =
  | { type: "message"; message: Message }
  | { type: "message.removed"; sessionID: string; messageID: string }
  | { type: "session.removed"; sessionID: string }

export class SessionStore {
  constructor(
    private readonly storage: Storage,
    private readonly bus: Bus,
  ) {}

  /* history: told of every write, including the silent ones the bus never hears. */
  private readonly watchers = new Set<(change: StoreChange) => void>()

  watch(watcher: (change: StoreChange) => void): () => void {
    this.watchers.add(watcher)
    return () => this.watchers.delete(watcher)
  }

  private changed(change: StoreChange): void {
    for (const watcher of this.watchers) watcher(change)
  }

  private infoKey(sessionID: string) {
    return `session/${sessionID}/info`
  }

  private messageKey(sessionID: string, messageID: string) {
    return `session/${sessionID}/message/${messageID}`
  }

  async create(input: {
    directory: string
    model: ModelRef
    agent?: AgentName
    staged?: boolean
    smart?: boolean
    scratch?: boolean
    sideOf?: string
    forkOf?: string
    title?: string
    /* subagents: the parent and the call that started it. */
    parentID?: string
    parentMessageID?: string
    parentCallID?: string
    subagent?: SessionInfo["subagent"]
  }): Promise<SessionInfo> {
    const now = Date.now()
    const session: SessionInfo = {
      id: Identifier.session(),
      title: input.title ?? "New session",
      directory: input.directory,
      model: input.model,
      agent: input.agent ?? "build",
      // plan: fixed now, so every turn of this conversation finds the same plan file.
      slug: newSlug(),
      ...(input.staged ? { staged: true } : {}),
      ...(input.smart ? { smart: true } : {}),
      ...(input.scratch ? { scratch: true } : {}),
      ...(input.sideOf ? { sideOf: input.sideOf } : {}),
      ...(input.forkOf ? { forkOf: input.forkOf } : {}),
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.parentMessageID ? { parentMessageID: input.parentMessageID } : {}),
      ...(input.parentCallID ? { parentCallID: input.parentCallID } : {}),
      ...(input.subagent ? { subagent: input.subagent } : {}),
      created: now,
      updated: now,
      usage: emptyUsage(),
    }
    await this.storage.write(this.infoKey(session.id), session)
    this.bus.publish({ type: "session.updated", session })
    return session
  }

  async get(sessionID: string): Promise<SessionInfo | undefined> {
    return this.storage.read<SessionInfo>(this.infoKey(sessionID))
  }

  async require(sessionID: string): Promise<SessionInfo> {
    const session = await this.get(sessionID)
    if (!session) throw new Error(`Session ${sessionID} not found`)
    return session
  }

  async list(): Promise<SessionInfo[]> {
    const ids = await this.storage.listDirectories("session")
    const sessions: SessionInfo[] = []
    for (const id of ids) {
      const session = await this.get(id)
      if (session) sessions.push(session)
    }
    // Most recently touched first - matches how the sidebar is read.
    return sessions.sort((a, b) => b.updated - a.updated)
  }

  async update(sessionID: string, patch: Partial<SessionInfo>): Promise<SessionInfo> {
    const session = await this.require(sessionID)
    const next: SessionInfo = { ...session, ...patch, updated: Date.now() }
    await this.storage.write(this.infoKey(sessionID), next)
    this.bus.publish({ type: "session.updated", session: next })
    return next
  }

  /*
   * MiMo's per-conversation access level. Written without touching `updated`:
   * choosing a level is not activity, and must not move the conversation up
   * the side column.
   */
  async setAccess(sessionID: string, access: SessionInfo["access"]): Promise<SessionInfo> {
    const session = await this.require(sessionID)
    const next: SessionInfo = { ...session, access }
    if (!access) delete next.access
    await this.storage.write(this.infoKey(sessionID), next)
    this.bus.publish({ type: "session.updated", session: next })
    return next
  }

  /*
   * The MCP servers a conversation was offered at its first turn.
   *
   * MiMo's MCP page says a saved change applies from the next conversation, so
   * this is kept with the conversation rather than in memory alone - after a
   * restart it must still be offered the same servers. Written without
   * touching `updated`, as the access level is: recording it is not activity
   * and must not move the conversation up the side column.
   */
  async setMcpServers(sessionID: string, names: readonly string[]): Promise<void> {
    const session = await this.require(sessionID)
    const next: SessionInfo = { ...session, mcpServers: [...names] }
    await this.storage.write(this.infoKey(sessionID), next)
    this.bus.publish({ type: "session.updated", session: next })
  }

  /** Turning off full access puts every conversation that was at it back on the default, as MiMo does. */
  async dropFullAccess(): Promise<void> {
    for (const session of await this.list()) {
      if (session.access === "full") await this.setAccess(session.id, undefined)
    }
  }

  /** Folds one assistant turn's usage into the session running total. */
  async addUsage(sessionID: string, usage: Usage): Promise<void> {
    const session = await this.require(sessionID)
    await this.update(sessionID, {
      usage: {
        input: session.usage.input + usage.input,
        output: session.usage.output + usage.output,
        reasoning: session.usage.reasoning + usage.reasoning,
        cacheRead: session.usage.cacheRead + usage.cacheRead,
        cacheWrite: session.usage.cacheWrite + usage.cacheWrite,
        cost: session.usage.cost + usage.cost,
      },
    })
  }


  private historyKey(sessionID: string) {
    return `session/${sessionID}/history`
  }

  /**
   * Undo and redo as two stacks.
   *
   * Kept next to the session rather than in memory so the history survives a
   * restart: a change made an hour ago is exactly the one worth taking back.
   */
  private async history(sessionID: string): Promise<History> {
    const stored = await this.storage.read<Partial<History>>(this.historyKey(sessionID))
    // Written before rollback existed, so its documents carry neither list.
    return { undo: stored?.undo ?? [], redo: stored?.redo ?? [], reverted: stored?.reverted ?? [], floor: stored?.floor }
  }

  /** How deep each stack is, for a UI that has to know whether to offer them. */
  async historyDepth(sessionID: string): Promise<{ undo: number; redo: number }> {
    const state = await this.history(sessionID)
    return { undo: state.undo.length, redo: state.redo.length }
  }

  async pushSnapshot(sessionID: string, snapshot: Snapshot): Promise<void> {
    const state = await this.history(sessionID)
    state.undo.push(snapshot)
    // A new change ends the redo line, the way it does in any editor.
    state.redo = []
    /*
     * Each entry holds whole files, so an afternoon of edits on a large file
     * would grow this without limit. Twenty turns is far more than anyone
     * reaches back through, and the oldest are the least likely to be wanted.
     */
    while (state.undo.length > UNDO_DEPTH) {
      /*
       * The dropped turn's last message becomes the floor. Everything at or
       * before it now predates what this session can put back, so a rollback
       * aimed there has to be refused rather than moving the transcript on its
       * own.
       */
      const dropped = state.undo.shift()
      const last = dropped?.messages?.[dropped.messages.length - 1]
      if (last) state.floor = last
    }
    await this.storage.write(this.historyKey(sessionID), state)
  }

  /** Where the file history stops, so a rollback knows what it cannot promise. */
  async floor(sessionID: string): Promise<string | undefined> {
    return (await this.history(sessionID)).floor
  }

  /** The turns currently rolled back, nearest the visible conversation first. */
  async reverted(sessionID: string): Promise<RevertStep[]> {
    return (await this.history(sessionID)).reverted
  }

  /**
   * Takes the newest recorded turn off the undo stack and files it as rolled
   * back, in one write.
   */
  async takeBack(sessionID: string, step: RevertStep): Promise<void> {
    const state = await this.history(sessionID)
    state.undo.pop()
    state.reverted.unshift(step)
    await this.storage.write(this.historyKey(sessionID), state)
  }

  /**
   * Withdraws the offer to put back what an ordinary undo took away.
   *
   * A turn on the redo stack was taken back while its messages stayed on
   * screen. Once the conversation has been rolled back past those messages the
   * offer is no longer a coherent one: accepting it would write files belonging
   * to a turn the reader can no longer see.
   */
  async forgetRedo(sessionID: string): Promise<void> {
    const state = await this.history(sessionID)
    if (!state.redo.length) return
    state.redo = []
    await this.storage.write(this.historyKey(sessionID), state)
  }

  /** Puts the earliest rolled back turn back on the undo stack, in one write. */
  async putBack(sessionID: string): Promise<void> {
    const state = await this.history(sessionID)
    const step = state.reverted.shift()
    if (step) state.undo.push(step.snapshot)
    await this.storage.write(this.historyKey(sessionID), state)
  }

  /**
   * Forgets everything that was rolled back.
   *
   * Used when a rolled back session is prompted again: the conversation has
   * taken a different turning, so there is nothing left to restore and holding
   * whole files for it would be so much dead weight.
   */
  async dropReverted(sessionID: string): Promise<void> {
    const state = await this.history(sessionID)
    if (!state.reverted.length) return
    state.reverted = []
    await this.storage.write(this.historyKey(sessionID), state)
  }

  /**
   * The snapshot an undo or redo would use, without disturbing either stack.
   *
   * Taking it off first meant a restore that failed part way had nothing to put
   * back: the entry was already gone from disk.
   */
  async peekSnapshot(sessionID: string, direction: "undo" | "redo"): Promise<Snapshot | undefined> {
    const state = await this.history(sessionID)
    const stack = state[direction]
    return stack[stack.length - 1]
  }

  /**
   * Takes the top of one stack and files a replacement on the other, in one
   * write - so the pair cannot be interrupted with the entry on neither.
   */
  async moveSnapshot(
    sessionID: string,
    from: "undo" | "redo",
    to: "undo" | "redo",
    replacement: Snapshot,
  ): Promise<void> {
    const state = await this.history(sessionID)
    state[from].pop()
    state[to].push(replacement)
    await this.storage.write(this.historyKey(sessionID), state)
  }

  async delete(sessionID: string): Promise<void> {
    await this.storage.removeDirectory(`session/${sessionID}`)
    this.changed({ type: "session.removed", sessionID })
    this.bus.publish({ type: "session.deleted", sessionID })
  }

  /**
   * A new session carrying this one's history up to a point.
   *
   * The reference's fork is a server call - `POST /session/{id}/fork` with a
   * messageID, "create a new session by forking an existing session at a
   * specific message point" - and the new session keeps everything up to and
   * including that message. Forking used to mean starting a blank session and
   * retyping the one sentence, which threw away the conversation that made the
   * sentence worth asking, and is not what the reference does.
   *
   * The copies keep their ids. Message ids are only ever used inside a session
   * - the storage key carries the session, and the revert stack lives on the
   * session record - so there is nothing for them to collide with, and minting
   * new ones would break the references a message's own parts hold to it.
   */
  async fork(sessionID: string, messageID: string, titleSuffix = false): Promise<SessionInfo> {
    const origin = await this.require(sessionID)
    const messages = await this.messages(sessionID)
    const at = messages.findIndex((message) => message.id === messageID)
    if (at < 0) throw new Error(`Message ${messageID} is not in session ${sessionID}`)

    const session = await this.create({
      directory: origin.directory,
      model: origin.model,
      agent: origin.agent,
      // A branch works the way its origin did, and in the same kind of folder.
      staged: origin.staged,
      scratch: origin.scratch,
      // Named for what it came from, so the pair reads as a pair in the list:
      // the same title, or MiMo's 「(分支)」 after it for a branch off a reply.
      title: titleSuffix ? branchTitle(origin.title) : origin.title,
      // Remembered so the branch can say where it came from and lead back there.
      forkOf: origin.id,
    })

    for (const message of messages.slice(0, at + 1)) {
      await this.saveMessage({ ...message, sessionID: session.id }, true)
    }
    return session
  }

  async messages(sessionID: string): Promise<Message[]> {
    const ids = await this.storage.list(`session/${sessionID}/message`)
    const messages: Message[] = []
    for (const id of ids) {
      /*
       * One unreadable message must not cost the whole conversation.
       *
       * A file can be damaged by anything that interrupts a write - and this
       * app shipped a version whose concurrent saves could interleave into the
       * same temp file. Skipping the damaged one leaves a gap in the
       * transcript; letting it throw made the session refuse to open at all.
       */
      const message = await this.storage
        .read<Message>(this.messageKey(sessionID, id))
        .catch(() => undefined)
      if (message) messages.push(message)
    }
    return messages
  }

  /**
   * Writes a message and announces it. `silent` skips the broadcast for the
   * high-frequency path where a delta event already told the UI what changed
   * and the write is only for durability.
   */
  async saveMessage(message: Message, silent = false): Promise<void> {
    await this.storage.write(this.messageKey(message.sessionID, message.id), message)
    this.changed({ type: "message", message })
    if (!silent) this.bus.publish({ type: "message.updated", message })
  }

  /**
   * Removes one message for good.
   *
   * Two callers: a rollback being made permanent when a rolled back session is
   * prompted again, and an edit or retry, which deletes the messages from the
   * one resent onward as MiMo does. Nothing else deletes a message: a
   * transcript that quietly loses turns is worse than a long one.
   */
  async deleteMessage(sessionID: string, messageID: string): Promise<void> {
    await this.storage.remove(this.messageKey(sessionID, messageID))
    this.changed({ type: "message.removed", sessionID, messageID })
  }

  async lastAssistant(sessionID: string): Promise<AssistantMessage | undefined> {
    const messages = await this.messages(sessionID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "assistant") return message
    }
    return undefined
  }
}

/**
 * MiMo's title for a branch: 「{title} (分支)」, and branching a branch counts
 * on - 「(分支 2)」, 「(分支 3)」. Chinese in every language, as MiMo writes it.
 */
export function branchTitle(title: string): string {
  const found = /^(.*) \(分支(?: (\d+))?\)$/.exec(title)
  if (!found) return `${title} (分支)`
  return `${found[1]} (分支 ${found[2] ? Number(found[2]) + 1 : 2})`
}
