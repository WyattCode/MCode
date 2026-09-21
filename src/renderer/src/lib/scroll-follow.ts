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

/* Leaving always wins; coming back needs the end itself, reached by the reader. */
export function nextFollowing(following: boolean, up: boolean, distance: number, within: number, echo: boolean): boolean {
  if (up) return false
  if (distance <= within && !echo) return true
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

