/**
 * What every app the app tool drives has in common, whatever reads it - a web
 * page over DevTools, a native Windows window over UI Automation: a window
 * read as a numbered list of what can be acted on plus what it says, a batch
 * of steps run in one call with each step's own effect reported, and after a
 * first look only what changed.
 */

/** The longest a `wait` step may ask for. */
export const WAIT_CAP_MS = 15_000

export interface Snapshot {
  title: string
  url: string
  /** Which load of the page this is, where the reader can tell: a reload at the same address is a new document with new numbers. */
  doc?: string
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
export const REF_ERRORS: Record<string, string> = {
  unknown: "is not in the last snapshot; take a new one",
  gone: "is no longer on the page; take a new snapshot",
  hidden: "is on the page but not visible",
  "not-select": "is not a native select; click it and then click the option instead",
}

/** A step that cannot be done, said the way the model should read it. */
export class StepError extends Error {}

export abstract class SteppingDriver {
  /** What the window looked like at the last look, which later answers are measured against. */
  protected last?: Snapshot

  abstract readonly label: string
  abstract get alive(): boolean
  abstract pages(): Promise<PageInfo[]>
  abstract use(id: string): Promise<void>
  abstract screenshot(file: string): Promise<void>
  abstract evaluate(expression: string): Promise<string>
  abstract close(): Promise<void>

  /** The window as it is now. */
  protected abstract read(): Promise<Snapshot>
  /** Does one step, and waits for the window to settle after it; answers a note on how it went, or nothing. */
  protected abstract step(step: Step): Promise<string>
  /** Called before each step. */
  protected async prepare(): Promise<void> {}
  /** How many complaints the app has made so far - errors it logged - and the report of them, emptied as it is taken. */
  protected logCount(): number {
    return 0
  }
  protected drainLogs(): string {
    return ""
  }

  /**
   * What the window offers and says. After the first time, only what changed
   * since the last look is shown unless `full` is asked for - or the window is
   * a different one, or so much changed that a diff would be longer than it.
   */
  async snapshot(full = false): Promise<string> {
    const now = await this.read()
    const before = this.last
    this.last = now
    return formatSnapshot(now, full ? undefined : before) + this.drainLogs()
  }

  /** Runs the steps in order, stopping at the first that fails; every step says what it did, then everything that changed. */
  async run(steps: Step[], signal?: AbortSignal): Promise<{ output: string; done: number }> {
    if (!this.last) this.last = await this.read()
    const report: string[] = []
    let done = 0
    let failure = ""
    // What the window looked like before each step, so every step can say what it did by itself.
    let previous: Snapshot | undefined = this.last
    for (const [index, step] of steps.entries()) {
      if (signal?.aborted) {
        failure = "Stopped."
        break
      }
      try {
        await this.prepare()
        const logged = this.logCount()
        const note = await this.step(step)
        const after = await this.read().catch(() => undefined)
        // A wait changes nothing by itself; what it waited for is its note.
        const effect = previous && after && step.action !== "wait" ? stepEffect(previous, after) : ""
        const complained = this.logCount() > logged ? "the page reported an error (below)" : ""
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
    return { output: [lines.filter(Boolean).join("\n"), now ? formatSnapshot(now, before) : "The window could not be read after these steps.", this.drainLogs().trim()].filter(Boolean).join("\n\n"), done }
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
  if (before && before.doc !== now.doc && before.url === now.url) return `The page was loaded again; its elements have new numbers.\n${whole()}`
  if (!before || before.url !== now.url || before.modal !== now.modal || before.doc !== now.doc) return whole()
  const elements = diff(before.elements, now.elements)
  const text = diff(before.text, now.text)
  const changes = elements.added.length + elements.removed.length + text.added.length + text.removed.length
  if (changes === 0) return [...head, "Nothing on the page changed."].join("\n")
  if (changes > (now.elements.length + now.text.length) * 0.6) return whole()
  const block = (title: string, lines: string[]) => (lines.length ? [`${title}:`, ...lines] : [])
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
  else if (before.doc !== after.doc) parts.push("the page reloaded")
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
  const removedRefs = new Set(elements.removed.map(refOf))
  const changed = elements.added.filter((line) => removedRefs.has(refOf(line))).length
  const shownNew = elements.added.length - changed
  const gone = elements.removed.length - changed
  const counts = [shownNew ? `${shownNew} element(s) appeared` : "", gone ? `${gone} gone` : "", changed ? `${changed} changed state` : ""].filter(Boolean)
  if (counts.length) parts.push(counts.join(", "))
  return parts.length ? parts.join("; ") : "no visible change"
}

function refOf(line: string): string | undefined {
  return line.match(/^\[(\d+)\]/)?.[1]
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

export function requireRef(step: Step): number {
  const ref = Number(step.ref)
  if (!Number.isInteger(ref) || ref <= 0) throw new StepError(`${step.action} needs the number of an element from the snapshot`)
  return ref
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A key combination the way the app tool writes one - Enter, Control+a, Control++ - split into its modifiers and its key. */
export function splitCombo(combo: string): { modifiers: string[]; name: string } {
  const trimmed = combo.trim()
  // The plus key itself: "+" alone, or last after a modifier ("Control++").
  if (trimmed === "+" || trimmed.endsWith("++")) return { modifiers: trimmed.slice(0, -1).split("+").map((part) => part.trim()).filter(Boolean), name: "+" }
  const parts = trimmed.split("+").map((part) => part.trim()).filter(Boolean)
  return { modifiers: parts.slice(0, -1), name: parts.at(-1) ?? "" }
}
