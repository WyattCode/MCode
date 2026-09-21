/**
 * Round 20, section A: the engine items the round's code review found in the
 * turn loop (R20-A1 onwards).
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundTwentyEngineChecks` with its own check and section.
 *
 * Every check runs whole turns through the real runner over a fake provider
 * that answers from a script - the conversation's steps, the goal judge's
 * verdicts and the compaction summary each from their own - and keeps every
 * request whole, so a check can read exactly what the model was sent.
 * Everything runs in temporary folders of its own: nothing reads the user's
 * profile, calls a real model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import type { Check } from "./smoke-round5"
import type { AssistantMessage, ServerEvent, ToolPart } from "../src/shared/protocol"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { JUDGE_SYSTEM } from "../src/server/session/goal"
import { SUMMARY_INSTRUCTION } from "../src/server/session/summary"
import { LOOP_ANSWERS } from "../src/server/session/reminders"

type Section = (name: string) => void

export async function roundTwentyEngineChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r20a-"))
  const titles = process.env.MCODE_GENERATE_TITLES
  process.env.MCODE_GENERATE_TITLES = "0"
  try {
    await loopChecks(check, section, path.join(root, "loops"))
  } finally {
    if (titles === undefined) delete process.env.MCODE_GENERATE_TITLES
    else process.env.MCODE_GENERATE_TITLES = titles
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/* ---------------------------------------------------------------- the harness */

interface Call {
  name: string
  input: Record<string, unknown>
}
/** One scripted answer: words with the reason they stop, calls, or a refusal. Each may be held back first. */
type Reply = ({ text: string; finish?: "stop" | "length"; prompt?: number } | { calls: Call[] } | { status: number; error: string }) & { delay?: number }
interface Seen {
  body: { messages?: { role: string; content: unknown; tool_calls?: unknown[] }[] }
  text: string
}

