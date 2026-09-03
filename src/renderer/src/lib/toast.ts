import { ref } from "vue"

/**
 * Brief confirmations, shown in the corner and dismissed on their own.
 *
 * Connecting a provider happens in three different places; rather than each one
 * finding somewhere to say so, they all end up here and the message is shown
 * the same way wherever the work started.
 */

/**
 * What kind of thing happened.
 *
 * Every toast drew the same green tick, so "could not check for updates" and
 * "file too large" were confirmed as successes. The mark and its colour follow
 * this instead.
 */
export type ToastKind = "done" | "failed"

export interface Toast {
  id: number
  title: string
  body?: string
  kind: ToastKind
  /** An optional next step, drawn as a button and dismissing the toast. */
  action?: { label: string; run: () => void }
}

const LIFETIME = 6000
/** Enough to see a couple stack up, few enough that they cannot bury the app. */
const LIMIT = 3

let counter = 0
export const toasts = ref<Toast[]>([])

export function notify(title: string, body?: string, action?: Toast["action"]): number {
  return raise("done", title, body, action)
}

/** The same, for something that did not work. */
export function notifyFailure(title: string, body?: string, action?: Toast["action"]): number {
  return raise("failed", title, body, action)
}

function raise(kind: ToastKind, title: string, body?: string, action?: Toast["action"]): number {
  const id = ++counter
  toasts.value = [...toasts.value, { id, title, body, kind, action }].slice(-LIMIT)
  setTimeout(() => dismiss(id), LIFETIME)
  return id
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((entry) => entry.id !== id)
}
