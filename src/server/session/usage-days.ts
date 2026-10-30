import type { Message } from "@shared/protocol"
import type { Storage } from "../storage"
import { addRow, localDay, rowOf, usageSince, type UsageRecord, type UsageRow } from "../usage-summary"
import { inParallel, type SessionStore } from "./store"

const KEY = "usage-daily"
/** Bumped when the stored shape changes; a document of any other version is built again from the transcripts. */
const VERSION = 1
/** How long after a step's usage lands the totals are brought up to date and written. */
const SETTLE_MS = 2000

/** [day, model, input, output, reasoning, cacheRead, cacheWrite, cost, turns, priced, unpriced] */
type StoredRow = [string, string, number, number, number, number, number, number, number, number, number]

interface UsageDocument {
  version: number
  /** Each conversation's turns by day and model, and the record time they were counted at. */
  sessions: Record<string, { updated: number; rows: StoredRow[] }>
}

const pack = (row: UsageRow): StoredRow => [
  row.day,
  row.model,
  row.usage.input,
  row.usage.output,
  row.usage.reasoning,
  row.usage.cacheRead,
  row.usage.cacheWrite,
  row.usage.cost,
  row.turns,
  row.priced,
  row.unpriced,
]

const unpack = (row: StoredRow): UsageRow => ({
  day: row[0],
  model: row[1],
  usage: { input: row[2], output: row[3], reasoning: row[4], cacheRead: row[5], cacheWrite: row[6], cost: row[7] },
  turns: row[8],
  priced: row[9],
  unpriced: row[10],
})

/** A transcript's turns as the usage page counts them. */
function turnsOf(messages: readonly Message[]): UsageRecord[] {
  const records: UsageRecord[] = []
  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) continue
    /*
     * The turn's own clock, not the session's. A conversation returned to over
     * a fortnight would otherwise report every token it ever spent on
     * whichever day it was last touched.
     */
    records.push({ at: message.time.created, model: message.model, usage: message.usage, turn: true })
  }
  return records
}

/**
 * Each conversation's spend by local day and model, kept in one document so the
 * usage page need not read every transcript (S13-2).
 *
 * The page used to read every message of every conversation each time it
 * opened: 44-46 s at two thousand conversations. Now a conversation is read
 * again only when it changed - a message with usage was saved or one was
 * removed, or its record moved on since it was counted - and the page sums the
 * rows. Kept per conversation rather than as one running total so the figures
 * stay the ones the transcripts give: a deleted conversation, a message taken
 * back by a retry and a branch's copied turns count exactly as reading them
 * all would.
 *
 * The document is derived: missing, of another version or unreadable (moved
 * aside), it is built again from the transcripts, once, and written whole.
 */
export class UsageDays {
  private document?: Promise<UsageDocument>
  /** Conversations written to since they were last counted. */
  private readonly dirty = new Set<string>()
  private current?: Promise<void>
  private again = false
  private timer?: ReturnType<typeof setTimeout>
  private live = false
  private stopped = false
  /** The stored file could not be read and could not be moved aside: nothing may write over it. */
  private blocked = false

  constructor(
    private readonly storage: Storage,
    private readonly store: SessionStore,
  ) {
    store.watch((change) => {
      if (change.type === "message") {
        if (change.message.role !== "assistant" || !change.message.usage) return
        this.dirty.add(change.message.sessionID)
      } else if (change.type === "message.removed") this.dirty.add(change.sessionID)
      else this.dirty.delete(change.sessionID)
      this.settle()
    })
  }

  /** The running app's side: build or catch up now, and keep up after each step from then on. */
  start(): void {
    this.live = true
    void this.refresh()
  }

  /** Stops keeping up, and waits for a pass in flight to leave off without writing. */
  async stop(): Promise<void> {
    this.live = false
    this.stopped = true
    clearTimeout(this.timer)
    await this.current?.catch(() => undefined)
  }

  private settle(): void {
    if (!this.live || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh()
    }, SETTLE_MS)
    this.timer.unref?.()
  }

  private load(): Promise<UsageDocument> {
    this.document ??= (async () => {
      const read = await this.storage.readOrCorrupt<UsageDocument>(KEY)
      if (read.unreadable) {
        this.blocked = true
        console.warn(`[usage] ${this.storage.fileOf(KEY)} could not be read (${read.unreadable}); left in place, writes are refused, counted again from the conversations`)
      } else if (read.corrupt !== undefined) {
        const aside = await this.storage.quarantine(KEY).catch(() => undefined)
        if (aside === undefined) this.blocked = true
        console.warn(`[usage] ${this.storage.fileOf(KEY)} could not be read (${read.corrupt}); moved to ${aside ?? "nowhere"} and counted again from the conversations`)
      }
      const value = read.value
      if (value && value.version === VERSION && value.sessions && typeof value.sessions === "object") return value
      return { version: VERSION, sessions: {} }
    })()
    return this.document
  }

  /** Brings every conversation's rows up to date; a call made during a pass waits for one that starts after it. */
  refresh(): Promise<void> {
    this.again = true
    this.current ??= (async () => {
      try {
        while (this.again) {
          this.again = false
          await this.pass()
        }
      } finally {
        this.current = undefined
      }
    })()
    return this.current
  }

  private async pass(): Promise<void> {
    const document = await this.load()
    const sessions = await this.store.list()
    let changed = false
    const listed = new Set(sessions.map((session) => session.id))
    for (const id of Object.keys(document.sessions)) {
      if (listed.has(id)) continue
      delete document.sessions[id]
      changed = true
    }
    const stale = sessions.filter((session) => document.sessions[session.id]?.updated !== session.updated || this.dirty.has(session.id))
    await inParallel(stale, 8, async (session) => {
      if (this.stopped) return
      // Cleared before reading, so a message saved during the read counts it again next pass.
      this.dirty.delete(session.id)
      const byKey = new Map<string, UsageRow>()
      for (const record of turnsOf(await this.store.messages(session.id))) {
        const row = rowOf(record)
        const key = `${row.day}\n${row.model}`
        const found = byKey.get(key)
        if (found) addRow(found, row)
        else byKey.set(key, row)
      }
      document.sessions[session.id] = { updated: session.updated, rows: [...byKey.values()].map(pack) }
      changed = true
    })
    if (changed && !this.stopped && !this.blocked) await this.storage.write(KEY, document).catch(() => undefined)
  }

  /**
   * What the usage page sums for the last `days`: whole days as rows, and the
   * turns of the day the window starts in, one by one - the window starts at
   * this moment that many days ago, so that day counts only what came after it.
   */
  async gather(days: number, now = Date.now()): Promise<{ rows: UsageRow[]; records: UsageRecord[] }> {
    await this.refresh()
    const document = await this.load()
    const first = localDay(usageSince(days, now))
    const rows: UsageRow[] = []
    const records: UsageRecord[] = []
    for (const [id, entry] of Object.entries(document.sessions)) {
      let edge = false
      for (const row of entry.rows) {
        if (row[0] > first) rows.push(unpack(row))
        else if (row[0] === first) edge = true
      }
      if (!edge) continue
      for (const record of turnsOf(await this.store.messages(id))) if (localDay(record.at) === first) records.push(record)
    }
    return { rows, records }
  }
}
