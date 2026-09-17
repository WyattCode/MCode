/**
 * Native windows the main process opens, handled per platform as MiMo does.
 * Kept free of Electron's modules so the smoke run can hold each rule.
 */

/* ---------------------------------------------------------------- dialogs */

/**
 * The window a file or folder dialog is attached to. On macOS MiMo attaches
 * none, so the dialog is a free-standing panel rather than a sheet sliding
 * out of the title bar; elsewhere it is attached, so it cannot be lost behind.
 */
export function dialogParent<W>(platform: string, window: W | null | undefined): W | undefined {
  if (platform === "darwin") return undefined
  return window ?? undefined
}

let openDialog: symbol | undefined

/**
 * One native dialog at a time, as MiMo allows: the claim is a token to give
 * back, or undefined while another dialog is up. On macOS the asking window is
 * blurred then, so the panel that is already open comes forward.
 */
export function claimDialog(platform: string, asking?: { blur?: () => void } | null): symbol | undefined {
  if (openDialog) {
    if (platform === "darwin") {
      try {
        asking?.blur?.()
      } catch {
        // A window that is going away needs no focus moved.
      }
    }
    return undefined
  }
  openDialog = Symbol("native-dialog")
  return openDialog
}

export function releaseDialog(token: symbol | undefined): void {
  if (token && openDialog === token) openDialog = undefined
}

/* ---------------------------------------------------------------- microphone */

/**
 * MiMo's microphone check before recording: macOS asks when nobody has
 * decided yet; Windows refuses only when the system setting does; anywhere
 * else (and for any other answer on Windows) recording goes ahead and
 * getUserMedia says the rest.
 */
export function micDecision(platform: string, status: string): "allow" | "ask" | "deny" {
  if (platform === "darwin") {
    if (status === "granted") return "allow"
    if (status === "not-determined") return "ask"
    return "deny"
  }
  if (platform === "win32") return status === "denied" || status === "restricted" ? "deny" : "allow"
  return "allow"
}

/* ---------------------------------------------------------------- full screen */

interface FullScreenWindow {
  isFullScreen(): boolean
  isDestroyed(): boolean
  setFullScreen(flag: boolean): void
  hide(): void
  once(event: "leave-full-screen", listener: () => void): unknown
  removeListener(event: "leave-full-screen", listener: () => void): unknown
}

const pendingHides = new WeakMap<object, () => void>()

/**
 * Hides a window that is being closed to the tray or menu bar. A full-screen
 * window on macOS leaves full screen first and hides once it has; if the app
 * is activated meanwhile (a click on its Dock icon), `cancelPendingHide` drops
 * that hide, as MiMo does, so the window does not vanish again just after it
 * was asked for.
 */
export function hideWindow(window: FullScreenWindow, platform: string): void {
  cancelPendingHide(window)
  if (platform !== "darwin" || !window.isFullScreen()) {
    window.hide()
    return
  }
  const left = () => {
    pendingHides.delete(window)
    if (!window.isDestroyed()) window.hide()
  }
  pendingHides.set(window, () => {
    pendingHides.delete(window)
    window.removeListener("leave-full-screen", left)
  })
  window.once("leave-full-screen", left)
  window.setFullScreen(false)
}

/** Drops a hide still waiting for full screen to end; nothing when there is none. */
export function cancelPendingHide(window: object | null | undefined): void {
  if (window) pendingHides.get(window)?.()
}
