import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UserMessage } from "../src/shared/protocol"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { runningDelivery } from "../src/renderer/src/lib/composer-delivery"
import type { Check } from "./smoke-round5"

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

async function harness(root: string, held: ReturnType<typeof gate>) {
  const bodies: string[] = []
  globalThis.fetch = async (_url, options) => {
    bodies.push(String(options?.body))
    if (bodies.length === 1) {
      const signal = options?.signal
      let abort: () => void = () => undefined
      const stopped = new Promise<void>((resolve) => { abort = resolve })
      signal?.addEventListener("abort", abort, { once: true })
      if (!signal?.aborted) await Promise.race([held.opened, stopped])
      signal?.removeEventListener("abort", abort)
      if (signal?.aborted) throw signal.reason
    }
    const lines = [
      { choices: [{ delta: { content: "done" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]
    const response = lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") + "data: [DONE]\n\n"
    return new Response(response, { headers: { "content-type": "text/event-stream" } })
  }
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  const storage = new Storage(path.join(root, "data", "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "data", "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: "http://127.0.0.1:4333/v1", models: [{ id: "m", name: "M" }] }], directory: project })
  await config.setApiKey("fake", "k")
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, new Permissions(bus, config), { accessToken: async () => undefined } as never, storage)
  const settled = async (sessionID: string) => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await until(() => !runner.busySessions().includes(sessionID))
  }
  return { store, runner, project, bodies, settled, bus }
}

