import type { Message, MessageHit, SessionInfo } from "../shared/protocol"
import { MESSAGE_SEARCH_CHARS, scoreMatch, snippetOf } from "../shared/search-score"

/**
 * Finding words inside conversations, for the search overlay.
 *
 * MiMo's search matches a conversation by its title and by what was said in
 * it, and shows the line it found under the title. The window only holds the
 * open conversation's messages, so the reading is done here, where every
 * transcript is on disk - every conversation, where MiMo reads the loaded ones
 * and a few more.
 */

/**
 * What a search reads of one message, as MiMo reads it: what was asked, or
 * what was answered with each step's output after it - not reasoning - joined
 * and cut at 20,000 characters.
 */
export function messageText(message: Message): string {
  if (message.role === "user") return message.text.slice(0, MESSAGE_SEARCH_CHARS)
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : part.type === "tool" && part.output ? [part.output] : []))
    .filter(Boolean)
    .join("  ")
    .slice(0, MESSAGE_SEARCH_CHARS)
}

/** The best-scoring message holding the query, as a snippet with its score; nothing when none matches. */
export function findInMessages(messages: Message[], query: string): Omit<MessageHit, "sessionID"> | undefined {
  const needle = query.trim().toLowerCase()
  if (!needle) return undefined
  let best: Omit<MessageHit, "sessionID"> | undefined
  for (const message of messages) {
    const text = messageText(message)
    if (!text) continue
    const found = scoreMatch(text, needle)
    if (!found || (best && found.score <= best.score)) continue
    best = { messageID: message.id, score: found.score, ...snippetOf(text, found.ranges) }
  }
  return best
}

/**
 * How many conversations are read when the index cannot narrow the field.
 *
 * Only reached while the index is still being filled, or on a machine where
 * SQLite would not open at all. Without it, one keystroke read every message of
 * every conversation from disk - measured at about 150,000 file reads on a
 * profile with 500 conversations - on the same thread as every running turn.
 */
export const SCAN_LIMIT = 200

/**
 * One hit per conversation - its best message - best first and, between equal
 * scores, newest first, up to `limit`.
 *
 * Archived conversations, side chats and subagents are left out, as they are
 * from every list the overlay draws.
 *
 * `narrow` is the full-text index (N11-5): given the query it names the
 * conversations worth reading, and only those are read. It returns nothing when
 * it cannot help - no index, or one still being filled - and then the newest
 * SCAN_LIMIT conversations are read instead, so a search during the first
 * minutes after an upgrade is incomplete rather than ruinous.
 */
export async function searchMessages(
  sessions: SessionInfo[],
  load: (sessionID: string) => Promise<Message[]>,
  query: string,
  limit = 50,
  narrow?: (query: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined,
): Promise<MessageHit[]> {
  if (!query.trim()) return []
  const eligible = sessions.filter((session) => !session.archived && !session.sideOf && !session.parentID)
  const named = await narrow?.(query)
  const candidates = named ? eligible.filter((session) => named.includes(session.id)) : eligible.slice(0, SCAN_LIMIT)
  const hits: (MessageHit & { updated: number })[] = []
  for (const session of candidates) {
    const found = findInMessages(await load(session.id), query)
    if (found) hits.push({ sessionID: session.id, ...found, updated: session.updated })
  }
  return hits
    .sort((a, b) => b.score - a.score || b.updated - a.updated)
    .slice(0, limit)
    .map(({ updated: _updated, ...hit }) => hit)
}
