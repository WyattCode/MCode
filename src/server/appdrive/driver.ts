/**
 * Drives one app's pages for the app tool: a web page in a browser this tool
 * started, or an Electron app (or any Chromium) that was started with a
 * DevTools port.
 *
 * Built for a text-only model working fast. The page is read as a numbered
 * list of what can be acted on plus what it says - no screenshots needed - and
 * a whole batch of actions runs in one call, each waiting only until the page
 * goes quiet rather than for a fixed time. After a batch the model is shown
 * what changed, not the whole page again.
 */
import fsp from "node:fs/promises"
import path from "node:path"
import { Cdp, browserSocketURL, type CdpEvent } from "./cdp"
import { closeBrowser, findBrowser, launchBrowser, type LaunchedBrowser } from "./browser"
import { CHOOSE, FOCUS, HAS_TEXT, LOCATE, QUIET_FOR, SNAPSHOT, WATCH } from "./page-scripts"
import { REF_ERRORS, StepError, SteppingDriver, WAIT_CAP_MS, requireRef, sleep, splitCombo, type PageInfo, type Snapshot, type Step } from "./stepping"

export { WAIT_CAP_MS, formatSnapshot, stepEffect, type PageInfo, type Snapshot, type Step } from "./stepping"

/** How many elements one snapshot lists; a page with more says how many it left out. */
export const SNAPSHOT_LIMIT = 250
/** How long the page has to stay unchanged after an action before the next one runs. */
const QUIET_MS = 120
/** The longest one action waits for the page to go quiet. */
const SETTLE_CAP_MS = 2_500
/** How many of the page's errors and warnings are reported at once. */
const LOG_LIMIT = 20

export class AppDriver extends SteppingDriver {
  private page?: { targetId: string; sessionId: string }
  private logs: string[] = []
  private stopListening: () => void

  private constructor(
    private readonly cdp: Cdp,
    readonly label: string,
    private readonly owned?: LaunchedBrowser,
  ) {
    super()
    this.stopListening = cdp.on((event) => this.observe(event))
  }

  /** Opens a URL in a browser of this tool's own. */
  static async open(url: string): Promise<AppDriver> {
    const executable = findBrowser()
    if (!executable) throw new Error("No Chrome or Edge was found on this machine to open the page in.")
    const browser = await launchBrowser(executable)
    try {
      const driver = new AppDriver(await Cdp.connect(await browserSocketURL(browser.port)), url, browser)
      const pages = await driver.pages()
      await driver.use(pages[0]?.id ?? (await driver.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId)
      await driver.goto(url)
      return driver
    } catch (error) {
      await closeBrowser(browser)
      throw error
    }
  }

  /** Connects to a Chromium already listening on a DevTools port - an Electron app started with --remote-debugging-port. */
  static async attach(port: number, match?: string): Promise<AppDriver> {
    const driver = new AppDriver(await Cdp.connect(await browserSocketURL(port)), `127.0.0.1:${port}`)
    const pages = await driver.pages()
    if (!pages.length) {
      driver.cdp.close()
      throw new Error(`The app on port ${port} has no open window yet.`)
    }
    const wanted = match ? pages.find((page) => page.id === match || page.title.includes(match) || page.url.includes(match)) : pages[0]
    if (!wanted) {
      // Asked for a particular window and it is not there (yet): say which there are, rather than acting on another.
      driver.cdp.close()
      throw new Error(`No window of the app on port ${port} matches "${match}". Its windows: ${pages.map((page) => `"${page.title || page.url}"`).join(", ")}`)
    }
    await driver.use(wanted.id)
    return driver
  }

  get alive(): boolean {
    return !this.cdp.closed
  }

  /** The app's windows and tabs, DevTools' own left out. */
  async pages(): Promise<PageInfo[]> {
    const { targetInfos } = await this.cdp.send<{ targetInfos: { targetId: string; type: string; title: string; url: string }[] }>("Target.getTargets")
    return targetInfos
      // The browser's own pages - its settings, sign-in and sync dialogs - are not the app.
      .filter((target) => target.type === "page" && !/^(devtools|edge|chrome|chrome-extension|chrome-untrusted):/.test(target.url))
      .map((target) => ({ id: target.targetId, title: target.title, url: target.url, current: target.targetId === this.page?.targetId }))
  }

  /** Makes a window or tab the one every later action works on. */
  async use(targetId: string): Promise<void> {
    if (this.page?.targetId === targetId) return
    const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
    this.page = { targetId, sessionId }
    this.last = undefined
    await Promise.all([this.send("Runtime.enable"), this.send("Page.enable"), this.send("Log.enable").catch(() => undefined)])
    await this.cdp.send("Target.activateTarget", { targetId }).catch(() => undefined)
    // Focus-dependent UI - menus that close on blur, focus rings - behaves as it would for a person at the window.
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined)
  }

