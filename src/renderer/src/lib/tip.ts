import type { App, DirectiveBinding } from "vue"

/**
 * Tooltips drawn by the app.
 *
 * The native `title` attribute hands the job to the OS: a pale yellow-ish box
 * in the system font, half a second late, in the wrong place, and impossible to
 * theme. Everything else here is drawn by us, so these are too.
 *
 * One element is shared by every target rather than one per button - there is
 * only ever a single tooltip on screen, and thousands of hidden nodes to keep
 * in sync would be waste.
 */

type Placement = "right" | "top" | "bottom" | "left"

interface Tip {
  label: string
  /** Rendered dimmer beside the label, e.g. a shortcut. */
  hint?: string
  placement?: Placement
}

/** Distance from the control, and the closest a tip may sit to the window edge. */
const GAP = 8
const EDGE = 6
/**
 * How long the pointer must rest before a tip appears.
 *
 * Short enough to feel answerable, long enough that crossing a toolbar on the
 * way somewhere else does not set off a trail of boxes. Matches the roughly
 * half-second the platform's own tooltips wait.
 */
const DELAY = 500
/**
 * Once one tip has been shown, neighbours follow immediately for this long.
 *
 * Waiting again at every button turns reading a toolbar into a sequence of
 * pauses; the first wait establishes that the user is looking for labels.
 */
const WARM = 400

let node: HTMLElement | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let current: HTMLElement | undefined
/** When the last tip was dismissed, for the warm window above. */
let last = 0

function element(): HTMLElement {
  if (node) return node
  node = document.createElement("div")
  node.className = "app-tip"
  node.setAttribute("role", "tooltip")
  document.body.appendChild(node)
  return node
}

function parse(value: Tip | string): Tip {
  return typeof value === "string" ? { label: value } : value
}

/**
 * @param clicked dismissed by a click rather than by the pointer moving on.
 *
 * Clicking ends the hunt for labels, so the next control waits the full delay
 * again; carrying the warm window through a click made tips jump out at someone
 * who had already found what they wanted.
 */
function hide(clicked = false) {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (node?.classList.contains("on")) last = clicked ? 0 : Date.now()
  current = undefined
  node?.classList.remove("on")
}

/** Where a tip would sit on a given side of the control. */
function offer(anchor: DOMRect, self: DOMRect, placement: Placement) {
  const middleY = anchor.top + (anchor.height - self.height) / 2
  const middleX = anchor.left + (anchor.width - self.width) / 2
  if (placement === "right") return { left: anchor.right + GAP, top: middleY }
  if (placement === "left") return { left: anchor.left - self.width - GAP, top: middleY }
  if (placement === "top") return { left: middleX, top: anchor.top - self.height - GAP }
  return { left: middleX, top: anchor.bottom + GAP }
}

/**
 * Picks a side with room, rather than squeezing the tip into one without.
 *
 * Clamping alone was wrong: a tip on a control near the right edge slid back
 * over the control it was describing. Only the axis the tip extends along
 * decides the side; the other is clamped, which merely shifts the box along the
 * control instead of covering it.
 */
function fit(anchor: DOMRect, self: DOMRect, preferred: Placement) {
  const opposite: Record<Placement, Placement> = { right: "left", left: "right", top: "bottom", bottom: "top" }
  const vw = window.innerWidth
  const vh = window.innerHeight

  for (const placement of [preferred, opposite[preferred]]) {
    const spot = offer(anchor, self, placement)
    const room =
      placement === "left" || placement === "right"
        ? spot.left >= EDGE && spot.left + self.width <= vw - EDGE
        : spot.top >= EDGE && spot.top + self.height <= vh - EDGE
    if (room) return { ...spot, side: placement }
  }
  return { ...offer(anchor, self, preferred), side: preferred }
}

