/**
 * One benchmark task, run in the real app against a real model.
 *
 * Started by scripts/bench/run.mjs with the task's folder, prompt and output
 * file in the environment. Runs the built app (out/main) on the profile named
 * by BENCH_PROFILE - a throwaway profile whose provider key the user entered
 * there themselves; this script never reads credentials.json - with the home
 * folder fenced off, so no real skills, memory or history reach the model.
 * Sends the prompt as a new conversation, waits for the turn to end, and
 * writes what the conversation's own records say it did.
 *
 * Run through run.mjs, not by hand.
 */
const path = require("node:path")
const fs = require("node:fs")
const { pathToFileURL } = require("node:url")

const REPO = path.join(__dirname, "..", "..")
const TASK_DIR = process.env.BENCH_TASK_DIR
const PROMPT = process.env.BENCH_PROMPT
const OUT = process.env.BENCH_OUT
const PROFILE = process.env.BENCH_PROFILE
const LIMIT_MS = Number(process.env.BENCH_LIMIT_MS || 8 * 60_000)
if (!TASK_DIR || !PROMPT || !OUT || !PROFILE) throw new Error("run through scripts/bench/run.mjs")

const scratch = path.join(path.dirname(OUT), path.basename(OUT, ".json") + "-home")
fs.mkdirSync(scratch, { recursive: true })
process.env.USERPROFILE = scratch
process.env.HOME = scratch
process.env.LOCALAPPDATA = path.join(scratch, "localappdata")

/*
 * The profile's settings for this task: its folder as the project, full
 * access so no approval card stops a measured run, and no MCP servers, so the
 * tools the model is offered are the app's own.
 */
const CONFIG = path.join(PROFILE, "storage", "config.json")
const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"))
config.directory = TASK_DIR
config.projects = [TASK_DIR, ...(config.projects ?? []).filter((entry) => entry !== TASK_DIR)].slice(0, 20)
/*
 * Full access the way the settings switch sets it (renderer lib/confirm-queue
 * `accessPatch`): every bucket not denied allows, and the map it replaced is
 * kept. The level word alone is not full access - with a bucket still asking,
 * the default reads as "ask", every edit waits on a card, and a run measures
 * that wait instead of the model.
 */
const map = config.permissions ?? {}
if (Object.values(map).some((action) => action === "ask")) {
  config.accessBefore = { ...map }
  config.permissions = Object.fromEntries(Object.entries(map).map(([kind, action]) => [kind, action === "deny" ? "deny" : "allow"]))
}
config.allowFullAccess = true
config.accessLevel = "full"
config.mcpServers = {}
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2))

const SESSIONS = path.join(PROFILE, "storage", "session")
const before = new Set(fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS) : [])

const { app, BrowserWindow } = require("electron")
app.setPath("appData", path.join(scratch, "appdata"))
app.setPath("userData", PROFILE)
app.commandLine.appendSwitch("disable-gpu")

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const result = { task: path.basename(TASK_DIR), notes: [] }

/** What the conversation's records say happened: steps, tools, time and tokens. */
function measure() {
  const fresh = fs.readdirSync(SESSIONS).filter((id) => !before.has(id))
  const messages = []
  for (const id of fresh) {
    const dir = path.join(SESSIONS, id, "message")
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) messages.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")))
  }
  messages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  const replies = messages.filter((message) => message.role === "assistant")
  const tools = replies.flatMap((message) => (message.parts ?? []).filter((part) => part.type === "tool"))
  const first = messages.find((message) => message.role === "user")?.time?.created ?? 0
  const last = Math.max(0, ...replies.map((message) => message.time?.completed ?? message.time?.created ?? 0))
  const sum = (key) => replies.reduce((total, message) => total + (message.usage?.[key] ?? 0), 0)
  const directories = fresh.map((id) => JSON.parse(fs.readFileSync(path.join(SESSIONS, id, "info.json"), "utf8")).directory)
  if (directories.some((directory) => path.resolve(directory) !== path.resolve(TASK_DIR))) result.notes.push("ran outside the task folder: " + directories.join(", "))
  return {
    sessions: fresh.length,
    steps: replies.length,
    toolCalls: tools.length,
    toolErrors: tools.filter((part) => part.status === "error").length,
    // Calls that waited on an approval card: at full access there should be none.
    asked: tools.filter((part) => (part.metadata?.permissions ?? []).length > 0).length,
    tools: tools.map((part) => part.name),
    seconds: first && last ? Math.round((last - first) / 100) / 10 : 0,
    promptTokens: sum("input") + sum("cacheRead") + sum("cacheWrite"),
    uncachedTokens: sum("input"),
    outputTokens: sum("output"),
    // The largest single request: the fixed part (system prompt and tools) plus the conversation so far.
    largestRequest: Math.max(0, ...replies.map((message) => (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0))),
    errors: replies.filter((message) => message.error).map((message) => String(message.error?.message ?? message.error).slice(0, 200)),
    finalText: (replies.at(-1)?.parts ?? []).filter((part) => part.type === "text").map((part) => part.text).join("").slice(0, 400),
  }
}

