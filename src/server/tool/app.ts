import os from "node:os"
import path from "node:path"
import type { ToolDefinition, ToolContext, ToolResult } from "./types"
import { ToolError } from "./types"
import { resolvePath } from "./fs-util"
import { AppDriver, WAIT_CAP_MS, type Step } from "../appdrive/driver"

/**
 * Operating the app being built, as a person would - MCode's own tool, not
 * MiMo's (the user's 2026-09-28 request: test the app's buttons and tabs as
 * fast as WorkBuddy does).
 *
 * The window is read as a numbered list of what can be acted on plus what it
 * says, so a model that reads no pictures can drive it; a batch of steps runs
 * in one call, each waiting only until the page goes quiet. Web pages open in
 * a browser of the tool's own; an Electron app is reached through the DevTools
 * port it was started with. Windows' native apps and phones are later rounds.
 */

/** One driver per conversation: the app it has open, kept between calls. */
const drivers = new Map<string, AppDriver>()

/** Ends every app session: the browsers this tool started close, attached apps are only let go. Called when the backend stops. */
export async function closeAllApps(): Promise<void> {
  const open = [...drivers.values()]
  drivers.clear()
  await Promise.all(open.map((driver) => driver.close().catch(() => undefined)))
}

/** The steps a `do` may contain. */
const ACTIONS = ["click", "double_click", "type", "press", "select", "hover", "scroll", "wait", "goto", "back", "reload"] as const

/** The most steps one call runs; more is a sign the model is scripting blind rather than looking. */
export const STEP_LIMIT = 40

export const AppTool: ToolDefinition = {
  name: "app",
  description: [
    "Operate a web page or an Electron app's window the way a person would - click, type, choose, press keys - to try out what you built. The window is read as a numbered list of what can be acted on, plus its text; no screenshots are needed.",
    "",
    "Actions",
    "- open {url}: open a page (http, https, file, localhost) in a browser window of this tool's own.",
    "- attach {port, target?}: connect to an Electron app or a Chromium started with --remote-debugging-port=<port>. Start it yourself first, in the background (electron-vite: `npx electron-vite dev --remoteDebuggingPort 9222`; plain Electron: `npx electron . --remote-debugging-port=9222`; a built app: `app.exe --remote-debugging-port=9222`). target picks a window by title or address.",
    "- snapshot {full?}: read the window again. After the first read only the changes are shown, unless full is true.",
    "- do {steps}: run several steps in one call - this is the fast way to work. They run in order, each waiting only until the page settles, and stop at the first that fails. The answer says what each did and what changed on the page.",
    "- tabs {target?}: list the app's windows and tabs, or switch to the one target names.",
    "- screenshot {path?}: save a PNG - to show the user, or for a model that reads images.",
    "- eval {expression}: run JavaScript in the page and get its value back.",
    "- close: close the browser this tool opened. An attached app is only disconnected, never closed.",
    "",
    "Steps (each {action, ...})",
    "- click / double_click / hover {ref}",
    "- type {ref, text, submit?}: replaces what the field holds; submit presses Enter after it",
    "- press {key}: Enter, Tab, Escape, ArrowDown, Control+a, ...",
    "- select {ref, value}: a native select, by its value or its visible text",
    "- scroll {ref} or {dy}",
    `- wait {text, ms?}: until the text is on the page (at most ${WAIT_CAP_MS / 1000}s), or wait {ms}`,
    "- goto {url}, back, reload",
    "",
    "Working fast",
    "- Put every step you already know into one do: switching to a tab, pressing its three buttons and waiting for a result is one call, not five.",
    "- A number like [12] comes from a snapshot and stays valid for as long as that element exists, so later calls can reuse it.",
    "- Judge the result from the changes and the errors the page reported, which every answer includes; take a new snapshot only when you need the whole window.",
  ].join("\n"),
  permission: "bash",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open", "attach", "snapshot", "do", "tabs", "screenshot", "eval", "close"] },
      url: { type: "string", description: "open: the page to open" },
      port: { type: "integer", description: "attach: the app's DevTools port" },
      target: { type: "string", description: "attach, tabs: a window or tab, by part of its title or address, or its id" },
      steps: {
        type: "array",
        description: "do: the steps, in order",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...ACTIONS] },
            ref: { type: "integer", description: "The element's number from the snapshot" },
            text: { type: "string", description: "type: what to enter; wait: the text to wait for" },
            key: { type: "string", description: "press: the key, such as Enter or Control+a" },
            value: { type: "string", description: "select: the option's value or visible text" },
            url: { type: "string", description: "goto: the address" },
            ms: { type: "integer", description: "wait: how long, or the most to wait for text" },
            submit: { type: "boolean", description: "type: press Enter afterwards" },
            dy: { type: "integer", description: "scroll: pixels down (negative for up)" },
          },
          required: ["action"],
        },
      },
      full: { type: "boolean", description: "snapshot: the whole window rather than what changed" },
      expression: { type: "string", description: "eval: the JavaScript to run" },
      path: { type: "string", description: "screenshot: where to save the PNG" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  /*
   * One conversation's calls run one after another. Calls in one step run
   * together (the runner's Promise.all), and two batches of clicks
   * interleaved on one page would each read the other's changes.
   */
  execute(input, context) {
    const before = queues.get(context.sessionID) ?? Promise.resolve()
    const run = before.then(() => perform(input, context))
    const settled = run.catch(() => undefined)
    queues.set(context.sessionID, settled)
    void settled.then(() => {
      if (queues.get(context.sessionID) === settled) queues.delete(context.sessionID)
    })
    return run
  },
}

