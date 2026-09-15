import { computed, onBeforeUnmount, reactive, ref, watch } from "vue"

/*
 * MiMo's streaming reveal: a live answer comes out a few characters a frame
 * rather than in network-sized chunks, and each new character fades in over
 * 220ms. The numbers are MiMo's own; the pure pieces are exported so the checks
 * can hold them to those numbers.
 */

/** Characters shown this frame: at least 2, a 22nd of the backlog, and faster once it lags past 200. */
export function revealStep(backlog: number): number {
  if (backlog <= 0) return 0
  const steady = Math.max(2, Math.ceil(backlog / 22))
  const catchUp = backlog > 200 ? Math.ceil((backlog - 200) / 3) : 0
  return Math.min(backlog, Math.max(steady, catchUp))
}

export const FADE_MS = 220
/** At most this many characters are fading at once. */
export const FADE_STAMPS = 300
/** A live block with more text than this is shown without the fade, as MiMo skips it. */
export const FADE_SOURCE_LIMIT = 9000

/** A cubic ease-out from 0 to 1 over the fade. */
export function fadeOpacity(age: number): number {
  const progress = Math.min(1, Math.max(0, age / FADE_MS))
  return 1 - Math.pow(1 - progress, 3)
}

export function opacitiesOf(stamps: readonly number[], now: number): number[] {
  return stamps.map((stamp) => fadeOpacity(now - stamp))
}

/** Drops the stamps whose fade has finished; they are oldest first. */
export function pruneStamps(stamps: number[], now: number): number[] {
  let at = 0
  while (at < stamps.length && now - stamps[at] >= FADE_MS) at += 1
  return at === 0 ? stamps : stamps.slice(at)
}

/** Kept per live block: where fading starts, and each character's brightest opacity so far. */
export interface FadeAnchor {
  start: number
  floors: number[]
}

const VOID_TAGS = new Set(["br", "hr", "img", "input", "wbr", "col", "area", "source"])
/* MiMo leaves code alone; the renderer's own buttons, icons and KaTeX are chrome, not typed text. */
const SKIPPED_TAGS = new Set(["pre", "code", "button", "svg"])
const SKIPPED_CLASS = /(^|\s)(md-codeblock|md-table-actions|katex[\w-]*)(\s|$)/
const ROW_TAGS = new Set(["table", "thead", "tbody", "tr"])
/* One character: an entity, or one code point so an emoji is never split. */
const UNIT = /&[#\w]+;|[\s\S]/gu

/**
 * MiMo's fade tail over a rendered block: the last `opacities.length`
 * characters of its text are each wrapped in a span at their opacity, oldest
 * first. Text in code, direct text of table rows and whitespace-only text are
 * left out, a fully bright character stays plain, and with an anchor a
 * character never dims again once it has brightened.
 *
 * Works on the renderer's own markup, where every text piece is escaped, so a
 * split on tags is exact.
 */
export function fadeTail(html: string, opacities: readonly number[], anchor?: FadeAnchor): string {
  const count = opacities.length
  if (count <= 0) return html
  const pieces = html.split(/(<[^>]*>)/)
  const stack: { name: string; skip: boolean }[] = []
  let skipping = 0
  const texts: { index: number; start: number; units: string[] }[] = []
  let total = 0

  pieces.forEach((piece, index) => {
    if (index % 2 === 1) {
      const closing = /^<\s*\/\s*([a-zA-Z][\w-]*)/.exec(piece)
      if (closing) {
        const at = stack.map((entry) => entry.name).lastIndexOf(closing[1].toLowerCase())
        if (at >= 0) for (const entry of stack.splice(at)) if (entry.skip) skipping -= 1
        return
      }
      const opening = /^<\s*([a-zA-Z][\w-]*)/.exec(piece)
      if (!opening) return
      const name = opening[1].toLowerCase()
      if (VOID_TAGS.has(name) || /\/\s*>$/.test(piece)) return
      const skip = SKIPPED_TAGS.has(name) || SKIPPED_CLASS.test(/\bclass="([^"]*)"/.exec(piece)?.[1] ?? "")
      stack.push({ name, skip })
      if (skip) skipping += 1
      return
    }
    if (!piece || skipping > 0 || /^\s*$/.test(piece)) return
    const parent = stack[stack.length - 1]
    if (parent && ROW_TAGS.has(parent.name)) return
    const units = piece.match(UNIT) ?? []
    texts.push({ index, start: total, units })
    total += units.length
  })

  if (!total) return html
  let from = Math.max(0, total - count)
  if (anchor) {
    from = Math.max(from, anchor.start)
    anchor.start = from
  }
  if (from >= total) return html
  const span = total - from
  for (const text of texts) {
    if (text.start + text.units.length <= from) continue
    const out = text.units.map((unit, offset) => {
      const position = text.start + offset
      if (position < from) return unit
      const slot = Math.min(count - 1, position - from + Math.max(0, count - span))
      let opacity = opacities[slot] ?? 1
      if (anchor) {
        const floor = anchor.floors[position] ?? 0
        if (opacity < floor) opacity = floor
        anchor.floors[position] = opacity
      }
      return opacity >= 0.999 ? unit : `<span class="sm-fade" style="opacity:${opacity.toFixed(3)}">${unit}</span>`
    })
    pieces[text.index] = out.join("")
  }
  return pieces.join("")
}

