/**
 * Drives an Android app on a phone or an emulator for the app tool, through
 * adb: the screen is read with uiautomator's dump of the view hierarchy and
 * acted on with `input` (taps, swipes, text, key events). Everything happens
 * on the device, so the user's own mouse and keyboard are never involved.
 *
 * What the model sees is the same as for a web page or a native window: a
 * numbered list of what can be acted on plus the screen's text, batches of
 * steps with each step's own effect, and only the changes after a first look.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { AGENT_DEX } from "./android-agent"
import { REF_ERRORS, StepError, SteppingDriver, WAIT_CAP_MS, requireRef, sleep, splitCombo, type PageInfo, type Snapshot, type Step } from "./stepping"

/** How many elements one listing holds. */
const SNAPSHOT_LIMIT = 250
/**
 * How long a screen is given to start reacting before it is read again. The
 * reader then waits for the app's accessibility events to go quiet itself
 * (McodeAgent's waitForIdle); `uiautomator dump`, the fallback, waits too.
 */
const SETTLE_MS = 150
/** How long a launched app has to come to the front. */
const LAUNCH_WAIT_MS = 20_000

/** Where adb usually is: the SDK's platform-tools, wherever the SDK was put. */
function adbCandidates(): string[] {
  const exe = process.platform === "win32" ? "adb.exe" : "adb"
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk"),
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    ...(process.platform === "win32" ? ["C:\\Android\\sdk", "D:\\Android\\sdk", "C:\\Android\\Sdk", "D:\\Android\\Sdk"] : []),
  ].filter((root): root is string => Boolean(root))
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, exe))
  return [...(process.env.MCODE_ADB ? [process.env.MCODE_ADB] : []), ...onPath, ...roots.map((root) => path.join(root, "platform-tools", exe))]
}

/** The adb to use, or undefined when there is none. */
export function findAdb(): string | undefined {
  return adbCandidates().find((file) => fs.existsSync(file))
}

function run(adb: string, args: string[], timeoutMs = 20_000, binary = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(adb, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) {
        const said = String(stderr ?? "").trim() || String(stdout ?? "").trim() || error.message
        reject(new Error(said.split(/\r?\n/).slice(0, 3).join(" ")))
      } else resolve(binary ? (stdout as Buffer) : (stdout as Buffer))
    })
  })
}

export interface Device {
  serial: string
  state: string
  model: string
}

/**
 * Where the common Android emulators listen for adb on this machine: MuMu
 * (16384, and 7555 in older versions), LDPlayer and BlueStacks (5555), Nox
 * (62001). An emulator's adb connection drops when another adb - its own
 * bundled one, say - restarts the server, and then adb lists nothing although
 * the emulator is running; connecting to these local ports finds it again.
 */
const EMULATOR_PORTS = [16384, 7555, 5555, 62001]

export async function reconnectEmulators(adb: string): Promise<void> {
  // One at a time, stopping at the first that answers: an emulator can listen on several of these, and each would list it again.
  for (const port of EMULATOR_PORTS) {
    const said = (await run(adb, ["connect", `127.0.0.1:${port}`], 4_000).catch(() => Buffer.from(""))).toString("utf8")
    if (/connected to/i.test(said) && !/cannot/i.test(said)) return
  }
}

/**
 * The devices ready to use, each once. One emulator reached through two
 * ports is listed by adb twice; its serial number (ro.serialno), or where an
 * emulator leaves that empty its Android ID, says it is the same device, where
 * the model name could not - two phones of one model are two devices.
 */
export async function connectedDevices(adb: string): Promise<Device[]> {
  const ready = (await listDevices(adb)).filter((device) => device.state === "device")
  if (ready.length < 2) return ready
  // The serial number where the device has one; emulators often leave it empty, and then the Android ID, which is per device too.
  const identities = await Promise.all(
    ready.map((device) =>
      run(adb, ["-s", device.serial, "shell", "getprop ro.serialno; settings get secure android_id"], 5_000).then(
        (out) => out.toString("utf8").split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== "null") ?? device.serial,
        () => device.serial,
      ),
    ),
  )
  const seen = new Set<string>()
  return ready.filter((device, index) => {
    const identity = identities[index] || device.serial
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

/** The devices adb can see, with their model names. */
export async function listDevices(adb: string): Promise<Device[]> {
  const out = (await run(adb, ["devices", "-l"])).toString("utf8")
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = "", state = "", ...rest] = line.split(/\s+/)
      const model = rest.find((part) => part.startsWith("model:"))?.slice("model:".length) ?? ""
      return { serial, state, model }
    })
}

