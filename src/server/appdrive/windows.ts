/**
 * Drives a native Windows app's window for the app tool - WinForms, WPF,
 * Win32, Qt with its accessibility on - through UI Automation, hosted by
 * windows-host.ts in a Windows PowerShell of its own.
 *
 * Everything the model sees is the same as for a web page: a numbered list of
 * what can be acted on plus the window's text, batches of steps with each
 * step's own effect, and only the changes after a first look.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { spawn, type ChildProcess } from "node:child_process"
import { REF_ERRORS, StepError, SteppingDriver, WAIT_CAP_MS, requireRef, sleep, splitCombo, type PageInfo, type Snapshot, type Step } from "./stepping"
import { WINDOWS_HOST } from "./windows-host"

/** How many elements one listing holds. */
const SNAPSHOT_LIMIT = 250
/** How long the window has to stay the same after a step before the next one runs, and the longest that is waited. */
const QUIET_MS = 150
const SETTLE_CAP_MS = 2_500
/** How recently a program must have started for its window to be named when a window is not found. */
const RECENT_SECONDS = 900
/** How long a launched program has to put up a window. */
const LAUNCH_WAIT_MS = 20_000

/** The host's errors, in the words the model reads. */
const HOST_ERRORS: Record<string, string> = {
  ...REF_ERRORS,
  combobox: "is a combo box; choose with select {ref, value} instead of clicking it",
  "not-attached": "no window is attached",
  "window-closed": "the window was closed",
  "no-window": "no window matches",
}

/** A running host: requests out, answers in, matched by id. */
class Host {
  private next = 1
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private ended = false

  private constructor(private readonly child: ChildProcess) {
    readline.createInterface({ input: child.stdout! }).on("line", (line) => this.receive(line))
    child.once("exit", () => this.end())
  }