function place(target: HTMLElement, tip: Tip) {
  const box = element()
  box.textContent = ""

  const label = document.createElement("span")
  label.textContent = tip.label
  box.appendChild(label)

  /*
   * A shortcut is drawn as the keys you press, not as the string "Ctrl+K".
   * Each token gets its own cap, which is what makes a two-key binding legible
   * at eleven pixels.
   */
  if (tip.hint) {
    const keys = document.createElement("span")
    keys.className = "app-tip-keys"
    for (const token of tip.hint.split("+")) {
      const cap = document.createElement("span")
      cap.className = "app-tip-key"
      cap.textContent = token.trim()
      keys.appendChild(cap)
    }
    box.appendChild(keys)
  }

  // Measured before it is shown, so the box never appears at a stale position.
  const anchor = target.getBoundingClientRect()
  const self = box.getBoundingClientRect()
  const preferred = tip.placement ?? "right"
  const spot = fit(anchor, self, preferred)
  // The entrance slides out of the control, so the eye is sent back to it.
  box.dataset.side = spot.side ?? preferred
  // Flushed before `on` lands: without it the browser only recomputes once, at
  // the end, and interpolates from the previous tip's direction - a tip below a
  // toolbar button would slide in from the left because the last one did.
  void box.offsetHeight

  // Never let it leave the window; a tooltip half off-screen is worse than none.
  const left = Math.min(Math.max(EDGE, spot.left), window.innerWidth - self.width - EDGE)
  const top = Math.min(Math.max(EDGE, spot.top), window.innerHeight - self.height - EDGE)

  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
  box.classList.add("on")
}

function show(target: HTMLElement, tip: Tip) {
  if (!tip.label) return
  current = target
  if (timer) clearTimeout(timer)
  const warm = Date.now() - last < WARM
  timer = setTimeout(
    () => {
      if (current !== target || !target.isConnected) return
      place(target, tip)
    },
    warm ? 0 : DELAY,
  )
}

/**
 * Gives an icon-only control a name a screen reader can read.
 *
 * These buttons used to carry `title`, which the browser exposes as the
 * accessible name. A drawn tooltip is only pixels, so without this the whole
 * chrome announces itself as a row of unlabelled buttons. Anything that already
 * has a name of its own - visible text, or an explicit aria-label - is left
 * alone.
 */
function name(el: HTMLElement, tip: Tip) {
  if (!tip.label) return
  const own = el.getAttribute("aria-label")
  if (el.dataset.tipNamed !== "1" && (own || el.textContent?.trim())) return
  if (own === tip.label) return
  el.setAttribute("aria-label", tip.label)
  el.dataset.tipNamed = "1"
}

export const tip = {
  mounted(el: HTMLElement, binding: DirectiveBinding<Tip | string>) {
    const read = () => parse(binding.value)
    name(el, read())
    const enter = () => show(el, read())
    const leave = () => hide()
    /*
     * Only for focus the browser considers worth showing a ring for.
     *
     * A dialog that moves focus to its first control on open was making that
     * control's tooltip appear unbidden, over the dialog's own heading. Keyboard
     * focus still gets one; being focused by code does not.
     */
    const focused = () => {
      if (el.matches(":focus-visible")) enter()
    }

    el.addEventListener("mouseenter", enter)
    el.addEventListener("mouseleave", leave)
    // Focus gets one too, so the keyboard is not told less than the mouse.
    el.addEventListener("focus", focused)
    el.addEventListener("blur", leave)
    // A tooltip lingering over the thing that was just clicked is noise.
    const click = () => hide(true)
    el.addEventListener("mousedown", click)

    Object.assign(el as unknown as Record<string, unknown>, {
      __tipCleanup: () => {
        el.removeEventListener("mouseenter", enter)
        el.removeEventListener("mouseleave", leave)
        el.removeEventListener("focus", focused)
        el.removeEventListener("blur", leave)
        el.removeEventListener("mousedown", click)
      },
    })
  },

  updated(el: HTMLElement, binding: DirectiveBinding<Tip | string>) {
    // Re-applied so the name follows a language change, not just the tooltip.
    name(el, parse(binding.value))
    if (current === el && node?.classList.contains("on")) place(el, parse(binding.value))
  },

  unmounted(el: HTMLElement) {
    if (current === el) hide()
    ;(el as unknown as { __tipCleanup?: () => void }).__tipCleanup?.()
  },
}

export function installTips(app: App): void {
  app.directive("tip", tip)
  // Wrapped, not passed directly: hide() takes a flag, and an Event is truthy.
  const dismiss = () => hide()
  window.addEventListener("scroll", dismiss, true)
  window.addEventListener("resize", dismiss)
  // Anything that moves the page out from under the pointer invalidates it.
  window.addEventListener("wheel", dismiss, { passive: true })
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide()
  })
}
