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

/** How many elements one snapshot lists; a page with more says how many it left out. */
export const SNAPSHOT_LIMIT = 250
/** How long the page has to stay unchanged after an action before the next one runs. */
const QUIET_MS = 120
/** The longest one action waits for the page to go quiet. */
const SETTLE_CAP_MS = 2_500
/** The longest a `wait` step may ask for. */
export const WAIT_CAP_MS = 15_000
/** How many of the page's errors and warnings are reported at once. */
const LOG_LIMIT = 20

export interface Snapshot {
  title: string
  url: string
  modal: string
  elements: string[]
  more: number
  text: string[]
}

export interface Step {
  action: "click" | "double_click" | "type" | "press" | "select" | "hover" | "scroll" | "wait" | "goto" | "back" | "reload"
  ref?: number
  text?: string
  key?: string
  value?: string
  url?: string
  ms?: number
  submit?: boolean
  clear?: boolean
  dy?: number
}

export interface PageInfo {
  id: string
  title: string
  url: string
  current: boolean
}

/** Where an element's reference went: every failure the model can act on, in its words. */
const REF_ERRORS: Record<string, string> = {
  unknown: "is not in the last snapshot; take a new one",
  gone: "is no longer on the page; take a new snapshot",
  hidden: "is on the page but not visible",
  "not-select": "is not a native select; click it and then click the option instead",
}

class StepError extends Error {}

export class AppDriver {
  private page?: { targetId: string; sessionId: string }
  private last?: Snapshot
  private logs: string[] = []
  private stopListening: () => void

