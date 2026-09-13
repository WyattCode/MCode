import type { Message, MessageHit, SessionInfo } from "../shared/protocol"

/**
 * Finding words inside conversations, for the search overlay.
 *
 * MiMo's search matches a conversation by its title and by what was said in
 * it, and shows the line it found under the title. The window only holds the
 * open conversation's messages, so the reading is done here, where every
 * transcript is on disk.
 */

/** What a search can find in one message: what was asked and what was answered - not reasoning or tool output. */
export function messageText(message: Message): string {
  if (message.role === "user") return message.text
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("  ")
}

/**
 * Forty characters either side of where the query occurs, with that place marked.
 *
 * Line breaks are turned into spaces first - one for one, so the offsets still
 * hold - because the snippet is drawn on a single line.
 */
export function snippetAround(text: string, at: number, length: number, room = 40) {
  const flat = text.replace(/\s/g, " ")
  const start = Math.max(0, at - room)
  const end = Math.min(flat.length, at + length + room)
  const before = start > 0 ? "…" : ""
  const after = end < flat.length ? "…" : ""
  return {
    text: before + flat.slice(start, end) + after,
    ranges: [{ start: at - start + before.length, end: at - start + before.length + length }],
  }
}

/** The first message holding the query, as a snippet; nothing when none does. */
export function findInMessages(messages: Message[], query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return undefined
  for (const message of messages) {
    const text = messageText(message)
    const at = text.toLowerCase().indexOf(needle)
    if (at >= 0) return { messageID: message.id, ...snippetAround(text, at, needle.length) }
  }
  return undefined
}

/**
 * One hit per conversation, newest conversations first, up to `limit`.
 *
 * Archived conversations and side chats are left out, as they are from every
 * list the overlay draws.
 */
export async function searchMessages(
  sessions: SessionInfo[],
  load: (sessionID: string) => Promise<Message[]>,
  query: string,
  limit = 50,
): Promise<MessageHit[]> {
  const hits: MessageHit[] = []
  if (!query.trim()) return hits
  const candidates = sessions.filter((session) => !session.archived && !session.sideOf).sort((a, b) => b.updated - a.updated)
  for (const session of candidates) {
    if (hits.length >= limit) break
    const found = findInMessages(await load(session.id), query)
    if (found) hits.push({ sessionID: session.id, ...found })
  }
  return hits
}
