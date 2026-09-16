/**
 * Words for a screen reader that nothing on screen says as they happen: a
 * permission request arriving, a turn ending, background work finishing.
 *
 * Two regions, polite and assertive, made once at start and never removed: a
 * live region only speaks about changes after it is in the page, so one
 * created with its message would say nothing. They are clipped to nothing, so
 * the window looks exactly as before.
 */
export type Urgency = "polite" | "assertive"

const regions = new Map<Urgency, HTMLElement>()
const timers = new Map<Urgency, number>()

const HIDDEN = [
  "position: fixed",
  "inset-block-start: 0",
  "inset-inline-start: 0",
  "inline-size: 1px",
  "block-size: 1px",
  "margin: -1px",
  "padding: 0",
  "overflow: hidden",
  "clip-path: inset(50%)",
  "white-space: nowrap",
  "border: 0",
].join(";")

export function installAnnouncer(host: HTMLElement = document.body): void {
  for (const urgency of ["polite", "assertive"] as const) {
    if (regions.has(urgency)) continue
    const region = document.createElement("div")
    region.setAttribute("role", urgency === "assertive" ? "alert" : "status")
    region.setAttribute("aria-live", urgency)
    region.setAttribute("aria-atomic", "true")
    region.dataset.announce = urgency
    region.setAttribute("style", HIDDEN)
    host.appendChild(region)
    regions.set(urgency, region)
  }
}

/**
 * Says `text` once. The region is emptied first and filled a beat later, so
 * the same words twice in a row (two requests with one title) are both read.
 */
export function announce(text: string, urgency: Urgency = "polite"): void {
  const region = regions.get(urgency)
  const words = text.replace(/\s+/g, " ").trim()
  if (!region || !words) return
  window.clearTimeout(timers.get(urgency))
  region.textContent = ""
  timers.set(
    urgency,
    window.setTimeout(() => {
      region.textContent = words
    }, 100),
  )
}

/** The visible text of the elements with these ids, in order, for an announcement built from what is drawn. */
export function textOf(ids: string[]): string {
  return ids
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
}
