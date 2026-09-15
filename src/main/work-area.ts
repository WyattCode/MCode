/**
 * Keeping a window on a screen that exists, as MiMo does when displays change
 * and when a window hidden to the tray comes back. Plain rectangles in, so
 * smoke can hold the rules.
 */

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

function inside(area: Box, box: Box): boolean {
  return box.x >= area.x && box.y >= area.y && box.x + box.width <= area.x + area.width && box.y + box.height <= area.y + area.height
}

function overlap(area: Box, box: Box): number {
  const width = Math.min(area.x + area.width, box.x + box.width) - Math.max(area.x, box.x)
  const height = Math.min(area.y + area.height, box.y + box.height) - Math.max(area.y, box.y)
  return width > 0 && height > 0 ? width * height : 0
}

/* How far the box's centre is from the area; zero when it is over it. */
function distance(area: Box, box: Box): number {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = Math.max(area.x - cx, 0, cx - (area.x + area.width))
  const dy = Math.max(area.y - cy, 0, cy - (area.y + area.height))
  return Math.hypot(dx, dy)
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

/**
 * Where a window should go so it lies wholly in a work area: nothing when it
 * already does (or there are no displays to ask), otherwise moved - and shrunk
 * if it is larger - into the area it overlaps most, or the nearest one when it
 * overlaps none.
 */
export function clampToWorkAreas(bounds: Box, areas: readonly Box[]): Box | undefined {
  if (!areas.length || areas.some((area) => inside(area, bounds))) return undefined
  let best = areas[0]!
  let most = -1
  for (const area of areas) {
    const shared = overlap(area, bounds)
    if (shared > most) {
      most = shared
      best = area
    }
  }
  if (most <= 0) {
    let nearest = Infinity
    for (const area of areas) {
      const far = distance(area, bounds)
      if (far < nearest) {
        nearest = far
        best = area
      }
    }
  }
  const width = Math.min(bounds.width, best.width)
  const height = Math.min(bounds.height, best.height)
  return {
    x: Math.round(clamp(bounds.x, best.x, best.x + best.width - width)),
    y: Math.round(clamp(bounds.y, best.y, best.y + best.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * Whether two bounds are the same once scaling noise is allowed for. Under
 * fractional display scaling a setBounds round-trip comes back a pixel or so
 * off, and re-applying on every such difference would grow the window each
 * time it came back from the tray - window-state.ts allows the same 4.
 */
export function closeBounds(a: Box, b: Box, tolerance = 4): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}

/**
 * The bounds a window hidden to the tray gets back on show: the ones recorded
 * when it hid, pulled onto a screen if that one has gone. Nothing for a window
 * that hid from full screen, or that recorded nothing.
 */
export function boundsOnShow(recorded: Box | undefined, fullScreen: boolean, areas: readonly Box[]): Box | undefined {
  if (!recorded || fullScreen) return undefined
  return clampToWorkAreas(recorded, areas) ?? recorded
}
