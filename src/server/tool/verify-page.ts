import fs from "node:fs/promises"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { checkPage, describeIssues } from "../appdrive/page-check"

/**
 * Open a local HTML page in a headless browser, run its animation forward, and
 * report what is wrong. It writes nothing to the project, but the page's scripts
 * really run, with the network, so it is asked about like a command, as the app
 * tool's opening of a page is.
 *
 * This is the check a person would make by opening the file - and the one the
 * model otherwise skips, since it cannot see the page. Measured on pages a
 * model wrote with its own say-so that they worked: one drew nothing at all
 * (an SVG with no size inside a flex box), another lost a function while being
 * "fixed" and silently stopped animating.
 */
export const VerifyPageTool: ToolDefinition = {
  name: "verify_page",
  description: [
    "Open a local HTML page in a headless browser, run its animation forward about eight seconds, and report what is wrong: console errors, scripts that do not parse, functions the page needs that are missing, SVG attributes that are NaN or malformed paths, and layers that are empty. It changes no file, but the page's scripts really run, so only use it on a page you wrote or trust. Animation driven by requestAnimationFrame, timers or Date is run forward; CSS animations are not.",
    "",
    "Use it after writing or assembling a page that has scripts or animation, before telling the user it works. An empty report is not proof the page looks right - it cannot see that a figure is ugly or misplaced - so it is one check, not the last word.",
    "",
    "Optional help for a page built from parts: `layers` names the layer elements and the part that draws each (so a problem is reported against the part to fix, and an empty layer is noticed), `require_functions` lists functions the page must define, and `checks_file` is a JavaScript file that runs in the page before the animation starts and may set `window.__specChecks = (add) => { add('part', 'what is wrong') }` for checks of its own; push functions to `window.__samplers` to be called after every animation step.",
    "",
    "Needs Chrome or Edge on this machine.",
  ].join("\n"),
  permission: "bash",
  asksForItself: true,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The HTML file to open, absolute or relative to the project root" },
      layers: { type: "object", description: "Layer element id -> the name of the part that draws it", additionalProperties: { type: "string" } },
      require_functions: { type: "array", items: { type: "string" }, description: "Global functions the page must define, for example update_bg" },
      checks_file: { type: "string", description: "A JavaScript file of checks of your own, run in the page" },
      seconds: { type: "number", description: "How many seconds of animation to run forward (default 8, at most 24)" },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.file_path ?? ""), "read")
    const display = relative(context.directory, target)
    const stat = await fs.stat(target).catch(() => undefined)
    if (!stat?.isFile()) throw new ToolError(`${display} is not a file.`)
    let layers: Record<string, string> | undefined
    if (input.layers !== undefined) {
      if (typeof input.layers !== "object" || input.layers === null || Array.isArray(input.layers)) throw new ToolError("layers must be an object of layer id -> part name.")
      layers = {}
      for (const [id, name] of Object.entries(input.layers)) {
        if (typeof name !== "string") throw new ToolError(`layers.${id} must be a string.`)
        layers[id] = name
      }
    }
    const requireFunctions = Array.isArray(input.require_functions) ? input.require_functions.filter((entry): entry is string => typeof entry === "string") : undefined
    let checksSource: string | undefined
    if (typeof input.checks_file === "string" && input.checks_file.trim()) {
      const checks = await resolvePath(context, input.checks_file.trim(), "read")
      checksSource = await fs.readFile(checks, "utf8").catch(() => {
        throw new ToolError(`Could not read checks_file ${relative(context.directory, checks)}.`)
      })
    }
    const seconds = typeof input.seconds === "number" && input.seconds > 0 ? Math.min(24, input.seconds) : undefined
    await context.permissions.ask({
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "bash",
      directory: context.directory,
      title: "Open a page and run its scripts in a headless browser",
      subject: display,
      patterns: [`verify_page: ${display}`],
      always: [`verify_page: ${display}`],
    })
    await context.beforeAction?.()
    context.progress("Loading the page in a headless browser...")
    let result: Awaited<ReturnType<typeof checkPage>>
    try {
      result = await checkPage({ file: target, layers, requireFunctions, checksSource, seconds, signal: context.signal })
    } catch (failure) {
      throw new ToolError(`The page could not be checked: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
    const clean = result.issues.length === 0
    return {
      output: `${display}, in ${result.browser}:\n${describeIssues(result.issues)}`,
      title: clean ? "no problems" : `${result.issues.length} problem(s)`,
      metadata: { path: display, issues: result.issues },
    }
  },
}
