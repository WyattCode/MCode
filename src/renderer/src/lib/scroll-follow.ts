/*
 * When the conversation follows the end of a reply, and where a question just
 * sent comes to rest. The rules are MiMo 26.920's (its scrollStick helpers and
 * ThreadView's scroll handler); they are kept apart from the component so they
 * can be checked without a window.
 */

/** Where a scroller stands: its scrollTop, scrollHeight and clientHeight. */
export interface Geometry {
  top: number
  height: number
  client: number
}

/* The jump button, and only the jump button, waits until the reader is this far from the end. */
export const JUMP_DISTANCE = 64

/* An upward move bigger than this, in one step or added up, is the reader leaving the end. */
export const UP_SLACK = 8

export function endDistance(at: Geometry): number {
  return at.height - at.top - at.client
}

export function jumpShown(at: Geometry): boolean {
  return at.height > at.client && endDistance(at) > JUMP_DISTANCE
}

/*
 * How close to the end counts as back at it: a pixel and a device pixel, so a
 * scrollTop the browser rounds on a fractional scale still lands. 2px at 1x-2x.
 */
export function reattachWithin(devicePixelRatio: number): number {
  return Math.ceil(1 + 1 / Math.max(0.25, devicePixelRatio))
}

/* Moved up more than the slack, and not because the content shrank or the view grew. */
export function scrolledUp(before: Geometry, after: Geometry): boolean {
  return after.top < before.top - UP_SLACK && after.height >= before.height && after.client <= before.client
}

/* Small upward steps, added up until the reader moves down again. */
export function upwardRun(run: number, before: Geometry, after: Geometry): number {
  if (after.top > before.top) return 0
  if (after.height >= before.height && after.client <= before.client) return run + (before.top - after.top)
  return run
}

/*
 * A move down by exactly what the content grew: the browser keeping the view
 * where it was (or the park moving it), not the reader arriving at the end.
 */
export function growthEcho(before: Geometry, after: Geometry): boolean {
  return after.top > before.top && after.height > before.height && Math.abs(after.top - before.top - (after.height - before.height)) <= 1
}

/*
 * Whether the reader moved the view down onto where it is. A scroll event
 * that did not move it down - the browser pulling scrollTop back as a parked
 * question's floor shrinks under a view standing at the end, or firing again
 * with nothing changed - lands on the end without the reader taking it there;
 * nor does a move that only matches the content's growth.
 */
export function movedDown(before: Geometry, after: Geometry): boolean {
  return after.top > before.top && !growthEcho(before, after)
}

/* Leaving always wins; coming back needs the end itself, reached by the reader. */
export function nextFollowing(following: boolean, up: boolean, distance: number, within: number, arrived: boolean): boolean {
  if (up) return false
  if (distance <= within && arrived) return true
  return following
}

/*
 * The holds: while one is on, following stays on but nothing is pinned. A
 * selection being made (after its first 600ms), a media element that just
 * started or stopped, an edit box that is open or just closed, a wheel turned
 * upward in the last 150ms.
 */
export const SELECT_GRACE = 600
export const MEDIA_HOLD = 600
export const EDIT_HOLD = 300
export const WHEEL_HOLD = 150

export interface Holds {
  selecting: boolean
  /* ms since the selecting state last changed. */
  sinceSelect: number
  sinceMedia: number
  editing: boolean
  sinceEdit: number
  sinceWheelUp: number
}

export function heldBy(holds: Holds): "media" | "edit" | "wheel" | "select" | undefined {
  if (holds.sinceMedia <= MEDIA_HOLD) return "media"
  if (holds.editing || holds.sinceEdit <= EDIT_HOLD) return "edit"
  if (holds.sinceWheelUp < WHEEL_HOLD) return "wheel"
  if (holds.selecting && holds.sinceSelect > SELECT_GRACE) return "select"
  return undefined
}

/*
 * Parking a question just sent: its top comes to rest a sixth of the way down
 * the view; a tall question rests higher, so that it ends by two thirds of the
 * way down and the reply starts in sight, but never nearer the top than 12px.
 */
export function parkTarget(clientHeight: number, rowHeight: number): number {
  return Math.min(clientHeight / 6, Math.max(12, (clientHeight * 2) / 3 - rowHeight))
}

/* The room the conversation lacks below the question, which ends at `end`, for it to scroll that far. */
export function parkRoom(rowTop: number, target: number, clientHeight: number, end: number): number {
  return Math.max(0, Math.ceil(rowTop - target + clientHeight - end))
}

/*
 * Where the view rests for a question too tall for the room below its target:
 * pinned to the end, its top would go above the view, so its top rests at the
 * target instead and the reply is written below. Undefined when the end is
 * where it rests (the room, if any, being made up by the floor).
 */
export function parkTop(rowTop: number, target: number, clientHeight: number, end: number): number | undefined {
  return end - clientHeight > rowTop - target ? Math.max(0, rowTop - target) : undefined
}

/*
 * A park is asked for by the composer just before it sends and used when the
 * question appears; one not used within 3s lapses, and a send that was refused
 * takes its own back.
 */
export const PARK_TTL = 3000
const parks = new Map<string, number>()

export function requestPark(sessionID: string, now = Date.now()): void {
  parks.set(sessionID, now)
}

export function clearPark(sessionID: string): void {
  parks.delete(sessionID)
}

export function consumePark(sessionID: string, now = Date.now()): boolean {
  const asked = parks.get(sessionID)
  if (asked === undefined) return false
  parks.delete(sessionID)
  return now - asked <= PARK_TTL
}

/*
 * Which questions enter with MiMo's msg-in: only those added while the
 * conversation is on screen. `from` is the first message index that animates;
 * a conversation just opened, or loaded in one go, animates nothing.
 */
export interface EnterMark {
  id: string | undefined
  length: number
  from: number
}

export function enterMark(mark: EnterMark | undefined, id: string | undefined, length: number): EnterMark {
  if (!mark || mark.id !== id) return { id, length, from: Number.MAX_SAFE_INTEGER }
  if (length > mark.length) {
    const loaded = mark.length === 0 && length - mark.length > 1
    return { id, length, from: loaded ? mark.from : Math.min(mark.from, mark.length) }
  }
  return length < mark.length ? { id, length, from: Math.min(mark.from, length) } : mark
}