// -------------------------------------------------------------- the hierarchy

interface ViewNode {
  attrs: Record<string, string>
  children: ViewNode[]
  path: string
}

/** uiautomator's XML, read into nodes. It is flat and regular: elements named `node`, attributes in double quotes, entities escaped. */
export function parseHierarchy(xml: string): ViewNode[] {
  const roots: ViewNode[] = []
  const stack: ViewNode[] = []
  const tag = /<(\/?)node\b([^>]*?)(\/?)>/g
  const decode = (text: string) =>
    text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, entity: string) =>
      entity === "amp" ? "&" : entity === "lt" ? "<" : entity === "gt" ? ">" : entity === "quot" ? '"' : entity === "apos" ? "'" : String.fromCodePoint(entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)),
    )
  let match: RegExpExecArray | null
  while ((match = tag.exec(xml))) {
    const [, closing, body, selfClosing] = match
    if (closing) {
      stack.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    for (const pair of body!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[pair[1]!] = decode(pair[2]!)
    const parent = stack.at(-1)
    const siblings = parent ? parent.children : roots
    const node: ViewNode = { attrs, children: [], path: `${parent?.path ?? ""}/${siblings.length}` }
    siblings.push(node)
    if (!selfClosing) stack.push(node)
  }
  return roots
}

function boundsOf(node: ViewNode): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(node.attrs.bounds ?? "")
  if (!match) return undefined
  const [x1, y1, x2, y2] = match.slice(1).map(Number) as [number, number, number, number]
  return x2 > x1 && y2 > y1 ? { x1, y1, x2, y2 } : undefined
}

function shortClass(node: ViewNode): string {
  return (node.attrs.class ?? "").split(".").pop() ?? ""
}

function roleOf(node: ViewNode): string {
  const kind = shortClass(node)
  if (/EditText|AutoCompleteTextView|SearchView/.test(kind)) return "textbox"
  if (/Switch|ToggleButton/.test(kind)) return "switch"
  if (/CheckBox|CheckedTextView/.test(kind) || node.attrs.checkable === "true") return "checkbox"
  if (/RadioButton/.test(kind)) return "radio"
  if (/Spinner/.test(kind)) return "combobox"
  if (/SeekBar|Slider/.test(kind)) return "slider"
  if (/TabView|Tab$/.test(kind)) return "tab"
  if (/Button/.test(kind)) return "button"
  return "clickable"
}

/** The words a person would read for a node: its own text or description, else what its children say. */
function nameOf(node: ViewNode, ancestors: ViewNode[] = []): string {
  const own = node.attrs.text || node.attrs["content-desc"]
  if (own) return squash(own)
  /*
   * A switch or a box in a settings row says nothing itself; the row's title
   * is its name. The title can sit a level or two up (the switch is often in
   * a frame of its own), so the nearest ancestors are asked in turn for words
   * outside the switch.
   */
  if (node.attrs.checkable === "true" || /Switch|CheckBox/.test(shortClass(node))) {
    for (const ancestor of ancestors.slice(-3).reverse()) {
      const words: string[] = []
      const gather = (at: ViewNode) => {
        if (at === node || words.length) return
        const said = at.attrs.text || at.attrs["content-desc"]
        if (said) words.push(said)
        for (const child of at.children) gather(child)
      }
      gather(ancestor)
      if (words.length) return squash(words[0]!)
    }
  }
  const words: string[] = []
  const gather = (at: ViewNode) => {
    for (const child of at.children) {
      const said = child.attrs.text || child.attrs["content-desc"]
      if (said) words.push(said)
      if (words.length < 4) gather(child)
    }
  }
  gather(node)
  if (words.length) return squash(words.join(" "))
  const id = node.attrs["resource-id"] ?? ""
  return squash(id.includes("/") ? id.split("/").pop()! : id)
}