app.whenReady().then(async () => {
  try {
    await import(pathToFileURL(path.join(REPO, "out", "main", "index.js")).href)
    const window = await new Promise((resolve) => {
      const poll = setInterval(() => {
        const found = BrowserWindow.getAllWindows()[0]
        if (found) {
          clearInterval(poll)
          resolve(found)
        }
      }, 100)
    })
    window.setSize(1300, 900)
    window.show()
    await wait(6000)
    const js = (code) => window.webContents.executeJavaScript(code)
    const zoom = () => window.webContents.getZoomFactor()
    const click = async (x, y) => {
      const at = { x: Math.round(x * zoom()), y: Math.round(y * zoom()) }
      window.webContents.sendInputEvent({ type: "mouseMove", ...at })
      window.webContents.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 })
      window.webContents.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 })
      await wait(400)
    }
    const centre = async (selector) =>
      JSON.parse(await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "null"; const r = el.getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]) })()`))
    /*
     * A new task in the task's folder, from its project row. The menu's new
     * task would open in the folder of whatever conversation the app came
     * back to, which is the last one the profile used. The side column pages
     * its projects by last use, so the folder is first marked used - the row's
     * own button does the same before it starts the task - to bring its row
     * onto the first page.
     */
    await js(`document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("app").addProject(${JSON.stringify(TASK_DIR)}, { used: true, silent: true })`)
    await wait(800)
    const createIn = `button.ico.inline[aria-label*=${JSON.stringify(path.basename(TASK_DIR))}]`
    const created = await js(`(() => { const button = document.querySelector(${JSON.stringify(createIn)}); if (!button) return false; button.click(); return true })()`)
    if (!created) throw new Error("no project row for the task folder")
    await wait(1500)
    const box = await centre("textarea")
    if (!box) throw new Error("no composer")
    await click(box[0], box[1])
    window.webContents.insertText(PROMPT)
    await wait(300)
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" })
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" })
    const started = Date.now()
    let idle = 0
    let began = false
    while (Date.now() - started < LIMIT_MS) {
      await wait(1000)
      // A question card (web search's first use, say) is answered with its first option, as a reader in a hurry would.
      const option = await centre("[data-confirm-opts] .q-opt")
      if (option) {
        result.notes.push("answered a question card")
        await click(option[0], option[1])
        continue
      }
      const busy = await js(`Boolean(document.querySelector(".send.stop"))`)
      if (busy) began = true
      idle = busy ? 0 : idle + 1
      if (began && idle >= 4) break
      if (!began && Date.now() - started > 60_000) {
        result.notes.push("the turn never started")
        break
      }
    }
    if (Date.now() - started >= LIMIT_MS) result.notes.push(`stopped at the ${LIMIT_MS / 60000}-minute limit`)
  } catch (error) {
    result.notes.push("agent error: " + String(error && error.message))
  } finally {
    try {
      Object.assign(result, measure())
    } catch (error) {
      result.notes.push("measure error: " + String(error))
    }
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
    app.exit(0)
  }
})
