import { createApp, type App } from "vue"
import ErrorPage from "../components/ErrorPage.vue"
import { formatError } from "./format-error"

/**
 * Puts something in the window when the interface stops being able to draw one.
 *
 * Vue does not re-throw an error raised while rendering: it tears the failing
 * subtree out, logs to a console nobody has open, and carries on. When the
 * subtree is the whole workspace - which it is, because everything hangs off a
 * single root - the result is a white rectangle with no message, no version and
 * no way out except killing the process. The app had no handler at all, so
 * every render fault ended that way.
 *
 * This installs the two handlers that catch it and hands the window to a panel
 * that at least says what happened and offers a way on.
 */

declare global {
  interface Window {
    /**
     * Fails on purpose, so the panel below can be seen without waiting for a
     * real fault. See `installErrorPage` for the three shapes it can take.
     */
    __mcodeCrash?: (kind?: "render" | "reject" | "blank") => void
  }
}

/**
 * Only the first failure gets the window.
 *
 * Tearing down a half-rendered tree runs every unmount hook in it, and those
 * can fail too - so the act of showing this panel is itself a likely source of
 * more errors, arriving while it is being shown. The first one is the one that
 * explains the others.
 */
let taken = false

/* MiMo's diagLog: the same failure into the day's log file, which outlives devtools nobody opened. */
function diag(what: string, error: unknown): void {
  try {
    window.mcode?.diagLog(`${what}: ${formatError(error)}`)
  } catch {
    // The bridge is what failed to load, perhaps; the console has it already.
  }
}

/**
 * True when there is nothing left on screen for the person to work with.
 *
 * The workspace mounts into #app and renders a root element unconditionally, so
 * an empty #app means either that mounting never finished or that a failure
 * emptied it. Either way the window is blank.
 */
function windowIsBlank(): boolean {
  const root = document.getElementById("app")
  return !root || root.childElementCount === 0
}

function takeWindow(error: unknown, failed: App): void {
  if (taken) return
  taken = true

  // Whoever has devtools open should still get the untouched value, with the
  // real stack, rather than only the formatted copy shown in the panel.
  console.error("MCode: fatal renderer error", error)
  diag("fatal renderer error", error)

  // A tree that failed while rendering can fail again while being taken down.
  try {
    failed.unmount()
  } catch (duringUnmount) {
    console.error("MCode: the failed interface also threw while unmounting", duringUnmount)
  }

  const host = document.createElement("div")
  host.id = "mcode-error-page"
  document.body.appendChild(host)

  try {
    createApp(ErrorPage, { error }).mount(host)
  } catch (secondary) {
    /*
     * If the panel itself cannot render there is nothing else to fall back on,
     * so the formatted chain goes straight into the page as text. It is bare,
     * but it is the difference between a bug report and a blank window.
     */
    console.error("MCode: the error page failed to render", secondary)
    try {
      host.textContent = formatError(error)
    } catch {
      // Formatting is the same code the panel just failed inside, so it gets
      // the same treatment: if it cannot describe the error, the error's own
      // name is still better than an empty window.
      host.textContent = Object.prototype.toString.call(error)
    }
    host.setAttribute("style", "padding:24px;white-space:pre-wrap;font-family:var(--font-mono)")
  }
}

export function installErrorPage(app: App): void {
  app.config.errorHandler = (error) => takeWindow(error, app)

  /*
   * A rejected promise is only fatal when nothing is left standing.
   *
   * Plenty of work in this app is started and not waited on - opening a
   * project, archiving a session, renaming one - and the store's actions let
   * their failures through, so a backend that says no, or a socket that drops
   * with a request in flight, produces an unhandled rejection while the
   * workspace is perfectly usable. Replacing the window in that case would turn
   * a failed action into a dead app, which is a worse fault than the one this
   * file exists to fix. So the window is only taken when the window is already
   * empty - which is exactly the failure being fixed, and is measurable rather
   * than guessed at.
   */
  window.addEventListener("unhandledrejection", (event) => {
    if (!windowIsBlank()) {
      console.warn("MCode: unhandled rejection, workspace still rendering", event.reason)
      diag("unhandled rejection", event.reason)
      return
    }
    takeWindow(event.reason, app)
  })

  /*
   * A way to see the panel without breaking something first.
   *
   * There is no supported route to a fatal render error from inside the running
   * app, which would make this whole file impossible to check by hand and
   * impossible to keep checked. Three shapes, from the devtools console:
   *
   *   __mcodeCrash()         a component throwing while it renders
   *   __mcodeCrash("reject") a rejected promise with the workspace still up,
   *                          which should be declined and logged, not fatal
   *   __mcodeCrash("blank")  the same rejection after the workspace has gone,
   *                          which is the shape that should take the window
   */
  window.__mcodeCrash = (kind = "render") => {
    const deliberate = new Error("__mcodeCrash: deliberate failure", {
      cause: new Error("__mcodeCrash: the cause, so the chain has a second link"),
    })

    if (kind === "render") {
      const probe = createApp({
        render: (): never => {
          throw deliberate
        },
      })
      probe.config.errorHandler = (error) => takeWindow(error, app)
      probe.mount(document.createElement("div"))
      return
    }

    if (kind === "blank") {
      try {
        app.unmount()
      } catch {
        // Already broken; the rejection below is what is being demonstrated.
      }
    }
    void Promise.reject(deliberate)
  }
}
