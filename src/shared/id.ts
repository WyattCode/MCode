import { randomBytes } from "node:crypto"

/**
 * Monotonic, lexicographically sortable ids.
 *
 * The 48-bit millisecond prefix means a plain string sort over ids is also a
 * chronological sort, which is what lets the session store list messages by
 * reading a directory and sorting the filenames.
 */
const counters = new Map<string, { time: number; seq: number }>()

export function id(prefix: string): string {
  const state = counters.get(prefix)
  /*
   * The clock is allowed to jump backwards - an NTP correction is enough - and
   * an id stamped with the earlier time would sort in front of ids already
   * written, which is how a transcript ends up out of order. Time only ever
   * moves forward here.
   */
  let now = Math.max(Date.now(), state?.time ?? 0)
  if (!state || state.time !== now) {
    counters.set(prefix, { time: now, seq: 0 })
  } else if (state.seq >= 0xffff) {
    /*
     * The counter is four hex digits wide, and a fifth would sort in front of
     * every id already written rather than after them. Borrowing a millisecond
     * keeps the width fixed and the order intact.
     */
    now += 1
    counters.set(prefix, { time: now, seq: 0 })
  } else {
    state.seq++
  }
  const seq = counters.get(prefix)!.seq
  const time = now.toString(16).padStart(12, "0")
  const count = seq.toString(16).padStart(4, "0")
  const rand = randomBytes(6).toString("hex")
  return `${prefix}_${time}${count}${rand}`
}

export const Identifier = {
  session: () => id("ses"),
  message: () => id("msg"),
  part: () => id("prt"),
  permission: () => id("prm"),
  shell: () => id("shl"),
  request: () => id("req"),
}
