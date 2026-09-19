import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ImportRun, ImportScan, ImportSource, ImportSourceResult, Message, ModelRef } from "@shared/protocol"
import { IMPORT_SOURCES } from "@shared/protocol"
import { Identifier } from "@shared/id"
import type { Storage } from "./storage"
import type { SessionStore } from "./session/store"
import { UNTITLED, clampTitle } from "./session/title"

/**
 * Conversations other coding tools have on this machine, offered once on a
 * first run - MiMo's 从其他 AI 应用导入.
 *
 * Three sources are read, and only read: Claude Code's
 * `~/.claude/projects/<project>/<id>.jsonl`, Codex's
 * `~/.codex/sessions/**\/*.jsonl`, and OpenCode's `opencode.db`. Nothing is
 * written back to them, nothing leaves this machine, and no line of what was
 * read reaches a log or an error message: a file that will not parse is
 * reported by its name and the kind of failure, never by its contents.
 *
 * MCODE_IMPORT_HOME stands in for the home directory so a check can point the
 * scan at fixtures of its own instead of the reader's real files.
 */

/** A file this big is left alone rather than held in memory whole. */
const MAX_FILE = 20 * 1024 * 1024

/** What one conversation looked like in the tool it came from. */
interface Found {
  /** Stable within its source: the file it came from, or the row's id. */
  key: string
  /** Changes when the source's copy changes, which is what makes a re-import a resync. */
  mtime: number
  title: string
  directory: string
  created: number
  updated: number
  turns: { role: "user" | "assistant"; text: string; at: number }[]
}

/** One source's record of what has already been taken from it. */
interface ImportedEntry {
  source: ImportSource
  key: string
  mtime: number
  sessionID: string
}

interface ImportedRecord {
  /** Which build's idea of this document it is; see `config.ts` for the same bargain. */
  schemaVersion?: number
  entries: Record<string, ImportedEntry>
}

const RECORD_KEY = "imported"

/** Raise this only when a change would be misread by a build that predates it. */
export const IMPORT_SCHEMA_VERSION = 1

function homeDirectory(): string {
  return process.env.MCODE_IMPORT_HOME || os.homedir()
}

function claudeRoot(home: string): string {
  return path.join(home, ".claude", "projects")
}

function codexRoot(home: string): string {
  return path.join(home, ".codex", "sessions")
}

/** Where OpenCode keeps its database, in the order its own data directory is worked out. */
function opencodeCandidates(home: string): string[] {
  const xdg = process.env.XDG_DATA_HOME
  return [
    ...(xdg ? [path.join(xdg, "opencode", "opencode.db")] : []),
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    path.join(home, ".opencode", "opencode.db"),
  ]
}

async function isDirectory(target: string): Promise<boolean> {
  return Boolean((await fs.stat(target).catch(() => undefined))?.isDirectory())
}

async function opencodeFile(home: string): Promise<string | undefined> {
  for (const candidate of opencodeCandidates(home)) {
    if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) return candidate
  }
  return undefined
}

/** Every `.jsonl` under a folder, at most `depth` levels down. */
async function jsonlFiles(root: string, depth: number): Promise<string[]> {
  const out: string[] = []
  const walk = async (directory: string, left: number): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (left > 0) await walk(full, left - 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        out.push(full)
      }
    }
  }
  await walk(root, depth)
  return out.sort()
}

/* ------------------------------------------------------------------ parsing */

/** A block of message content, whatever shape the tool writes it in. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== "object") continue
    const record = block as Record<string, unknown>
    // Only what was written as words: a tool call or its result is not the conversation.
    const kind = typeof record.type === "string" ? record.type : ""
    if (kind && !["text", "input_text", "output_text", "summary_text"].includes(kind)) continue
    if (typeof record.text === "string") parts.push(record.text)
  }
  return parts.join("\n").trim()
}

function timeOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

/** The title a conversation gets when the source did not name one. */
function titleFrom(turns: Found["turns"]): string {
  const first = turns.find((turn) => turn.role === "user" && turn.text.trim())
  if (!first) return UNTITLED
  const line = first.text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean)
  return line ? clampTitle(line.replace(/\s+/g, " ")) : UNTITLED
}

