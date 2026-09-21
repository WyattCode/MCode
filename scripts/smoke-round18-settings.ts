/**
 * Round 18, lane M: the settings MiMo 26.920 added or redid - the skill folders
 * of other tools (R18-M1), launch at login (R18-M2), the lab page (R18-M3),
 * the `/responses` protocol (R18-M4) and the redone models page (R18-M5).
 *
 * Everything here runs in plain node: folders are temporary, the home folder
 * is a folder of the check's own, and the login item is a stub that records
 * what it was asked. The drawn pages are in the lane's Electron probe.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { SESSION_CHAT_SKILL, discoverSkills, externalSkillDirs } from "../src/server/skill"
import { sanitizeConfig } from "../src/server/config-sanitize"
import { SESSION_CHAT_TOOLS, toolsForTurn, withheldByLab } from "../src/server/tool/registry"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { adapterFor } from "../src/server/provider/adapter"
import { AnthropicAdapter } from "../src/server/provider/anthropic"
import { ChatGPTSubscription, OpenAIResponses } from "../src/server/provider/chatgpt"
import { OpenAICompatible } from "../src/server/provider/openai"
import { modelVariants } from "../src/server/provider/variants"
import { probeModels } from "../src/server/provider/discover"
import { LIMIT_PRESETS, cloneId, limitLabel, modalitySummary } from "../src/renderer/src/lib/custom-model"
import type { AppConfig } from "../src/shared/protocol"
import {
  OPEN_HIDDEN_ARG,
  loginItemSupported,
  parseLoginItem,
  readLaunchAtLogin,
  startsHidden,
  writeLaunchAtLogin,
  type LoginItemHost,
} from "../src/main/login-item"

/** A login item that records what it was asked and answers as an OS would. */
function stubHost(isPackaged: boolean) {
  const asked: unknown[] = []
  let registered = false
  const host: LoginItemHost = {
    isPackaged,
    getLoginItemSettings: () => ({ openAtLogin: registered }),
    setLoginItemSettings: (settings) => {
      asked.push(settings)
      registered = settings.openAtLogin
    },
  }
  let stored = false
  const store = { read: () => stored, write: (enabled: boolean) => void (stored = enabled) }
  return { host, store, asked, stored: () => stored }
}

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