async function harness(root: string, options: { context?: number } = {}) {
  const parent: Reply[] = []
  const verdicts: Reply[] = []
  const turns: Seen[] = []
  const judged: Seen[] = []
  const summaries: Seen[] = []
  let calls = 0
  const provider = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", async () => {
      const body = JSON.parse(raw || "{}") as Seen["body"]
      const messages = body.messages ?? []
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
        .join("\n\n")
      const last = JSON.stringify(messages.at(-1)?.content ?? "")
      const seen: Seen = { body, text: JSON.stringify(messages) }
      let reply: Reply
      if (system.includes(JUDGE_SYSTEM.slice(0, 24))) {
        judged.push(seen)
        reply = verdicts.shift() ?? { text: JSON.stringify({ ok: true, reason: "done" }) }
      } else if (last.includes(SUMMARY_INSTRUCTION.slice(0, 40))) {
        summaries.push(seen)
        reply = { text: "## Task overview\nWriting a long answer.\n\n## Current state\nPart of it is written." }
      } else {
        turns.push(seen)
        reply = parent.shift() ?? { text: "parent done" }
      }
      if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay))
      if ("status" in reply) {
        response.writeHead(reply.status, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: reply.error, type: "invalid_request_error" } }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      if ("text" in reply) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`)
        const usage = { prompt_tokens: reply.prompt ?? 1, completion_tokens: 1 }
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reply.finish ?? "stop" }], usage })}\n\n`)
      } else {
        reply.calls.forEach((entry, index) => {
          const frame = { choices: [{ delta: { tool_calls: [{ index, id: `call_r20_${++calls}`, type: "function", function: { name: entry.name, arguments: JSON.stringify(entry.input) } }] } }] }
          response.write(`data: ${JSON.stringify(frame)}\n\n`)
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      }
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  const data = path.join(root, "data")
  const storage = new Storage(path.join(data, "storage"))
  const bus = new Bus()
  const events: ServerEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const config = new Config(storage, bus, path.join(data, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  const model = { id: "m", name: "M", ...(options.context ? { limit: { context: options.context } } : {}) }
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [model] }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)

  const until = async (test: () => boolean | Promise<boolean>, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }
  const settled = async (sessionID: string) => {
    await until(() => !runner.busySessions().includes(sessionID), 40_000)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const assistants = async (sessionID: string) => (await store.messages(sessionID)).filter((message): message is AssistantMessage => message.role === "assistant")
  const toolParts = async (sessionID: string) => (await assistants(sessionID)).flatMap((message) => message.parts.filter((part): part is ToolPart => part.type === "tool"))
  return {
    store,
    runner,
    project,
    model: { provider: "fake", model: "m" },
    events,
    turns,
    judged,
    summaries,
    until,
    settled,
    assistants,
    toolParts,
    script: (steps: Reply[]) => void parent.splice(0, parent.length, ...steps),
    scriptJudge: (steps: Reply[]) => void verdicts.splice(0, verdicts.length, ...steps),
    close: () => new Promise<void>((resolve) => provider.close(() => resolve())),
  }
}

const read = (file: string): Call => ({ name: "read", input: { file_path: file } })

/* ---------------------------------------------------------------- R20-A1: the loop detectors read settled calls */

async function loopChecks(check: Check, section: Section, root: string): Promise<void> {
  const app = await harness(root)
  try {
    section("Round 20 (R20-A1): four fruitless reads in a row are asked about before the fifth runs")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      const missing = (name: string) => path.join(app.project, `${name}.txt`)
      app.script([
        { calls: [read(missing("one"))] },
        { calls: [read(missing("two"))] },
        { calls: [read(missing("three"))] },
        { calls: [read(missing("four"))] },
        { calls: [read(missing("five"))] },
        { text: "gave up looking" },
      ])
      const since = app.events.length
      await app.runner.prompt({ sessionID: session.id, text: "find the file" })
      let asked: string | undefined
      await app.until(() => {
        const open = app.runner.questions.outstanding().find((request) => request.sessionID === session.id)
        if (!open) return false
        asked = open.questions[0]?.question
        app.runner.questions.reply(open.id, [[LOOP_ANSWERS.reject]])
        return true
      }, 15_000)
      await app.settled(session.id)
      check("a loop question is raised", asked !== undefined && asked.includes("4 search calls in a row have turned nothing up"), asked)
      const fifth = (await app.toolParts(session.id)).find((part) => part.input.file_path === missing("five"))
      check(
        "it is asked before the fifth read, which the refusal stops",
        fifth?.status === "error" && String(fifth.error).includes("The user stopped this call: 4 search calls in a row"),
        [fifth?.status, fifth?.error],
      )
      const fourth = (await app.toolParts(session.id)).find((part) => part.input.file_path === missing("four"))
      check("the four reads before it ran and failed on their own", fourth?.status === "error" && String(fourth.error).includes("File not found"), fourth?.error)
      const questions = app.events.slice(since).filter((event) => event.type === "question.asked")
      check("and it is asked once", questions.length === 1, questions.length)
    }

    section("Round 20 (R20-A1): a new turn starts its count afresh")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      const missing = (name: string) => path.join(app.project, `again-${name}.txt`)
      app.script([{ calls: [read(missing("one"))] }, { calls: [read(missing("two"))] }, { calls: [read(missing("three"))] }, { text: "not there" }])
      await app.runner.prompt({ sessionID: session.id, text: "look" })
      await app.settled(session.id)
      const since = app.events.length
      app.script([{ calls: [read(missing("four"))] }, { calls: [read(missing("five"))] }, { text: "still not there" }])
      await app.runner.prompt({ sessionID: session.id, text: "look again" })
      await app.settled(session.id)
      const questions = app.events.slice(since).filter((event) => event.type === "question.asked")
      check("five fruitless reads over two turns raise no question", questions.length === 0, questions.length)
      const parts = await app.toolParts(session.id)
      check("and all five ran", parts.length === 5 && parts.every((part) => String(part.error).includes("File not found")), parts.map((part) => part.error))
    }
  } finally {
    await app.close()
  }
}