const lastUser = (body: string | undefined): string => {
  const messages = (JSON.parse(body ?? "{}") as { messages?: { role: string; content: unknown }[] }).messages ?? []
  const content = messages.filter((message) => message.role === "user").at(-1)?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : ""
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
}
const until = async (test: () => boolean | Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

export async function queueDeliveryChecks(check: Check) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-queue-"))
  const fetchBefore = globalThis.fetch
  try {
    for (const [platform, modifier] of [["darwin", { metaKey: true }], ["win32", { ctrlKey: true }]] as const) {
      const enter = { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }
      for (const mode of ["queue", "steer"] as const) {
        check(`running Enter and modified Enter swap on ${platform} when default is ${mode}`,
          runningDelivery(enter, platform, mode) === mode &&
          runningDelivery({ ...enter, ...modifier }, platform, mode) === (mode === "queue" ? "steer" : "queue"))
      }
    }

    const first = gate()
    const run = await harness(path.join(root, "queue"), first)
    try {
      const session = await run.store.create({ title: "Queue checks", directory: run.project, model: { provider: "fake", model: "m" } })
      await run.runner.prompt({ sessionID: session.id, text: "first task" })
      await until(() => run.bodies.length === 1)
      const [a, b] = await Promise.all([
        run.runner.prompt({ sessionID: session.id, text: "queued one", delivery: "queue" }),
        run.runner.prompt({ sessionID: session.id, text: "queued two", delivery: "queue" }),
      ])
      const waiting = (await run.store.require(session.id)).queued ?? []
      check("two queued at once are both kept, in order", waiting.map((item) => item.text).join() === "queued one,queued two" && waiting[0]?.id === a && waiting[1]?.id === b, waiting)
      check("and neither reaches the transcript or the model while the turn runs", !(await run.store.messages(session.id)).some((message) => message.role === "user" && message.text.startsWith("queued")) && run.bodies.length === 1)
      const editor = {}
      await run.runner.beginQueueEdit(session.id, a, editor)
      const steer = await run.runner.prompt({ sessionID: session.id, text: "mid-turn steer", delivery: "queue" })
      const joinedID = await run.runner.sendQueuedNow(session.id, steer, "steer")
      const joined = (await run.store.messages(session.id)).find((message) => message.id === joinedID) as UserMessage
      check("explicit steer reaches the pending injection point while the provider is still held",
        joined?.steered === true && run.bodies.length === 1)
      first.open()
      await until(() => run.bodies.length >= 2)
      await run.settled(session.id)
      check("a live edit holds the FIFO head when the turn ends",
        run.bodies.length === 2 && (await run.store.require(session.id)).queued?.[0]?.id === a)
      await run.runner.updateQueued(session.id, a, "edited one", editor)
      await until(() => run.bodies.length >= 4)
      await run.settled(session.id)
      check("when the turn ends, each goes out as a turn of its own, oldest first", run.bodies.length === 4 && run.bodies[1]?.includes("mid-turn steer") && lastUser(run.bodies[2]) === "edited one" && lastUser(run.bodies[3]) === "queued two", run.bodies.map(lastUser))
      const users = (await run.store.messages(session.id)).filter((message): message is UserMessage => message.role === "user")
      check("marked as sent from the queue, not steered into the turn", users.filter((message) => message.queued).map((message) => message.text).join() === "edited one,queued two" && users.filter((message) => message.queued).every((message) => !message.steered), users.map((message) => [message.text, message.queued, message.steered]))
      check("the edited message retained its queue identity", users.find((message) => message.text === "edited one")?.queueSourceID === a)
      check("and the queue is empty afterwards", (await run.store.require(session.id)).queued === undefined)
    } finally {
      first.open()
    }

    const beforeFailure = gate()
    const paused = await harness(path.join(root, "queue-paused"), beforeFailure)
    try {
      const session = await paused.store.create({ title: "Queue checks", directory: paused.project, model: { provider: "fake", model: "m" } })
      await paused.runner.prompt({ sessionID: session.id, text: "running" })
      await until(() => paused.bodies.length === 1)
      const head = await paused.runner.prompt({ sessionID: session.id, text: "retry me", delivery: "queue" })
      const tail = await paused.runner.prompt({ sessionID: session.id, text: "then me", delivery: "queue" })
      const requireSession = paused.store.require.bind(paused.store)
      const saveMessage = paused.store.saveMessage.bind(paused.store)
      let rejectOnce = true
      paused.store.saveMessage = async (message) => {
        if (message.role === "user" && message.text === "retry me" && rejectOnce) {
          rejectOnce = false
          throw new Error("simulated send failure")
        }
        return saveMessage(message)
      }
      beforeFailure.open()
      await paused.settled(session.id)
      const failed = await requireSession(session.id)
      check("one automatic send failure pauses the whole queue in order",
        failed.queuePaused === true && failed.queued?.map((item) => item.id).join() === [head, tail].join())
      await paused.runner.prompt({ sessionID: session.id, text: "unrelated turn" })
      await paused.settled(session.id)
      check("a later normal turn does not resume the paused queue", paused.bodies.length === 2)
      if ((await requireSession(session.id)).queued?.some((item) => item.id === head)) {
        await paused.runner.sendQueuedNow(session.id, head, "send")
        await until(() => paused.bodies.length >= 4)
        await paused.settled(session.id)
      }
      const resumed = await requireSession(session.id)
      check("send now resumes the paused queue in order", !resumed.queuePaused && !resumed.queued &&
        lastUser(paused.bodies[2]) === "retry me" && lastUser(paused.bodies[3]) === "then me")
    } finally {
      beforeFailure.open()
    }
    const interrupted = gate()
    const immediate = await harness(path.join(root, "queue-immediate"), interrupted)
    try {
      const session = await immediate.store.create({ title: "Queue checks", directory: immediate.project, model: { provider: "fake", model: "m" } })
      await immediate.runner.prompt({ sessionID: session.id, text: "first task" })
      await until(() => immediate.bodies.length === 1)
      await immediate.runner.prompt({ sessionID: session.id, text: "original head", delivery: "queue" })
      const priority = await immediate.runner.prompt({ sessionID: session.id, text: "priority message", delivery: "queue" })
      let observedSending = false
      const unsubscribe = immediate.bus.subscribe((event) => {
        if (event.type === "session.queue.sending" && event.id === priority) observedSending = true
      })
      try {
        const sent = await immediate.runner.sendQueuedNow(session.id, priority, "send")
        await until(() => immediate.bodies.length >= 3)
        await immediate.settled(session.id)
        const message = (await immediate.store.messages(session.id)).find((entry) => entry.id === sent)
        check("send now starts a fresh turn ahead of the FIFO head", message?.role === "user" && message.queued && !message.steered &&
          lastUser(immediate.bodies[1]) === "priority message" && lastUser(immediate.bodies[2]) === "original head")
        check("a dispatch exposes sending transiently and clears it afterwards", observedSending &&
          !immediate.runner.sendingQueueItems()[session.id])
      } finally {
        unsubscribe()
      }
    } finally {
      interrupted.open()
    }

  } finally {
    globalThis.fetch = fetchBefore
    await fs.rm(root, { recursive: true, force: true })
  }
}
