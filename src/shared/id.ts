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