function squash(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function interactive(node: ViewNode): boolean {
  const a = node.attrs
  if (a.enabled === "false" && a.clickable !== "true") return false
  return a.clickable === "true" || a["long-clickable"] === "true" || a.checkable === "true" || /EditText|Spinner|SeekBar/.test(shortClass(node))
}

interface Listed {
  key: string
  center: { x: number; y: number }
  line: string
  node: ViewNode
}

// -------------------------------------------------------------- the reader

/**
 * McodeAgent running on the device: connected to the accessibility service
 * once, it answers each "dump" in milliseconds where `uiautomator dump`, which
 * starts over every time, takes about two seconds (measured on an Android 15
 * emulator: 2-20 ms against 2,000).
 */
class Reader {
  private waiting?: { expects: string; resolve: (xml: string) => void; reject: (error: Error) => void }
  private ended = false

  private constructor(private readonly child: ChildProcess) {
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      // A dump's XML, or a set-text answer; the readiness line is taken by start().
      if (line.startsWith("<?xml") || line.startsWith('{"ok"')) {
        if (this.waiting && !line.startsWith(this.waiting.expects)) return
        const waiting = this.waiting
        this.waiting = undefined
        waiting?.resolve(line)
      }
    })
    child.once("exit", () => {
      this.ended = true
      this.waiting?.reject(new Error("the screen reader on the device stopped"))
      this.waiting = undefined
    })
  }

  static async start(adb: string, serial: string): Promise<Reader> {
    const hash = crypto.createHash("sha256").update(AGENT_DEX).digest("hex").slice(0, 12)
    const remote = `/data/local/tmp/mcode-agent-${hash}.dex`
    const present = (await run(adb, ["-s", serial, "shell", `ls ${remote} 2>/dev/null`]).catch(() => Buffer.from(""))).toString("utf8").includes(remote)
    if (!present) {
      const local = path.join(os.tmpdir(), `mcode-agent-${hash}.dex`)
      fs.writeFileSync(local, Buffer.from(AGENT_DEX, "base64"))
      await run(adb, ["-s", serial, "push", local, remote], 30_000)
    }
    const child = spawn(adb, ["-s", serial, "shell", `CLASSPATH=${remote}:/system/framework/uiautomator.jar app_process / McodeAgent`], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000)
      readline.createInterface({ input: child.stdout! }).once("line", (line) => {
        clearTimeout(timer)
        resolve(line.includes('"ready"'))
      })
      child.once("exit", () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    if (!ready) {
      child.kill()
      throw new Error("the screen reader could not start on the device")
    }
    return new Reader(child)
  }

  get alive(): boolean {
    return !this.ended
  }

  dump(timeoutMs = 10_000): Promise<string> {
    return this.request("dump", timeoutMs)
  }

  /** Puts text into the editable field at a point, through the accessibility service: any language, unlike adb's input. */
  async setText(x: number, y: number, text: string): Promise<boolean> {
    const answer = await this.request(`settext ${x} ${y} ${Buffer.from(text, "utf8").toString("base64")}`, 10_000).catch(() => "")
    return answer.includes('"ok":true')
  }

  private request(line: string, timeoutMs: number): Promise<string> {
    if (this.ended) return Promise.reject(new Error("the screen reader on the device stopped"))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined
        reject(new Error("the screen reader on the device did not answer"))
      }, timeoutMs)
      this.waiting = {
        expects: line === "dump" ? "<?xml" : '{"ok"',
        resolve: (xml) => {
          clearTimeout(timer)
          resolve(xml)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.child.stdin!.write(`${line}\n`)
    })
  }

  stop(): void {
    if (this.ended) return
    this.child.stdin?.write("quit\n")
    setTimeout(() => this.child.kill(), 500)
  }
}

// -------------------------------------------------------------- the driver

export class AndroidDriver extends SteppingDriver {
  private ids = new Map<string, number>()
  private next = 1
  /** Where each numbered element was at the last look, and what it is. */
  private placed = new Map<number, Listed>()
  private screen?: { width: number; height: number }
  private lastPackage = ""
  /** The resident reader; without one - it could not start - every read is a `uiautomator dump`. */
  private reader?: Reader

  private constructor(
    private readonly adb: string,
    private serial: string,
    readonly label: string,
    private readonly launched?: string,
  ) {
    super()
  }