/** Each line that parses; a line that does not is skipped rather than failing the file. */
function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith("{")) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>)
    } catch {
      /* One damaged line costs that line, not the conversation. */
    }
  }
  return out
}

/** Claude Code's transcript: one JSON object per line, user and assistant entries carrying a `message`. */
function parseClaude(text: string, at: number): Omit<Found, "key" | "mtime"> | undefined {
  const rows = lines(text)
  if (!rows.length) return undefined
  const turns: Found["turns"] = []
  let directory = ""
  let summary = ""
  let first = at
  let last = at
  for (const row of rows) {
    if (typeof row.cwd === "string" && row.cwd && !directory) directory = row.cwd
    if (row.type === "summary" && typeof row.summary === "string") {
      summary = row.summary
      continue
    }
    const role = row.type === "user" ? "user" : row.type === "assistant" ? "assistant" : undefined
    if (!role) continue
    const message = row.message
    if (!message || typeof message !== "object") continue
    const body = textOf((message as Record<string, unknown>).content)
    if (!body) continue
    const when = timeOf(row.timestamp, at)
    if (!turns.length) first = when
    last = when
    turns.push({ role, text: body, at: when })
  }
  if (!turns.length) return undefined
  return {
    title: summary ? clampTitle(summary) : titleFrom(turns),
    directory,
    created: first,
    updated: last,
    turns,
  }
}

/** Codex's rollout: session_meta for the folder, then response_item / event_msg entries. */
function parseCodex(text: string, at: number): Omit<Found, "key" | "mtime"> | undefined {
  const rows = lines(text)
  if (!rows.length) return undefined
  const turns: Found["turns"] = []
  let directory = ""
  let first = at
  let last = at

  const add = (role: "user" | "assistant", body: string, when: number) => {
    if (!body.trim()) return
    if (!turns.length) first = when
    last = when
    turns.push({ role, text: body.trim(), at: when })
  }

  for (const row of rows) {
    const when = timeOf(row.timestamp, at)
    const payload = (row.payload && typeof row.payload === "object" ? row.payload : row) as Record<string, unknown>
    if (typeof payload.cwd === "string" && payload.cwd && !directory) directory = payload.cwd
    const kind = typeof payload.type === "string" ? payload.type : ""
    if (kind === "message") {
      const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : undefined
      if (role) add(role, textOf(payload.content), when)
      continue
    }
    // Its event log writes the same words under their own names.
    if (kind === "user_message" && typeof payload.message === "string") add("user", payload.message, when)
    else if (kind === "agent_message" && typeof payload.message === "string") add("assistant", payload.message, when)
  }
  if (!turns.length) return undefined
  return { title: titleFrom(turns), directory, created: first, updated: last, turns }
}

/* ----------------------------------------------------------------- OpenCode */

type Row = Record<string, unknown>

function columns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
    return new Set(rows.map((row) => String(row.name)))
  } catch {
    return new Set()
  }
}

function hasTable(db: DatabaseSync, table: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    return Boolean(row)
  } catch {
    return false
  }
}