/** Each conversation's calls still to finish, chained. */
const queues = new Map<string, Promise<unknown>>()

async function perform(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const action = String(input.action)
  if (action === "open") return open(String(input.url ?? ""), context)
  if (action === "attach") return attach(Number(input.port), typeof input.target === "string" ? input.target : undefined, context)
  const driver = drivers.get(context.sessionID)
  if (action === "close") {
    if (!driver) return { output: "Nothing was open.", title: "close" }
    drivers.delete(context.sessionID)
    await driver.close()
    return { output: `Closed ${driver.label}.`, title: "close" }
  }
  if (!driver || !driver.alive) {
    drivers.delete(context.sessionID)
    throw new ToolError(driver ? "The app's window was closed. Open or attach again." : "Nothing is open yet. Use open with a URL, or attach to an app's DevTools port, first.")
  }
  switch (action) {
    case "snapshot":
      return { output: await driver.snapshot(input.full === true), title: "snapshot" }
    case "do": {
      const steps = stepsOf(input.steps)
      const { output, done } = await driver.run(steps, context.signal)
      return { output, title: `${done}/${steps.length}`, metadata: { steps: steps.length, done } }
    }
    case "tabs": {
      const target = typeof input.target === "string" ? input.target.trim() : ""
      const pages = await driver.pages()
      if (target) {
        const page = pages.find((entry) => entry.id === target) ?? pages.find((entry) => entry.title.includes(target) || entry.url.includes(target))
        if (!page) throw new ToolError(`No window or tab matches "${target}".`)
        await driver.use(page.id)
        return { output: await driver.snapshot(true), title: page.title || page.url }
      }
      return { output: pages.map((page) => `${page.current ? "* " : "  "}${page.id}  ${page.title || "(untitled)"} - ${page.url}`).join("\n") || "No windows.", title: "tabs" }
    }
    case "screenshot": {
      const file = typeof input.path === "string" && input.path.trim() ? await resolvePath(context, input.path, "write") : path.join(os.tmpdir(), "mcode-app-shots", `${Date.now()}.png`)
      await driver.screenshot(file)
      return { output: `Saved the window as ${file}`, title: path.basename(file), metadata: { path: file } }
    }
    case "eval": {
      const expression = String(input.expression ?? "").trim()
      if (!expression) throw new ToolError("eval needs an expression")
      return { output: await driver.evaluate(expression), title: "eval" }
    }
    default:
      throw new ToolError(`Unknown action "${action}". Use open, attach, snapshot, do, tabs, screenshot, eval or close.`)
  }
}

async function open(url: string, context: ToolContext) {
  if (!/^(https?|file):\/\//i.test(url) && !/^localhost(:\d+)?(\/|$)/i.test(url)) throw new ToolError("open needs a full address, such as http://localhost:5173 or file:///C:/site/index.html")
  const address = /^localhost/i.test(url) ? `http://${url}` : url
  await context.permissions.ask({
    sessionID: context.sessionID,
    messageID: context.messageID,
    callID: context.callID,
    kind: "bash",
    directory: context.directory,
    title: "Open a page to operate it",
    subject: `open ${address}`,
  })
  const previous = drivers.get(context.sessionID)
  drivers.delete(context.sessionID)
  if (previous) await previous.close().catch(() => undefined)
  const driver = await AppDriver.open(address).catch((error: unknown) => {
    throw new ToolError(error instanceof Error ? error.message : String(error))
  })
  drivers.set(context.sessionID, driver)
  return { output: await driver.snapshot(true), title: address, metadata: { url: address } }
}

async function attach(port: number, target: string | undefined, context: ToolContext) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ToolError("attach needs the port the app was started with, as in --remote-debugging-port=9222")
  await context.permissions.ask({
    sessionID: context.sessionID,
    messageID: context.messageID,
    callID: context.callID,
    kind: "bash",
    directory: context.directory,
    title: "Connect to an app to operate it",
    subject: `attach 127.0.0.1:${port}`,
  })
  const previous = drivers.get(context.sessionID)
  drivers.delete(context.sessionID)
  if (previous) await previous.close().catch(() => undefined)
  const driver = await AppDriver.attach(port, target).catch((error: unknown) => {
    throw new ToolError(error instanceof Error ? error.message : String(error))
  })
  drivers.set(context.sessionID, driver)
  return { output: await driver.snapshot(true), title: `127.0.0.1:${port}`, metadata: { port } }
}

function stepsOf(value: unknown): Step[] {
  if (!Array.isArray(value) || value.length === 0) throw new ToolError("do needs steps: a list like [{\"action\":\"click\",\"ref\":3}]")
  if (value.length > STEP_LIMIT) throw new ToolError(`At most ${STEP_LIMIT} steps in one call; look at the page between batches.`)
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new ToolError(`Step ${index + 1} is not an object.`)
    const step = entry as Step
    if (!(ACTIONS as readonly string[]).includes(String(step.action))) throw new ToolError(`Step ${index + 1} has an unknown action "${String(step.action)}"; use one of ${ACTIONS.join(", ")}.`)
    return step
  })
}
