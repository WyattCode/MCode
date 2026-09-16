/**
 * The conversations the numbered and bracket shortcuts count along.
 *
 * MiMo's `K3`: the pinned conversations in the order they were pinned, then
 * every other conversation the side column lists - newest first, or by name
 * when Recent is sorted that way. Archived ones are in neither. Its Ctrl+1-9
 * opens the Nth of these, and its previous / next conversation step along them.
 */
export interface ChatRow {
  id: string
  updated: number
  archived?: boolean
}

export type RecentSort = "recent" | "name"

export function visibleChatOrder<T extends ChatRow>(
  sessions: readonly T[],
  pinned: readonly string[],
  sort: RecentSort,
  nameOf: (session: T) => string,
  locale: string,
): string[] {
  const live = sessions.filter((session) => !session.archived)
  const known = new Set(live.map((session) => session.id))
  const pinnedIDs = [...new Set(pinned)].filter((id) => known.has(id))
  const held = new Set(pinnedIDs)
  const rest = live.filter((session) => !held.has(session.id))
  if (sort === "name") rest.sort((a, b) => nameOf(a).localeCompare(nameOf(b), locale))
  else rest.sort((a, b) => b.updated - a.updated)
  return [...pinnedIDs, ...rest.map((session) => session.id)]
}

/**
 * MiMo's previous / next conversation (its `m5e`): along the visible order,
 * wrapping at both ends. From outside the list the first step lands on the
 * first (forward) or the last (back) conversation; a list of one has nowhere
 * else to go.
 */
export function stepTarget(chats: readonly string[], current: string | undefined, by: 1 | -1): string | undefined {
  if (!chats.length) return undefined
  const at = current ? chats.indexOf(current) : -1
  if (at < 0) return by === 1 ? chats[0] : chats[chats.length - 1]
  if (chats.length === 1) return undefined
  return chats[(at + by + chats.length) % chats.length]
}
