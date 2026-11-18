import type { AgentName, AssistantMessage, Effort, Message, ModelRef, SessionInfo, Usage } from "@shared/protocol"
import { adopt, Identifier } from "@shared/id"
import type { Storage } from "../storage"
import type { Bus } from "../bus"
import { newSlug } from "./plan"

export function emptyUsage(): Usage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

/** Most recently touched first, as the side column reads, and by id where two tie - so a patched list and a fresh read agree. */
function byRecent(a: SessionInfo, b: SessionInfo): number {
  return b.updated - a.updated || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Runs `work` over every item, at most `limit` at a time. */
export async function inParallel<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const index = next++
      await work(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
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
  /**
   * What the file held, as an object in the project's checkpoint store, or null
   * when it did not exist.
   *
   * MiMo keeps no file bodies in its conversation record at all: the session
   * row carries a diff summary and a checkpoint reference, and the bytes live
   * in a store of their own. This is that reference. A turn that regenerates a
   * tree of code used to put every one of those files, whole, into this
   * conversation's own document - so an undo document could reach hundreds of
   * megabytes, and every undo, redo and rollback read and wrote the lot.
   */
  blob?: string | null
  /**
   * What the file held, inline - the shape written before the checkpoint store.
   *
   * Still read, never written. A profile that has not been migrated (or whose
   * migration could not reach its project's store) keeps working exactly as it
   * did rather than losing its undo history. `blob` present is what says an
   * entry is in the new shape, because null is a meaningful value in both.
   */
  content?: string | null
  /**
   * Set when an inline `content` is base64 rather than text.
   *
   * Most of what a turn touches is source, and storing that as text kept a
   * snapshot readable. A file whose bytes are not valid UTF-8 cannot go through
   * a string without every byte the decoder did not understand being replaced,
   * so those were kept encoded and written back as bytes. Checkpoint objects
   * are bytes already and need none of this.
   */
  base64?: boolean
  /**
   * Why this file's contents could not be taken, when they could not.
   *
   * The third answer, between "here is what it held" and "it did not exist".
   * A file that is merely locked - the routine Windows EBUSY this project waits
   * out everywhere else - was recorded as the second, and an undo turns the
   * second into a deletion, so pressing undo removed a file whose contents had
   * been kept nowhere (R25-A1). Never persisted: a turn holding one of these is
   * filed as a turn that cannot be taken back, and a restore that meets one
   * refuses rather than going on.
   */
  unreadable?: string
}

/** Whether a recorded file points at the checkpoint store rather than carrying its body. */
export function isCheckpointed(file: SnapshotFile): boolean {
  return file.blob !== undefined
}

export interface Snapshot {
  at: number
  files: SnapshotFile[]
  /**
   * What the turn changed, in the shape MiMo keeps on its session row
   * (`summary_files`, `summary_additions`, `summary_deletions`).
   *
   * Recorded because the bodies are no longer here to count: anything that
   * wants to say how big a turn was has to be able to ask without reading the
   * checkpoint store. Absent on a snapshot written before this existed.
   */
  summary?: { files: number; additions?: number; deletions?: number }
  /**
   * The project whose checkpoint store holds this turn's objects.
   *
   * Kept on the snapshot rather than read from the session, because a
   * conversation can be moved and its old turns' objects stay where they were
   * written. Absent on the legacy shape, which needs no store.
   */
  directory?: string
  /**
   * The user messages this turn answered, in the order they were sent.
   *
   * A turn usually answers one; several steered in at once share a turn, and
   * records written before steers opened turns of their own (MiMo 26.914) can
   * hold a question and its steers. Rolling the conversation
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

  /**
   * The whole list, read once and kept until a record changes (N11-5).
   *
   * `list()` reads every conversation's info.json, and nineteen callers reach
   * it - every cross-conversation message, every subagent lookup, the sidebar,
   * the search overlay. Measured on this machine, the first window took 166ms
   * with two conversations and 223-236ms with two hundred, all of it here, and
   * the search overlay called it on every keystroke.
   *
   * A message being written does not touch a record, so the cache survives a
   * streaming turn. Create, update and delete patch the one record in place
   * (S13-4): dropping the cache instead meant every model step - its usage is
   * a record write - cost the next reader a re-read of every record, 367 ms at
   * two thousand conversations, and a bulk delete two of them per item.
   */
  private listing: Promise<SessionInfo[]> | undefined

  private forgetList(): void {
    this.listing = undefined
  }

  /**
   * Puts one record's new state into the cached list, if there is one; a list
   * still being read gets it once the read is done. `next` undefined removes it.
   * Idempotent, so a read that already saw the change is left as it is.
   */
  private patchList(sessionID: string, next: SessionInfo | undefined): void {
    if (!this.listing) return
    const copy = next && structuredClone(next)
    this.listing = this.listing.then((sessions) => {
      const at = sessions.findIndex((session) => session.id === sessionID)
      if (at >= 0) sessions.splice(at, 1)
      if (copy) {
        const into = sessions.findIndex((session) => byRecent(copy, session) < 0)
        sessions.splice(into < 0 ? sessions.length : into, 0, copy)
      }
      return sessions
    })
    // A failed read is dropped for the next caller to try again, as `list` drops it.
    const patched = this.listing
    patched.catch(() => {
      if (this.listing === patched) this.forgetList()
    })
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
    goalMode?: boolean
    smart?: boolean
    effort?: Effort
    scratch?: boolean
    /** MiMo's grouping label, carried by a branch so it is listed beside what it came from. */
    group?: string
    sideOf?: string
    forkOf?: string
    title?: string
    /* subagents: the parent and the call that started it. */
    parentID?: string
    parentMessageID?: string
    parentCallID?: string
    subagent?: SessionInfo["subagent"]
    /*
     * A conversation brought in from a file keeps its own clock and the
     * name it had, so the list reads as the history it is rather than as a
     * conversation made this minute.
     */
    created?: number
    updated?: number
    titleSource?: SessionInfo["titleSource"]
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
      ...(input.goalMode ? { goalMode: true } : {}),
      ...(input.smart !== undefined ? { smart: input.smart } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.scratch ? { scratch: true } : {}),
      ...(input.group !== undefined ? { group: input.group } : {}),
      ...(input.sideOf ? { sideOf: input.sideOf } : {}),
      ...(input.forkOf ? { forkOf: input.forkOf } : {}),
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.parentMessageID ? { parentMessageID: input.parentMessageID } : {}),
      ...(input.parentCallID ? { parentCallID: input.parentCallID } : {}),
      ...(input.subagent ? { subagent: input.subagent } : {}),
      ...(input.titleSource ? { titleSource: input.titleSource } : {}),
      created: input.created ?? now,
      updated: input.updated ?? now,
      usage: emptyUsage(),
    }
    await this.storage.write(this.infoKey(session.id), session)
    this.patchList(session.id, session)
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

  /**
   * The list as the folder holds it right now, not as this process last read it.
   *
   * The cache is patched by this process's own writes and by nothing else, so
   * it says nothing about a conversation another instance made since - and two
   * instances sharing one data directory is a supported case. Every pass that
   * *deletes* what the list does not name has to ask from disk first, or it
   * deletes the other instance's work (R26-B1, R26-B2).
   */
  async listFresh(): Promise<SessionInfo[]> {
    this.forgetList()
    return this.list()
  }

  async list(): Promise<SessionInfo[]> {
    this.listing ??= this.readAll().catch((cause: unknown) => {
      this.forgetList()
      throw cause
    })
    // A copy each time: callers hold on to what they are given, and one of them editing a record must not edit the cache.
    return structuredClone(await this.listing)
  }

  /**
   * Conversations whose record is there and could not be read, as the last
   * listing found them (L12-11).
   *
   * They are left exactly where they are - nothing writes a record it could
   * not read, and one repaired by hand is listed again at once - but they used
   * to be invisible to everything else too: the start-up sweep took their undo
   * stores as belonging to nobody, and nothing said they existed. Anything that
   * decides what is still spoken for asks here as well.
   */
  private unreadableIDs = new Set<string>()
  /** Said in the log once each, not on every listing. */
  private readonly loggedUnreadable = new Set<string>()

  /** The conversations the list could not read, by id. */
  async unreadable(): Promise<string[]> {
    await this.list()
    return [...this.unreadableIDs]
  }

  /**
   * The project folders unreadable conversations recorded turns in, read from
   * their undo history rather than their record - the one piece of them that
   * names where their checkpoint store is.
   */
  async unreadableDirectories(): Promise<string[]> {
    const directories = new Set<string>()
    for (const id of await this.unreadable()) {
      const history = await this.storage.read<Partial<History>>(this.historyKey(id)).catch(() => undefined)
      const snapshots = [...(history?.undo ?? []), ...(history?.redo ?? []), ...(history?.reverted ?? []).map((step) => step?.snapshot)]
      for (const snapshot of snapshots) if (typeof snapshot?.directory === "string" && snapshot.directory) directories.add(snapshot.directory)
    }
    return [...directories]
  }

  private async readAll(): Promise<SessionInfo[]> {
    const ids = await this.storage.listDirectories("session")
    // Sessions carry ids too, and a conversation created after the clock was
    // set back would otherwise list below one it was started after.
    for (const id of ids) adopt("ses", id)
    const sessions: SessionInfo[] = []
    const unreadable = new Set<string>()
    // A few dozen records at a time rather than one after another (S13-4).
    await inParallel(ids, 32, async (id) => {
      /*
       * One unreadable record must not cost the whole list.
       *
       * This is the guard `messages()` already has, one level up. A single
       * truncated or hand-edited info.json used to reject `list()` - which is
       * the side column, cross-conversation search, and everything else that
       * enumerates conversations - rather than only the damaged one. Asking for
       * that conversation by id still throws, because a caller that named it
       * cannot go on without it.
       */
      const read = await this.storage.readOrCorrupt<SessionInfo>(this.infoKey(id))
      /*
       * Every record that is there counts as one, whichever way it failed.
       * A record left out of both lists is one the artifact store's
       * `forgetMissing` reads as a conversation that no longer exists, and the
       * tombstone it writes for that is permanent - so a record held by a
       * scanner for a moment, or one holding something that is not an object,
       * has to land in `unreadable` rather than nowhere.
       */
      const problem = read.corrupt ?? read.unreadable
      if (read.value && typeof read.value === "object") sessions.push(read.value)
      else if (problem !== undefined || read.value !== undefined) {
        unreadable.add(id)
        if (!this.loggedUnreadable.has(id)) {
          this.loggedUnreadable.add(id)
          console.warn(`[sessions] ${this.storage.fileOf(this.infoKey(id))} could not be read (${problem ?? "it does not hold an object"}); the conversation is kept as it is and left out of the list`)
        }
      }
    })
    this.unreadableIDs = unreadable
    return sessions.sort(byRecent)
  }

  /**
   * The read-modify-write in flight for each document, so two cannot overlap.
   *
   * `Storage.write` puts writes of one key in order, but a read and the write
   * that follows it are not one critical section. Two of these run at the same
   * moment on a conversation's first turn - the background title and the first
   * step's usage - and whichever wrote second did so from a copy taken before
   * the other's field existed, so the title never appeared or the first step's
   * tokens were never counted. Chaining them by key makes each read see the
   * previous write.
   */
  private readonly updating = new Map<string, Promise<unknown>>()

  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.updating.get(key) ?? Promise.resolve()
    // Both arms, so a failed predecessor does not cancel everything behind it.
    const result = previous.then(work, work)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.updating.set(key, settled)
    void settled.then(() => {
      if (this.updating.get(key) === settled) this.updating.delete(key)
    })
    return result
  }

  /**
   * Conversations that have been deleted, for the rest of the run.
   *
   * A delete removes the folder, and a write already in flight for that
   * conversation - a usage figure landing as the turn ends, a title arriving
   * from the background - then recreates it, so the conversation comes back
   * with one document in it. The tombstone is what a write checks before it
   * touches the disk. Ids are never reused, so nothing ever clears it.
   */
  private readonly deleted = new Set<string>()

  /** One change to a conversation's record, read and written without anything in between. */
  private async writeInfo(sessionID: string, change: (session: SessionInfo) => SessionInfo): Promise<SessionInfo> {
    const session = await this.require(sessionID)
    const next = change(session)
    await this.saveInfo(sessionID, next)
    return next
  }

  private async saveInfo(sessionID: string, next: SessionInfo): Promise<void> {
    if (this.deleted.has(sessionID)) throw new Error(`Session ${sessionID} was deleted`)
    await this.storage.write(this.infoKey(sessionID), next)
    this.patchList(sessionID, next)
    this.bus.publish({ type: "session.updated", session: next })
  }

  async setArchived(sessionID: string, archived: boolean): Promise<{ session?: SessionInfo; changed: boolean }> {
    return this.exclusive(this.infoKey(sessionID), async () => {
      const session = await this.get(sessionID)
      if (!session || this.deleted.has(sessionID)) return { changed: false }
      if (Boolean(session.archived) === archived) return { session, changed: false }

      const updated = Date.now()
      const next = { ...session, archived, archivedAt: archived ? updated : undefined, updated }
      await this.saveInfo(sessionID, next)
      return { session: next, changed: true }
    })
  }

  async update(sessionID: string, patch: Partial<SessionInfo>): Promise<SessionInfo> {
    return this.exclusive(this.infoKey(sessionID), () =>
      this.writeInfo(sessionID, (session) => ({ ...session, ...patch, updated: Date.now() })),
    )
  }

  /**
   * 导入: writes a patch with the time it names rather than with now.
   *
   * `update` stamps every write with the current moment, which is right for
   * anything a turn does and wrong for a conversation being written again from
   * the app it came from: that one's place in the list belongs to when it was
   * last touched there.
   */
  async stamp(sessionID: string, patch: Partial<SessionInfo> & { updated: number }): Promise<SessionInfo> {
    return this.exclusive(this.infoKey(sessionID), () => this.writeInfo(sessionID, (session) => ({ ...session, ...patch })))
  }

  /*
   * MiMo's per-conversation access level. Written without touching `updated`:
   * choosing a level is not activity, and must not move the conversation up
   * the side column.
   */
  async setAccess(sessionID: string, access: SessionInfo["access"]): Promise<SessionInfo> {
    return this.exclusive(this.infoKey(sessionID), () =>
      this.writeInfo(sessionID, (session) => {
        const next: SessionInfo = { ...session, access }
        if (!access) delete next.access
        return next
      }),
    )
  }

  /** The conversation's own effort. Not activity, so `updated` stays, as with `setAccess`. */
  async setEffort(sessionID: string, effort: Effort): Promise<SessionInfo> {
    return this.exclusive(this.infoKey(sessionID), () => this.writeInfo(sessionID, (session) => ({ ...session, effort })))
  }

  /*
   * MiMo's `reviewRestricted`: a review took this conversation's turn, and it
   * may not be continued. Written without touching `updated`, for the same
   * reason `setAccess` is: the conversation did not do anything, so it must not
   * climb the side column. Lifting it deletes the field rather than writing
   * false, so a conversation that was never restricted and one that was and was
   * let go read the same.
   */
  async setReviewRestricted(sessionID: string, restricted: boolean): Promise<SessionInfo> {
    return this.exclusive(this.infoKey(sessionID), () =>
      this.writeInfo(sessionID, (session) => {
        const next: SessionInfo = { ...session }
        if (restricted) next.reviewRestricted = true
        else delete next.reviewRestricted
        return next
      }),
    )
  }

  /** Turning off full access puts every conversation that was at it back on the default, as MiMo does. */
  async dropFullAccess(): Promise<void> {
    for (const session of await this.list()) {
      if (session.access === "full") await this.setAccess(session.id, undefined)
    }
  }

  /**
   * Folds one assistant turn's usage into the session running total.
   *
   * Summed inside the lock rather than by reading first and calling `update`:
   * the figure being added to has to be the one on disk at the moment of the
   * write, and this is one of the two writers that used to race.
   */
  async addUsage(sessionID: string, usage: Usage): Promise<void> {
    await this.exclusive(this.infoKey(sessionID), () =>
      this.writeInfo(sessionID, (session) => {
        const prior = session.usage ?? emptyUsage()
        return {
          ...session,
          updated: Date.now(),
          usage: {
            input: prior.input + usage.input,
            output: prior.output + usage.output,
            reasoning: prior.reasoning + usage.reasoning,
            cacheRead: prior.cacheRead + usage.cacheRead,
            cacheWrite: prior.cacheWrite + usage.cacheWrite,
            cost: prior.cost + usage.cost,
          },
        }
      }),
    )
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
    /*
     * A damaged history must cost this conversation its undo, not its readers.
     *
     * Reading threw before, straight out of every caller - the depth the window
     * asks for, the snapshot a turn records - so one unparseable document
     * stopped undo, redo and rollback for that conversation altogether. The
     * shape was already tolerated (a document written before rollback existed
     * carries neither list); only unreadable JSON was not.
     *
     * The file is moved aside rather than left to be written over: what it held
     * is whole turns of file contents, and the next `pushSnapshot` would
     * otherwise replace it with a stack of one.
     */
    const read = await this.storage.readOrCorrupt<Partial<History>>(this.historyKey(sessionID))
    /*
     * A document the disk would not hand over is whole, not damaged, so it is
     * neither moved aside nor written over: this conversation offers no undo
     * for the rest of the run rather than replacing whole turns of file
     * contents with a stack of one. A damaged one that could not even be moved
     * is refused for the same reason.
     */
    if (read.unreadable) this.historyBlocked.add(sessionID)
    else if (read.corrupt && (await this.storage.quarantine(this.historyKey(sessionID))) === undefined) this.historyBlocked.add(sessionID)
    const stored = read.value
    // Written before rollback existed, so its documents carry neither list.
    return { undo: stored?.undo ?? [], redo: stored?.redo ?? [], reverted: stored?.reverted ?? [], floor: stored?.floor }
  }

  /** Conversations whose history document is there but could not be read, and so may not be written over. */
  private readonly historyBlocked = new Set<string>()

  /** Saves a conversation's stacks, unless reading them failed and writing would replace what is still on disk. */
  private async writeHistory(sessionID: string, state: History): Promise<void> {
    if (this.historyBlocked.has(sessionID)) return
    await this.storage.write(this.historyKey(sessionID), state)
  }

  /** How deep each stack is, for a UI that has to know whether to offer them. */
  async historyDepth(sessionID: string): Promise<{ undo: number; redo: number }> {
    const state = await this.history(sessionID)
    return { undo: state.undo.length, redo: state.redo.length }
  }

  async pushSnapshot(sessionID: string, snapshot: Snapshot): Promise<void> {
    await this.exclusive(this.historyKey(sessionID), () => this.pushSnapshotNow(sessionID, snapshot))
  }

  private async pushSnapshotNow(sessionID: string, snapshot: Snapshot): Promise<void> {
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
    await this.writeHistory(sessionID, state)
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
    await this.exclusive(this.historyKey(sessionID), async () => {
      const state = await this.history(sessionID)
      state.undo.pop()
      state.reverted.unshift(step)
      await this.writeHistory(sessionID, state)
    })
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
    await this.exclusive(this.historyKey(sessionID), async () => {
      const state = await this.history(sessionID)
      if (!state.redo.length) return
      state.redo = []
      await this.writeHistory(sessionID, state)
    })
  }

  /** Puts the earliest rolled back turn back on the undo stack, in one write. */
  async putBack(sessionID: string): Promise<void> {
    await this.exclusive(this.historyKey(sessionID), async () => {
      const state = await this.history(sessionID)
      const step = state.reverted.shift()
      if (step) state.undo.push(step.snapshot)
      await this.writeHistory(sessionID, state)
    })
  }

  /**
   * Forgets everything that was rolled back.
   *
   * Used when a rolled back session is prompted again: the conversation has
   * taken a different turning, so there is nothing left to restore and holding
   * whole files for it would be so much dead weight.
   */
  async dropReverted(sessionID: string): Promise<void> {
    return this.exclusive(this.historyKey(sessionID), async () => {
      const state = await this.history(sessionID)
      if (!state.reverted.length) return
      state.reverted = []
      await this.writeHistory(sessionID, state)
    })
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
    await this.exclusive(this.historyKey(sessionID), async () => {
      const state = await this.history(sessionID)
      state[from].pop()
      state[to].push(replacement)
      await this.writeHistory(sessionID, state)
    })
  }

  /**
   * Removes a conversation and everything it kept.
   *
   * The record's own write is waited out first: a usage figure or a title
   * landing as the delete runs would otherwise be queued behind the folder's
   * removal and recreate it. The tombstone then stops anything that starts
   * afterwards, and the queue in `Storage.removeDirectory` stops anything that
   * was already ahead of it.
   */
  async delete(sessionID: string): Promise<void> {
    // Tombstone first so a writeInfo that has not yet checked will refuse;
    // then wait out anything already inside exclusive, which may still land
    // a write - removeDirectory drains that save and takes the folder with it.
    this.deleted.add(sessionID)
    await (this.updating.get(this.infoKey(sessionID)) ?? Promise.resolve())
    await this.storage.removeDirectory(`session/${sessionID}`)
    this.updating.delete(this.infoKey(sessionID))
    this.historyBlocked.delete(sessionID)
    this.patchList(sessionID, undefined)
    this.unreadableIDs.delete(sessionID)
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
      smart: origin.smart,
      agent: origin.agent,
      // Its level too: a branch is the same conversation going another way, not a new one at the app's.
      ...(origin.effort ? { effort: origin.effort } : {}),
      // A branch works the way its origin did, and in the same kind of folder.
      goalMode: origin.goalMode,
      scratch: origin.scratch,
      // ...and is filed where its origin is filed, so a branch does not jump out of its project's group.
      group: origin.group,
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

  /**
   * Every message this conversation has on disk, in order, whether or not it
   * can be read.
   *
   * `messages()` skips what it cannot read so that one damaged file does not
   * cost the whole transcript - but a caller that *deletes* a range must not
   * inherit that skip. Deleting "from this message on" by the messages that
   * happened to read left the unreadable one behind, and it came back into the
   * transcript afterwards, sitting after the message the user had just edited
   * and going to the model as history from the branch they abandoned (R25-A4).
   */
  async messageIDs(sessionID: string): Promise<string[]> {
    const ids = await this.storage.list(`session/${sessionID}/message`)
    // Whatever is already on disk is the floor for what gets written next, so a
    // clock set back between two launches cannot file a new message earlier
    // than the ones it answers (see `adopt` in shared/id.ts).
    for (const id of ids) adopt("msg", id)
    return ids
  }

  async messages(sessionID: string): Promise<Message[]> {
    const ids = await this.storage.list(`session/${sessionID}/message`)
    for (const id of ids) adopt("msg", id)
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
  async saveMessage(message: Message, silent = false, durable = true): Promise<void> {
    await this.storage.write(this.messageKey(message.sessionID, message.id), message, { durable })
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
