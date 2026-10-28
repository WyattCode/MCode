import { randomBytes } from "node:crypto"

/**
 * Monotonic, lexicographically sortable ids.
 *
 * The 48-bit millisecond prefix means a plain string sort over ids is also a
 * chronological sort, which is what lets the session store list messages by
 * reading a directory and sorting the filenames (storage.ts's `list`, which
 * `SessionStore.messages` reads in that order).
 *
 * "Monotonic" has to hold against two things the clock does, and used to hold
 * against neither (R25-#7, carried over from the audit of PR #3):
 *
 *  - **The clock going backwards.** An NTP correction, a daylight change
 *    applied to the system clock, a user setting the time: `Date.now()` returns
 *    a smaller number than it did a moment ago, and the prefix written from it
 *    sorts *before* ids already on disk. A message written after that point
 *    reads as having come before the ones it answers, so the transcript is
 *    shown out of order and re-sent to the model out of order - and "delete
 *    from this message on", which walks the sorted ids, cuts the wrong span.
 *    The high-water mark below is what makes an id's prefix never decrease,
 *    whatever the clock says.
 *
 *  - **More than 65536 ids in one millisecond.** The counter is four hex
 *    digits; the 65537th would have been five, which is one character longer
 *    and therefore sorts *after* every id of the following milliseconds. The
 *    counter now rolls into the next millisecond instead, which is what the
 *    field is for.
 */
const counters = new Map<string, { time: number; seq: number }>()

/** The counter is four hex digits wide; past this the width, and the ordering, would break. */
const SEQ_LIMIT = 0x10000

/**
 * Raises a prefix's high-water mark to a timestamp already on disk.
 *
 * The counter above lives in this process only, so it protected against the
 * clock going backwards *within one run* and nothing else. Quit the app, set
 * the clock back a day, launch it again: the first message written sorted
 * before every message already in the conversation, so the transcript showed
 * out of order and "delete from this message on" cut the wrong span - the same
 * damage the in-process mark was added to prevent, one restart away (round 30
 * recorded it, round 78 closed it).
 *
 * `SessionStore.messages` and `messageIDs` call this for each id they read,
 * which is the one place every transcript goes through: whatever is on disk
 * becomes the floor for anything written after it. The cost is one map lookup
 * per id - the ids are read anyway.
 *
 * Only the timestamp half is taken. The sequence half is per-millisecond and
 * belongs to whoever wrote that millisecond; borrowing it would put a new id
 * behind an old one inside the same millisecond.
 */
export function adopt(prefix: string, existing: string): void {
  const at = `${prefix}_`
  if (!existing.startsWith(at)) return
  const stamp = Number.parseInt(existing.slice(at.length, at.length + 12), 16)
  if (!Number.isFinite(stamp)) return
  const state = counters.get(prefix)
  if (state && state.time >= stamp) return
  counters.set(prefix, { time: stamp, seq: SEQ_LIMIT - 1 })
}

export function id(prefix: string): string {
  const state = counters.get(prefix)
  /*
   * Never earlier than the last id of this prefix. Equal is the ordinary case
   * (several ids inside one millisecond) and is what the counter is for.
   */
  const time = Math.max(Date.now(), state?.time ?? 0)
  let seq = state && state.time === time ? state.seq + 1 : 0
  let stamp = time
  if (seq >= SEQ_LIMIT) {
    // A full millisecond of ids: carry into the next one rather than widening the field.
    stamp = time + 1
    seq = 0
  }
  counters.set(prefix, { time: stamp, seq })
  return `${prefix}_${stamp.toString(16).padStart(12, "0")}${seq.toString(16).padStart(4, "0")}${randomBytes(6).toString("hex")}`
}

export const Identifier = {
  session: () => id("ses"),
  message: () => id("msg"),
  part: () => id("prt"),
  permission: () => id("prm"),
  shell: () => id("shl"),
  request: () => id("req"),
}