/** The first of these columns the table actually has. */
function pick(available: Set<string>, names: string[]): string | undefined {
  return names.find((name) => available.has(name))
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Whatever this copy of OpenCode's database can say about its sessions.
 *
 * Its schema has moved between releases, so every column is looked up rather
 * than assumed, and a table that is not there simply yields less.
 */
function readOpenCode(file: string, at: number): Found[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    if (!hasTable(db, "session")) return []
    const sessionColumns = columns(db, "session")
    const idColumn = pick(sessionColumns, ["id", "session_id", "sessionID"])
    if (!idColumn) return []
    const titleColumn = pick(sessionColumns, ["title", "name", "summary"])
    const createdColumn = pick(sessionColumns, ["time_created", "created", "created_at", "time"])
    const updatedColumn = pick(sessionColumns, ["time_updated", "updated", "updated_at"])
    const directoryColumn = pick(sessionColumns, ["directory", "cwd", "path", "worktree"])
    const rows = db.prepare(`SELECT * FROM session`).all() as Row[]

    const bySession = new Map<string, Found["turns"]>()
    if (hasTable(db, "message")) {
      const messageColumns = columns(db, "message")
      const link = pick(messageColumns, ["session_id", "sessionID", "sessionId"])
      const roleColumn = pick(messageColumns, ["role"])
      const timeColumn = pick(messageColumns, ["time_created", "created", "created_at", "time"])
      const bodyColumns = ["content", "text", "data", "body", "parts"].filter((name) => messageColumns.has(name))
      if (link && roleColumn) {
        for (const row of db.prepare(`SELECT * FROM message`).all() as Row[]) {
          const sessionID = stringOf(row[link])
          if (!sessionID) continue
          const role = stringOf(row[roleColumn]) === "assistant" ? "assistant" : stringOf(row[roleColumn]) === "user" ? "user" : undefined
          if (!role) continue
          let body = ""
          for (const column of bodyColumns) {
            const raw = row[column]
            if (typeof raw !== "string" || !raw) continue
            if (raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[")) {
              try {
                const parsed: unknown = JSON.parse(raw)
                const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : undefined
                body = textOf(record?.content ?? record?.parts ?? parsed)
              } catch {
                /* Not JSON after all; the next column may still have words. */
              }
            } else {
              body = raw
            }
            if (body.trim()) break
          }
          if (!body.trim()) continue
          const turns = bySession.get(sessionID) ?? []
          turns.push({ role, text: body.trim(), at: timeColumn ? timeOf(row[timeColumn], at) : at })
          bySession.set(sessionID, turns)
        }
      }
    }

    const found: Found[] = []
    for (const row of rows) {
      const id = stringOf(row[idColumn])
      if (!id) continue
      const turns = (bySession.get(id) ?? []).sort((a, b) => a.at - b.at)
      const created = createdColumn ? timeOf(row[createdColumn], at) : at
      const updated = updatedColumn ? timeOf(row[updatedColumn], created) : created
      const title = titleColumn ? stringOf(row[titleColumn]) : ""
      found.push({
        key: id,
        // The row's own clock, so an edited conversation comes back as a resync.
        mtime: updated,
        title: title ? clampTitle(title) : titleFrom(turns),
        directory: directoryColumn ? stringOf(row[directoryColumn]) : "",
        created,
        updated,
        turns,
      })
    }
    return found
  } finally {
    db.close()
  }
}

/* --------------------------------------------------------------------- scan */

async function countClaude(home: string): Promise<{ available: boolean; sessions: number }> {
  const root = claudeRoot(home)
  if (!(await isDirectory(root))) return { available: false, sessions: 0 }
  return { available: true, sessions: (await jsonlFiles(root, 2)).length }
}

async function countCodex(home: string): Promise<{ available: boolean; sessions: number }> {
  const root = codexRoot(home)
  if (!(await isDirectory(root))) return { available: false, sessions: 0 }
  return { available: true, sessions: (await jsonlFiles(root, 5)).length }
}

async function countOpenCode(home: string): Promise<{ available: boolean; sessions: number }> {
  const file = await opencodeFile(home)
  if (!file) return { available: false, sessions: 0 }
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      if (!hasTable(db, "session")) return { available: true, sessions: 0 }
      const row = db.prepare("SELECT count(*) AS n FROM session").get() as { n: number } | undefined
      return { available: true, sessions: Number(row?.n ?? 0) }
    } finally {
      db.close()
    }
  } catch {
    // A database that cannot be opened - another process holding it, a newer format - is still an app that is there.
    return { available: true, sessions: 0 }
  }
}

/** The source's clock of a conversation recognised only by its own marker, which carried none. */
const UNKNOWN_MTIME = -1

/**
 * What has been taken so far, and whether that record may be written back.
 *
 * The record is not the only place this is written down (L12-9). Every
 * conversation an import made carries its source and key, so one whose entry
 * is missing - the record would not parse and was moved aside, or was deleted
 * by hand - is still recognised, and a second import writes the same
 * conversation again rather than a copy of it. Without that, one damaged
 * record duplicated every imported conversation.
 */