/** MCode's reduce-motion setting first; left to the system, the system's preference. */
export function motionReduced(): boolean {
  if (typeof document === "undefined") return true
  const motion = document.documentElement.getAttribute("data-motion")
  if (motion === "on") return true
  if (motion === "off") return false
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}

/** Text parts whose reveal is still playing out, so a turn's finished state can wait for them. */
export const revealing = reactive(new Set<string>())

/**
 * `paced` reveals new text a little each frame; `full` shows everything now (a
 * part that is no longer the live tail); `settle` lets a reveal already under
 * way finish after the stream has ended, and otherwise shows everything.
 */
export type RevealMode = "paced" | "full" | "settle"

/* A covered window can stop drawing frames; the text then catches up instead of stalling. */
const STALL_MS = 500

export function useStreamReveal(id: () => string, source: () => string, mode: () => RevealMode) {
  // What is already there when the part mounts is shown at once: history never replays.
  let revealed = source().length
  let stamps: number[] = []
  let clock = 0
  let playing = false
  let frameHandle: number | undefined
  let stall: ReturnType<typeof setTimeout> | undefined
  const frame = ref(0)
  const bump = () => (frame.value = (frame.value + 1) & 0xffff)

  function unschedule() {
    if (frameHandle !== undefined) cancelAnimationFrame(frameHandle)
    clearTimeout(stall)
    frameHandle = undefined
    stall = undefined
  }

  function mark() {
    if (playing) revealing.add(id())
    else revealing.delete(id())
  }

  function jump() {
    unschedule()
    const length = source().length
    const changed = revealed !== length || stamps.length > 0
    revealed = length
    stamps = []
    playing = false
    mark()
    if (changed) bump()
  }

  function tick() {
    unschedule()
    const now = performance.now()
    clock = now
    const length = source().length
    if (revealed > length) {
      revealed = length
      stamps = []
    }
    if (revealed < length) {
      const step = revealStep(length - revealed)
      for (let each = 0; each < step; each += 1) stamps.push(now)
      revealed += step
      if (stamps.length > FADE_STAMPS) stamps.splice(0, stamps.length - FADE_STAMPS)
    }
    stamps = pruneStamps(stamps, now)
    bump()
    if (revealed < length || stamps.length) schedule()
    else {
      playing = false
      mark()
    }
  }

  function schedule() {
    if (frameHandle !== undefined) return
    frameHandle = requestAnimationFrame(tick)
    stall = setTimeout(jump, STALL_MS)
  }

  function sync() {
    const current = mode()
    if (motionReduced() || current === "full" || (current === "settle" && !playing)) {
      jump()
      return
    }
    if (revealed < source().length || stamps.length) {
      playing = true
      mark()
      schedule()
    } else if (revealed > source().length) jump()
  }

  watch([source, mode], sync)

  // MiMo: coming back to the window shows the whole answer rather than replaying what was missed.
  const onVisibility = () => {
    if (document.visibilityState === "visible") jump()
  }
  document.addEventListener("visibilitychange", onVisibility)

  onBeforeUnmount(() => {
    unschedule()
    revealing.delete(id())
    document.removeEventListener("visibilitychange", onVisibility)
  })

  const text = computed(() => {
    void frame.value
    const full = source()
    return revealed >= full.length ? full : full.slice(0, revealed)
  })
  const opacities = computed(() => {
    void frame.value
    return stamps.length ? opacitiesOf(stamps, clock) : []
  })
  const done = computed(() => {
    void frame.value
    return revealed >= source().length && stamps.length === 0
  })
  return { text, opacities, done }
}
