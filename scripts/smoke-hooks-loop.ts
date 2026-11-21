/**
 * Hooks inside a real turn.
 *
 * smoke-hooks-engine.ts proves the engine spawns a process, reads its pipes and
 * obeys exit codes when it is called directly. What it cannot show is the one
 * thing a person actually depends on: that the runner reaches for the hooks at
 * all - before the tool acts, after it speaks, on the machine where the task is
 * running. A wiring mistake there is invisible to every other check, so this
 * file drives a whole turn (fake model on 127.0.0.1, the real BashTool, hooks
 * read from a real `.mcode/hooks.json`) and reads back both the transcript and
 * the next request the model was sent.
 */
import "./fenced-home"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer, type Server } from "node:http"
import type { Message, ToolPart } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { Config, levelMap } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"

type Check = (label: string, ok: boolean, detail?: unknown) => void
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A check is only green when every expect below held; a case that gives up must throw. */
function expect(ok: unknown, seen?: unknown): asserts ok {
  if (!ok) throw new Error(typeof seen === "string" ? seen.slice(0, 300) : JSON.stringify(seen)?.slice(0, 300) ?? "unmet")
}

/** What the fake model should do when it is asked: one tool call, then stop. */
interface Order {
  name: string
  input: Record<string, unknown>
}

interface Rig {
  root: string
  directory: string
  store: SessionStore
  runner: SessionRunner
  bodies: string[]
  turn: (marker: string, order: Order, directory?: string) => Promise<{ parts: ToolPart[]; seen: string[] }>
  close: () => Promise<void>
}

const ORDERS = new Map<string, Order>()

