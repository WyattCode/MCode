import type { App, DirectiveBinding } from "vue"

/**
 * Tooltips drawn by the app.
 *
 * MiMo has exactly one styled tooltip - a Radix Tooltip under a single
 * provider mounted at the root - and every value here is read from it: when a
 * tip opens, when it closes, where it sits and how it animates. The native
 * `title` attribute is still right where MiMo uses it (secondary controls in
 * the side panel, resize handles); this is for the controls MiMo gives its
 * drawn tip.
 *
 * A node is made per opening rather than one shared node repositioned: a tip
 * that closes plays its exit while the next plays its entrance, which one
 * shared node cannot show.
 */

export type Placement = "right" | "top" | "bottom" | "left"

export interface Tip {
  /** Optional when a card is given: the card's title names the control instead. */
  label?: string
  /** A shortcut, written after the label and a space as MiMo writes it: "返回 Ctrl+[". */
  hint?: string
  /** MiMo's default side is top; it flips to the opposite side when there is no room. */
  placement?: Placement
  /** No longer does anything: every tip wraps at 420px, as MiMo's do. Kept so older call sites type-check. */
  wrap?: boolean
  /**
   * MiMo's information card, as its conversation rows and title show one: a
   * title in medium weight over a few quieter lines (project, folder, when it
   * last changed). Empty lines are left out.
   */
  card?: { title: string; lines: (string | undefined)[] }
  /** Forced shut, and shut if already up. MiMo passes it while the trigger's own menu is open. */
  disabled?: boolean
  /** Forced open until it turns false, as MiMo's context-usage card stays once clicked. */
  pinned?: boolean
  /** "hover" leaves focus alone, as MiMo's menu-row descriptions do; the default opens on both. */
  trigger?: "hover" | "hoverFocus"
}

/** MiMo's `sideOffset`: the distance from the control. */
export const GAP = 6
/** MiMo's `collisionPadding`: the closest a tip may sit to the window edge. */
export const EDGE = 8
/** MiMo's provider `delayDuration`: how long the pointer rests before a tip appears. */
export const DELAY = 200
/**
 * MiMo's provider `skipDelayDuration`.
 *
 * For this long after any tip closes, the next one opens without waiting.
 * Every close starts it - a click on the control included - because MiMo's
 * provider starts the same timer whichever way a tip was dismissed.
 */
export const WARM = 300

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** How long a tip waits before opening, given when the last one closed (0 for never). */
export function openDelay(now: number, lastClosed: number): number {
  return lastClosed > 0 && now - lastClosed < WARM ? 0 : DELAY
}

/** The text of a plain tip: the label, then the shortcut after one space. */
export function tipText(tip: Pick<Tip, "label" | "hint">): string {
  const label = tip.label ?? ""
  if (!tip.hint) return label
  return label ? `${label} ${tip.hint}` : tip.hint
}

const OPPOSITE: Record<Placement, Placement> = { right: "left", left: "right", top: "bottom", bottom: "top" }

/** Where a tip would sit on a given side of the control, centred along it. */
function offer(anchor: Box, self: Size, side: Placement) {
  const middleY = anchor.top + (anchor.height - self.height) / 2
  const middleX = anchor.left + (anchor.width - self.width) / 2
  if (side === "right") return { left: anchor.right + GAP, top: middleY }
  if (side === "left") return { left: anchor.left - self.width - GAP, top: middleY }
  if (side === "top") return { left: middleX, top: anchor.top - self.height - GAP }
  return { left: middleX, top: anchor.bottom + GAP }
}

/** How far a tip on this side runs past the padded window edge along the axis it extends. */
function overflow(anchor: Box, self: Size, side: Placement, view: Size) {
  const spot = offer(anchor, self, side)
  if (side === "left" || side === "right") {
    return Math.max(0, EDGE - spot.left) + Math.max(0, spot.left + self.width - (view.width - EDGE))
  }
  return Math.max(0, EDGE - spot.top) + Math.max(0, spot.top + self.height - (view.height - EDGE))
}

/**
 * Picks the side and the position, the way MiMo's popper does.
 *
 * The preferred side if it fits, else the opposite one, else whichever of the
 * two overflows less. Along the control the tip is then shifted inside the
 * padding, but never so far that it stops overlapping the control's span -
 * the side axis itself is not clamped, exactly as MiMo leaves it.
 */
