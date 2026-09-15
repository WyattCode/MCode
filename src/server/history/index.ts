import fs from "node:fs/promises"
import type { Message, SessionInfo } from "@shared/protocol"
import type { Bus } from "../bus"
import type { Storage } from "../storage"
import type { SessionStore, StoreChange } from "../session/store"
import type { IndexDatabase } from "./database"
import { projectKey, rowsOf } from "./extract"
import { ftsQuery } from "./text"

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

/** Bumped when what is indexed changes, so an index from before is filled again. */
const CONTENT_VERSION = "1"

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
  /** Only this project's conversations (MiMo's scope "project"); absent searches all of them. */
  directory?: string
  sessionID?: string
  toolName?: string
  after?: number
  before?: number
  limit?: number
}

export class HistoryIndex {
  private readonly pending = new Map<string, Message>()
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Each session's project as last indexed, so a move can be noticed. */
  private readonly projects = new Map<string, string>()
  private unwatch: (() => void) | undefined
  private unsubscribe: (() => void) | undefined
  private closed = false
  /** Settles once the start-up comparison with the store has finished. */
  ready: Promise<void> = Promise.resolve()
  /** True while that comparison runs: search may then be missing what it has not reached yet. */
  building = false

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
    if (this.database.meta("history_content") !== CONTENT_VERSION) {
      this.database.transaction(() => {
        this.db.exec("DELETE FROM history_part")
        this.db.exec("DELETE FROM history_session")
      })
      this.database.setMeta("history_content", CONTENT_VERSION)
    }
    for (const row of this.db.prepare("SELECT session_id, project FROM history_session").all() as { session_id: string; project: string }[]) {
      this.projects.set(row.session_id, row.project)
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

  close(): void {
    this.closed = true
    this.flush()
    if (this.timer) clearTimeout(this.timer)
    this.unwatch?.()
    this.unsubscribe?.()
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
        this.db.prepare("DELETE FROM history_part WHERE session_id = ? AND message_id = ?").run(change.sessionID, change.messageID)
        return
      case "session.removed":
        for (const key of [...this.pending.keys()]) if (key.startsWith(`${change.sessionID}/`)) this.pending.delete(key)
        this.forgetSession(change.sessionID)
    }
  }

  /**
   * A new conversation's project is noted as it is made, so its first saves are
   * indexed at once; one moved to another project takes its rows with it.
   */
  private onSession(session: SessionInfo): void {
    const known = this.projects.get(session.id)
    const project = projectKey(session.directory)
    if (this.closed || known === project) return
    if (known === undefined) {
      this.projects.set(session.id, project)
      return
    }
    this.database.transaction(() => {
      this.db.prepare("UPDATE history_part SET project = ? WHERE session_id = ?").run(project, session.id)
      this.db.prepare("UPDATE history_session SET project = ? WHERE session_id = ?").run(project, session.id)
    })
    this.projects.set(session.id, project)
  }

  private forgetSession(sessionID: string): void {
    this.database.transaction(() => {
      this.db.prepare("DELETE FROM history_part WHERE session_id = ?").run(sessionID)
      this.db.prepare("DELETE FROM history_session WHERE session_id = ?").run(sessionID)
    })
    this.projects.delete(sessionID)
  }

