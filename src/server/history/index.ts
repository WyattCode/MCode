import fs from "node:fs/promises"
import type { Message, SessionInfo } from "@shared/protocol"
import type { Bus } from "../bus"
import type { Storage } from "../storage"
import type { SessionStore, StoreChange } from "../session/store"
import type { IndexDatabase } from "./database"
import { rowsOf, summaryRow } from "./extract"
import { projectMemoryID } from "../memory/project-id"

/** What identifies a session's current compaction summary. */
const summaryStamp = (session: SessionInfo): string => (session.compacted ? `${session.compacted.messageID}:${session.compacted.at}` : "")
import { ftsQuery, plainSnippet, searchColumn, substringPieces, trigramPhrase } from "./text"

/**
 * The full-text index of every conversation, as MiMo's `history` tool searches it.
 *
 * Kept up to date from the session store's own writes, a moment after each
 * one so a streaming reply is indexed once rather than once per word. When
 * the app starts, whatever the index missed - a first run, a file deleted, a
 * write that landed as the app was closing - is found by comparing the store
 * with it and filled in the background. The JSON store is never written to.
 */

/** MiMo's ceiling on search results. */
export const SEARCH_HARD_CAP = 50
export const SEARCH_DEFAULT = 10

/** How long a saved message waits before it is indexed, so a stream of saves costs one write. */
const SETTLE_MS = 400

/** Slack on file times when deciding whether a message changed after it was indexed. */
const MTIME_SLACK_MS = 1500

/** How many sessions' folders the start-up comparison asks about at once. */
const CHECK_PARALLEL = 16

/** While the index catches up, how many never-indexed conversations a search reads directly, newest first. */
export const UNINDEXED_SCAN = 20

/**
 * How many of the newest parts the overlay reads for a query of one or two
 * characters, which the trigram index cannot look up. Bounded so a keystroke
 * costs the same on a long history as on a short one.
 */
export const SHORT_SCAN = 3_000

/** How many of a query's pieces, longest first, the trigram lookup requires; the rest are left to the overlay. */
const TRIGRAM_PHRASES = 16

/**
 * Bumped when what is indexed changes, so an index from before is filled again.
 * 2: projects are named by repository (memory/project-id.ts), and compaction
 * summaries and tool attachments are indexed.
 */
const CONTENT_VERSION = "2"

export interface HistoryHit {
  part_id: string
  session_id: string
  message_id: string
  project: string
  tool_name: string | null
  snippet: string
  score: number
  time_created: number
}

export interface HistorySearch {
  query: string
  /**
   * Only this project's conversations (MiMo's scope "project"): every folder
   * of the same repository, or every folder outside one. Absent searches all.
   */
  directory?: string
  sessionID?: string
  toolName?: string
  after?: number
  before?: number
  limit?: number
  /** Match the last word as a prefix: for the overlay, which searches as the user types. */
  prefix?: boolean
}

export class HistoryIndex {
  private readonly pending = new Map<string, Message>()
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Each session's project as last indexed, so a move can be noticed. */
  private readonly projects = new Map<string, string>()
  /** Which compaction summary each session last had indexed, so an unchanged one is not written again. */
  private readonly summaries = new Map<string, string>()
  /** The sessions the index holds, so a search while it catches up knows which it has not reached (S13-5). */
  private readonly indexedSessions = new Set<string>()
  private unwatch: (() => void) | undefined
  private unsubscribe: (() => void) | undefined
  private closed = false
  /**
   * The whole of `start()`, from the content check to the comparison with the
   * store (N11-12). The database lives in a worker now, so a start that is
   * still running when the store is closed would have its statements refused;
   * `close()` waits this out first. Errors are swallowed here, as they are in
   * `ready`: an index that cannot be built leaves history missing, not broken.
   */
  private starting: Promise<void> = Promise.resolve()
  /** Settles once the start-up comparison with the store has finished. */
  ready: Promise<void> = Promise.resolve()
  /** True while that comparison runs: search may then be missing what it has not reached yet. */
  building = false
  /**
   * Every write in flight, in order (N11-12). The index lives in a worker now,
   * so a write is something to wait for; a search waits for all of them first,
   * so it never reads behind a save.
   */
  private writing: Promise<unknown> = Promise.resolve()

  /** Queues a write behind the others; one that fails is dropped, as it was, and the next reconcile makes it good. */
  private queue(work: () => Promise<unknown>): Promise<unknown> {
    this.writing = this.writing.then(work).catch(() => undefined)
    return this.writing
  }