async function record(storage: Storage, sessions?: SessionStore): Promise<ImportedRecord & { fromNewerVersion: boolean; blocked: boolean }> {
  const read = await storage.readOrCorrupt<Partial<ImportedRecord>>(RECORD_KEY)
  let blocked = false
  if (read.corrupt !== undefined) {
    const aside = await storage.quarantine(RECORD_KEY)
    // Nothing is written over a record that could be neither read nor moved.
    blocked = !aside
    console.warn(`[import] the import record could not be read (${read.corrupt})${aside ? `; it was kept as ${aside}` : " and could not be moved aside"}`)
  }
  const stored = read.value
  const entries: Record<string, ImportedEntry> = { ...(stored?.entries ?? {}) }
  for (const session of sessions ? await sessions.list().catch(() => []) : []) {
    const marker = session.imported
    if (!marker || !IMPORT_SOURCES.includes(marker.source)) continue
    const key = `${marker.source}:${marker.key}`
    entries[key] ??= { source: marker.source, key: marker.key, mtime: marker.mtime ?? UNKNOWN_MTIME, sessionID: session.id }
  }
  return {
    entries,
    // A record from a later build is read as far as it goes and never written back.
    fromNewerVersion: typeof stored?.schemaVersion === "number" && stored.schemaVersion > IMPORT_SCHEMA_VERSION,
    blocked,
  }
}

/** What each source holds, and how much of it has already been taken. */
export async function scanImports(storage: Storage, sessions?: SessionStore): Promise<ImportScan> {
  const home = homeDirectory()
  const taken = await record(storage, sessions)
  const counts = { cc: 0, codex: 0, opencode: 0 } as Record<ImportSource, number>
  for (const entry of Object.values(taken.entries)) {
    if (IMPORT_SOURCES.includes(entry.source)) counts[entry.source] += 1
  }
  const [cc, codex, opencode] = await Promise.all([countClaude(home), countCodex(home), countOpenCode(home)])
  return {
    cc: { ...cc, imported: counts.cc },
    codex: { ...codex, imported: counts.codex },
    opencode: { ...opencode, imported: counts.opencode },
  }
}

/** Whether a scan found anything worth asking about, which is MiMo's condition for the first-run window. */
export function worthAsking(scan: ImportScan): boolean {
  return IMPORT_SOURCES.some((source) => scan[source].available && scan[source].sessions > 0)
}

/* ---------------------------------------------------------------------- run */

function emptyResult(): ImportSourceResult {
  return { scanned: 0, imported: 0, resynced: 0, skipped: 0, errors: [] }
}

/** A file's own failures, named without a word of what is inside it. */
async function readFound(file: string, parse: (text: string, at: number) => Omit<Found, "key" | "mtime"> | undefined): Promise<Found | string> {
  const stats = await fs.stat(file).catch(() => undefined)
  if (!stats?.isFile()) return `${path.basename(file)}: missing`
  if (stats.size > MAX_FILE) return `${path.basename(file)}: too large`
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return `${path.basename(file)}: unreadable`
  const parsed = parse(text, stats.mtimeMs)
  if (!parsed) return `${path.basename(file)}: no conversation in it`
  return { key: file, mtime: Math.round(stats.mtimeMs), ...parsed }
}

async function foundOf(source: ImportSource, home: string): Promise<{ items: Found[]; errors: string[] }> {
  const items: Found[] = []
  const errors: string[] = []
  if (source === "opencode") {
    const file = await opencodeFile(home)
    if (!file) return { items, errors }
    try {
      items.push(...readOpenCode(file, Date.now()))
    } catch {
      errors.push(`${path.basename(file)}: unreadable`)
    }
    return { items, errors }
  }
  const root = source === "cc" ? claudeRoot(home) : codexRoot(home)
  if (!(await isDirectory(root))) return { items, errors }
  for (const file of await jsonlFiles(root, source === "cc" ? 2 : 5)) {
    const result = await readFound(file, source === "cc" ? parseClaude : parseCodex)
    if (typeof result === "string") errors.push(result)
    else items.push(result)
  }
  return { items, errors }
}