  /**
   * Connects to a device - by its serial or part of its model name, or the
   * only one there is - and, given a package, starts that app and waits for it
   * to come to the front.
   */
  static async connect(target: string | undefined, packageName: string | undefined): Promise<AndroidDriver> {
    const adb = findAdb()
    if (!adb) throw new Error("adb was not found. Install Android SDK platform-tools, or set ANDROID_HOME to the SDK.")
    let devices = await connectedDevices(adb)
    if (!devices.length) {
      await reconnectEmulators(adb)
      devices = await connectedDevices(adb)
    }
    if (!devices.length) throw new Error("No Android device is connected. Start an emulator or connect a phone with USB debugging on (adb devices lists none); an emulator on a port may need `adb connect 127.0.0.1:<port>` first.")
    const wanted = target ? devices.find((device) => device.serial === target || device.model.toLowerCase().includes(target.toLowerCase())) : devices.length === 1 ? devices[0] : undefined
    if (!wanted) throw new Error(`${target ? `No device matches "${target}".` : "More than one device is connected; name one with target."} Devices: ${devices.map((device) => `${device.serial}${device.model ? ` (${device.model})` : ""}`).join(", ")}`)
    const driver = new AndroidDriver(adb, wanted.serial, wanted.model || wanted.serial, packageName)
    driver.reader = await Reader.start(adb, wanted.serial).catch(() => undefined)
    if (packageName) await driver.start(packageName)
    return driver
  }

  get alive(): boolean {
    return true
  }

  private shell(args: string[], timeoutMs?: number): Promise<Buffer> {
    return run(this.adb, ["-s", this.serial, "shell", ...args], timeoutMs)
  }

  private async start(packageName: string): Promise<void> {
    if (!/^[\w.]+$/.test(packageName)) throw new Error(`"${packageName}" is not a package name`)
    const out = (await this.shell(["monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"], 30_000).catch((error: Error) => Buffer.from(error.message))).toString("utf8")
    if (/No activities found|not found/i.test(out)) throw new Error(`${packageName} is not installed on ${this.label}, or has no launcher screen. Install it first (adb install), then launch again.`)
    const until = Date.now() + LAUNCH_WAIT_MS
    while (Date.now() < until) {
      const now = await this.read().catch(() => undefined)
      if (now && this.lastPackage === packageName) return
      await sleep(500)
    }
    throw new Error(`${packageName} did not come to the front within ${LAUNCH_WAIT_MS / 1000}s`)
  }

  async pages(): Promise<PageInfo[]> {
    const devices = await listDevices(this.adb)
    return devices.map((device) => ({ id: device.serial, title: device.model || device.serial, url: `android://${device.state}`, current: device.serial === this.serial }))
  }

  async use(id: string): Promise<void> {
    this.reader?.stop()
    this.reader = await Reader.start(this.adb, id).catch(() => undefined)
    this.serial = id
    this.last = undefined
    this.ids.clear()
    this.placed.clear()
    this.screen = undefined
  }