  constructor(
    private readonly database: IndexDatabase,
    private readonly store: SessionStore,
    private readonly storage: Storage,
    private readonly bus: Bus,
  ) {}

  private get db() {
    return this.database.db
  }

  start(): Promise<void> {
    this.starting = this.begin().catch(() => undefined)
    return this.starting
  }

  private async begin(): Promise<void> {
    // Building from the first moment: until the comparison below has run, a search may be missing things.
    this.building = true
    if ((await this.database.meta("history_content")) !== CONTENT_VERSION) {
      await this.database.transaction(async (tx) => {
        await tx.exec("DELETE FROM history_part")
        await tx.exec("DELETE FROM history_session")
      })
      await this.database.setMeta("history_content", CONTENT_VERSION)
      /*
       * The file does not shrink on its own (N11-40): a full rebuild emptied
       * every table and the pages stayed allocated, so each content change left
       * the index its previous size again on top of the new one. It is the one
       * store here with no other way of giving space back.
       */
      // A large index takes a while to rewrite; given longer than an ordinary statement.
      await this.db.exec("VACUUM", { timeoutMs: 5 * 60_000 })
    }
    for (const row of await this.db.all<{ session_id: string; project: string }>("SELECT session_id, project FROM history_session")) {
      this.projects.set(row.session_id, row.project)
      this.indexedSessions.add(row.session_id)
    }
    this.unwatch = this.store.watch((change) => this.onChange(change))
    this.unsubscribe = this.bus.subscribe((event) => {
      if (event.type === "session.updated") this.onSession(event.session)
    })
    this.building = true
    this.ready = this.reconcile()
      .catch(() => undefined)
      .finally(() => {
        this.building = false
      })
    return this.ready
  }

async close(): Promise<void> {
    this.closed = true
    const flushed = this.flush()
    if (this.timer) clearTimeout(this.timer)
    this.unwatch?.()
    this.unsubscribe?.()
    // Whatever start and the comparison are still doing, and every write they or a save has queued (N11-12).
    await this.starting
    await flushed
    await this.writing
  }

  private onChange(change: StoreChange): void {
    if (this.closed) return
    switch (change.type) {
      case "message":
        this.pending.set(`${change.message.sessionID}/${change.message.id}`, change.message)
        if (!this.timer) this.timer = setTimeout(() => this.flush(), SETTLE_MS)
        return
      case "message.removed":
        this.pending.delete(`${change.sessionID}/${change.messageID}`)
        void this.queue(() => this.db.run("DELETE FROM history_part WHERE session_id = ? AND message_id = ?", change.sessionID, change.messageID))
        return
      case "session.removed":
        for (const key of [...this.pending.keys()]) if (key.startsWith(`${change.sessionID}/`)) this.pending.delete(key)
        void this.forgetSession(change.sessionID)
    }
  }

  /**
   * A new conversation's project is noted as it is made, so its first saves are
   * indexed at once; one moved to another project takes its rows with it.
   */
  private onSession(session: SessionInfo): void {
    if (this.closed) return
    const known = this.projects.get(session.id)
    const project = projectMemoryID(session.directory)
    // A new or replaced compaction summary is searchable as soon as it is written.
    if (this.summaries.get(session.id) !== summaryStamp(session)) void this.writeSummary(session, project)
    if (known === project) return
    if (known === undefined) {
      this.projects.set(session.id, project)
      return
    }
    void this.queue(() =>
      this.database.transaction(async (tx) => {
        await tx.run("UPDATE history_part SET project = ? WHERE session_id = ?", project, session.id)
        await tx.run("UPDATE history_session SET project = ? WHERE session_id = ?", project, session.id)
      }),
    )
    this.projects.set(session.id, project)
  }

  private forgetSession(sessionID: string): Promise<unknown> {
    this.projects.delete(sessionID)
    this.summaries.delete(sessionID)
    this.indexedSessions.delete(sessionID)
    return this.queue(() =>
      this.database.transaction(async (tx) => {
        await tx.run("DELETE FROM history_part WHERE session_id = ?", sessionID)
        await tx.run("DELETE FROM history_session WHERE session_id = ?", sessionID)
      }),
    )
  }

