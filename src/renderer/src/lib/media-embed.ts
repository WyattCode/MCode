import { readMediaMeta, type MediaMeta } from "@shared/media-platform"
import { motionReduced } from "./stream-reveal"

/*
 * The window's half of MiMo's video cards: the cards the main process looked
 * up, kept for the session; one inline player at a time; and a new player
 * brought into view the way MiMo brings it.
 */

const PER_CALL = 20
const known = new Map<string, MediaMeta>()
const asking = new Map<string, Promise<MediaMeta | undefined>>()

/** The cards for these links, in order; a link the platform says nothing usable about has none. */
export async function enrichMedia(urls: string[]): Promise<MediaMeta[]> {
  const bridge = window.mcode
  const fresh = urls.filter((url) => !known.has(url) && !asking.has(url))
  if (fresh.length && bridge?.mediaEnrich) {
    for (let at = 0; at < fresh.length; at += PER_CALL) {
      const batch = fresh.slice(at, at + PER_CALL)
      const job = bridge
        .mediaEnrich(batch)
        .catch(() => batch.map(() => null))
        .then((answers) => {
          batch.forEach((url, index) => {
            const meta = readMediaMeta(answers[index])
            // Only a card is kept: a miss is asked again, and the main process decides how long a miss lasts.
            if (meta) known.set(url, meta)
            asking.delete(url)
          })
        })
      for (const url of batch) asking.set(url, job.then(() => known.get(url)))
    }
  }
  const found = await Promise.all(urls.map((url) => (known.has(url) ? Promise.resolve(known.get(url)) : (asking.get(url) ?? Promise.resolve(undefined)))))
  return found.filter((meta): meta is MediaMeta => Boolean(meta))
}

/* MiMo keeps one player open: opening another collapses the one before. */
let open: (() => void) | undefined

export function claimPlayer(collapse: () => void): void {
  if (open && open !== collapse) open()
  open = collapse
}

export function releasePlayer(collapse: () => void): void {
  if (open === collapse) open = undefined
}

function scrollerOf(element: HTMLElement): HTMLElement | undefined {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node
  }
  return undefined
}

/* MiMo's glide to the bottom: 460ms, easing out on a cube. */
function glideToBottom(scroller: HTMLElement): () => void {
  const from = scroller.scrollTop
  const began = performance.now()
  let frame = requestAnimationFrame(function step(now) {
    const share = Math.min(1, (now - began) / 460)
    const target = scroller.scrollHeight - scroller.clientHeight
    scroller.scrollTop = from + (target - from) * (1 - (1 - share) ** 3)
    if (share < 1) frame = requestAnimationFrame(step)
    else scroller.scrollTop = scroller.scrollHeight
  })
  return () => cancelAnimationFrame(frame)
}

/** A player that opens within 160px of the end follows the thread down to it; otherwise it is scrolled just into view. */
export function revealPlayer(element: HTMLElement): () => void {
  let cancel: (() => void) | undefined
  const frame = requestAnimationFrame(() => {
    const scroller = scrollerOf(element)
    if (!scroller) return
    const reduced = motionReduced()
    const box = element.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (scroller.scrollHeight - (scroller.scrollTop + (box.bottom - view.top)) <= 160) {
      if (reduced) scroller.scrollTop = scroller.scrollHeight
      else cancel = glideToBottom(scroller)
    } else element.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" })
  })
  return () => {
    cancelAnimationFrame(frame)
    cancel?.()
  }
}
