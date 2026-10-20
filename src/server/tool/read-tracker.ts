import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

interface Stamp {
  mtimeMs: number
  size: number
  hash?: string
}

const MAX_SESSIONS = 200
const MAX_ENTRIES_PER_SESSION = 2000

/**
 * Per-session file stamps, keyed by resolved path.
 *
 * The outer Map is kept in least-recently-used order: touching a session moves
 * it to the end, and the oldest sessions are dropped when the cap is reached.
 * Each inner Map is likewise LRU by path.
 */
const sessions = new Map<string, Map<string, Stamp>>()

// Windows and macOS default filesystems are case-insensitive, so the key must
// fold case there or `/Users/X/File.ts` misses the stamp written for a
// differently-cased spelling of the same file.
const CASE_FOLD = process.platform === "win32" || process.platform === "darwin"

function pathKey(absPath: string): string {
  const resolved = path.resolve(absPath)
  return CASE_FOLD ? resolved.toLowerCase() : resolved
}

function touchSession(sessionID: string): Map<string, Stamp> {
  let entries = sessions.get(sessionID)
  if (entries) {
    sessions.delete(sessionID)
    sessions.set(sessionID, entries)
    return entries
  }
  entries = new Map()
  sessions.set(sessionID, entries)
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest === undefined) break
    sessions.delete(oldest)
  }
  return entries
}

function touchEntry(entries: Map<string, Stamp>, key: string, stamp: Stamp): void {
  entries.delete(key)
  entries.set(key, stamp)
  while (entries.size > MAX_ENTRIES_PER_SESSION) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export function recordRead(sessionID: string, absPath: string, stat: { mtimeMs: number; size: number }, content?: string): void {
  const entries = touchSession(sessionID)
  const stamp: Stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
  if (content !== undefined) stamp.hash = hashContent(content)
  touchEntry(entries, pathKey(absPath), stamp)
}

export async function recordWrite(sessionID: string, absPath: string, content?: string): Promise<void> {
  const stat = await fs.stat(absPath).catch(() => undefined)
  if (!stat) return
  recordRead(sessionID, absPath, { mtimeMs: stat.mtimeMs, size: stat.size }, content)
}

export function wasRead(sessionID: string, absPath: string): boolean {
  const entries = sessions.get(sessionID)
  if (!entries) return false
  return entries.has(pathKey(absPath))
}

export async function checkFresh(sessionID: string, absPath: string, current?: string): Promise<string | undefined> {
  const entries = sessions.get(sessionID)
  if (!entries) return undefined

  const key = pathKey(absPath)
  const stamp = entries.get(key)
  if (!stamp) return undefined

  // Keep the session and entry hot.
  touchSession(sessionID)
  touchEntry(entries, key, stamp)

  const stat = await fs.stat(absPath).catch(() => undefined)
  if (!stat) return undefined
  if (stat.mtimeMs !== stamp.mtimeMs || stat.size !== stamp.size) {
    return "changed since last read/write"
  }
  if (current !== undefined && stamp.hash !== undefined && hashContent(current) !== stamp.hash) {
    return "changed since last read/write"
  }
  return undefined
}
