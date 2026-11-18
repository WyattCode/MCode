import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SteppingDriver, StepError, WAIT_CAP_MS, requireRef, sleep, type Step, type Snapshot } from "./stepping"

export const SCREEN_SETTINGS = "System Settings → Privacy & Security → Screen & System Audio Recording"
export const INPUT_SETTINGS = "System Settings → Privacy & Security → Accessibility and Automation"

type Point = { x: number; y: number }
export type MacInput =
  | { action: "click"; point: Point; count: number }
  | { action: "type"; text: string; clear: boolean; submit: boolean }
  | { action: "press"; key: string }

export interface MacWindow {
  title: string
  elements: { role: string; title: string; point: Point }[]
}

export interface MacOSHost {
  enabled(): boolean
  launch(app: string): Promise<void>
  activate(app: string): Promise<void>
  inspect(app: string): Promise<MacWindow>
  capture(app: string): Promise<{ png: Buffer; width: number; height: number }>
  input(app: string, input: MacInput): Promise<void>
}

let host: MacOSHost | undefined
export function installMacOSHost(value: MacOSHost | undefined): void {
  host = value
}

export function requireMacOSHost(): MacOSHost {
  if (!host?.enabled()) throw new StepError("Enable Computer Control in MCode's settings on the Mac running MCode.")
  return host
}

export class MacOSDriver extends SteppingDriver {
  private closed = false
  private folder?: string
  private readonly ids = new Map<string, number>()
  private points = new Map<number, Point>()
  private next = 1

  private constructor(readonly label: string, private readonly host: MacOSHost) {
    super()
  }

  static async open(app: string): Promise<MacOSDriver> {
    const host = requireMacOSHost()
    await host.launch(app)
    const driver = new MacOSDriver(app, host)
    await driver.waitForIdle()
    return driver
  }

  get alive(): boolean {
    return !this.closed && this.host.enabled()
  }

  private checkEnabled(): void {
    if (!this.alive) throw new StepError("Computer Control is off. Enable it in MCode's settings and open the app again.")
  }

  async activate(): Promise<void> {
    this.checkEnabled()
    await this.host.activate(this.label)
    await this.waitForIdle()
  }

  async pages() {
    const window = await this.readWindow()
    return [{ id: this.label, title: window?.title || this.label, url: this.url, current: true }]
  }

  async use(id: string): Promise<void> {
    this.checkEnabled()
    if (id !== this.label) throw new StepError("Open a different macOS app with the macos action.")
  }

  async evaluate(): Promise<string> {
    throw new StepError("eval needs a web page or an Electron DevTools connection.")
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.folder) await fs.rm(this.folder, { recursive: true, force: true })
  }

  async screenshot(file: string): Promise<void> {
    this.checkEnabled()
    const { png } = await this.host.capture(this.label)
    this.checkEnabled()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, png)
  }

  private get url(): string {
    return `macos://${encodeURIComponent(this.label)}`
  }

  private async readWindow(): Promise<MacWindow | undefined> {
    this.checkEnabled()
    return this.host.inspect(this.label).catch(() => undefined)
  }

  protected async read(): Promise<Snapshot> {
    this.checkEnabled()
    const [window, image] = await Promise.all([
      this.readWindow(),
      this.host.capture(this.label).catch((error: unknown) => error instanceof StepError ? error : undefined),
    ])
    this.checkEnabled()
    const text: string[] = []
    if (image && !(image instanceof StepError)) {
      this.folder ??= await fs.mkdtemp(path.join(os.tmpdir(), "mcode-macctl-"))
      const file = path.join(this.folder, "desktop.png")
      await fs.writeFile(file, image.png)
      text.push(`Desktop screenshot: ${file}`)
      text.push(`Primary display grid in logical points: x=0…${image.width - 1}, y=0…${image.height - 1}, origin at top left. Grid lines are not drawn on the PNG.`)
    } else {
      text.push(image?.message ?? `Screen capture unavailable. Allow MCode in ${SCREEN_SETTINGS}, then reopen MCode if macOS asks.`)
    }
    if (!window?.elements.length) text.push(`No accessible front-window controls are available. Bring ${this.label} to the front and check ${INPUT_SETTINGS}. Use the screenshot grid when available.`)

    const points = new Map<number, Point>()
    const elements = (window?.elements ?? []).map(({ role, title, point }, index) => {
      const key = JSON.stringify([window?.title, role, title, point, index])
      let id = this.ids.get(key)
      if (id === undefined) {
        id = this.next++
        this.ids.set(key, id)
      }
      points.set(id, point)
      return `[${id}] ${role} ${JSON.stringify(title)} at (${point.x}, ${point.y})`
    })
    this.points = points
    return { title: window?.title || this.label, url: this.url, modal: "", elements, more: 0, text }
  }

  protected async step(step: Step): Promise<string> {
    this.checkEnabled()
    switch (step.action) {
      case "click":
      case "double_click":
        await this.click(step)
        break
      case "type":
        if (step.ref !== undefined) {
          await this.click({ action: "click", ref: step.ref })
          await this.waitForIdle()
        }
        this.checkEnabled()
        await this.host.input(this.label, { action: "type", text: String(step.text ?? ""), clear: step.clear === true, submit: step.submit === true })
        break
      case "press":
        if (!step.key) throw new StepError("press needs a key, such as Enter or Command+a")
        await this.host.input(this.label, { action: "press", key: step.key })
        break
      case "wait": {
        const duration = Math.max(0, Math.min(step.ms ?? (step.text ? 5_000 : 500), WAIT_CAP_MS))
        if (!step.text) {
          await sleep(duration)
          return ""
        }
        const until = Date.now() + duration
        while (Date.now() < until) {
          const window = await this.readWindow()
          if (window && [window.title, ...window.elements.map((element) => element.title)].some((line) => line.includes(step.text!))) return "it appeared"
          await sleep(150)
        }
        throw new StepError(`"${step.text}" did not appear in the accessible window within ${duration / 1000}s`)
      }
      default:
        throw new StepError(`${step.action} is unavailable on the macOS desktop.`)
    }
    await this.waitForIdle()
    return ""
  }

  private async click(step: Step): Promise<void> {
    const ref = step.ref === undefined ? undefined : requireRef(step)
    const expected = ref === undefined ? undefined : this.points.get(ref)
    if (ref !== undefined) {
      await this.read()
      if (this.points.get(ref)?.x !== expected?.x || this.points.get(ref)?.y !== expected?.y) {
        throw new StepError("The control moved or disappeared. Take a new snapshot.")
      }
    }
    const point = ref !== undefined ? expected : { x: step.x, y: step.y }
    if (!point || typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new StepError("click needs x and y in logical points or a current reference from snapshot.")
    }
    this.checkEnabled()
    await this.host.input(this.label, { action: "click", point: { x: point.x, y: point.y }, count: step.action === "double_click" ? 2 : 1 })
  }

  /** SteppingDriver reads immediately after this bounded quiet wait. */
  private async waitForIdle(): Promise<void> {
    await sleep(250)
    const until = Date.now() + 1_250
    let previous: string | undefined
    while (Date.now() < until && this.alive) {
      const window = await this.readWindow()
      if (!window) return
      const state = JSON.stringify(window)
      if (state === previous) return
      previous = state
      await sleep(120)
    }
  }
}