  static async start(timeoutMs = 20_000): Promise<Host> {
    // Written once per version of the script, under a name that says which.
    const hash = crypto.createHash("sha256").update(WINDOWS_HOST).digest("hex").slice(0, 12)
    const file = path.join(os.tmpdir(), `mcode-uia-${hash}.ps1`)
    if (!fs.existsSync(file)) fs.writeFileSync(file, `﻿${WINDOWS_HOST}`)
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    let failure = ""
    child.stderr!.on("data", (chunk) => (failure += String(chunk)))
    const host = new Host(child)
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      host.onReady = () => {
        clearTimeout(timer)
        resolve(true)
      }
      child.once("exit", () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    if (!ready) {
      host.stop()
      throw new Error(`UI Automation could not be started: ${failure.trim().split(/\r?\n/).slice(0, 3).join(" ") || "no answer from PowerShell"}`)
    }
    return host
  }

  private onReady?: () => void

  get alive(): boolean {
    return !this.ended
  }

  call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.ended) return Promise.reject(new Error("the UI Automation host has stopped"))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`${op}: no answer within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child.stdin!.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  stop(): void {
    this.child.stdin?.end()
    if (this.child.exitCode === null) this.child.kill()
    this.end()
  }

  private receive(line: string): void {
    let message: { ready?: boolean; id?: number; result?: unknown; error?: string }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.ready) return this.onReady?.()
    const waiting = typeof message.id === "number" ? this.waiting.get(message.id) : undefined
    if (!waiting) return
    this.waiting.delete(message.id!)
    if (message.error !== undefined) waiting.reject(new Error(message.error))
    else waiting.resolve(message.result)
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiting of this.waiting.values()) waiting.reject(new Error("the UI Automation host has stopped"))
    this.waiting.clear()
  }
}

export class WindowsDriver extends SteppingDriver {
  private constructor(
    private readonly host: Host,
    readonly label: string,
    private readonly launched?: ChildProcess,
  ) {
    super()
  }

  /** Attaches to a window that is already open, by part of its title, its program's name, or its window handle. */
  static async attach(match: string): Promise<WindowsDriver> {
    const host = await Host.start()
    try {
      const found = await host.call<{ title: string }>("attach", { match })
      return new WindowsDriver(host, found.title)
    } catch (error) {
      // Only programs started in the last few minutes are named: the app being built is one of them, and the rest of the desktop is not the model's to read.
      const windows = await host.call<{ title: string; process: string }[]>("windows", { recent: RECENT_SECONDS }).catch(() => [])
      host.stop()
      const recent = windows.map((window) => `"${window.title}" (${window.process})`).join(", ")
      throw new Error(
        `${messageOf(error) === "no-window" ? `No open window matches "${match}".` : messageOf(error)} ${recent ? `Windows of programs started in the last ${RECENT_SECONDS / 60} minutes: ${recent}.` : `No program started in the last ${RECENT_SECONDS / 60} minutes has a window open.`} To start one, use launch.`,
      )
    }
  }

  /** Starts a program and attaches to the first window it shows; `match` picks one by title when it shows several. */
  static async launch(executable: string, args: string[], cwd: string, match?: string): Promise<WindowsDriver> {
    // The host first, to note which window the user has in front: a program's first window takes the front, and is given it back once it is up.
    const host = await Host.start()
    const front = await host.call<number>("front").catch(() => 0)
    const child = spawn(executable, args, { cwd, stdio: "ignore", detached: false, windowsHide: false })
    const started = await new Promise<Error | undefined>((resolve) => {
      child.once("error", resolve)
      child.once("spawn", () => resolve(undefined))
    })
    if (started) {
      host.stop()
      throw new Error(`${executable} could not be started: ${started.message}`)
    }
    const until = Date.now() + LAUNCH_WAIT_MS
    while (Date.now() < until) {
      if (child.exitCode !== null && !match) break
      const found = await host.call<{ title: string }>("attach", { match: match ?? "", pid: match ? 0 : child.pid }).catch(() => undefined)
      if (found) {
        await sleep(300)
        await host.call("restore-front", { handle: front }).catch(() => undefined)
        return new WindowsDriver(host, found.title, child)
      }
      await sleep(250)
    }
    host.stop()
    if (child.exitCode === null) child.kill()
    throw new Error(child.exitCode !== null && !match ? `${path.basename(executable)} exited (code ${child.exitCode}) without showing a window; if it hands off to another process, launch it with target set to its window's title.` : `No window${match ? ` matching "${match}"` : ""} appeared within ${LAUNCH_WAIT_MS / 1000}s.`)
  }

  get alive(): boolean {
    return this.host.alive
  }

  /** The attached program's own windows - a second window, a tool window - so the model can move between them. */
  async pages(): Promise<PageInfo[]> {
    const windows = await this.host.call<{ id: string; title: string; process: string; current: boolean }[]>("windows", { own: true })
    return windows.map((window) => ({ id: window.id, title: window.title, url: `window://${window.process}`, current: window.current }))
  }

  async use(id: string): Promise<void> {
    await this.host.call("attach", { match: id })
    this.last = undefined
  }

  async screenshot(file: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    await this.host.call("screenshot", { file })
  }

  async evaluate(): Promise<string> {
    throw new Error("eval works in web pages and Electron apps; a native window has no page to run it in.")
  }

  async close(): Promise<void> {
    this.host.stop()
    // A program this tool started is ended with it; one it only attached to is left running.
    if (this.launched && this.launched.exitCode === null) {
      spawn("taskkill", ["/PID", String(this.launched.pid), "/T"], { stdio: "ignore", windowsHide: true })
      await sleep(1_500)
      if (this.launched.exitCode === null) this.launched.kill()
    }
  }

  protected async read(): Promise<Snapshot> {
    return this.host.call<Snapshot>("snapshot", { limit: SNAPSHOT_LIMIT }).catch((error) => {
      throw new StepError(HOST_ERRORS[messageOf(error)] ?? messageOf(error))
    })
  }

  protected async step(step: Step): Promise<string> {
    switch (step.action) {
      case "click":
      case "double_click":
      case "hover":
        return this.act(step.action, { ref: requireRef(step) })
      case "type": {
        const ref = requireRef(step)
        const note = await this.act("type", { ref, text: String(step.text ?? "") })
        if (step.submit) await this.act("press", { ref, ...nativeKey("Enter") })
        return note
      }
      case "select":
        return this.act("select", { ref: requireRef(step), value: String(step.value ?? step.text ?? "") })
      case "press":
        if (!step.key) throw new StepError("press needs a key, such as Enter or Control+a")
        return this.act("press", nativeKey(step.key))
      case "scroll":
        return this.act("scroll", step.ref !== undefined ? { ref: requireRef(step) } : { dy: step.dy ?? 600 })
      case "wait": {
        if (step.text) {
          const cap = Math.min(step.ms ?? 5_000, WAIT_CAP_MS)
          const until = Date.now() + cap
          while (Date.now() < until) {
            const now = await this.read().catch(() => undefined)
            if (now && [...now.text, ...now.elements].some((line) => line.includes(step.text!))) return "it appeared"
            await sleep(150)
          }
          throw new StepError(`"${step.text}" did not appear within ${cap / 1000}s`)
        }
        await sleep(Math.min(step.ms ?? 500, WAIT_CAP_MS))
        return ""
      }
      default:
        throw new StepError(`${step.action} is for web pages; a native window has no address`)
    }
  }

  /** One action through the host, then the wait for the window to settle. */
  private async act(action: string, args: Record<string, unknown>): Promise<string> {
    let note: string
    try {
      note = await this.host.call<string>("act", { action, ...args })
    } catch (error) {
      const message = messageOf(error)
      if (message.startsWith("no-option:")) throw new StepError(`no option matches; the options are: ${message.slice("no-option:".length).split("|").join(", ")}`)
      const known = HOST_ERRORS[message]
      throw new StepError(known ? (args.ref !== undefined ? `[${args.ref}] ${known}` : known) : message)
    }
    await this.host.call("settle", { quiet: QUIET_MS, cap: SETTLE_CAP_MS }, SETTLE_CAP_MS + 10_000).catch(() => undefined)
    return note
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Named keys as Windows virtual-key codes, with the character each types when it types one. */
const NATIVE_KEYS: Record<string, { vk: number; text?: string }> = {
  enter: { vk: 13, text: "\r" },
  tab: { vk: 9, text: "\t" },
  escape: { vk: 27, text: "\u001b" },
  esc: { vk: 27, text: "\u001b" },
  backspace: { vk: 8, text: "\b" },
  delete: { vk: 46 },
  space: { vk: 32, text: " " },
  arrowup: { vk: 38 },
  arrowdown: { vk: 40 },
  arrowleft: { vk: 37 },
  arrowright: { vk: 39 },
  home: { vk: 36 },
  end: { vk: 35 },
  pageup: { vk: 33 },
  pagedown: { vk: 34 },
  insert: { vk: 45 },
}

const NATIVE_MODIFIERS: Record<string, string> = { control: "ctrl", ctrl: "ctrl", alt: "alt", shift: "shift" }

/**
 * A key the way the app tool names it - Enter, Control+a, Alt+F4 - as what is
 * posted to the window: its virtual-key code, the character it types, and the
 * modifiers held. Posted, not typed on the real keyboard, so the user keeps it.
 */
export function nativeKey(combo: string): { vk: number; text: string; mods: string } {
  const { modifiers, name } = splitCombo(combo)
  const mods: string[] = []
  for (const part of modifiers) {
    const modifier = NATIVE_MODIFIERS[part.toLowerCase()]
    if (!modifier) throw new StepError(`the ${part} key cannot be pressed in a native window; use Control, Alt or Shift`)
    mods.push(modifier)
  }
  const named = NATIVE_KEYS[name.toLowerCase()]
  if (named) return { vk: named.vk, text: named.text ?? "", mods: mods.join(",") }
  const f = /^f([1-9]|1[0-2])$/i.exec(name)
  if (f) return { vk: 111 + Number(f[1]), text: "", mods: mods.join(",") }
  if (name.length === 1) {
    const upper = name.toUpperCase()
    // Letters and digits have their own codes; anything else is looked up in the keyboard layout by the host.
    const vk = /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0
    return { vk, text: name, mods: mods.join(",") }
  }
  throw new StepError(`unknown key "${name}"`)
}