  private constructor(
    private readonly cdp: Cdp,
    readonly label: string,
    private readonly owned?: LaunchedBrowser,
  ) {
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

  /**
   * What the page offers and says. After the first time, only what changed
   * since the last look is shown unless `full` is asked for - or the page is a
   * different one, or so much changed that a diff would be longer than the page.
   */
  async snapshot(full = false): Promise<string> {
    const now = await this.read()
    const before = this.last
    this.last = now
    return formatSnapshot(now, full ? undefined : before) + this.drainLogs()
  }

  /** Runs the steps in order, stopping at the first that fails, then shows what changed. */
  async run(steps: Step[], signal?: AbortSignal): Promise<{ output: string; done: number }> {
    if (!this.last) this.last = await this.read()
    const report: string[] = []
    let done = 0
    let failure = ""
    // What the page looked like before each step, so every step can say what it did by itself.
    let previous: Snapshot | undefined = this.last
    for (const [index, step] of steps.entries()) {
      if (signal?.aborted) {
        failure = "Stopped."
        break
      }
      try {
        await this.watch()
        const logged = this.logs.length
        const note = await this.step(step)
        const after = await this.read().catch(() => undefined)
        // A wait changes nothing by itself; what it waited for is its note.
        const effect = previous && after && step.action !== "wait" ? stepEffect(previous, after) : ""
        const complained = this.logs.length > logged ? "the page reported an error (below)" : ""
        previous = after
        const said = [note, effect, complained].filter(Boolean).join("; ")
        report.push(`${index + 1}. ${describeStep(step)}${said ? ` -> ${said}` : ""}`)
        done += 1
      } catch (error) {
        failure = `${index + 1}. ${describeStep(step)} failed: ${error instanceof Error ? error.message : String(error)}`
        break
      }
    }
    const now = await this.read().catch(() => undefined)
    const before = this.last
    if (now) this.last = now
    const lines = [...report]
    if (failure) lines.push(failure, steps.length - done - 1 > 0 ? `The remaining ${steps.length - done - 1} step(s) were not run.` : "")
    return { output: [lines.filter(Boolean).join("\n"), now ? formatSnapshot(now, before) : "The page could not be read after these steps.", this.drainLogs().trim()].filter(Boolean).join("\n\n"), done }
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

  private async step(step: Step): Promise<string> {
    switch (step.action) {
      case "click":
      case "double_click": {
        const at = await this.locate(step.ref)
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
  private async watch(): Promise<void> {
    await this.call(WATCH).catch(() => undefined)
  }

  private async locate(ref: number | undefined): Promise<{ x: number; y: number; covered: string; disabled: boolean }> {
    const id = requireRef({ ref } as Step)
    const at = await this.call<{ error?: string; x: number; y: number; covered: string; disabled: boolean }>(LOCATE, id)
    if (at.error) throw new StepError(`[${id}] ${REF_ERRORS[at.error] ?? at.error}`)
    return at
  }

  private mouse(type: string, x: number, y: number, clickCount: number): Promise<unknown> {
    return this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount })
  }

  private async key(combo: string): Promise<void> {
    const parts = combo.split("+").map((part) => part.trim()).filter(Boolean)
    const name = parts.pop() ?? ""
    let modifiers = 0
    for (const part of parts) modifiers |= MODIFIERS[part.toLowerCase()] ?? 0
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

  private async read(): Promise<Snapshot> {
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

  private drainLogs(): string {
    if (!this.logs.length) return ""
    const shown = this.logs.slice(0, LOG_LIMIT)
    const more = this.logs.length - shown.length
    this.logs = []
    return `\n\nThe page reported:\n${shown.map((line) => `- ${line}`).join("\n")}${more > 0 ? `\n- (${more} more)` : ""}`
  }
}

// -------------------------------------------------------------------- format

/** A snapshot as the model reads it: the whole of it, or what changed since `before`. */
export function formatSnapshot(now: Snapshot, before?: Snapshot): string {
  const head = [`${now.title || "(untitled)"} - ${now.url}`, now.modal ? `A modal dialog is open ("${now.modal}"); only what is inside it is listed.` : ""].filter(Boolean)
  const whole = () =>
    [
      ...head,
      "",
      now.elements.length ? now.elements.join("\n") : "(nothing to act on)",
      now.more ? `(${now.more} more elements not listed; scroll or act on what is here first)` : "",
      "",
      "Text on the page:",
      now.text.join("\n") || "(none)",
    ]
      .filter((line, index, all) => line !== "" || all[index - 1] !== "")
      .join("\n")
  if (!before || before.url !== now.url || before.modal !== now.modal) return whole()
  const elements = diff(before.elements, now.elements)
  const text = diff(before.text, now.text)
  const changes = elements.added.length + elements.removed.length + text.added.length + text.removed.length
  if (changes === 0) return [...head, "Nothing on the page changed."].join("\n")
  if (changes > (now.elements.length + now.text.length) * 0.6) return whole()
  const block = (title: string, lines: string[]) => (lines.length ? [`${title}:`, ...lines] : [])
  const refOf = (line: string) => line.match(/^\[(\d+)\]/)?.[1]
  const removedRefs = new Set(elements.removed.map(refOf))
  const addedRefs = new Set(elements.added.map(refOf))
  return [
    ...head,
    "What changed (earlier references still hold):",
    ...block("Changed", elements.added.filter((line) => removedRefs.has(refOf(line)))),
    ...block("Now shown", elements.added.filter((line) => !removedRefs.has(refOf(line)))),
    ...block("Gone", elements.removed.filter((line) => !addedRefs.has(refOf(line)))),
    ...block("New text", text.added),
    ...block("Text gone", text.removed),
  ].join("\n")
}

/** How much of one step's effect is spelled out; the full account comes once, after the batch. */
const EFFECT_LINES = 3
const EFFECT_LINE_MAX = 80

/**
 * What one step changed, in a line: where the page went, a dialog coming or
 * going, the text it put on the page, and how many elements changed. "no
 * visible change" is said out loud, because a button that does nothing is
 * exactly what a test is looking for.
 */
export function stepEffect(before: Snapshot, after: Snapshot): string {
  const parts: string[] = []
  if (before.url !== after.url) parts.push(`now at ${after.url}`)
  if (!before.modal && after.modal) parts.push(`a dialog opened ("${after.modal.slice(0, EFFECT_LINE_MAX)}")`)
  if (before.modal && !after.modal) parts.push("the dialog closed")
  // A dialog coming or going changes what is listed wholesale; the listing after the batch shows the result.
  if (before.modal !== after.modal) return parts.join("; ")
  const text = diff(before.text, after.text)
  if (text.added.length) {
    const shown = text.added.slice(0, EFFECT_LINES).map((line) => (line.length > EFFECT_LINE_MAX ? `${line.slice(0, EFFECT_LINE_MAX - 1)}…` : line))
    parts.push(`shows: ${shown.join(" | ")}${text.added.length > EFFECT_LINES ? ` (+${text.added.length - EFFECT_LINES} more lines)` : ""}`)
  } else if (text.removed.length) parts.push(`${text.removed.length} line(s) of text gone`)
  const elements = diff(before.elements, after.elements)
  const refOf = (line: string) => line.match(/^\[(\d+)\]/)?.[1]
  const removedRefs = new Set(elements.removed.map(refOf))
  const changed = elements.added.filter((line) => removedRefs.has(refOf(line))).length
  const shownNew = elements.added.length - changed
  const gone = elements.removed.length - changed
  const counts = [shownNew ? `${shownNew} element(s) appeared` : "", gone ? `${gone} gone` : "", changed ? `${changed} changed state` : ""].filter(Boolean)
  if (counts.length) parts.push(counts.join(", "))
  return parts.length ? parts.join("; ") : "no visible change"
}

function diff(before: string[], now: string[]): { added: string[]; removed: string[] } {
  const had = new Set(before)
  const has = new Set(now)
  return { added: now.filter((line) => !had.has(line)), removed: before.filter((line) => !has.has(line)) }
}

export function describeStep(step: Step): string {
  switch (step.action) {
    case "click":
    case "double_click":
    case "hover":
      return `${step.action} [${step.ref}]`
    case "type":
      return `type ${JSON.stringify(String(step.text ?? "").slice(0, 40))} into [${step.ref}]${step.submit ? " and press Enter" : ""}`
    case "press":
      return `press ${step.key}`
    case "select":
      return `select ${JSON.stringify(step.value ?? step.text)} in [${step.ref}]`
    case "scroll":
      return step.ref !== undefined ? `scroll to [${step.ref}]` : `scroll by ${step.dy ?? 600}`
    case "wait":
      return step.text ? `wait for ${JSON.stringify(step.text)}` : `wait ${step.ms ?? 500}ms`
    case "goto":
      return `go to ${step.url}`
    default:
      return step.action
  }
}

function requireRef(step: Step): number {
  const ref = Number(step.ref)
  if (!Number.isInteger(ref) || ref <= 0) throw new StepError(`${step.action} needs the number of an element from the snapshot`)
  return ref
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