  async screenshot(file: string): Promise<void> {
    const png = await run(this.adb, ["-s", this.serial, "exec-out", "screencap", "-p"], 30_000, true)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, png)
  }

  async evaluate(): Promise<string> {
    throw new Error("eval works in web pages and Electron apps; on Android, read the screen with snapshot, or use adb through the shell.")
  }

  async close(): Promise<void> {
    this.reader?.stop()
    // An app this tool started is stopped again; the device itself is left as it was.
    if (this.launched) await this.shell(["am", "force-stop", this.launched]).catch(() => undefined)
  }

  // ------------------------------------------------------------ reading

  private async dump(): Promise<string> {
    if (this.reader?.alive) {
      const xml = await this.reader.dump().catch(() => undefined)
      if (xml) return xml
    }
    return (await run(this.adb, ["-s", this.serial, "exec-out", "uiautomator", "dump", "/dev/tty"], 30_000)).toString("utf8")
  }

  protected async read(): Promise<Snapshot> {
    const raw = await this.dump()
    const start = raw.indexOf("<?xml")
    const end = raw.lastIndexOf("</hierarchy>")
    if (start < 0 || end < 0) throw new StepError(`the screen could not be read: ${squash(raw, 160) || "no answer from uiautomator"}`)
    const roots = parseHierarchy(raw.slice(start, end))
    const listed: Listed[] = []
    const text: string[] = []
    const seen = new Set<string>()
    let more = 0
    let packageName = ""
    const walk = (node: ViewNode, insideListed: boolean, ancestors: ViewNode[]) => {
      packageName ||= node.attrs.package ?? ""
      const box = boundsOf(node)
      const listedHere = Boolean(box) && interactive(node)
      if (listedHere && box) {
        if (listed.length >= SNAPSHOT_LIMIT) more += 1
        else {
          const key = `${node.path}|${node.attrs.class ?? ""}|${node.attrs["resource-id"] ?? ""}`
          let number = this.ids.get(key)
          if (!number) {
            number = this.next++
            this.ids.set(key, number)
          }
          const role = roleOf(node)
          const states: string[] = []
          if (node.attrs.enabled === "false") states.push("disabled")
          if (node.attrs.checked === "true") states.push("checked")
          if (node.attrs.selected === "true") states.push("selected")
          if (role === "textbox") {
            if (node.attrs.focused === "true") states.push("focused")
            states.push(`value=${JSON.stringify(squash(node.attrs.password === "true" && node.attrs.text ? "•••" : (node.attrs.text ?? ""), 40))}`)
          }
          listed.push({ key, center: { x: Math.round((box.x1 + box.x2) / 2), y: Math.round((box.y1 + box.y2) / 2) }, line: `[${number}] ${role} ${JSON.stringify(role === "textbox" ? squash(node.attrs["content-desc"] || node.attrs.hint || node.attrs["resource-id"]?.split("/").pop() || "") : nameOf(node, ancestors))}${states.length ? ` ${states.join(" ")}` : ""}`, node })
        }
      }
      const said = node.attrs.text || node.attrs["content-desc"]
      if (said && !listedHere && !insideListed) {
        const line = squash(said, 160)
        if (line && !seen.has(line) && text.length < 80) {
          seen.add(line)
          text.push(line)
        }
      }
      for (const child of node.children) walk(child, insideListed || listedHere, [...ancestors, node])
    }
    for (const root of roots) walk(root, false, [])
    this.lastPackage = packageName
    this.placed = new Map(listed.map((entry) => [Number(/^\[(\d+)\]/.exec(entry.line)![1]), entry]))
    const rootBox = roots[0] ? boundsOf(roots[0]) : undefined
    if (rootBox) this.screen = { width: rootBox.x2, height: rootBox.y2 }
    return { title: this.label, url: `android://${packageName || "device"}`, modal: "", elements: listed.map((entry) => entry.line), more, text }
  }

  // ------------------------------------------------------------ acting

  private at(step: Step): Listed {
    const ref = requireRef(step)
    const found = this.placed.get(ref)
    if (!found) throw new StepError(`[${ref}] ${[...this.ids.values()].includes(ref) ? REF_ERRORS.gone : REF_ERRORS.unknown}`)
    return found
  }

  protected async step(step: Step): Promise<string> {
    switch (step.action) {
      case "click":
      case "double_click": {
        const target = this.at(step)
        if (target.node.attrs.enabled === "false") return "it is disabled"
        await this.shell(["input", "tap", String(target.center.x), String(target.center.y)])
        if (step.action === "double_click") await this.shell(["input", "tap", String(target.center.x), String(target.center.y)])
        await sleep(SETTLE_MS)
        return ""
      }
      case "type": {
        const target = this.at(step)
        const text = String(step.text ?? "")
        await this.shell(["input", "tap", String(target.center.x), String(target.center.y)])
        // The field's text set through the accessibility service: any language, and the whole of it at once. It replaces
        // the text, so to add to it the old text goes first - except in a password field, which reports only dots.
        const kept = step.clear === false ? (target.node.attrs.text ?? "") : ""
        if (this.reader?.alive && !(kept && target.node.attrs.password === "true") && (await this.reader.setText(target.center.x, target.center.y, kept + text))) {
          if (step.submit) await this.shell(["input", "keyevent", "66"])
          await sleep(SETTLE_MS)
          return ""
        }
        // Without the reader, adb's input types what a hardware keyboard could: ASCII only.
        if (/[^\x20-\x7e]/.test(text)) throw new StepError("this field could not take text through the accessibility service, and adb's own input types only plain ASCII")
        const existing = (target.node.attrs.text ?? "").length
        if (step.clear !== false && existing) await this.shell(["input", "keyevent", "123", ...Array.from({ length: Math.min(existing, 200) }, () => "67")])
        if (text) await this.shell(["input", "text", adbText(text)])
        if (step.submit) await this.shell(["input", "keyevent", "66"])
        await sleep(SETTLE_MS)
        return ""
      }
      case "press": {
        if (!step.key) throw new StepError("press needs a key, such as Enter, Back or Home")
        const code = androidKey(step.key)
        await this.shell(["input", "keyevent", ...code])
        await sleep(SETTLE_MS)
        return ""
      }
      case "select": {
        const target = this.at(step)
        await this.shell(["input", "tap", String(target.center.x), String(target.center.y)])
        await sleep(SETTLE_MS * 2)
        await this.read()
        const wanted = String(step.value ?? step.text ?? "").toLowerCase()
        const options = [...this.placed.values()]
        const match = options.find((entry) => nameOf(entry.node).toLowerCase() === wanted) ?? options.find((entry) => nameOf(entry.node).toLowerCase().includes(wanted))
        if (!match) {
          await this.shell(["input", "keyevent", "4"])
          throw new StepError(`no option matches; what was offered: ${options.map((entry) => nameOf(entry.node)).slice(0, 30).join(", ")}`)
        }
        await this.shell(["input", "tap", String(match.center.x), String(match.center.y)])
        await sleep(SETTLE_MS)
        return `chose "${nameOf(match.node)}"`
      }
      case "scroll": {
        if (step.ref !== undefined) throw new StepError("on Android, scroll takes dy (positive to go down the page); a numbered element is reached by scrolling until it is listed")
        const screen = this.screen ?? { width: 1080, height: 1920 }
        const x = Math.round(screen.width / 2)
        const dy = step.dy ?? 600
        const from = Math.round(screen.height * 0.65)
        const to = Math.max(1, Math.min(screen.height - 1, from - dy))
        await this.shell(["input", "swipe", String(x), String(from), String(x), String(to), "300"])
        await sleep(SETTLE_MS)
        return ""
      }
      case "hover":
        throw new StepError("a touch screen has no hover")
      case "wait": {
        if (step.text) {
          const cap = Math.min(step.ms ?? 5_000, WAIT_CAP_MS)
          const until = Date.now() + cap
          while (Date.now() < until) {
            const now = await this.read().catch(() => undefined)
            if (now && [...now.text, ...now.elements].some((line) => line.includes(step.text!))) return "it appeared"
            await sleep(300)
          }
          throw new StepError(`"${step.text}" did not appear within ${cap / 1000}s`)
        }
        await sleep(Math.min(step.ms ?? 500, WAIT_CAP_MS))
        return ""
      }
      case "back":
        await this.shell(["input", "keyevent", "4"])
        await sleep(SETTLE_MS)
        return ""
      case "goto":
        if (!step.url) throw new StepError("goto needs a url")
        await this.shell(["am", "start", "-a", "android.intent.action.VIEW", "-d", step.url])
        await sleep(SETTLE_MS * 3)
        return ""
      case "reload":
        throw new StepError("reload is for web pages")
      default:
        throw new StepError(`unknown action "${String((step as { action?: unknown }).action)}"`)
    }
  }
}