  /**
   * The conversation's compaction summary, as a row of its own under the last
   * message it covers. The store keeps only the latest one, so any earlier row
   * is replaced.
   */
  private writeSummary(session: SessionInfo, project: string): Promise<unknown> {
    const row = summaryRow(session)
    this.summaries.set(session.id, summaryStamp(session))
    return this.queue(() =>
      this.database.transaction(async (tx) => {
        await tx.run("DELETE FROM history_part WHERE session_id = ? AND kind = 'summary'", session.id)
        if (row) {
          await tx.run(
            "INSERT INTO history_part (part_id, session_id, message_id, project, kind, tool_name, body, search_body, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row.part_id,
            row.session_id,
            row.message_id,
            project,
            row.kind,
            row.tool_name,
            row.body,
            searchColumn(row.body),
            row.time_created,
          )
        }
      }),
    )
  }

  /** Writes every message waiting to be indexed, and settles once every write so far has landed. Search waits for this. */
  flush(): Promise<unknown> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending.size) return this.writing
    const batch = [...this.pending.values()]
    this.pending.clear()
    const now = Date.now()
    const bySession = new Map<string, Message[]>()
    for (const message of batch) bySession.set(message.sessionID, [...(bySession.get(message.sessionID) ?? []), message])
    for (const [sessionID, messages] of bySession) {
      const project = this.projects.get(sessionID)
      if (project === undefined) {
        // Not seen before: its project is read first, then it is indexed like any other.
        void this.queue(async () => {
          const session = await this.store.get(sessionID)
          if (!session || this.closed) return
          this.projects.set(sessionID, projectMemoryID(session.directory))
          await this.writeNow(sessionID, projectMemoryID(session.directory), messages, now)
        })
        continue
      }
      void this.write(sessionID, project, messages, now)
    }
    return this.writing
  }

  private write(sessionID: string, project: string, messages: Message[], stamp: number, replaceSession = false): Promise<unknown> {
    return this.queue(() => this.writeNow(sessionID, project, messages, stamp, replaceSession))
  }

  private async writeNow(sessionID: string, project: string, messages: Message[], stamp: number, replaceSession = false): Promise<void> {
    await this.database.transaction(async (tx) => {
      if (replaceSession) await tx.run("DELETE FROM history_part WHERE session_id = ?", sessionID)
      for (const message of messages) {
        // A message written again keeps the compaction summary filed under it; that row follows the session, not the message.
        await tx.run("DELETE FROM history_part WHERE session_id = ? AND message_id = ? AND kind != 'summary'", sessionID, message.id)
        for (const row of rowsOf(message)) {
          await tx.run(
            "INSERT INTO history_part (part_id, session_id, message_id, project, kind, tool_name, body, search_body, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row.part_id,
            row.session_id,
            row.message_id,
            project,
            row.kind,
            row.tool_name,
            row.body,
            searchColumn(row.body),
            row.time_created,
          )
        }
      }
      await tx.run(
        "INSERT INTO history_session (session_id, project, indexed_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project = excluded.project, indexed_at = excluded.indexed_at",
        sessionID,
        project,
        stamp,
      )
    })
    this.indexedSessions.add(sessionID)
  }

  /**
   * Brings the index level with the store: sessions it has never seen are
   * indexed whole, messages whose file changed after the session was last
   * indexed are indexed again, and anything no longer on disk is dropped.
   * One session at a time, newest first, yielding between them, so a first run
   * over a long history does not hold up the app.
   *
   * A session unchanged since it was indexed is not looked into at all
   * (S13-5). Its record was not written since (so neither its project nor its
   * compaction summary moved), and its message folder was not either: every
   * save creates its temp file in that folder and renames it into place, so
   * the folder's own time moves with every message written or removed. One
   * stat per session, a few at a time, instead of one per message file.
   */
  private async reconcile(): Promise<void> {
    const indexed = new Map((await this.db.all<{ session_id: string; indexed_at: number }>("SELECT session_id, indexed_at FROM history_session")).map((row) => [row.session_id, row.indexed_at]))
    const sessions = await this.store.list()
    const onDisk = new Set(sessions.map((session) => session.id))
    for (const sessionID of indexed.keys()) if (!onDisk.has(sessionID) && !this.closed) await this.forgetSession(sessionID)
    const unchanged = await this.unchanged(sessions, indexed)
    for (const session of sessions) {
      if (this.closed) return
      if (unchanged.has(session.id)) {
        this.projects.set(session.id, projectMemoryID(session.directory))
        // Its summary was written when it was indexed, and has not moved since.
        if (!this.summaries.has(session.id)) this.summaries.set(session.id, summaryStamp(session))
        continue
      }
      const started = Date.now()
      const since = indexed.get(session.id)
      const ids = await this.storage.list(`session/${session.id}/message`)
      if (since === undefined) {
        const messages = await this.store.messages(session.id)
        if (this.closed) return
        this.projects.set(session.id, projectMemoryID(session.directory))
        await this.write(session.id, projectMemoryID(session.directory), messages, started, true)
      } else {
        const changed: Message[] = []
        for (const id of ids) {
          const stat = await fs.stat(this.storage.fileOf(`session/${session.id}/message/${id}`)).catch(() => undefined)
          if (!stat || stat.mtimeMs < since - MTIME_SLACK_MS) continue
          const message = await this.storage.read<Message>(`session/${session.id}/message/${id}`).catch(() => undefined)
          if (message) changed.push(message)
        }
        const kept = new Set(ids)
        const stale = (await this.db.all<{ message_id: string }>("SELECT DISTINCT message_id FROM history_part WHERE session_id = ?", session.id))
          .map((row) => row.message_id)
          .filter((id) => !kept.has(id))
        if (this.closed) return
        if (stale.length) {
          await this.queue(() =>
            this.database.transaction(async (tx) => {
              for (const id of stale) await tx.run("DELETE FROM history_part WHERE session_id = ? AND message_id = ?", session.id, id)
            }),
          )
        }
        this.projects.set(session.id, projectMemoryID(session.directory))
        await this.write(session.id, projectMemoryID(session.directory), changed, started)
      }
      if (this.summaries.get(session.id) !== summaryStamp(session)) await this.writeSummary(session, projectMemoryID(session.directory))
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** The indexed sessions whose record and message folder are both older than their indexing, asked a few at a time. */
  private async unchanged(sessions: readonly SessionInfo[], indexed: ReadonlyMap<string, number>): Promise<Set<string>> {
    const quiet = sessions.filter((session) => {
      const since = indexed.get(session.id)
      return since !== undefined && session.updated < since - MTIME_SLACK_MS
    })
    const found = new Set<string>()
    let next = 0
    const worker = async () => {
      while (next < quiet.length && !this.closed) {
        const session = quiet[next++]!
        const since = indexed.get(session.id)!
        const folder = await fs.stat(this.storage.folder(`session/${session.id}/message`)).catch(() => undefined)
        // No folder is no messages: the index has none for it either, unless the folder went, which a walk finds.
        if (folder && folder.mtimeMs < since - MTIME_SLACK_MS) found.add(session.id)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, quiet.length) }, worker))
    return found
  }

  /**
   * The conversations worth reading for a search of `query` (N11-5, S13-5).
   *
   * The index names them. While it is still catching up after a launch it
   * names what it has - every conversation indexed before, plus whatever was
   * written since - and the newest few it has never seen are added to be read
   * directly, so a search right after launch is answered in about the time a
   * settled one is rather than by reading hundreds of transcripts.
   */
  async candidates(query: string, sessions: readonly SessionInfo[]): Promise<string[]> {
    const matched = await this.holding(query)
    /*
     * The newest SEARCH_HARD_CAP of them that the overlay lists at all. The
     * overlay scores what it reads and keeps the best, and MiMo's reads the
     * conversations it has loaded - the recent ones - so when more hold the
     * query than can be read, the recent ones are what is read.
     */
    const found = new Set(
      sessions
        .filter((session) => matched.has(session.id) && !session.archived && !session.sideOf && !session.parentID)
        .sort((a, b) => b.updated - a.updated)
        .slice(0, SEARCH_HARD_CAP)
        .map((session) => session.id),
    )
    if (!this.building) return [...found]
    let unseen = 0
    for (const session of sessions) {
      if (unseen >= UNINDEXED_SCAN) break
      if (session.archived || session.sideOf || session.parentID || this.indexedSessions.has(session.id)) continue
      found.add(session.id)
      unseen += 1
    }
    return [...found]
  }

  /**
   * Every conversation with a message that may hold `query` as the overlay
   * matches it: anywhere in the text, inside a word or across words (R15-S3).
   *
   * Pieces of three characters or more are looked up in the trigram index, a
   * message having to hold them all (the longest TRIGRAM_PHRASES); shorter pieces are then left to the
   * overlay's own matcher, which only makes the set larger. A query with no
   * piece that long has no trigram to look up, so it is answered twice over:
   * by the word index across the whole history, as before (a word, or the
   * start of one, and Chinese of any length), and by reading the newest
   * SHORT_SCAN parts for it anywhere.
   */
  private async holding(query: string): Promise<Set<string>> {
    await this.flush()
    const pieces = substringPieces(query)
    if (!pieces.length) return new Set()
    /*
     * Each distinct phrase once, whatever its case (the trigram match ignores
     * case), and only the longest few: every phrase is a SELECT joined by
     * INTERSECT, which SQLite refuses past 500, and a pasted paragraph has
     * that many. Leaving the shorter ones out only makes the set larger, and
     * the overlay's own matcher reads every conversation it names.
     */
    const distinct = new Map<string, string>()
    for (const phrase of pieces.map(trigramPhrase)) if (phrase !== undefined) distinct.set(phrase.toLowerCase(), phrase)
    const phrases = [...distinct.values()].sort((a, b) => [...b].length - [...a].length).slice(0, TRIGRAM_PHRASES)
    if (phrases.length) {
      const one = "SELECT p.message_id, p.session_id FROM history_part_trigram t JOIN history_part p ON p.id = t.rowid WHERE history_part_trigram MATCH ?"
      const rows = await this.db.all<{ session_id: string }>(`SELECT DISTINCT session_id FROM (${phrases.map(() => one).join(" INTERSECT ")})`, ...phrases)
      return new Set(rows.map((row) => row.session_id))
    }
    const found = new Set<string>()
    const expression = ftsQuery(query, "AND", true)
    if (expression) {
      const words = await this.db.all<{ session_id: string }>(
        "SELECT DISTINCT p.session_id FROM history_part_fts f JOIN history_part p ON p.id = f.rowid WHERE history_part_fts MATCH ?",
        expression,
      )
      for (const row of words) found.add(row.session_id)
    }
    // SQLite's lower() folds only ASCII, which is what a query this short mostly is.
    const recent = await this.db.all<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM (
         SELECT session_id, body FROM history_part WHERE kind IN ('text', 'tool') ORDER BY time_created DESC LIMIT ?
       ) WHERE instr(lower(body), ?) > 0`,
      SHORT_SCAN,
      query.trim().toLowerCase(),
    )
    for (const row of recent) found.add(row.session_id)
    return found
  }

  async search(input: HistorySearch): Promise<HistoryHit[]> {
    await this.flush()
    const expression = ftsQuery(input.query, "AND", input.prefix)
    if (!expression) return []
    const limit = Math.max(1, Math.min(input.limit ?? SEARCH_DEFAULT, SEARCH_HARD_CAP))
    const where: string[] = []
    const params: (string | number)[] = [expression]
    if (input.directory !== undefined) {
      where.push("p.project = ?")
      params.push(projectMemoryID(input.directory))
    }
    if (input.sessionID) {
      where.push("p.session_id = ?")
      params.push(input.sessionID)
    }
    if (input.toolName) {
      where.push("p.tool_name = ?")
      params.push(input.toolName)
    }
    if (input.after !== undefined) {
      where.push("p.time_created >= ?")
      params.push(input.after)
    }
    if (input.before !== undefined) {
      where.push("p.time_created <= ?")
      params.push(input.before)
    }
    params.push(limit)
    const rows = await this.db.all<Omit<HistoryHit, "score"> & { rank: number }>(
      `SELECT p.part_id, p.session_id, p.message_id, p.project, p.tool_name, p.time_created,
              substr(snippet(history_part_fts, 0, '<<', '>>', '...', 32), 1, 1001) AS snippet,
              bm25(history_part_fts) AS rank
       FROM history_part_fts JOIN history_part p ON p.id = history_part_fts.rowid
       WHERE history_part_fts MATCH ? ${where.length ? `AND ${where.join(" AND ")}` : ""}
       ORDER BY rank LIMIT ?`,
      ...params,
    )
    // The snippet comes out of the indexed column, so the spaces cut into CJK writing come out of it.
    return rows.map(({ rank, ...row }) => ({ ...row, snippet: plainSnippet(row.snippet), score: -rank }))
  }

  /** The conversation a message belongs to, when the index has seen it. */
  async sessionOf(messageID: string): Promise<string | undefined> {
    await this.flush()
    const row = await this.db.get<{ session_id: string }>("SELECT session_id FROM history_part WHERE message_id = ? LIMIT 1", messageID)
    return row?.session_id
  }

  /** How many parts are indexed, for the checks. */
  async count(): Promise<number> {
    await this.flush()
    return (await this.db.get<{ n: number }>("SELECT count(*) AS n FROM history_part"))!.n
  }
}
