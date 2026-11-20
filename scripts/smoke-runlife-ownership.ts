import "./fenced-home"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ServerEvent } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { SessionRunner } from "../src/server/session/runner"
import { SessionStore } from "../src/server/session/store"
import { Storage } from "../src/server/storage"

export function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { open, wait }
}

export async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runner")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function fixture(test: (setup: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-runlife-"))
  const originalFetch = globalThis.fetch
  try {
    await test(await setup(root))
  } finally {
    globalThis.fetch = originalFetch
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function setup(root: string) {
  const project = path.join(root, "project")
  await fs.mkdir(project)
  const storage = new Storage(path.join(root, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({
    customProviders: [{ id: "fake", name: "Fake", baseURL: "http://127.0.0.1:4333/v1", models: [{ id: "m", name: "M" }] }],
    directory: project,
  })
  await config.setApiKey("fake", "k")
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, new Permissions(bus, config), { accessToken: async () => undefined } as never, storage)
  const session = await store.create({ title: "Ownership", directory: project, model: { provider: "fake", model: "m" } })
  const events: ServerEvent[] = []
  bus.subscribe((event) => events.push(event))
  const calls: ReturnType<typeof gate>[] = []
  globalThis.fetch = async (_url, options) => {
    const call = gate()
    calls.push(call)
    await call.wait
    if (options?.signal?.aborted) throw options.signal.reason
    return new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } })
  }
  const internals = runner as unknown as {
    running: Map<string, AbortController>
    steering: Map<string, unknown>
    turnCompletions: Map<AbortController, Promise<void>>
  }
  const owner = () => {
    const controller = internals.running.get(session.id)
    assert.ok(controller)
    return controller
  }
  return {
    store, runner, session, events, calls, internals, owner,
    prompt: (text: string) => runner.prompt({ sessionID: session.id, text }),
    stop: () => runner.abort(session.id),
    completion: () => {
      const completion = internals.turnCompletions.get(owner())
      assert.ok(completion)
      return completion
    },
  }
}

export async function smoke(name: string, check: () => Promise<void>) {
  try {
    await check()
    console.log(`PASS ${name}`)
  } catch (error) {
    process.exitCode = 1
    console.error(`FAIL ${name}: ${(error as Error).message}`)
  }
}

const cases: { name: string; run: () => Promise<void> }[] = []
function register(name: string, run: () => Promise<void>): void { cases.push({ name, run }) }

{
  register("startup failure preserves the replacement controller", () => fixture(async (f) => {
    const requireSession = f.store.require.bind(f.store)
    const held = gate()
    f.store.require = async (id) => {
      await held.wait
      throw new Error("old setup failed")
    }
    const rejected = assert.rejects(f.prompt("old"), /old setup failed/)
    f.store.require = requireSession
    f.stop()
    await f.prompt("new")
    const owner = f.owner()
    const done = f.completion()
    await until(() => f.calls.length === 1)
    held.open()
    await rejected
    const stillOwned = f.internals.running.get(f.session.id) === owner
    f.calls[0].open()
    await done
    assert.ok(stillOwned, "old setup removed the replacement controller")
  }))

  register("stopped completion preserves replacement steering and emits no idle", () => fixture(async (f) => {
    await f.prompt("old")
    const oldDone = f.completion()
    await until(() => f.calls.length === 1)
    f.stop()
    await f.prompt("new")
    const newDone = f.completion()
    const steering = f.internals.steering.get(f.session.id)
    assert.ok(steering)
    await until(() => f.calls.length === 2)
    f.calls[0].open()
    await oldDone
    const stillOpen = f.internals.steering.get(f.session.id) === steering
    const prematureIdle = f.events.some((event) => event.type === "session.idle")
    f.calls[1].open()
    await newDone
    assert.deepEqual({ stillOpen, prematureIdle }, { stillOpen: true, prematureIdle: false })
  }))
}

export async function runlifeOwnershipChecks(check: (label: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  for (const { name, run } of cases) {
    try { await run(); check(name, true) } catch (err) { check(name, false, err instanceof Error ? err.message : String(err)) }
  }
}

/* Standalone entry: the battery drives `runlifeOwnershipChecks` instead, so the count is never left to an argv match.
 * The basename is compared exactly because the battery builds this file as `rounds-smoke-runlife-ownership.mjs`. */
const entry = process.argv[1]?.split("/").pop()
if (entry === "smoke-runlife-ownership.ts" || entry === "smoke-runlife-ownership.mjs") {
  void (async () => {
    for (const { name, run } of cases) await smoke(name, run)
  })()
}