/** Text as `input text` takes it: spaces as %s, and the characters its shell would read specially escaped. */
export function adbText(text: string): string {
  return text.replace(/([\\"'`$&|;<>()*?!#~^%{}[\]])/g, "\\$1").replace(/ /g, "%s")
}

const ANDROID_KEYS: Record<string, number> = {
  enter: 66,
  tab: 61,
  escape: 111,
  esc: 111,
  back: 4,
  home: 3,
  menu: 82,
  backspace: 67,
  delete: 112,
  space: 62,
  arrowup: 19,
  arrowdown: 20,
  arrowleft: 21,
  arrowright: 22,
  pageup: 92,
  pagedown: 93,
  search: 84,
  appswitch: 187,
}

/** A key the way the app tool names it, as `input keyevent` arguments. Modifiers are not something adb's key events carry reliably. */
export function androidKey(combo: string): string[] {
  const { modifiers, name } = splitCombo(combo)
  if (modifiers.length) throw new StepError("key combinations cannot be sent to Android through adb; press the key alone, or use the app's own buttons")
  const named = ANDROID_KEYS[name.toLowerCase()]
  if (named) return [String(named)]
  if (/^[a-z]$/i.test(name)) return [String(29 + name.toLowerCase().charCodeAt(0) - 97)]
  if (/^[0-9]$/.test(name)) return [String(7 + Number(name))]
  throw new StepError(`unknown key "${name}"; Android keys include Enter, Back, Home, Tab, Backspace and the arrows`)
}
