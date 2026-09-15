import { ref } from "vue"
import { t } from "./i18n"

/**
 * Brief notices, shown at the top of the window and dismissed on their own.
 *
 * Connecting a provider happens in three different places; rather than each one
 * finding somewhere to say so, they all end up here and the message is shown
 * the same way wherever the work started.
 *
 * Laid out as MiMo's notices are: a one-line capsule per notice in one of four
 * levels, up to two links after the title, five seconds unless the pointer is
 * resting on it or the window is hidden, and the same level and title raised
 * again replaces the one on screen instead of stacking a copy.
 */

/** How the notice is coloured, and which mark it carries. */
export type ToastLevel = "info" | "success" | "warning" | "danger"

/** A next step, drawn as a link after the title; following it dismisses the notice. */
export interface ToastLink {
  label: string
  run: () => void
}

export interface ToastOptions {
  level?: ToastLevel
  /**
   * A detail older callers pass, usually a failure's reason. MiMo's notice is a
   * title alone, so this is folded into the title after " · " rather than drawn
   * as a second text.
   */
  body?: string
  links?: ToastLink[]
  /** The single link older callers pass; joins `links`. */
  action?: ToastLink
  /** Milliseconds on screen; 0 keeps it until closed. */
  duration?: number
  closable?: boolean
  /** Replaces whatever notice holds this id. Defaults to the level and the title. */
  id?: string
}

export interface Toast {
  id: string
  level: ToastLevel
  title: string
  links: ToastLink[]
  closable: boolean
}

/** The one line a notice shows: the title, and any detail folded in after it. */
export function toastTitle(title: string, body?: string): string {
  const detail = body?.trim()
  return detail ? `${title} · ${detail}` : title
}

export const DURATION = 5000
/** Enough to see a couple stack up, few enough that they cannot bury the app. */
const LIMIT = 3
/** MiMo draws at most two links on a notice. */
const LINKS = 2

export const toasts = ref<Toast[]>([])

/* Each notice's remaining time, so a pause resumes with what was left. */
interface Clock {
  handle?: ReturnType<typeof setTimeout>
  left: number
  since: number
  held: boolean
}

const clocks = new Map<string, Clock>()
let hidden = false

/** The identity MiMo gives a notice: its level and title, hashed. */
export function toastID(level: ToastLevel, title: string): string {
  const text = `${level}|${title}`
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `n${(hash >>> 0).toString(36)}`
}

function start(id: string) {
  const clock = clocks.get(id)
  if (!clock || clock.held || hidden || clock.handle) return
  clock.since = Date.now()
  clock.handle = setTimeout(() => dismiss(id), clock.left)
}

function halt(id: string) {
  const clock = clocks.get(id)
  if (!clock?.handle) return
  clearTimeout(clock.handle)
  clock.handle = undefined
  clock.left = Math.max(0, clock.left - (Date.now() - clock.since))
}

function stop(id: string) {
  halt(id)
  clocks.delete(id)
}

export function show(level: ToastLevel, heading: string, options: ToastOptions = {}): string {
  const title = toastTitle(heading, options.body)
  const id = options.id ?? toastID(level, title)
  const links = [...(options.links ?? []), ...(options.action ? [options.action] : [])].slice(0, LINKS)
  const entry: Toast = { id, level, title, links, closable: options.closable !== false }
  if (toasts.value.some((item) => item.id === id)) {
    toasts.value = toasts.value.map((item) => (item.id === id ? entry : item))
  } else {
    const next = [...toasts.value, entry]
    for (const gone of next.slice(0, Math.max(0, next.length - LIMIT))) stop(gone.id)
    toasts.value = next.slice(-LIMIT)
  }
  // A replacement starts its time again, as a fresh notice would.
  stop(id)
  const duration = options.duration ?? DURATION
  if (duration > 0) {
    clocks.set(id, { left: duration, since: 0, held: false })
    start(id)
  }
  return id
}

/** The pointer is resting on a notice: its time stops. */
export function hold(id: string): void {
  const clock = clocks.get(id)
  if (!clock) return
  clock.held = true
  halt(id)
}

/** And carries on with what it had left. */
export function release(id: string): void {
  const clock = clocks.get(id)
  if (!clock) return
  clock.held = false
  start(id)
}

export function dismiss(id: string): void {
  stop(id)
  toasts.value = toasts.value.filter((entry) => entry.id !== id)
}

/** MiMo's four calls, by level. */
export const notice = {
  info: (title: string, options?: ToastOptions) => show("info", title, options),
  success: (title: string, options?: ToastOptions) => show("success", title, options),
  warning: (title: string, options?: ToastOptions) => show("warning", title, options),
  danger: (title: string, options?: ToastOptions) => show("danger", title, options),
  dismiss,
}

/*
 * The two calls every existing site uses. The second argument is still the
 * body, or now an options object carrying a level and links.
 */
export function notify(title: string, body?: string | ToastOptions, action?: ToastLink): string {
  const options = typeof body === "object" ? body : { body, action }
  return show(options.level ?? "info", title, options)
}

/** The same, for something that did not work. */
export function notifyFailure(title: string, body?: string | ToastOptions, action?: ToastLink): string {
  const options = typeof body === "object" ? body : { body, action }
  return show(options.level ?? "danger", title, options)
}

/** The id MiMo's zoom notice replaces itself under. */
export const ZOOM_TOAST = "app-zoom"

/** MiMo's zoom notice: the percent and the key back to 100%, or that it is back. */
export function zoomNotice(percent: number, platform: string): string {
  const whole = Math.round(percent)
  if (whole === 100) return t("zoom.restored")
  return t("zoom.changed", { percent: whole, combo: platform === "darwin" ? "⌘0" : "Ctrl+0" })
}

/* A hidden window is not being read, so no notice runs out while it is. */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    hidden = document.hidden
    for (const id of [...clocks.keys()]) {
      if (hidden) halt(id)
      else start(id)
    }
  })
}