export function fit(anchor: Box, self: Size, preferred: Placement, view: Size): { left: number; top: number; side: Placement } {
  const first = overflow(anchor, self, preferred, view)
  const second = overflow(anchor, self, OPPOSITE[preferred], view)
  const side = first === 0 || first <= second ? preferred : OPPOSITE[preferred]
  const spot = offer(anchor, self, side)
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)
  if (side === "top" || side === "bottom") {
    const shifted = clamp(spot.left, EDGE, view.width - self.width - EDGE)
    return { left: clamp(shifted, anchor.left - self.width, anchor.right), top: spot.top, side }
  }
  const shifted = clamp(spot.top, EDGE, view.height - self.height - EDGE)
  return { left: spot.left, top: clamp(shifted, anchor.top - self.height, anchor.bottom), side }
}

interface Layer {
  node: HTMLElement
  target: HTMLElement
}

interface State {
  value: Tip | string
  /** Opened by pointer movement since the pointer last entered: MiMo opens once per entry. */
  moved: boolean
  /** A press is in progress on the control, so the focus it gives does not open the tip. */
  pressed: boolean
  cleanup: () => void
}

const states = new WeakMap<HTMLElement, State>()
/** The tip opened by pointer or focus. */
let open: Layer | undefined
/** A tip held open by `pinned`, which pointer and focus leave alone. */
let pinned: Layer | undefined
let pending: { target: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined
/** When the last tip closed, for the warm window. */
let last = 0
let watcher: ResizeObserver | undefined

function parse(value: Tip | string): Tip {
  return typeof value === "string" ? { label: value } : value
}

function read(el: HTMLElement): Tip {
  return parse(states.get(el)?.value ?? "")
}

function showable(tip: Tip) {
  return Boolean(tip.label || tip.card?.title) && !tip.disabled
}

function render(node: HTMLElement, tip: Tip) {
  node.textContent = ""
  node.classList.toggle("card", Boolean(tip.card))
  if (!tip.card) {
    node.textContent = tipText(tip)
    return
  }
  const title = document.createElement("div")
  title.className = "app-tip-title"
  title.textContent = tip.card.title
  node.appendChild(title)
  for (const text of tip.card.lines) {
    if (!text) continue
    const line = document.createElement("div")
    line.className = "app-tip-line"
    line.textContent = text
    node.appendChild(line)
  }
}

/** Measured from the corner, so the box's own size is never squeezed by where it last sat. */
function position(layer: Layer, tip: Tip) {
  const { node, target } = layer
  node.style.left = "0px"
  node.style.top = "0px"
  const anchor = target.getBoundingClientRect()
  const self = { width: node.offsetWidth, height: node.offsetHeight }
  const spot = fit(anchor, self, tip.placement ?? "top", { width: window.innerWidth, height: window.innerHeight })
  // The side picks the transform origin, so the scale grows out of the control.
  node.dataset.side = spot.side
  node.style.left = `${Math.round(spot.left)}px`
  node.style.top = `${Math.round(spot.top)}px`
}

function reposition() {
  for (const layer of [open, pinned]) {
    if (layer?.target.isConnected) position(layer, read(layer.target))
  }
}

function watch() {
  if (typeof ResizeObserver === "undefined") return
  watcher ??= new ResizeObserver(reposition)
  watcher.disconnect()
  for (const layer of [open, pinned]) {
    if (!layer) continue
    watcher.observe(layer.target)
    watcher.observe(layer.node)
  }
}

function openLayer(target: HTMLElement, tip: Tip): Layer {
  const node = document.createElement("div")
  node.className = "app-tip"
  node.setAttribute("role", "tooltip")
  render(node, tip)
  document.body.appendChild(node)
  const layer = { node, target }
  position(layer, tip)
  // Set last, after measuring: the entrance scales the box, which would skew the measurement.
  node.dataset.state = "open"
  return layer
}

/** Plays the exit, reversed from the entrance, then removes the node. */
function closeLayer(layer: Layer) {
  const { node } = layer
  node.removeAttribute("role")
  node.dataset.state = "closed"
  const done = () => node.remove()
  if (getComputedStyle(node).animationName === "none") return done()
  node.addEventListener("animationend", done, { once: true })
  // A window in the background advances no animation clock, so animationend may never come.
  setTimeout(done, 400)
}

function cancel() {
  if (pending) clearTimeout(pending.timer)
  pending = undefined
}

/** Closes the pointer/focus tip; every close starts the warm window. */
function hide() {
  cancel()
  if (!open) return
  closeLayer(open)
  open = undefined
  last = Date.now()
  watch()
}

function hideFor(el: HTMLElement) {
  if (pending?.target === el) cancel()
  if (open?.target === el) hide()
}

function show(el: HTMLElement) {
  cancel()
  const tip = read(el)
  if (!el.isConnected || !showable(tip) || pinned?.target === el) return
  if (open?.target === el) return
  // Opening one closes any other, as MiMo's provider does.
  if (open) hide()
  open = openLayer(el, tip)
  watch()
}

function enter(el: HTMLElement) {
  const tip = read(el)
  if (!showable(tip) || pinned?.target === el || open?.target === el) return
  cancel()
  // With a tip already up, the provider is not delayed.
  const delay = open ? 0 : openDelay(Date.now(), last)
  if (delay === 0) return show(el)
  pending = { target: el, timer: setTimeout(() => show(el), delay) }
}

/** Applies the latest value: content, `disabled` and `pinned`. */
function sync(el: HTMLElement) {
  const tip = read(el)
  if (tip.disabled) hideFor(el)
  const wantsPin = Boolean(tip.pinned) && showable(tip)
  if (wantsPin && pinned?.target !== el) {
    if (pinned) closeLayer(pinned)
    if (open?.target === el) {
      pinned = open
      open = undefined
    } else {
      pinned = openLayer(el, tip)
    }
    watch()
  } else if (!wantsPin && pinned?.target === el) {
    // Released while the pointer still rests on it: it stays up as an ordinary tip.
    if (!tip.disabled && showable(tip) && el.matches(":hover") && !open) open = pinned
    else closeLayer(pinned)
    pinned = undefined
    watch()
  }
  for (const layer of [open, pinned]) {
    if (layer?.target !== el) continue
    render(layer.node, tip)
    position(layer, tip)
  }
}

/**
 * Gives an icon-only control a name a screen reader can read.
 *
 * A drawn tooltip is only pixels, so without this the whole chrome announces
 * itself as a row of unlabelled buttons. Anything that already has a name of
 * its own - visible text, or an explicit aria-label - is left alone.
 */
function name(el: HTMLElement, tip: Tip) {
  // A card describes something already named by its own text.
  if (!tip.label) return
  const own = el.getAttribute("aria-label")
  if (el.dataset.tipNamed !== "1" && (own || el.textContent?.trim())) return
  if (own === tip.label) return
  el.setAttribute("aria-label", tip.label)
  el.dataset.tipNamed = "1"
}

export const tip = {
  mounted(el: HTMLElement, binding: DirectiveBinding<Tip | string>) {
    /*
     * The value is read at the moment of use, from what `updated` last stored.
     * The binding this hook receives is not the one later updates carry, so a
     * tip whose label only exists once something changes stayed empty for good.
     */
    const state: State = { value: binding.value, moved: false, pressed: false, cleanup: () => undefined }
    states.set(el, state)
    name(el, read(el))

    // MiMo opens on pointer movement, once per entry, and never for touch.
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || state.moved) return
      state.moved = true
      enter(el)
    }
    const leave = () => {
      state.moved = false
      hideFor(el)
    }
    // A press closes it, and the focus the press gives does not reopen it.
    const release = () => {
      state.pressed = false
    }
    const press = () => {
      state.pressed = true
      document.addEventListener("pointerup", release, { once: true })
      hideFor(el)
    }
    const click = () => hideFor(el)
    /*
     * Any focus opens it at once, without the delay, as MiMo's does - not only
     * keyboard focus. `trigger: "hover"` opts a control out.
     */
    const focus = () => {
      if (state.pressed || read(el).trigger === "hover") return
      show(el)
    }
    const blur = () => hideFor(el)

    el.addEventListener("pointermove", move)
    el.addEventListener("pointerleave", leave)
    el.addEventListener("pointerdown", press)
    el.addEventListener("click", click)
    el.addEventListener("focus", focus)
    el.addEventListener("blur", blur)
    state.cleanup = () => {
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerleave", leave)
      el.removeEventListener("pointerdown", press)
      el.removeEventListener("click", click)
      el.removeEventListener("focus", focus)
      el.removeEventListener("blur", blur)
      document.removeEventListener("pointerup", release)
    }
    sync(el)
  },

  updated(el: HTMLElement, binding: DirectiveBinding<Tip | string>) {
    const state = states.get(el)
    if (!state) return
    state.value = binding.value
    // Re-applied so the name follows a language change, not just the tooltip.
    name(el, read(el))
    sync(el)
  },

  unmounted(el: HTMLElement) {
    hideFor(el)
    if (pinned?.target === el) {
      pinned.node.remove()
      pinned = undefined
      watch()
    }
    states.get(el)?.cleanup()
    states.delete(el)
  },
}

export function installTips(app: App): void {
  app.directive("tip", tip)
  // A press anywhere dismisses the open tip, as MiMo's dismissable layer does.
  document.addEventListener("pointerdown", () => hide(), true)
  // Only a scroll that moves the control closes its tip; a list scrolling elsewhere does not.
  window.addEventListener(
    "scroll",
    (event) => {
      if (open && event.target instanceof Node && event.target.contains(open.target)) hide()
    },
    true,
  )
  // A resized window moves the tip with its control rather than dismissing it.
  window.addEventListener("resize", reposition)
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") hide()
    },
    true,
  )
}