async function rig(globalHooks?: unknown): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-hooks-loop-"))
  const directory = path.join(root, "project")
  await fs.mkdir(directory, { recursive: true })

  const bodies: string[] = []
  let call = 0
  const provider: Server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      bodies.push(body)
      const asked = JSON.parse(body || "{}") as { messages?: { role: string; content?: unknown }[] }
      const last = asked.messages?.at(-1)
      response.writeHead(200, { "content-type": "text/event-stream" })
      // Only a fresh ask gets a tool call; the request that carries the tool's
      // answer is the one the checks read, so it must end the turn quietly.
      // The ask is not plain text (the runner wraps it), so the marker is found
      // the way the round-10 rig does: anywhere inside the serialised content.
      const askedText = JSON.stringify(last?.content ?? "")
      const marker = last?.role === "user" ? [...ORDERS.keys()].find((key) => askedText.includes(key)) : undefined
      const order = marker ? ORDERS.get(marker) : undefined
      if (order) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_hl_${++call}`, type: "function", function: { name: order.name, arguments: JSON.stringify(order.input) } }] } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      } else {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      }
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port

  const storage = new Storage(path.join(root, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  // Full access, spelled the way the app spells it: `defaultAccess` reads the
  // bucket map, not the chip, so every bucket has to be allowed or a hook waits
  // forever on a question no window is there to answer.
  await config.set({
    customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }],
    directory,
    accessLevel: "full",
    allowFullAccess: true,
    permissions: levelMap("full"),
    hooks: globalHooks ?? {},
  })
  await config.setApiKey("fake", "k")

  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, new Permissions(bus, config), { accessToken: async () => undefined } as never, storage)

  const idle = async (sessionID: string) => {
    const deadline = Date.now() + 30_000
    while (runner.busySessions().includes(sessionID)) {
      if (Date.now() >= deadline) throw new Error(`turn for ${sessionID} never went idle`)
      await wait(25)
    }
  }

  return {
    root,
    directory,
    store,
    runner,
    bodies,
    async turn(marker, order, at) {
      ORDERS.set(marker, order)
      const before = bodies.length
      const session = await store.create({ title: marker, directory: at ?? directory, model: { provider: "fake", model: "m" } })
      await runner.prompt({ sessionID: session.id, text: marker })
      await wait(50)
      await idle(session.id)
      const messages = (await store.messages(session.id)) as Message[]
      const parts = messages.flatMap((message) =>
        message.role === "assistant" ? (message.parts as unknown as ToolPart[]).filter((part) => part.type === "tool") : [],
      )
      return { parts, seen: bodies.slice(before) }
    },
    close: async () => {
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** A project's own hooks, which is where a hook normally comes from. */
async function projectHooks(directory: string, hooks: unknown): Promise<void> {
  const dir = path.join(directory, ".mcode")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "hooks.json"), JSON.stringify({ hooks }), "utf8")
}

const bash = (command: string): Order => ({ name: "bash", input: { command, description: "Run a word" } })

/*
 * Hook commands run through cmd.exe on Windows (`/d /s /c`) and /bin/sh everywhere else, so a
 * battery written in POSIX verbs tests nothing on the Windows release. `echo x > "file"` and `&&`
 * mean the same thing in both, and a delay is the one verb that has no portable spelling
 * (`sleep N` versus `ping -n N`), so only that is branched.
 */
const markCommand = (file: string): string => `echo m > "${file}"`
const hangCommand = (seconds: number): string => (process.platform === "win32" ? `ping -n ${seconds + 1} 127.0.0.1` : `sleep ${seconds}`)
const toolError = (part: ToolPart | undefined): string =>
  JSON.stringify({ status: part?.status, error: (part as { error?: unknown } | undefined)?.error, inputError: (part?.input as { error?: unknown } | undefined)?.error, output: String(part?.output ?? "").slice(0, 200) })

const cases: { name: string; run: () => Promise<void> }[] = []
function register(name: string, run: () => Promise<void>): void {
  cases.push({ name, run })
}

register("a project hook runs before the tool and is told which tool is coming", async () => {
  const r = await rig()
  try {
    const env = path.join(r.root, "env.txt")
    const payload = path.join(r.root, "payload.json")
    await projectHooks(r.directory, { PreToolUse: [{ matcher: "*", command: `printf '%s %s' "$MCODE_HOOK_EVENT" "$MCODE_HOOK_TOOL" > "${env}"; cat > "${payload}"` }] })
    const { parts, seen } = await r.turn("HOOKENV", bash("echo hookside-ok"))
    expect(parts[0]?.output?.includes("hookside-ok"), { status: parts[0]?.status, out: String(parts[0]?.output).slice(0, 200) })
    expect(await fs.readFile(env, "utf8").catch(() => ""), "the hook never ran: no env file")
    expect(await fs.readFile(env, "utf8") === "PreToolUse bash")
    const sent = await fs.readFile(payload, "utf8")
    expect(sent.includes('"tool":"bash"') && sent.includes("echo hookside-ok"), sent.slice(0, 200))
    expect(seen.length >= 2, { requests: seen.length })
  } finally {
    await r.close()
  }
})

register("a hook that refuses the call keeps the tool from acting and the model is told why", async () => {
  const r = await rig()
  try {
    const sideEffect = path.join(r.root, "must-not-exist")
    await projectHooks(r.directory, { PreToolUse: [{ matcher: "*", command: `printf 'no bash on this project\\nsecond line the model never needs' >&2; exit 2` }] })
    const { parts, seen } = await r.turn("HOOKBLOCK", bash(`${markCommand(sideEffect)} && echo should-not-run`))
    expect(!(await fs.stat(sideEffect).then(() => true, () => false)), "the blocked command still ran")
    expect(!String(parts[0]?.output ?? "").includes("should-not-run"), parts[0]?.output)
    const told = toolError(parts[0])
    expect(told.includes("no bash on this project"), told.slice(0, 200))
    expect(!told.includes("second line the model never needs"), told.slice(0, 200))
    // The refusal has to reach the model, or it keeps believing the call worked.
    expect(seen.slice(1).some((body) => body.includes("no bash on this project")), { requests: seen.length })
  } finally {
    await r.close()
  }
})

register("a hook that speaks after the tool is heard by the model as a note", async () => {
  const r = await rig()
  try {
    await projectHooks(r.directory, { PostToolUse: [{ matcher: "*", command: `printf 'note-from-hook'` }] })
    const { parts, seen } = await r.turn("HOOKNOTE", bash("echo tool-spoke"))
    const output = String(parts[0]?.output ?? "")
    expect(output.includes("tool-spoke"), output.slice(0, 200))
    expect(output.includes("hook: note-from-hook"), output.slice(0, 200))
    expect(seen.slice(1).some((body) => body.includes("hook: note-from-hook")), { requests: seen.length })
  } finally {
    await r.close()
  }
})

register("a hook that never returns is put down at its timeout and the task carries on", async () => {
  const r = await rig()
  try {
    /*
     * Speed alone cannot tell a timeout from a hook that never ran, so the hook leaves evidence it
     * started before hanging. Without the marker file this case passes on any build where hooks do
     * not run at all, which is the worst kind of green.
     */
    const begun = path.join(r.root, "hook-begun")
    await projectHooks(r.directory, { PreToolUse: [{ matcher: "*", command: `${markCommand(begun)} && ${hangCommand(120)}`, timeoutMs: 400 }] })
    const started = Date.now()
    const { parts } = await r.turn("HOOKHANG", bash("echo carried-on"))
    const elapsed = Date.now() - started
    expect(parts[0]?.output?.includes("carried-on"), { elapsed, out: String(parts[0]?.output).slice(0, 200) })
    const began = await fs.stat(begun).then(() => true, () => false)
    expect(began, "the hook never started, so a quick turn proves nothing about timeouts")
    // The hook sleeps for two minutes; only the timeout can explain a quick turn.
    expect(elapsed < 20_000, { elapsed })
  } finally {
    await r.close()
  }
})

register("a turn whose hook was never addressed to it is not counted as a timeout", async () => {
  // The control group for the case above: same shape, same speed, but the hook is written for a
  // tool this turn never calls. It must show no start marker - the evidence the timeout case needs.
  const r = await rig()
  try {
    const begun = path.join(r.root, "never-begun")
    await projectHooks(r.directory, { PreToolUse: [{ matcher: "Write", command: `${markCommand(begun)} && ${hangCommand(120)}`, timeoutMs: 400 }] })
    const started = Date.now()
    await r.turn("HOOKNOTEV", bash("echo quick"))
    const elapsed = Date.now() - started
    const began = await fs.stat(begun).then(() => true, () => false)
    expect(!began, { elapsed, began })
  } finally {
    await r.close()
  }
})

register("the standalone guard fires for real file names on either path style", async () => {
  expect(runsAsStandalone("C:\\Users\\Wyatt\\MCode\\scripts\\smoke-hooks-loop.mjs"), "a native Windows path ran no battery and exited 0")
  expect(runsAsStandalone("/Users/wyatt/MCode/scripts/smoke-hooks-loop.mjs"), "a POSIX path should run the battery")
  expect(!runsAsStandalone("/Users/wyatt/MCode/out/rounds-smoke-hooks-loop.mjs"), "the battery's own bundle must not run this file twice")
})

register("a hook written for one project does not run in another", async () => {
  const r = await rig()
  try {
    const marker = path.join(r.root, "wrong-project-ran")
    await projectHooks(r.directory, { PreToolUse: [{ matcher: "*", command: markCommand(marker) }] })
    const elsewhere = path.join(r.root, "other-project")
    await fs.mkdir(elsewhere, { recursive: true })
    const { parts } = await r.turn("HOOKSCOPE", bash("echo scoped"), elsewhere)
    expect(parts[0]?.output?.includes("scoped"), String(parts[0]?.output).slice(0, 200))
    expect(!(await fs.stat(marker).then(() => true, () => false)), "another project's hook ran here")
  } finally {
    await r.close()
  }
})

register("a global hook reaches a turn in a project that has none of its own", async () => {
  const probe = path.join(os.tmpdir(), `mcode-hooks-loop-global-${process.pid}.txt`)
  await fs.rm(probe, { force: true })
  const r = await rig({ PreToolUse: [{ matcher: "*", command: `printf ran > "${probe}"` }] })
  try {
    const { parts } = await r.turn("HOOKGLOBAL", bash("echo global-reached"))
    expect(parts[0]?.output?.includes("global-reached"), String(parts[0]?.output).slice(0, 200))
    expect(await fs.readFile(probe, "utf8").then((text) => text === "ran", () => false), "the global hook never ran")
  } finally {
    await fs.rm(probe, { force: true })
    await r.close()
  }
})

export async function hooksLoopChecks(check: Check): Promise<void> {
  for (const { name, run } of cases) {
    try {
      await run()
      check(name, true)
    } catch (error) {
      check(name, false, error instanceof Error ? `${error.message}` : String(error))
    }
  }
}

/* Standalone entry: the battery drives `hooksLoopChecks` instead, so the count is never left to an argv match.
 * The basename is compared exactly because the battery builds this file as `rounds-smoke-hooks-loop.mjs`. */
export function runsAsStandalone(argvPath: string | undefined): boolean {
  // Both separators: a native Windows path splits into nothing on "/" alone, which left the file
  // running no battery and exiting 0 - a pass that tested nothing.
  const entry = argvPath?.split(/[\\/]/).pop()
  return entry === "smoke-hooks-loop.ts" || entry === "smoke-hooks-loop.mjs"
}

if (runsAsStandalone(process.argv[1])) {
  void (async () => {
    let failed = 0
    await hooksLoopChecks((label, ok, detail) => {
      if (ok) console.log(`PASS ${label}`)
      else {
        failed++
        console.error(`FAIL ${label}${detail === undefined ? "" : ` -> ${String(JSON.stringify(detail)).slice(0, 300)}`}`)
      }
    })
    process.exit(failed ? 1 : 0)
  })()
}