  async screenshot(file: string): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, Buffer.from(data, "base64"))
  }

  /** Runs an expression in the page and answers its value as JSON. */
  async evaluate(expression: string): Promise<string> {
    const result = await this.send<{ result: { value?: unknown; description?: string; type: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    )
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    const value = result.result.value
    return value === undefined ? (result.result.description ?? result.result.type) : JSON.stringify(value, null, 2)
  }

  async close(): Promise<void> {
    this.stopListening()
    if (this.owned) {
      await this.cdp.send("Browser.close").catch(() => undefined)
      this.cdp.close()
      await closeBrowser(this.owned)
    } else {
      // Someone else's app: only the connection is closed, never the app.
      if (this.page) await this.cdp.send("Target.detachFromTarget", { sessionId: this.page.sessionId }).catch(() => undefined)
      this.cdp.close()
    }
  }

  // ------------------------------------------------------------------ steps

  protected async step(step: Step): Promise<string> {
    switch (step.action) {
      case "click":
      case "double_click": {
        const at = await this.locate(step.ref)
        /*
         * A native select opens a list the browser draws itself, outside the
         * page: nothing in it can be read, and it swallows the keys that
         * follow. A model that clicked one and then pressed arrows has
         * changed the value without seeing it.
         */
        if (at.tag === "SELECT") throw new StepError(`[${step.ref}] is a native select; choose with select {ref, value} instead. Its options: ${(at.options ?? []).join(", ")}`)
        const count = step.action === "double_click" ? 2 : 1
        await this.mouse("mouseMoved", at.x, at.y, 0)
        for (let click = 1; click <= count; click++) {
          await this.mouse("mousePressed", at.x, at.y, click)
          await this.mouse("mouseReleased", at.x, at.y, click)
        }
        await this.settle()
        return at.covered ? `the point was covered by "${at.covered}", which got the click` : at.disabled ? "it is disabled" : ""
      }
      case "hover": {
        const at = await this.locate(step.ref)
        await this.mouse("mouseMoved", at.x, at.y, 0)
        await this.settle()
        return ""
      }
      case "type": {
        const ref = requireRef(step)
        const focused = await this.call<{ error?: string; focused?: boolean }>(FOCUS, ref, step.clear !== false)
        if (focused.error) throw new StepError(`[${ref}] ${REF_ERRORS[focused.error] ?? focused.error}`)
        await this.send("Input.insertText", { text: String(step.text ?? "") })
        if (step.submit) await this.key("Enter")
        await this.settle()
        return focused.focused ? "" : "the element did not take focus, so the text may have gone elsewhere"
      }
      case "press":
        if (!step.key) throw new StepError("press needs a key, such as Enter or Control+a")
        await this.key(step.key)
        await this.settle()
        return ""
      case "select": {
        const ref = requireRef(step)
        const chosen = await this.call<{ error?: string; chosen?: string; options?: string[] }>(CHOOSE, ref, String(step.value ?? step.text ?? ""))
        if (chosen.error === "no-option") throw new StepError(`no option matches; the options are: ${(chosen.options ?? []).join(", ")}`)
        if (chosen.error) throw new StepError(`[${ref}] ${REF_ERRORS[chosen.error] ?? chosen.error}`)
        await this.settle()
        return `chose "${chosen.chosen}"`
      }
      case "scroll": {
        if (step.ref !== undefined) await this.locate(step.ref)
        else await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 200, deltaX: 0, deltaY: step.dy ?? 600 })
        await this.settle()
        return ""
      }
      case "wait": {
        if (step.text) {
          const cap = Math.min(step.ms ?? 5_000, WAIT_CAP_MS)
          const until = Date.now() + cap
          while (Date.now() < until) {
            if (await this.call<boolean>(HAS_TEXT, step.text).catch(() => false)) return "it appeared"
            await sleep(100)
          }
          throw new StepError(`"${step.text}" did not appear within ${cap / 1000}s`)
        }
        await sleep(Math.min(step.ms ?? 500, WAIT_CAP_MS))
        return ""
      }
      case "goto":
        if (!step.url) throw new StepError("goto needs a url")
        await this.goto(step.url)
        return ""
      case "back":
        await this.send("Runtime.evaluate", { expression: "history.back()" })
        await this.loaded()
        return ""
      case "reload":
        await this.send("Page.reload")
        await this.loaded()
        return ""
      default:
        throw new StepError(`unknown action "${String((step as { action?: unknown }).action)}"`)
    }
  }

  private async goto(url: string): Promise<void> {
    const result = await this.send<{ errorText?: string }>("Page.navigate", { url })
    if (result.errorText) throw new StepError(`could not open ${url}: ${result.errorText}`)
    await this.loaded()
  }

  /** Waits for a navigation to finish and the new page to go quiet. */
  private async loaded(): Promise<void> {
    await sleep(50)
    const until = Date.now() + 15_000
    while (Date.now() < until) {
      const state = await this.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }).catch(() => undefined)
      if (state?.result.value === "complete") break
      await sleep(100)
    }
    await this.settle()
  }

  /**
   * Waits for the page to stop changing: loaded, and no DOM change for
   * QUIET_MS, or SETTLE_CAP_MS gone by. Polled from here because the page's own
   * timers crawl while its window is in the background. A page that navigated
   * away has lost the recorder; the new one gets it on the next poll.
   */
  private async settle(): Promise<void> {
    const until = Date.now() + SETTLE_CAP_MS
    while (Date.now() < until) {
      const state = await this.call<{ quiet: number; loaded: boolean; watched: boolean }>(QUIET_FOR).catch(() => undefined)
      if (state && !state.watched) await this.call(WATCH).catch(() => undefined)
      else if (state?.loaded && state.quiet >= QUIET_MS) return
      await sleep(30)
    }
  }

  /** Starts the change recorder before an action, so the quiet spell is measured from the action itself. */
  protected async prepare(): Promise<void> {
    await this.call(WATCH).catch(() => undefined)
  }

  private async locate(ref: number | undefined): Promise<{ x: number; y: number; covered: string; disabled: boolean; tag: string; options?: string[] }> {
    const id = requireRef({ ref } as Step)
    const at = await this.call<{ error?: string; x: number; y: number; covered: string; disabled: boolean; tag: string; options?: string[] }>(LOCATE, id)
    if (at.error) throw new StepError(`[${id}] ${REF_ERRORS[at.error] ?? at.error}`)
    return at
  }

  private mouse(type: string, x: number, y: number, clickCount: number): Promise<unknown> {
    return this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount })
  }

  private async key(combo: string): Promise<void> {
    const split = splitCombo(combo)
    const name = split.name
    let modifiers = 0
    for (const part of split.modifiers) modifiers |= MODIFIERS[part.toLowerCase()] ?? 0
    const key = keyOf(name)
    // Text is only typed when no command modifier is held, as a real keyboard does: Control+a selects, it does not type "a".
    const text = modifiers & ~8 ? undefined : key.text
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, ...(text ? { text, unmodifiedText: text } : {}) })
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode })
  }

  // ------------------------------------------------------------------ plumbing

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.page) return Promise.reject(new Error("No page is open."))
    return this.cdp.send<T>(method, params, this.page.sessionId)
  }

  /** Calls one of the page scripts with JSON arguments and answers its value. */
  private async call<T>(script: string, ...args: unknown[]): Promise<T> {
    const expression = `(${script})(${args.map((arg) => JSON.stringify(arg)).join(", ")})`
    const result = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value as T
  }

  protected async read(): Promise<Snapshot> {
    return this.call<Snapshot>(SNAPSHOT, SNAPSHOT_LIMIT)
  }

  /** The page's own complaints - console errors and warnings, uncaught exceptions, failed loads - kept for the next answer. */
  private observe(event: CdpEvent): void {
    if (!this.page || event.sessionId !== this.page.sessionId) return
    let line: string | undefined
    if (event.method === "Runtime.consoleAPICalled") {
      const type = String(event.params.type)
      if (type !== "error" && type !== "warning" && type !== "assert") return
      const args = ((event.params.args as { value?: unknown; description?: string }[] | undefined) ?? []).map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? "")))
      // console's %c styling: the markers go, and so do the CSS strings they consumed.
      const styled = args[0]?.includes("%c") ? (args[0].match(/%c/g) ?? []).length : 0
      const words = styled ? [args[0]!.replaceAll("%c", ""), ...args.slice(1 + styled)] : args
      line = `console.${type === "warning" ? "warn" : type}: ${words.join(" ")}`
    } else if (event.method === "Runtime.exceptionThrown") {
      const details = event.params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
      line = `uncaught: ${details?.exception?.description ?? details?.text ?? "exception"}`
    } else if (event.method === "Log.entryAdded") {
      const entry = event.params.entry as { level?: string; text?: string; url?: string } | undefined
      if (entry?.level !== "error") return
      line = `${entry.text ?? "error"}${entry.url ? ` (${entry.url})` : ""}`
    }
    if (!line) return
    line = line.replace(/\s+/g, " ").trim().slice(0, 300)
    if (this.logs.length < LOG_LIMIT * 2) this.logs.push(line)
  }

  protected logCount(): number {
    return this.logs.length
  }

  protected drainLogs(): string {
    if (!this.logs.length) return ""
    const shown = this.logs.slice(0, LOG_LIMIT)
    const more = this.logs.length - shown.length
    this.logs = []
    return `\n\nThe page reported:\n${shown.map((line) => `- ${line}`).join("\n")}${more > 0 ? `\n- (${more} more)` : ""}`
  }
}

const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
}

function keyOf(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const named = NAMED_KEYS[name.toLowerCase()]
  if (named) return named
  if (name.length === 1) {
    const upper = name.toUpperCase()
    const letter = /[A-Z]/.test(upper)
    const digit = /[0-9]/.test(name)
    return { key: name, code: letter ? `Key${upper}` : digit ? `Digit${name}` : "", keyCode: letter || digit ? upper.charCodeAt(0) : 0, text: name }
  }
  throw new StepError(`unknown key "${name}"`)
}