async function skill(root: string, name: string, description = `the ${name} skill`): Promise<void> {
  await fs.mkdir(path.join(root, name), { recursive: true })
  await fs.writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`, "utf8")
}

export async function roundEighteenSettingsChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ---------------------------------------------------------------- R18-M1
  section("Round 18 (M1): the skill folders of other tools, `.agents` read by default")
  {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r18m1-"))
    try {
      const home = path.join(base, "home")
      const repo = path.join(base, "repo")
      const nested = path.join(repo, "packages", "app")
      const storage = path.join(base, "storage")
      await fs.mkdir(path.join(repo, ".git"), { recursive: true })
      await fs.mkdir(nested, { recursive: true })
      await skill(path.join(home, ".agents", "skills"), "global-agents")
      await skill(path.join(home, ".agents", "skills"), "shared", "from the global agents folder")
      await skill(path.join(home, ".claude", "skills"), "global-claude")
      await skill(path.join(home, ".codex", "skills"), "global-codex")
      await skill(path.join(home, ".opencode", "skills"), "global-opencode")
      await skill(path.join(repo, ".agents", "skills"), "project-agents")
      await skill(path.join(repo, ".agents", "skills"), "shared", "from the repository root")
      await skill(path.join(nested, ".agents", "skills"), "shared", "from the nearer folder")
      await skill(path.join(repo, ".claude", "skills"), "project-claude")
      await skill(path.join(storage, "skills"), "own", "from the app's own folder")
      await skill(path.join(repo, ".agents", "skills"), "own", "from the project agents folder")
      // Only `skills`, as MiMo reads these folders; a `skill` folder there is not one.
      await skill(path.join(home, ".agents", "skill"), "singular")

      const names = async (settings?: Pick<AppConfig, "skillPaths" | "sessionChat">) => {
        const scan = await discoverSkills({ directory: nested, storageDirectory: storage, builtinRoot: null, home, settings })
        return scan.skills
      }
      const plain = await names()
      const has = (list: { name: string }[], name: string) => list.some((entry) => entry.name === name)
      check("R18-M1: by default the global ~/.agents/skills is read", has(plain, "global-agents"), plain.map((entry) => entry.name))
      check("R18-M1: and the project's .agents/skills", has(plain, "project-agents"))
      check("R18-M1: the three brand folders stay unread by default", !has(plain, "global-claude") && !has(plain, "global-codex") && !has(plain, "global-opencode") && !has(plain, "project-claude"))
      check("R18-M1: only a `skills` folder counts there", !has(plain, "singular"))
      check("R18-M1: the nearer project folder wins a shared name", plain.find((entry) => entry.name === "shared")?.description === "from the nearer folder")
      check("R18-M1: the app's own global folder is read after them and wins", plain.find((entry) => entry.name === "own")?.description === "from the app's own folder")
      check("R18-M1: a skill from these folders is the user's, not a shipped one", plain.every((entry) => !entry.builtin))

      const claude = await names({ skillPaths: { claude: true } })
      check("R18-M1: switching Claude on reads ~/.claude/skills", has(claude, "global-claude") && has(claude, "project-claude"))
      check("R18-M1: and leaves .agents as it was", has(claude, "global-agents"))
      const none = await names({ skillPaths: { agents: false } })
      check("R18-M1: switching .agents off stops reading it", !has(none, "global-agents") && !has(none, "project-agents"))
      const all = await names({ skillPaths: { claude: true, codex: true, opencode: true } })
      check("R18-M1: all four read when all are on", ["global-agents", "global-claude", "global-codex", "global-opencode"].every((name) => has(all, name)))
      check("R18-M1: the folders in MiMo's order", externalSkillDirs({ claude: true, codex: true, opencode: true }).join(" ") === ".claude .codex .opencode .agents")
      check("R18-M1: and only .agents when nothing was chosen", externalSkillDirs(undefined).join(" ") === ".agents")

      const doc = { skillPaths: { agents: false, claude: "yes", other: true } } as unknown as AppConfig
      sanitizeConfig(doc, {} as AppConfig)
      check("R18-M1: a stored choice that is not a boolean, or not one of the four, is dropped", JSON.stringify(doc.skillPaths) === JSON.stringify({ agents: false }), doc.skillPaths)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
    const source = await read("src/server/skill.ts")
    check("R18-M1: skill.ts no longer says MiMo switches the four folders off", !/switches all four off/.test(source))
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    check("R18-M1: the config page lists the four folders with a switch each", /data-skill-path-switch/.test(settings) && /\["agents", "claude", "codex", "opencode"\]/.test(settings))
    check("R18-M1: and the config file row can copy its path", /data-config-copy-path/.test(settings) && /navigator\.clipboard\.writeText\(target\)/.test(settings))
  }

  // ---------------------------------------------------------------- R18-M2
  section("Round 18 (M2): 开机自启, asked of the OS through a stub")
  {
    check("R18-M2: offered on Windows and macOS", loginItemSupported("win32") && loginItemSupported("darwin"))
    check("R18-M2: not on Linux, where MiMo has no autostart entry either", !loginItemSupported("linux"))

    const win = stubHost(true)
    check("R18-M2: off until turned on", readLaunchAtLogin(win.host, "win32", win.store) === false)
    const on = writeLaunchAtLogin(win.host, "win32", win.store, true)
    check("R18-M2: Windows registers the app to open hidden", JSON.stringify(win.asked[0]) === JSON.stringify({ openAtLogin: true, args: [OPEN_HIDDEN_ARG] }), win.asked)
    check("R18-M2: and answers with what the OS then says", on === true)
    writeLaunchAtLogin(win.host, "win32", win.store, false)
    check("R18-M2: turning it off removes the same entry", JSON.stringify(win.asked[1]) === JSON.stringify({ openAtLogin: false, args: [OPEN_HIDDEN_ARG] }), win.asked)

    const mac = stubHost(true)
    writeLaunchAtLogin(mac.host, "darwin", mac.store, true)
    check("R18-M2: macOS asks the OS to open it hidden", JSON.stringify(mac.asked[0]) === JSON.stringify({ openAtLogin: true, openAsHidden: true }), mac.asked)

    const dev = stubHost(false)
    const devOn = writeLaunchAtLogin(dev.host, "win32", dev.store, true)
    check("R18-M2: a development build never registers the bare Electron binary", dev.asked.length === 0)
    check("R18-M2: it keeps the choice instead", devOn === true && dev.stored() === true)

    const linux = stubHost(true)
    check("R18-M2: on Linux nothing is asked of anyone", writeLaunchAtLogin(linux.host, "linux", linux.store, true) === false && linux.asked.length === 0)

    check("R18-M2: a login start on Windows stays hidden", startsHidden("win32", ["MCode.exe", OPEN_HIDDEN_ARG]))
    check("R18-M2: an ordinary start does not", !startsHidden("win32", ["MCode.exe"]) && !startsHidden("darwin", ["MCode", OPEN_HIDDEN_ARG]))
    check("R18-M2: an unreadable choice file is off", parseLoginItem("{") === false && parseLoginItem('{"openAtLogin":true}') === true)

    const main = await read("src/main/index.ts")
    check("R18-M2: the first window is made hidden after a login start", /createWindow\(!hiddenAtLogin\)/.test(main))
    check("R18-M2: and shown after all when the tray turns out to be off", /if \(hiddenAtLogin && !enabled\) \{[\s\S]{0,200}window\.show\(\)/.test(main))
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    check("R18-M2: the row sits under the tray row and only where it is offered", /data-tray-row[\s\S]*v-if="loginItem\.supported"[^>]*data-launch-at-login-row/.test(settings))
  }

  // ---------------------------------------------------------------- R18-M3
  section("Round 18 (M3): the lab page, and session chat behind its switch")
  {
    const names = (sessionChat?: boolean) => toolsForTurn("build", { voiceFeedback: true, sessionChat }).map((tool) => tool.name)
    const on = names(undefined)
    const off = names(false)
    check("R18-M3: session chat is on by default, as MiMo ships it: all six tools offered", [...SESSION_CHAT_TOOLS].every((name) => on.includes(name)), on)
    check("R18-M3: switched off, none of the six is offered", [...SESSION_CHAT_TOOLS].every((name) => !off.includes(name)))
    check("R18-M3: and nothing else goes with them", off.length === on.length - SESSION_CHAT_TOOLS.size)
    check("R18-M3: a call to one while off is not run", withheldByLab("talk_to_session", { sessionChat: false }) && !withheldByLab("talk_to_session", {}) && !withheldByLab("read", { sessionChat: false }))
    const runner = await read("src/server/session/runner.ts")
    check("R18-M3: the runner offers the turn's tools by the setting", /sessionChat: settings\.sessionChat/.test(runner))
    check("R18-M3: and refuses a withheld one at dispatch", /labOff\(name\) \? undefined : findTool\(name\)/.test(runner))

    const doc = { sessionChat: "no" } as unknown as AppConfig
    sanitizeConfig(doc, {} as AppConfig)
    check("R18-M3: a stored switch that is not a boolean is dropped, which is on", doc.sessionChat === undefined)

    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    const nav = settings.slice(settings.indexOf('<nav class="nav"'), settings.indexOf("</nav>"))
    const order = ["navShows('environment')", "navShows('lab')", "navShows('archive')"].map((needle) => nav.indexOf(needle))
    check("R18-M3: the lab group sits between 编码 and 已归档, as in MiMo", order.every((at) => at >= 0) && order[0] < order[1] && order[1] < order[2], order)
    check("R18-M3: always shown - no condition beyond the search", /<button v-show="navShows\('lab'\)" class="nav-item"/.test(nav))
    check("R18-M3: the switch reads absent as on", /:class="\{ on: app\.config\?\.sessionChat !== false \}"/.test(settings))
    check("R18-M3: only switches with a behaviour behind them are drawn", !/gitVersionPin|uncommittedHint/.test(settings))
  }

  // ---------------------------------------------------------------- R18-M4
  section("Round 18 (M4): the /responses protocol for a custom provider")
  {
    check("R18-M4: each kind reaches its own wire", adapterFor("anthropic") === AnthropicAdapter && adapterFor("chatgpt") === ChatGPTSubscription && adapterFor("openai-compatible") === OpenAICompatible)
    check("R18-M4: and /responses the Responses API", adapterFor("openai-responses") === OpenAIResponses)
    const entry = { id: "gpt-5.1", name: "GPT-5.1", reasoning: true, contextWindow: 0, input: 0, output: 0 } as Parameters<typeof modelVariants>[1]
    check("R18-M4: efforts follow MiMo's @ai-sdk/openai arm, as the subscription's do", JSON.stringify(modelVariants("openai-responses", entry)) === JSON.stringify(modelVariants("chatgpt", entry)))

    const seen: { url?: string; headers?: http.IncomingHttpHeaders; body?: Record<string, unknown> } = {}
    const server = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (chunk) => (raw += chunk))
      req.on("end", () => {
        seen.url = req.url
        seen.headers = req.headers
        seen.body = JSON.parse(raw)
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        const frame = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
        frame({ type: "response.output_text.delta", delta: "hello" })
        frame({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 3 } } })
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as AddressInfo).port
      let text = ""
      const outcome = await OpenAIResponses.stream(
        {
          apiKey: "sk-test",
          model: { provider: "gw", model: "gpt-5.1" },
          system: "be brief",
          history: [{ id: "u1", role: "user", text: "hi", attachments: [], time: 0 } as never],
          tools: [],
          effort: "medium",
          signal: new AbortController().signal,
          baseURL: `http://127.0.0.1:${port}/v1/`,
          headers: { "x-route": "blue", Authorization: "Bearer not-this" },
        },
        (event) => {
          if (event.type === "text.delta") text += event.text
        },
      )
      check("R18-M4: the request goes to <base>/responses", seen.url === "/v1/responses", seen.url)
      check("R18-M4: with the provider's key, which a header of the same name cannot displace", seen.headers?.authorization === "Bearer sk-test", seen.headers?.authorization)
      check("R18-M4: and the provider's own headers beside it", seen.headers?.["x-route"] === "blue")
      check("R18-M4: none of the subscription's own headers", seen.headers?.originator === undefined && seen.headers?.["chatgpt-account-id"] === undefined)
      check("R18-M4: the body is a Responses body", Array.isArray(seen.body?.input) && seen.body?.instructions === "be brief" && seen.body?.stream === true, seen.body)
      check("R18-M4: and the reply streams back", text === "hello" && outcome.stop === "end_turn" && outcome.usage.input === 12)
    } finally {
      server.close()
    }

    const config = await read("src/server/config.ts")
    check("R18-M4: a provider stored with `responses` is reached over it", /entry\.protocol === "responses" \? "openai-responses"/.test(config))
    const handlers = await read("src/server/handlers.ts")
    check("R18-M4: adding and editing keep the choice", (handlers.match(/request\.protocol === "anthropic" \|\| request\.protocol === "responses"/g) ?? []).length === 2)
    const runner = await read("src/server/session/runner.ts")
    check("R18-M4: no caller picks an adapter by hand any more", !/\? ChatGPTSubscription/.test(runner + handlers))
  }

  // ---------------------------------------------------------------- R18-M5
  section("Round 18 (M5): the models page as MiMo 26.920 redid it")
  {
    const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch
    let asked: { url?: string; headers?: Record<string, string> } = {}
    const recording = (body: string) =>
      (async (url: string, init: { headers: Record<string, string> }) => {
        asked = { url, headers: init.headers }
        return new Response(body, { status: 200 })
      }) as unknown as typeof fetch
    const ok = await probeModels({ baseURL: "https://gw.example/v1/", apiKey: " sk-1 ", fetcher: recording(JSON.stringify({ data: [{ id: "a" }, "b", { model: "c" }, { id: "a" }] })) })
    check("R18-M5: 测试连接 asks <base>/models with the key", asked.url === "https://gw.example/v1/models" && asked.headers?.authorization === "Bearer sk-1", asked)
    check("R18-M5: and reads ids as MiMo does - strings, `id` or `model` rows, once each", ok.ok && ok.models.join() === "a,b,c", ok)
    const listed = await probeModels({ baseURL: "https://gw.example/v1", apiKey: "k", fetcher: answer(200, JSON.stringify({ models: [{ id: "x" }] })) })
    check("R18-M5: under `models` as well as `data`", listed.ok && listed.models.join() === "x")
    await probeModels({ baseURL: "https://gw.example/v1", apiKey: "k", protocol: "anthropic", fetcher: recording("{}") })
    check("R18-M5: an Anthropic gateway also gets its own key header", asked.headers?.["x-api-key"] === "k" && Boolean(asked.headers?.["anthropic-version"]))
    const denied = await probeModels({ baseURL: "https://gw.example/v1", apiKey: "k", fetcher: answer(401, "{}") })
    check("R18-M5: a refusal reports its status", !denied.ok && denied.reason === "http" && denied.status === 401)
    const page = await probeModels({ baseURL: "https://gw.example/v1", apiKey: "k", fetcher: answer(200, "<html>") })
    check("R18-M5: a page that is not JSON says so", !page.ok && page.reason === "json")
    const slow = await probeModels({ baseURL: "http://10.255.255.1/v1", apiKey: "k", timeout: 1, fetcher: ((_u: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => { const hold = setTimeout(() => undefined, 2000); init.signal.addEventListener("abort", () => (clearTimeout(hold), reject(init.signal.reason))) })) as unknown as typeof fetch })
    check("R18-M5: and one that never answers times out", !slow.ok && slow.reason === "timeout", slow)

    check("R18-M5: MiMo 26.920's limit sizes", LIMIT_PRESETS.context.join() === "256000,512000,1000000" && LIMIT_PRESETS.output.join() === "32000,64000,128000")
    check("R18-M5: written as it writes them", limitLabel(256_000) === "256K" && limitLabel(1_000_000) === "1M" && limitLabel(1_500_000) === "1.5M" && limitLabel(12_345) === "12345" && limitLabel(undefined) === "—")
    const label = (key: string) => key
    check("R18-M5: pictures, sound and video read together are 全模态", modalitySummary({ image: true, audio: true, video: true, pdf: false }, label) === "omni")
    check("R18-M5: PDF follows after a dot, and none is a dash", modalitySummary({ image: true, audio: false, video: false, pdf: true }, label) === "image·pdf" && modalitySummary({ image: false, audio: false, video: false, pdf: false }, label) === "—")
    check("R18-M5: a clone's id starts on the first free -copy", cloneId("gw", new Set(["gw", "gw-copy"])) === "gw-copy-2" && cloneId("gw", new Set(["gw"])) === "gw-copy")

    const models = await read("src/renderer/src/components/ModelsPage.vue")
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    check("R18-M5: a row of tabs - refresh, add, then one per provider", /data-provider-tabs[\s\S]*data-provider-refresh-all[\s\S]*data-provider-add[\s\S]*v-for="provider in listed"/.test(models))
    check("R18-M5: a custom provider's tab carries delete, clone and save", /data-provider-remove[\s\S]*data-provider-clone[\s\S]*data-provider-save/.test(models))
    check("R18-M5: the form offers the three protocols", ["openai", "anthropic", "responses"].every((value) => form.includes(`<option value="${value}">`)))
    check("R18-M5: a connection test, a model picker and the four inputs", /data-provider-probe/.test(form) && /data-model-combo/.test(form) && /v-for="key in MODALITIES"/.test(form))
    check("R18-M5: a blank key on an edit tests with the one held, never sent to the window", /\.\.\.\(editing \? \{ provider: editing\.id \} : \{\}\)/.test(form))
    check("R18-M5: the old add-model dialog is gone", !(await fs.stat(path.join(process.cwd(), "src/renderer/src/components/CustomModelDialog.vue")).catch(() => undefined)) && !/CustomModelDialog/.test(settings + models))
    check("R18-M5: the settings dialog draws the page from its own component", /<ModelsPage v-else \/>/.test(settings))
    check("R18-M5: kept as decided in round nine - a vendor chip opens the connect dialog", /@click="openConnect\(group\)"/.test(models))
    check("R18-M5: and a connected vendor keeps its endpoint and its models", /data-provider-endpoint/.test(models) && /app\.discoverModels\(provider\.id\)/.test(models))
    const handlers = await read("src/server/handlers.ts")
    check("R18-M5: a clone takes the id chosen, checked as a new provider's", /const chosen = request\.id\?\.trim\(\)/.test(handlers) && /providerIdProblem\(chosen, ids\)/.test(handlers))
  }

  // Session chat's skill, which the lab switch takes away with the tools.
  {
    const builtin = path.join(process.cwd(), "resources", "skills")
    const on = await discoverSkills({ directory: os.tmpdir(), builtinRoot: builtin, home: path.join(os.tmpdir(), "mcode-r18-no-home") })
    const off = await discoverSkills({ directory: os.tmpdir(), builtinRoot: builtin, home: path.join(os.tmpdir(), "mcode-r18-no-home"), settings: { sessionChat: false } })
    check("R18-M3: session chat's skill ships", on.skills.some((entry) => entry.name === SESSION_CHAT_SKILL))
    check("R18-M3: and is gone while session chat is off", !off.skills.some((entry) => entry.name === SESSION_CHAT_SKILL))
  }
}