function messagesOf(found: Found, sessionID: string, model: ModelRef): Message[] {
  const out: Message[] = []
  for (const turn of found.turns) {
    if (turn.role === "user") {
      out.push({
        id: Identifier.message(),
        sessionID,
        role: "user",
        text: turn.text,
        attachments: [],
        time: { created: turn.at },
      })
      continue
    }
    out.push({
      id: Identifier.message(),
      sessionID,
      role: "assistant",
      model,
      agent: "build",
      parts: [{ type: "text", id: Identifier.part(), text: turn.text }],
      finish: "end_turn",
      time: { created: turn.at, completed: turn.at },
    })
  }
  return out
}

export interface ImportDeps {
  storage: Storage
  sessions: SessionStore
  model: ModelRef
}

/**
 * Takes the chosen sources' conversations into this app.
 *
 * A conversation is recognised by (source, its key there, the source's own
 * modification time): unchanged since it was taken, it is skipped; changed, its
 * copy here is written again - the same conversation, not a second one; unseen,
 * it is created. Nothing is ever written back to the source.
 */
export async function runImport(deps: ImportDeps, sources: readonly ImportSource[]): Promise<ImportRun> {
  const home = homeDirectory()
  const taken = await record(deps.storage, deps.sessions)
  const out ={ cc: emptyResult(), codex: emptyResult(), opencode: emptyResult() } as ImportRun
  const wanted = IMPORT_SOURCES.filter((source) => sources.includes(source))

  for (const source of wanted) {
    const result = out[source]
    const { items, errors } = await foundOf(source, home)
    result.errors.push(...errors)
    for (const item of items) {
      result.scanned += 1
      const key = `${source}:${item.key}`
      const entry = taken.entries[key]
      const existing = entry ? await deps.sessions.get(entry.sessionID).catch(() => undefined) : undefined
      if (entry && existing && (entry.mtime === item.mtime || entry.mtime === UNKNOWN_MTIME)) {
        /*
         * Recognised by its marker alone, with no clock to compare: it is taken
         * as unchanged rather than written again, since writing again would
         * replace whatever was added to it here since.
         */
        if (entry.mtime === UNKNOWN_MTIME) taken.entries[key] = { ...entry, mtime: item.mtime }
        result.skipped += 1
        continue
      }
      try {
        if (entry && existing) {
          // Changed since it was taken: the same conversation is written again rather than doubled.
          for (const message of await deps.sessions.messages(existing.id)) {
            await deps.sessions.deleteMessage(existing.id, message.id)
          }
          for (const message of messagesOf(item, existing.id, deps.model)) {
            await deps.sessions.saveMessage(message, true)
          }
          await deps.sessions.stamp(existing.id, { title: item.title, updated: item.updated, imported: { source, key: item.key, mtime: item.mtime } })
          taken.entries[key] = { source, key: item.key, mtime: item.mtime, sessionID: existing.id }
          result.resynced += 1
          continue
        }
        const session = await deps.sessions.create({
          // Where it worked, when the source recorded one; it never joins the project list.
          directory: item.directory || home,
          model: deps.model,
          agent: "build",
          title: item.title,
          /* MiMo's "moved out": listed on its own rather than filed under a project. */
          group: "",
          created: item.created,
          updated: item.updated,
          titleSource: "user",
          imported: { source, key: item.key, mtime: item.mtime },
        })
        for (const message of messagesOf(item, session.id, deps.model)) {
          await deps.sessions.saveMessage(message, true)
        }
        taken.entries[key] = { source, key: item.key, mtime: item.mtime, sessionID: session.id }
        result.imported += 1
      } catch {
        result.errors.push(`${path.basename(item.key)}: could not be written`)
      }
    }
  }

  /*
   * Not written over a record a later build wrote. The conversations it already
   * took are still recognised above - the entries are read as usual - but
   * writing this build's understanding back would drop whatever it had added,
   * and the next run would import everything again as though it were new.
   */
  if (!taken.fromNewerVersion && !taken.blocked) {
    await deps.storage.write(RECORD_KEY, { schemaVersion: IMPORT_SCHEMA_VERSION, entries: taken.entries })
  }
  return out
}
