/**
 * Round 9: the MCP lifecycle, measured against MiMo's desktop and engine.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundNineMcpChecks` with its own check and section. Servers are the real
 * fixtures under scripts/fixtures, spoken to over their pipes or over HTTP,
 * so what is checked is what a conversation would get.
 */
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Storage } from "../src/server/storage"
import { parseJsonc, renderJsonc } from "../src/server/jsonc"
import { CodedError, paramsOf } from "../src/shared/errors"
import { McpServers, TOOLS_UNAVAILABLE, toolRule } from "../src/server/mcp"
import { mergeMcpSecrets } from "../src/server/mcp-save"
import { checkEntry, claudeServers, projectFiles, resolveServers, substituteEntry } from "../src/server/mcp-sources"
import type { AppConfig, McpServerConfig, Request } from "../src/shared/protocol"
import { startBackend } from "../src/server/index"
import { handle } from "../src/server/handlers"
import { Permissions } from "../src/server/permission"
import { DEFAULT_PERMISSIONS } from "../src/shared/protocol"
import { MCP_STATUS_TONE, mcpNeedsSignIn, mcpStatusLabel } from "../src/renderer/src/lib/mcp-status"

type Section = (name: string) => void

async function temporary(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** M-4: config.json is JSONC, saved key by key, and never written over once a hand edit broke it. */
async function jsoncConfig(check: Check, section: Section): Promise<void> {
  section("Round 9: config.json takes comments and keeps them (M-4)")
  const dir = await temporary("mcode-r9-jsonc-")
  try {
    const read = parseJsonc('{\n  // a note\n  "a": 1,\n  "b": [1, 2,],\n}\n')
    check("comments and trailing commas parse", JSON.stringify(read.value) === '{"a":1,"b":[1,2]}' && !read.problem, read)
    const broken = parseJsonc('{\n  "a": 1\n  "b": 2\n}')
    check("a broken file says where, counted from 1", broken.problem?.line === 3 && broken.problem.column === 3, broken.problem)
    check("a blank file is no document", parseJsonc("  \n").value === undefined && !parseJsonc("").problem)
    const edited = renderJsonc("config.json", '{\n  // keep me\n  "a": 1, /* and me */\n  "b": { "c": true },\n}\n', { a: 2, b: { c: true }, d: "new" })
    check(
      "a save edits only what changed and keeps the comments",
      edited.includes("// keep me") && edited.includes("/* and me */") && /"a": 2/.test(edited) && /"d": "new"/.test(edited) && JSON.stringify(parseJsonc(edited).value) === '{"a":2,"b":{"c":true},"d":"new"}',
      edited,
    )
    const dropped = renderJsonc("config.json", '{\n  "a": 1,\n  // about b\n  "b": 2\n}\n', { a: 1 })
    check("a key that went is taken out", JSON.stringify(parseJsonc(dropped).value) === '{"a":1}', dropped)

    const storage = new Storage(path.join(dir, "storage"))
    const file = storage.fileOf("config")
    await fs.mkdir(path.dirname(file), { recursive: true })
    const handWritten = '{\n  // my servers\n  "theme": "dark",\n  "mcpServers": {\n    "one": { "type": "local", "command": ["node"], }, // trailing comma\n  },\n}\n'
    await fs.writeFile(file, handWritten)
    const config = new Config(storage, new Bus(), path.join(dir, "credentials.json"))
    await config.load()
    check("a config file with comments loads rather than being set aside", !config.unreadable && config.get().theme === "dark" && Boolean(config.get().mcpServers.one), config.unreadable)
    await config.set({ theme: "light" })
    const after = await fs.readFile(file, "utf8")
    check("a setting saved from the window keeps the file's comments", after.includes("// my servers") && after.includes("// trailing comma") && /"theme": "light"/.test(after), after)

    const bad = after.replace('"theme": "light",', '"theme": "light"')
    await fs.writeFile(file, bad)
    const refused = await config.set({ theme: "dark" }).then(
      () => undefined,
      (error: unknown) => error,
    )
    const params = paramsOf(refused)
    check(
      "a save over a file a hand edit broke is refused, naming the line and column",
      refused instanceof CodedError && refused.code === "error.configUnparseable" && params?.file === "config.json" && typeof params.line === "number" && typeof params.column === "number",
      { refused: String(refused), params },
    )
    check("and the broken file is left exactly as it was", (await fs.readFile(file, "utf8")) === bad)
    check("and the setting in memory is not ahead of the file", config.get().theme === "light", config.get().theme)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const fixture = () => path.join(process.cwd(), "scripts/fixtures/mcp-lifecycle-server.cjs")

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

/** M-5, M-6, M-16: where a project's servers come from, and what an entry must be. */
async function serverSources(check: Check, section: Section): Promise<void> {
  section("Round 9: MCP entries from the app, the project and Claude Code (M-5, M-6, M-16)")
  const dir = await temporary("mcode-r9-sources-")
  try {
    const home = path.join(dir, "home")
    await write(path.join(dir, "cfg", "token.txt"), "  from-a-file \n")
    await write(path.join(home, "secret.txt"), "home-secret")
    process.env.MCODE_R9_PROBE_VAR = "from-env"
    const filled = (await substituteEntry(
      {
        type: "remote",
        url: "https://x.example/{env:MCODE_R9_PROBE_VAR}",
        headers: { a: "Bearer {file:token.txt}", b: "{file:~/secret.txt}", c: "[{env:MCODE_R9_UNSET_VAR}]" },
        command: ["{env:MCODE_R9_PROBE_VAR}"],
      },
      path.join(dir, "cfg"),
      home,
    )) as { url: string; headers: Record<string, string>; command: string[] }
    check("{env:NAME} is filled in, in the address and the command", filled.url === "https://x.example/from-env" && filled.command[0] === "from-env", filled)
    check("{file:path} is the file's trimmed text, counted from the config file's folder", filled.headers.a === "Bearer from-a-file", filled.headers.a)
    check("~/ in a file path is the home folder", filled.headers.b === "home-secret", filled.headers.b)
    check("an unset variable is empty", filled.headers.c === "[]", filled.headers.c)
    const missing = await substituteEntry({ url: "{file:nope.txt}" }, dir, home).then(
      () => "",
      (error: Error) => error.message,
    )
    check("a file that is not there makes the entry fail, naming it", missing.includes("{file:nope.txt}") && missing.includes("does not exist"), missing)

    check("an entry without a type is skipped", "skip" in checkEntry({ command: ["x"] }) && "skip" in checkEntry("text"))
    const stringCommand = checkEntry({ type: "local", command: "npx server" })
    check("a command written as one string is refused, not split", "invalid" in stringCommand, stringCommand)
    check("an unknown type is refused", "invalid" in checkEntry({ type: "sse", url: "https://x" }))
    check("a remote entry needs an address", "invalid" in checkEntry({ type: "remote" }))
    check("environment values must be strings", "invalid" in checkEntry({ type: "local", command: ["x"], environment: { A: 1 } }))
    check("a well-formed entry passes", "config" in checkEntry({ type: "local", command: ["node", "x.js"], environment: { A: "1" }, timeout: 5000 }))

    // A repository inside a folder that has a config of its own, which the walk must not reach.
    const outer = path.join(dir, "outer")
    const repo = path.join(outer, "repo")
    const sub = path.join(repo, "sub")
    await write(path.join(outer, "mcode.json"), '{"mcpServers":{"outside":{"type":"local","command":["x"]}}}')
    await fs.mkdir(path.join(repo, ".git"), { recursive: true })
    await write(path.join(repo, "mcode.json"), '{"mcpServers":{"shared":{"environment":{"FROM":"repo"}},"proj":{"type":"local","command":["node","{file:tool.js}"]}}}')
    await write(path.join(repo, "tool.js"), "repo-tool")
    await write(path.join(sub, "mcode.json"), '{"mcpServers":{"shared":{"environment":{"LEVEL":"sub-json"}}}}')
    await write(path.join(sub, "mcode.jsonc"), '{\n  // nearest wins\n  "mcpServers": {"shared": {"environment": {"LEVEL": "sub-jsonc"}},},\n}')
    await write(path.join(sub, ".mcode", "mcode.json"), '{"mcpServers":{"dotted":{"type":"local","command":["y"]}}}')
    await write(path.join(repo, ".mcode", "mcode.jsonc"), '{"mcpServers":{"typeless":{"command":["z"]},"broken":{"type":"local","command":"z --flag"}}}')
    await write(path.join(home, ".mcode", "mcode.json"), '{"mcpServers":{}}')
    const files = (await projectFiles(sub, home)).map((file) => path.relative(dir, file).replaceAll("\\", "/"))
    check(
      "project files are merged outermost first up to the repository root, then the .mcode folders, then the home one",
      JSON.stringify(files) ===
        JSON.stringify(["outer/repo/mcode.json", "outer/repo/sub/mcode.json", "outer/repo/sub/mcode.jsonc", "outer/repo/sub/.mcode/mcode.json", "outer/repo/.mcode/mcode.jsonc", "home/.mcode/mcode.json"]),
      files,
    )

    await write(
      path.join(home, ".claude.json"),
      JSON.stringify({
        // Shaped like a server but outside mcpServers: nothing but that key is taken.
        decoy: { command: "top-level-not-a-server" },
        mcpServers: {
          shared: { command: "claude-would-lose" },
          fromClaude: { command: "npx", args: ["-y", "pkg"], env: { K: "v" } },
          web: { type: "http", url: "https://mcp.example/mcp", headers: { A: "b" } },
          old: { type: "sse", url: "https://mcp.example/sse" },
          badArgs: { command: "x", args: "not-a-list" },
          later: { command: "home-version" },
        },
      }),
    )
    await write(path.join(sub, ".claude.json"), JSON.stringify({ mcpServers: { later: { command: "project-version", disabled: true } } }))
    const claude = await claudeServers(path.join(home, ".claude.json"))
    check(
      "Claude Code's servers are taken from mcpServers only, SSE and malformed ones skipped",
      JSON.stringify(Object.keys(claude)) === '["shared","fromClaude","web","later"]' &&
        JSON.stringify(claude.fromClaude) === '{"type":"local","command":["npx","-y","pkg"],"environment":{"K":"v"},"enabled":true}' &&
        claude.web?.type === "remote" && claude.web.headers?.A === "b",
      claude,
    )

    const resolved = await resolveServers({
      servers: {
        shared: { type: "local", command: ["node", "app.js"], environment: { FROM: "app" } },
        appOnly: { type: "remote", url: "https://{env:MCODE_R9_PROBE_VAR}.example/mcp" },
      },
      configFile: path.join(dir, "cfg", "config.json"),
      directory: sub,
      home,
    })
    const byName = Object.fromEntries(resolved.map((entry) => [entry.name, entry]))
    check(
      "the servers keep the order their first layer named them: the app's, the project's, then Claude Code's",
      JSON.stringify(resolved.map((entry) => entry.name)) === '["shared","appOnly","proj","dotted","broken","fromClaude","web","later"]',
      resolved.map((entry) => entry.name),
    )
    check(
      "a project layer is merged into the app's entry key by key, the nearest file winning",
      JSON.stringify(byName.shared?.config?.environment) === '{"FROM":"repo","LEVEL":"sub-jsonc"}' && byName.shared?.config?.command?.[1] === "app.js" && byName.shared.origin === "app",
      byName.shared,
    )
    check("{file:…} in a project file counts from that file's folder", byName.proj?.config?.command?.[1] === "repo-tool", byName.proj)
    check("the app's own entries are filled in too", byName.appOnly?.config?.url === "https://from-env.example/mcp", byName.appOnly)
    check("a Claude Code server never displaces one of MCode's", byName.shared?.config?.command?.[0] === "node")
    check("the project's .claude.json wins over the home one", byName.later?.config?.command?.[0] === "project-version" && byName.later.config.enabled === false, byName.later)
    check("an entry without a type is left out, a malformed one kept with its reason", !byName.typeless && Boolean(byName.broken?.invalid) && !byName.broken?.config, byName.broken)
    check("the walk stops at the repository root", !byName.outside)
    const alone = await resolveServers({ servers: { one: { type: "local", command: ["x"] } }, configFile: path.join(dir, "config.json"), home })
    check("without a project only the app's list is read", JSON.stringify(alone.map((entry) => entry.name)) === '["one"]')
  } finally {
    delete process.env.MCODE_R9_PROBE_VAR
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** A stand-in for the settings store: what McpServers reads, and the event a save sends. */
function stubConfig(bus: Bus, initial: { mcpServers: Record<string, McpServerConfig>; directory: string; mcpTimeout?: number }) {
  let value = { ...initial }
  return {
    get: () => value as unknown as AppConfig,
    set: async (patch: Partial<AppConfig>) => {
      value = { ...value, ...(patch as typeof value) }
      bus.publish({ type: "config.updated", config: value as unknown as AppConfig })
      return value as unknown as AppConfig
    },
  }
}

const toolContext = (directory: string, asked: unknown[] = []) =>
  ({
    sessionID: "ses_r9",
    messageID: "msg_r9",
    callID: `call_${Math.random().toString(36).slice(2)}`,
    directory,
    permissions: { ask: async (input: unknown) => void asked.push(input) },
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => {},
  }) as never

async function callTool(mcp: McpServers, directory: string, name: string, input: Record<string, unknown> = {}): Promise<string> {
  const tool = mcp.tools(directory).find((entry) => entry.name === name)
  if (!tool) return `NO TOOL ${name}`
  return tool.execute(input, toolContext(directory)).then(
    (result) => result.output,
    (error: Error) => `ERROR ${error.message}`,
  )
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** M-7: each project directory has its own servers, started in that directory. */
async function perProject(check: Check, section: Section): Promise<void> {
  section("Round 9: MCP servers per project directory (M-7)")
  const dir = await temporary("mcode-r9-projects-")
  const bus = new Bus()
  const first = path.join(dir, "first")
  const second = path.join(dir, "second")
  await fs.mkdir(path.join(first, ".git"), { recursive: true })
  await fs.mkdir(path.join(second, ".git"), { recursive: true })
  await write(path.join(second, "mcode.json"), JSON.stringify({ mcpServers: { extra: { type: "local", command: ["node", fixture(), "--tag", "second-only"] } } }))
  const config = stubConfig(bus, { mcpServers: { life: { type: "local", command: ["node", fixture()] } }, directory: first })
  const mcp = new McpServers(bus, config as never, undefined, path.join(dir, "home"))
  try {
    await mcp.start()
    await mcp.ready(second)
    const whereFirst = await callTool(mcp, first, "life_where")
    const whereSecond = await callTool(mcp, second, "life_where")
    check("a local server starts in its own project's folder", same(whereFirst, first) && same(whereSecond, second), { whereFirst, whereSecond })
    check("a project's own server is offered only there", (await callTool(mcp, second, "extra_tag")) === "second-only" && !mcp.tools(first).some((tool) => tool.name.startsWith("extra_")))
    check("the settings page reports on the directory new conversations start in", JSON.stringify(mcp.list().map((entry) => entry.name)) === '["life"]', mcp.list())
    const statuses: string[] = []
    const off = bus.subscribe((event) => {
      if (event.type === "mcp.status") statuses.push(event.servers.map((entry) => entry.name).join(","))
    })
    await mcp.ready(path.join(dir, "third"))
    off()
    check("a project's servers never show up in that report", statuses.every((names) => names === "life"), statuses)
  } finally {
    await mcp.close()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function until(test: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** M-1, M-2: a saved change reaches every conversation when the next one starts, never under a running turn. */
async function nextConversation(check: Check, section: Section): Promise<void> {
  section("Round 9: saved MCP changes apply from the next conversation (M-1, M-2)")
  const dir = await temporary("mcode-r9-next-")
  const bus = new Bus()
  const project = path.join(dir, "project")
  await fs.mkdir(project, { recursive: true })
  const pids = path.join(dir, "pids")
  await fs.mkdir(pids)
  const life = (tag: string): McpServerConfig => ({ type: "local", command: ["node", fixture(), "--tag", tag, "--pid-file", path.join(pids, `life-${tag}`)] })
  const config = stubConfig(bus, {
    mcpServers: {
      life: life("one"),
      broken: { type: "local", command: ["node", path.join(dir, "missing-server.cjs")] },
      gone: { type: "local", command: ["node", fixture(), "--tag", "gone"] },
    },
    directory: project,
  })
  const mcp = new McpServers(bus, config as never, undefined, path.join(dir, "home"))
  let busy = false
  mcp.useBusy(() => busy)
  const status = (name: string) => mcp.list().find((entry) => entry.name === name)?.status
  try {
    await mcp.start()
    check("to begin with, one server answers and a misspelled one has failed", (await callTool(mcp, project, "life_tag")) === "one" && status("broken") === "failed", mcp.list())

    const servers = () => (config.get() as unknown as { mcpServers: Record<string, McpServerConfig> }).mcpServers
    await config.set({ mcpServers: { ...servers(), life: life("two"), broken: { type: "local", command: ["node", fixture(), "--tag", "fixed"] } } })
    await config.set({ theme: "dark" } as Partial<AppConfig>)
    await new Promise((resolve) => setTimeout(resolve, 300))
    check("saving only writes the config: a running conversation keeps the servers it had", (await callTool(mcp, project, "life_tag")) === "one" && status("broken") === "failed")

    // A new conversation while a turn is running: noted, not applied.
    busy = true
    await mcp.commitIfDirty()
    await config.set({ mcpServers: Object.fromEntries(Object.entries(servers()).filter(([name]) => name !== "gone")) })
    await mcp.commitIfDirty()
    check("a new conversation while another turn runs changes nothing yet", (await callTool(mcp, project, "life_tag")) === "one")
    check("a server removed meanwhile still answers the running turn", (await callTool(mcp, project, "gone_tag")) === "gone")
    bus.publish({ type: "session.idle", sessionID: "still-busy" })
    await new Promise((resolve) => setTimeout(resolve, 300))
    check("one turn ending while another still runs changes nothing either", (await callTool(mcp, project, "life_tag")) === "one")

    busy = false
    bus.publish({ type: "session.idle", sessionID: "last" })
    const applied = await until(async () => (await callTool(mcp, project, "life_tag")) === "two")
    check("once the last turn ends, the edited command is what runs (M-1)", applied, await callTool(mcp, project, "life_tag"))
    check("the server whose command was fixed connects this time", await until(() => status("broken") === "connected"), mcp.list())
    check("and the removed one is gone", !mcp.tools(project).some((tool) => tool.name.startsWith("gone_")) && status("gone") === undefined, mcp.list())

    const pidBefore = await fs.readFile(path.join(pids, "life-two"), "utf8")
    await config.set({ theme: "light" } as Partial<AppConfig>)
    await mcp.commitIfDirty()
    await new Promise((resolve) => setTimeout(resolve, 300))
    check("a conversation after an unrelated setting changed reconnects nothing", (await fs.readFile(path.join(pids, "life-two"), "utf8")) === pidBefore && status("life") === "connected")

    // MiMo's page: a server added since the report was made is connected at once.
    await config.set({ mcpServers: { ...servers(), added: { type: "local", command: ["node", fixture(), "--tag", "added"] } } })
    check("a newly added server is not in the report until something asks", status("added") === undefined)
    await mcp.register("added")
    check("registering it from the settings page connects it now", status("added") === "connected" && (await callTool(mcp, project, "added_tag")) === "added", mcp.list())
    await mcp.register("added")
    check("registering a known server again starts nothing new", mcp.list().filter((entry) => entry.name === "added").length === 1)
    const unknown = await mcp.register("nobody").then(
      () => "",
      (error: Error) => error.message,
    )
    check("a name the config does not have is refused", unknown.includes("nobody"), unknown)
    await mcp.commitIfDirty()
    await new Promise((resolve) => setTimeout(resolve, 300))
    check("the next conversation keeps a registered server as it is", status("added") === "connected")
  } finally {
    await mcp.close()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  // The backend: a conversation created through the socket's request is the moment.
  const data = await temporary("mcode-r9-backend-")
  const home = path.join(data, "project")
  await write(path.join(data, "storage", "config.json"), JSON.stringify({ directory: home, mcpServers: { life: { type: "local", command: ["node", fixture(), "--tag", "before"] } } }))
  await fs.mkdir(home, { recursive: true })
  const backend = await startBackend(data)
  try {
    const { runtime } = backend
    await runtime.mcp.ready(home)
    await runtime.config.set({ mcpServers: { life: { type: "local", command: ["node", fixture(), "--tag", "after"] } } })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const before = await callTool(runtime.mcp, home, "life_tag")
    await handle(runtime, { type: "session.create" } as Request)
    const after = await until(async () => (await callTool(runtime.mcp, home, "life_tag")) === "after")
    check("in the app, creating a conversation is what applies a saved change", before === "before" && after, { before })
  } finally {
    await backend.close()
    await fs.rm(data, { recursive: true, force: true }).catch(() => {})
  }
}

/** M-3: an MCP call asks nothing by default, at the default level and at 帮我审批. */
async function noApprovalByDefault(check: Check, section: Section): Promise<void> {
  section("Round 9: MCP tool calls ask no approval by default (M-3)")
  const dir = await temporary("mcode-r9-approve-")
  try {
    const open = async (name: string, stored?: Record<string, unknown>) => {
      const storage = new Storage(path.join(dir, name))
      if (stored) await write(storage.fileOf("config"), JSON.stringify(stored))
      const bus = new Bus()
      const config = new Config(storage, bus, path.join(dir, name, "credentials.json"))
      await config.load()
      const questions: unknown[] = []
      bus.subscribe((event) => {
        if (event.type === "permission.requested") questions.push(event.request)
      })
      return { config, permissions: new Permissions(bus, config), questions }
    }
    const call = (gate: Permissions, sessionID = "ses_m3") =>
      Promise.race([
        gate.ask({ sessionID, messageID: "m", callID: `c${Math.random()}`, kind: "mcp", title: "files: read", subject: "{}", scope: "mcp:files" }).then(() => "ran"),
        new Promise<string>((resolve) => setTimeout(() => resolve("asked"), 400)),
      ])
    check("the MCP bucket's default is allow", DEFAULT_PERMISSIONS.mcp === "allow")
    const fresh = await open("fresh")
    check("on a first install (帮我审批) a call runs without a question", fresh.config.get().accessLevel === "auto" && (await call(fresh.permissions)) === "ran" && !fresh.questions.length)
    const plain = await open("plain", { permissions: { mcp: "ask", bash: "ask" }, accessLevel: "ask" })
    check("a stored config written with the old default is moved to allow once", plain.config.get().permissions.mcp === "allow" && plain.config.get().permissions.bash === "ask", plain.config.get().permissions)
    check("so at the ask-first level a call runs without a question too", (await call(plain.permissions)) === "ran" && !plain.questions.length)
    await plain.config.set({ permissions: { ...plain.config.get().permissions, mcp: "ask" } })
    const reopened = await open("plain")
    check("choosing ask again afterwards sticks", reopened.config.get().permissions.mcp === "ask", reopened.config.get().permissions)
    check("and then a call asks", (await call(reopened.permissions)) === "asked" && reopened.questions.length === 1)
    reopened.permissions.rejectAll("ses_m3")
    const refused = await open("refused", { permissions: { mcp: "deny" } })
    check("a refusal is never turned into allow", refused.config.get().permissions.mcp === "deny")
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** M-8: the 工具 button's own connection. */
async function toolsProbe(check: Check, section: Section): Promise<void> {
  section("Round 9: the tools list asks the server itself (M-8)")
  const dir = await temporary("mcode-r9-probe-")
  const seen: { path: string; key?: string; body: any }[] = []
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {}
      seen.push({ path: request.url ?? "", key: request.headers["x-key"] as string | undefined, body })
      const url = request.url ?? ""
      if (url.startsWith("/locked")) {
        response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' })
        return response.end()
      }
      if (url.startsWith("/legacy")) {
        response.writeHead(405)
        return response.end()
      }
      if (body.id === undefined) {
        response.writeHead(202)
        return response.end()
      }
      if (body.method === "initialize") {
        if (url.startsWith("/refuses")) {
          response.writeHead(200, { "content-type": "application/json" })
          return response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "not today" } }))
        }
        response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "probe-session" })
        return response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {} } })}\n\n`)
      }
      const cursor = body.params?.cursor
      const result = cursor ? { tools: [{ name: "second", description: "page two" }] } : { tools: [{ name: "first" }], nextCursor: "p2" }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as { port: number }).port
  const bus = new Bus()
  process.env.MCODE_R9_PROBE_KEY = "from-env"
  const config = stubConfig(bus, {
    mcpServers: {
      off: { type: "local", command: ["node", fixture(), "--pages", "5"], enabled: false },
      crashes: { type: "local", command: ["node", fixture(), "--fail", "3"] },
      silent: { type: "local", command: ["node", "-e", "setInterval(() => {}, 1000)"] },
      web: { type: "remote", url: `http://127.0.0.1:${port}/mcp`, headers: { "x-key": "{env:MCODE_R9_PROBE_KEY}" }, enabled: false },
      locked: { type: "remote", url: `http://127.0.0.1:${port}/locked` },
      legacy: { type: "remote", url: `http://127.0.0.1:${port}/legacy` },
      refuses: { type: "remote", url: `http://127.0.0.1:${port}/refuses` },
      bad: { type: "local", command: "node server.js" } as unknown as McpServerConfig,
    },
    directory: dir,
  })
  const mcp = new McpServers(bus, config as never, undefined, path.join(dir, "home"))
  try {
    const off = await mcp.probe("off")
    check(
      "a switched-off local server still lists its tools, every page of them",
      "tools" in off && off.tools.map((tool) => tool.name).join() === "where,argv,env,tag,slow,die" && off.tools[0].description === "lifecycle where",
      off,
    )
    const crashes = await mcp.probe("crashes")
    check("a server that exits says so with its code", "error" in crashes && crashes.error.includes("exited (code 3)"), crashes)
    const started = Date.now()
    const silent = await mcp.probe("silent", 600)
    check("a server that never answers is given up on after the timeout", "error" in silent && silent.error === "no answer within 1s" && Date.now() - started < 3000, silent)
    const web = await mcp.probe("web")
    check(
      "a remote server is asked directly, its pages followed, with the configured header filled in",
      "tools" in web && web.tools.map((tool) => tool.name).join() === "first,second" && seen.filter((entry) => entry.path === "/mcp").every((entry) => entry.key === "from-env"),
      { web, seen: seen.map((entry) => [entry.path, entry.key, entry.body.method]) },
    )
    const locked = await mcp.probe("locked")
    check(
      "a server that wants a sign-in is reported, with no sign-in attempted",
      "error" in locked && locked.error === "initialize HTTP 401" && !seen.some((entry) => entry.path.includes("well-known")),
      locked,
    )
    const legacy = await mcp.probe("legacy")
    check("no older transport is tried; the answer says it may be one", "error" in legacy && legacy.error.startsWith("initialize HTTP 405") && seen.filter((entry) => entry.path === "/legacy").length === 1, legacy)
    const refuses = await mcp.probe("refuses")
    check("a refused handshake is quoted", "error" in refuses && refuses.error === "initialize: not today", refuses)
    const bad = await mcp.probe("bad")
    check("a malformed entry says what is wrong with it", "error" in bad && bad.error.includes("invalid config"), bad)
    const missing = await mcp.probe("nobody")
    check("an unknown name is an error, not a crash", "error" in missing)
    check("probing connects nothing for conversations", mcp.list().length === 0 && mcp.tools(dir).length === 0)
  } finally {
    delete process.env.MCODE_R9_PROBE_KEY
    await mcp.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** M-9: a server that wants a sign-in but cannot register a client has a state of its own. */
async function clientRegistration(check: Check, section: Section): Promise<void> {
  section("Round 9: a server that cannot register a client (M-9)")
  const dir = await temporary("mcode-r9-register-")
  const paths: string[] = []
  const server = createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      const url = request.url ?? ""
      paths.push(`${request.method} ${url}`)
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const open = url.includes("/open")
      const json = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(value))
      }
      if (url.includes("oauth-protected-resource")) return json({ resource: `${origin}${open ? "/open" : "/closed"}/mcp`, authorization_servers: [`${origin}${open ? "/open" : "/closed"}`] })
      if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) {
        const base = url.includes("/open") ? `${origin}/open` : `${origin}/closed`
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          ...(url.includes("/open") ? { registration_endpoint: `${base}/register` } : {}),
        })
      }
      if (url.endsWith("/register")) return json({ client_id: "probe-client", redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"] })
      const scope = url.startsWith("/open") ? "/open" : "/closed"
      response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${scope}/mcp"` })
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as { port: number }).port
  const bus = new Bus()
  const config = stubConfig(bus, {
    mcpServers: {
      closed: { type: "remote", url: `http://127.0.0.1:${port}/closed/mcp` },
      open: { type: "remote", url: `http://127.0.0.1:${port}/open/mcp` },
    },
    directory: dir,
  })
  const storage = new Storage(path.join(dir, "storage"))
  const mcp = new McpServers(bus, config as never, storage, path.join(dir, "home"))
  try {
    await mcp.start()
    const closed = mcp.list().find((entry) => entry.name === "closed")
    const open = mcp.list().find((entry) => entry.name === "open")
    check(
      "a server whose authorization server will not register a client waits for a client id, and says so",
      closed?.status === "needs_client_registration" && Boolean(closed.error?.includes("oauth.clientId")),
      closed,
    )
    check("one that can register waits for a sign-in, with nothing to explain", open?.status === "needs_auth" && !open.error, open)
    check("neither was tried a second way", !paths.some((entry) => entry.startsWith("GET /closed/mcp")), paths)
  } finally {
    await mcp.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  check("the page shows both as waiting for authorization, with 授权", mcpStatusLabel("needs_client_registration") === "needs_auth" && mcpNeedsSignIn("needs_client_registration") && MCP_STATUS_TONE.needs_client_registration === "warn")
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** M-11: a local server is stopped gently first. */
async function gracefulStop(check: Check, section: Section): Promise<void> {
  section("Round 9: stopping a local server (M-11)")
  const dir = await temporary("mcode-r9-stop-")
  const one = async (name: string, args: string[]) => {
    const bus = new Bus()
    const config = stubConfig(bus, { mcpServers: { [name]: { type: "local", command: ["node", fixture(), ...args] } }, directory: dir })
    const mcp = new McpServers(bus, config as never, undefined, path.join(dir, "home"))
    await mcp.start()
    const connected = mcp.list()[0]?.status === "connected"
    const started = Date.now()
    await mcp.close()
    return { connected, ms: Date.now() - started }
  }
  try {
    const gentle = await one("gentle", ["--linger", "--end-file", path.join(dir, "gentle-ended"), "--pid-file", path.join(dir, "gentle-pid")])
    const gentlePid = Number(await fs.readFile(path.join(dir, "gentle-pid"), "utf8"))
    check(
      "its input is closed first, and a server that then exits by itself is left to",
      gentle.connected && (await fs.readFile(path.join(dir, "gentle-ended"), "utf8").catch(() => "")) === "input closed" && gentle.ms >= 250 && gentle.ms < 1500 && !alive(gentlePid),
      gentle,
    )
    const stubborn = await one("stubborn", ["--stubborn", "--pid-file", path.join(dir, "stubborn-pid")])
    const stubbornPid = Number(await fs.readFile(path.join(dir, "stubborn-pid"), "utf8"))
    const gone = await until(() => !alive(stubbornPid), 3000)
    check("one that ignores it is given two seconds, then terminated", stubborn.connected && stubborn.ms >= 1900 && stubborn.ms < 6000 && gone, stubborn)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** M-12, M-13: how a failing local server is reported, and when. */
async function failureReports(check: Check, section: Section): Promise<void> {
  section("Round 9: a failing local server explains itself (M-12, M-13)")
  const dir = await temporary("mcode-r9-fail-")
  const bus = new Bus()
  const events: { name: string; status: string; error?: string }[][] = []
  bus.subscribe((event) => {
    if (event.type === "mcp.status") events.push(event.servers.map((entry) => ({ name: entry.name, status: entry.status, error: entry.error })))
  })
  const config = stubConfig(bus, {
    mcpServers: {
      exits: { type: "local", command: ["node", fixture(), "--fail", "3", "--api-key", "sk-r9secretvalue123456"] },
      noisy: { type: "local", command: ["node", fixture(), "--fail", "4", "--noise", "10000"] },
      toolless: { type: "local", command: ["node", fixture(), "--no-tools"] },
      dies: { type: "local", command: ["node", fixture()] },
    },
    directory: dir,
  })
  const mcp = new McpServers(bus, config as never, undefined, path.join(dir, "home"))
  const logged: string[] = []
  const original = { info: console.info, error: console.error }
  const capture =
    (level: "info" | "error") =>
    (...args: unknown[]) => {
      logged.push(`${level} ${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}`)
    }
  console.info = capture("info")
  console.error = capture("error")
  try {
    await mcp.start()
    const state = (name: string) => mcp.list().find((entry) => entry.name === name)
    const exits = state("exits")
    check(
      "a server that exits at start says why, how it ended and what it printed, joined by semicolons",
      exits?.status === "failed" && exits.error === "the server exited; exit code 3; lifecycle fixture: refusing to start on purpose",
      exits,
    )
    const noisy = state("noisy")?.error ?? ""
    const tail = noisy.split("; ").at(-1) ?? ""
    check("only the last 4096 characters of what it printed are kept", tail.length <= 4096 && tail.length > 4000 && tail.endsWith("refusing to start on purpose"), tail.length)
    check("what a server prints goes to the log, line by line", logged.some((line) => line.startsWith("info [mcp] exits stderr: lifecycle fixture: refusing to start on purpose")), logged.slice(0, 5))
    const startLog = logged.find((line) => line.startsWith("error [mcp] exits: local server failed to start")) ?? ""
    check("a failed start is logged with its exit code and the command masked", startLog.includes('"exitCode":3') && !startLog.includes("sk-r9secretvalue123456") && startLog.includes("--api-key"), startLog)
    const toolless = state("toolless")
    check("a server that shakes hands but will not list its tools fails with one plain sentence", toolless?.status === "failed" && toolless.error === TOOLS_UNAVAILABLE, toolless)
    check("and the real reason is in the log", logged.some((line) => line.includes("[mcp] toolless: tool list failed") && line.includes("tool list unavailable on purpose")))

    check("a healthy server is connected before it is told to die", state("dies")?.status === "connected")
    const before = events.length
    await callTool(mcp, dir, "dies_die")
    const reported = await until(() => events.slice(before).some((list) => list.some((entry) => entry.name === "dies" && entry.status === "failed")), 5000)
    check("a server that dies while in use is reported at once, with its exit code (M-12)", reported && Boolean(state("dies")?.error?.includes("exit code 5")), { reported, dies: state("dies") })
    check("and its tools are withdrawn", !mcp.tools(dir).some((tool) => tool.name.startsWith("dies_")))
  } finally {
    console.info = original.info
    console.error = original.error
    await mcp.close()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** M-14: an app-wide call timeout, and per-tool rules in a server's entry. */
async function timeoutsAndToolRules(check: Check, section: Section): Promise<void> {
  section("Round 9: the app-wide MCP call timeout and per-tool rules (M-14)")
  const rules = { "*": "ask", tag: true, "sl*": false, env: "deny" } as const
  check(
    "the last matching rule wins, true and false meaning allow and deny",
    toolRule(rules, "tag") === "allow" && toolRule(rules, "slow") === "deny" && toolRule(rules, "where") === "ask" && toolRule(rules, "env") === "deny" && toolRule(undefined, "tag") === undefined,
  )
  check("a malformed rule makes the entry invalid", "invalid" in checkEntry({ type: "local", command: ["x"], tools: { a: "sometimes" } }))
  const kept = mergeMcpSecrets({ type: "remote", url: "https://x", tools: { a: false }, oauth: { clientId: "id" } }, { type: "remote", url: "https://y" })
  check("saving from the form keeps hand-written tool rules and sign-in settings", kept.tools?.a === false && kept.oauth !== false && kept.oauth?.clientId === "id", kept)

  const dir = await temporary("mcode-r9-rules-")
  const bus = new Bus()
  const config = stubConfig(bus, {
    mcpServers: {
      ruled: { type: "local", command: ["node", fixture()], tools: rules },
      plain: { type: "local", command: ["node", fixture()] },
      patient: { type: "local", command: ["node", fixture()], timeout: 5000 },
    },
    directory: dir,
    mcpTimeout: 400,
  })
  const mcp = new McpServers(bus, config as never, undefined, path.join(dir, "home"))
  const questions: { kind: string; title: string }[] = []
  const permissionConfig = { get: () => ({ permissions: { ...DEFAULT_PERMISSIONS }, accessLevel: "ask", allowFullAccess: false }) }
  const gate = new Permissions(bus, permissionConfig as never)
  const asking = new Permissions(bus, { get: () => ({ permissions: { ...DEFAULT_PERMISSIONS, mcp: "ask" }, accessLevel: "ask" }) } as never)
  bus.subscribe((event) => {
    if (event.type === "permission.requested") {
      questions.push({ kind: event.request.kind, title: event.request.title })
      // Whichever gate raised it answers; the other does not know the id.
      gate.respond(event.request.id, "once")
      asking.respond(event.request.id, "once")
    }
  })
  const run = (name: string, permissions: Permissions = gate) => {
    const tool = mcp.tools(dir).find((entry) => entry.name === name)
    if (!tool) return Promise.resolve(`NO TOOL ${name}`)
    const context = { ...(toolContext(dir) as object), permissions } as never
    return tool.execute({}, context).then(
      (result) => result.output,
      (error: Error) => `ERROR ${error.message}`,
    )
  }
  try {
    await mcp.start()
    const names = mcp.tools(dir).map((tool) => tool.name)
    check("a tool its rules deny is not offered to the model", !names.includes("ruled_slow") && !names.includes("ruled_env") && names.includes("ruled_where") && names.includes("plain_slow"), names)
    await run("plain_tag")
    check("with no rule, a call runs without a question, MCP calls being allowed", questions.length === 0, questions)
    await run("plain_tag", asking)
    check("with MCP calls set to ask, a call asks", questions.length === 1, questions)
    await run("ruled_tag", asking)
    check("but a tool its rules allow runs without a question even then", questions.length === 1, questions)
    questions.length = 0
    const asked = await run("ruled_where")
    check("a tool its rules ask about asks, although MCP calls are allowed", questions.length === 1 && questions[0].title === "ruled: where" && same(asked, dir), { questions, asked })
    const refusing = new Permissions(bus, { get: () => ({ permissions: { ...DEFAULT_PERMISSIONS, mcp: "deny" }, accessLevel: "ask" }) } as never)
    const refused = await run("ruled_tag", refusing)
    check("an allowing rule does not get past MCP calls being refused", refused.startsWith("ERROR Refused"), refused)

    const started = Date.now()
    const timedOut = await run("plain_slow")
    check("a server with no timeout of its own gets the app-wide one", timedOut === "ERROR tools/call timed out" && Date.now() - started < 1500, { timedOut, ms: Date.now() - started })
    const patient = await run("patient_slow")
    check("a server's own timeout wins over it", patient === "(no output)" || patient === "", patient)
  } finally {
    await mcp.close()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function roundNineMcpChecks(check: Check, section: Section): Promise<void> {
  // Never the reader's own ~/.claude.json or ~/.mcode: the backend reads servers from both.
  process.env.MCODE_IMPORT_HOME ??= await temporary("mcode-r9-home-")
  // A part that throws is a failed check, not a crash that hides every part after it.
  const parts: [string, (check: Check, section: Section) => Promise<void>][] = [
    ["M-4", jsoncConfig],
    ["M-5/M-6/M-16", serverSources],
    ["M-7", perProject],
    ["M-1/M-2", nextConversation],
    ["M-3", noApprovalByDefault],
    ["M-8", toolsProbe],
    ["M-9", clientRegistration],
    ["M-11", gracefulStop],
    ["M-12/M-13", failureReports],
    ["M-14", timeoutsAndToolRules],
  ]
  for (const [name, part] of parts) {
    await part(check, section).catch((error: unknown) => check(`round 9 ${name} ran to its end`, false, String(error)))
  }
}