  /** Writes every message waiting to be indexed. Search calls this first, so it never reads behind a save. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending.size) return
    const batch = [...this.pending.values()]
    this.pending.clear()
    const now = Date.now()
    const bySession = new Map<string, Message[]>()
    for (const message of batch) bySession.set(message.sessionID, [...(bySession.get(message.sessionID) ?? []), message])
    for (const [sessionID, messages] of bySession) {
      const project = this.projects.get(sessionID)
      if (project === undefined) {
        // Not seen before: its project is read first, then it is indexed like any other.
        void this.store.get(sessionID).then((session) => {
          if (!session || this.closed) return
          this.projects.set(sessionID, projectKey(session.directory))
          this.write(sessionID, projectKey(session.directory), messages, now)
        })
        continue
      }
      this.write(sessionID, project, messages, now)
    }
  }

  private write(sessionID: string, project: string, messages: Message[], stamp: number, replaceSession = false): void {
    const remove = this.db.prepare("DELETE FROM history_part WHERE session_id = ? AND message_id = ?")
    const insert = this.db.prepare(
      "INSERT INTO history_part (part_id, session_id, message_id, project, kind, tool_name, body, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    this.database.transaction(() => {
      if (replaceSession) this.db.prepare("DELETE FROM history_part WHERE session_id = ?").run(sessionID)
      for (const message of messages) {
        remove.run(sessionID, message.id)
        for (const row of rowsOf(message)) insert.run(row.part_id, row.session_id, row.message_id, project, row.kind, row.tool_name, row.body, row.time_created)
      }
      this.db
        .prepare("INSERT INTO history_session (session_id, project, indexed_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project = excluded.project, indexed_at = excluded.indexed_at")
        .run(sessionID, project, stamp)
    })
  }

  /**
   * Brings the index level with the store: sessions it has never seen are
   * indexed whole, messages whose file changed after the session was last
   * indexed are indexed again, and anything no longer on disk is dropped.
   * One session at a time, yielding between them, so a first run over a long
   * history does not hold up the app.
   */
  private async reconcile(): Promise<void> {
    const indexed = new Map((this.db.prepare("SELECT session_id, indexed_at FROM history_session").all() as { session_id: string; indexed_at: number }[]).map((row) => [row.session_id, row.indexed_at]))
    const sessions = await this.store.list()
    const onDisk = new Set(sessions.map((session) => session.id))
    for (const sessionID of indexed.keys()) if (!onDisk.has(sessionID) && !this.closed) this.forgetSession(sessionID)
    for (const session of sessions) {
      if (this.closed) return
      const started = Date.now()
      const since = indexed.get(session.id)
      const ids = await this.storage.list(`session/${session.id}/message`)
      if (since === undefined) {
        const messages = await this.store.messages(session.id)
        if (this.closed) return
        this.projects.set(session.id, projectKey(session.directory))
        this.write(session.id, projectKey(session.directory), messages, started, true)
      } else {
        const changed: Message[] = []
        for (const id of ids) {
          const stat = await fs.stat(this.storage.fileOf(`session/${session.id}/message/${id}`)).catch(() => undefined)
          if (!stat || stat.mtimeMs < since - MTIME_SLACK_MS) continue
          const message = await this.storage.read<Message>(`session/${session.id}/message/${id}`).catch(() => undefined)
          if (message) changed.push(message)
        }
        const kept = new Set(ids)
        const stale = (this.db.prepare("SELECT DISTINCT message_id FROM history_part WHERE session_id = ?").all(session.id) as { message_id: string }[])
          .map((row) => row.message_id)
          .filter((id) => !kept.has(id))
        if (this.closed) return
        if (stale.length) {
          const drop = this.db.prepare("DELETE FROM history_part WHERE session_id = ? AND message_id = ?")
          this.database.transaction(() => stale.forEach((id) => drop.run(session.id, id)))
        }
        this.projects.set(session.id, projectKey(session.directory))
        this.write(session.id, projectKey(session.directory), changed, started)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  search(input: HistorySearch): HistoryHit[] {
    this.flush()
    const expression = ftsQuery(input.query, "AND")
    if (!expression) return []
    const limit = Math.max(1, Math.min(input.limit ?? SEARCH_DEFAULT, SEARCH_HARD_CAP))
    const where: string[] = []
    const params: (string | number)[] = [expression]
    if (input.directory !== undefined) {
      where.push("p.project = ?")
      params.push(projectKey(input.directory))
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
    const rows = this.db
      .prepare(
        `SELECT p.part_id, p.session_id, p.message_id, p.project, p.tool_name, p.time_created,
                substr(snippet(history_part_fts, 0, '<<', '>>', '...', 32), 1, 1001) AS snippet,
                bm25(history_part_fts) AS rank
         FROM history_part_fts JOIN history_part p ON p.id = history_part_fts.rowid
         WHERE history_part_fts MATCH ? ${where.length ? `AND ${where.join(" AND ")}` : ""}
         ORDER BY rank LIMIT ?`,
      )
      .all(...params) as (Omit<HistoryHit, "score"> & { rank: number })[]
    return rows.map(({ rank, ...row }) => ({ ...row, score: -rank }))
  }

  /** The conversation a message belongs to, when the index has seen it. */
  sessionOf(messageID: string): string | undefined {
    this.flush()
    const row = this.db.prepare("SELECT session_id FROM history_part WHERE message_id = ? LIMIT 1").get(messageID) as { session_id: string } | undefined
    return row?.session_id
  }

  /** How many parts are indexed, for the checks. */
  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM history_part").get() as { n: number }).n
  }
}
