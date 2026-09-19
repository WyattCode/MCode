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

/**
 * Where a window with saved bounds opens (I13-4): grown to the minimum size,
 * then wholly inside a work area, as MiMo places it at creation. The old rule
 * kept any bounds with 120 by 40 of the window on a screen, and that strip
 * could be the bottom of it - leaving the title bar, the only thing to drag a
 * frameless window by, above the top of the screen. With no displays to ask
 * (a locked workstation) the saved bounds are kept.
 */
export function startBounds(saved: Box, areas: readonly Box[], min: { width: number; height: number }): Box {
  const sized = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.max(min.width, Math.round(saved.width)),
    height: Math.max(min.height, Math.round(saved.height)),
  }
  return clampToWorkAreas(sized, areas) ?? sized
}

/*
 * MiMo's maximize on Linux (I13-7): the window is sized to the work area
 * rather than handed to the window manager, whose maximize differs from one
 * desktop to the next. A window counts as maximized when its size is within
 * 2 px of the work area's, as MiMo measures it.
 */
const FILL_TOLERANCE = 2

export function fillsWorkArea(bounds: Box, area: Box): boolean {
  return Math.abs(bounds.width - area.width) <= FILL_TOLERANCE && Math.abs(bounds.height - area.height) <= FILL_TOLERANCE
}

/* The preferred size, no larger than the area, in the middle of it. */
function centred(area: Box, preferred: { width: number; height: number }): Box {
  const width = Math.min(preferred.width, area.width)
  const height = Math.min(preferred.height, area.height)
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height }
}

/**
 * Where MiMo's Linux maximize toggle puts a window. One that fills the work
 * area goes back to the saved bounds - held between the minimum and the area,
 * or the preferred size in the middle of the area when nothing is saved or the
 * saved bounds would fill it again. Any other window fills the work area.
 */
export function linuxMaximizeToggle(
  current: Box,
  area: Box,
  saved: Box | undefined,
  sizes: { min: { width: number; height: number }; preferred: { width: number; height: number } },
): { bounds: Box; maximized: boolean } {
  if (!fillsWorkArea(current, area)) return { bounds: { ...area }, maximized: true }
  if (!saved) return { bounds: centred(area, sizes.preferred), maximized: false }
  const width = Math.max(sizes.min.width, Math.min(Math.round(saved.width), area.width))
  const height = Math.max(sizes.min.height, Math.min(Math.round(saved.height), area.height))
  const back = { x: Math.round(saved.x), y: Math.round(saved.y), width, height }
  return { bounds: fillsWorkArea(back, area) ? centred(area, sizes.preferred) : back, maximized: false }
}
