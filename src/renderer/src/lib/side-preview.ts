/*
 * MiMo 26.920's folded side column previews itself: resting on the toggle for
 * 150ms opens the preview, and leaving lets it go 200ms later unless the
 * pointer has moved into the preview (or back onto the controls) meanwhile.
 * Only while the column is folded; a preview asked to stay open simply stays.
 */

export const PREVIEW_OPEN_MS = 150
export const PREVIEW_CLOSE_MS = 200

type Timer = ReturnType<typeof setTimeout>

export interface PreviewClock {
  setTimeout(run: () => void, ms: number): Timer
  clearTimeout(timer: Timer | undefined): void
}

const realClock: PreviewClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer),
}

export interface SidePreview {
  /** From the toggle: open after 150ms, or close after 200ms. */
  schedule(open: boolean): void
  /** From the preview and the controls beside the toggle: they keep an open preview, and let it go when left. */
  hold(open: boolean): void
  /** At once: Escape, a press elsewhere, the toggle pressed, another screen or conversation. */
  close(): void
}

export function sidePreview(folded: () => boolean, shown: { value: boolean }, clock: PreviewClock = realClock): SidePreview {
  let timer: Timer | undefined
  const stop = () => {
    clock.clearTimeout(timer)
    timer = undefined
  }
  const schedule = (open: boolean) => {
    stop()
    if (!folded() || (open && shown.value)) return
    timer = clock.setTimeout(
      () => {
        timer = undefined
        shown.value = open && folded()
      },
      open ? PREVIEW_OPEN_MS : PREVIEW_CLOSE_MS,
    )
  }
  return {
    schedule,
    hold: (open) => {
      if (folded() && shown.value) schedule(open)
    },
    close: () => {
      stop()
      shown.value = false
    },
  }
}
