/**
 * MiMo's installing notice: before the app quits into the installer it shows a
 * system notification and waits for it to be delivered, up to 1.5 s, so the
 * notice is on screen when the window disappears. Plain promises and timers
 * in, so smoke can hold the wait.
 */

export const NOTICE_DELIVERY_TIMEOUT = 1500

export interface Timers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Resolves when `delivered` settles either way, or after `timeoutMs`, whichever is first. */
export function waitForDelivery(
  delivered: Promise<unknown> | undefined,
  timeoutMs = NOTICE_DELIVERY_TIMEOUT,
  timers: Timers = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
): Promise<void> {
  if (!delivered) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = timers.setTimeout(resolve, timeoutMs)
    const done = () => {
      timers.clearTimeout(timer)
      resolve()
    }
    delivered.then(done, done)
  })
}

/** Something that says once whether it was shown, the way Electron's Notification does. */
export interface NoticeEvents {
  once(event: "show" | "failed", listener: () => void): unknown
}

/** The moment a notice is shown or fails to be, as a promise. */
export function deliveryOf(notice: NoticeEvents): Promise<void> {
  return new Promise((resolve) => {
    try {
      notice.once("show", () => resolve())
      notice.once("failed", () => resolve())
    } catch {
      resolve()
    }
  })
}
