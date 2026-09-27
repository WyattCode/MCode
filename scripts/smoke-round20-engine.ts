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
import type { AssistantMessage, Message, ServerEvent, ToolPart } from "../src/shared/protocol"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { JUDGE_SYSTEM, judgeTranscript } from "../src/server/session/goal"
import { toProviderMessages } from "../src/server/provider/anthropic"
import { SUMMARY_INSTRUCTION } from "../src/server/session/summary"
import { LENGTH_NOTE, LOOP_ANSWERS } from "../src/server/session/reminders"

type Section = (name: string) => void

export async function roundTwentyEngineChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r20a-"))
  const titles = process.env.MCODE_GENERATE_TITLES
  process.env.MCODE_GENERATE_TITLES = "0"
  try {
    await loopChecks(check, section, path.join(root, "loops"))
    await compactionChecks(check, section, root)
    await goalChecks(check, section, path.join(root, "goal"))
    await lengthNoteChecks(check, section, path.join(root, "notes"))
    await steeredChecks(check, section, path.join(root, "steered"))
    await judgeChecks(check, section, path.join(root, "judge"))
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
        reply = { text: "## Objective\nWriting a long answer.\n\n## Work State\nPart of it is written." }
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
const textOf = (message: AssistantMessage | undefined) => (message?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

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

/* ---------------------------------------------------------------- R20-A2: a compaction ends a continuation */

async function compactionChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 20 (R20-A2): a cut reply refused as too long goes on in a message after the compaction")
  {
    const app = await harness(path.join(root, "refused"))
    try {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ text: "part one ", finish: "length" }, { status: 400, error: "prompt is too long: 300000 tokens > 200000 maximum" }, { text: "part two" }])
      await app.runner.prompt({ sessionID: session.id, text: "write it all" })
      await app.settled(session.id)
      const mark = (await app.store.get(session.id))?.compacted?.messageID
      const replies = await app.assistants(session.id)
      const first = replies.find((message) => textOf(message).includes("part one"))
      const rest = replies.find((message) => textOf(message).includes("part two"))
      check("the conversation was compacted once", app.summaries.length === 1 && mark !== undefined, app.summaries.length)
      check("the rest is not welded into the cut reply", first !== undefined && !textOf(first).includes("part two"), textOf(first))
      check("it has a message of its own, after the compaction mark", rest !== undefined && rest.id !== first?.id && mark !== undefined && rest.id > mark, [rest?.id, mark])
    } finally {
      await app.close()
    }
  }

  section("Round 20 (R20-A2): a cut reply that crossed the line goes on in a message after the compaction")
  {
    const app = await harness(path.join(root, "crossed"), { context: 1000 })
    try {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ text: "part one ", finish: "length", prompt: 990 }, { text: "part two" }])
      await app.runner.prompt({ sessionID: session.id, text: "write it all" })
      await app.settled(session.id)
      const mark = (await app.store.get(session.id))?.compacted?.messageID
      const replies = await app.assistants(session.id)
      const first = replies.find((message) => textOf(message).includes("part one"))
      const rest = replies.find((message) => textOf(message).includes("part two"))
      check("the conversation was compacted once", app.summaries.length === 1 && mark !== undefined, app.summaries.length)
      check("the rest is not welded into the cut reply", first !== undefined && !textOf(first).includes("part two"), textOf(first))
      check("it has a message of its own, after the compaction mark", rest !== undefined && rest.id !== first?.id && mark !== undefined && rest.id > mark, [rest?.id, mark])
      check("and the model was asked for it without the cut reply in view", app.turns.length === 2 && !app.turns[1]!.text.includes("part one"), app.turns.length)
    } finally {
      await app.close()
    }
  }
}

/* ---------------------------------------------------------------- R20-A3: a verdict is about the goal it judged */

async function goalChecks(check: Check, section: Section, root: string): Promise<void> {
  const app = await harness(root)
  try {
    const pursue = async (condition: string) => {
      const session = await app.store.create({ directory: app.project, model: app.model })
      await app.store.update(session.id, { goal: { condition, startedAt: Date.now() - 1000, attempts: 0 } })
      return session
    }

    section("Round 20 (R20-A3): a goal cleared while the judge reads stays cleared")
    {
      const session = await pursue("ship it")
      app.script([{ text: "working on it" }])
      app.scriptJudge([{ text: JSON.stringify({ ok: false, reason: "not shipped yet" }), delay: 800 }])
      const judgedBefore = app.judged.length
      const turnsBefore = app.turns.length
      await app.runner.prompt({ sessionID: session.id, text: "go" })
      await app.until(() => app.judged.length > judgedBefore)
      await app.store.update(session.id, { goal: undefined })
      await app.settled(session.id)
      const after = await app.store.get(session.id)
      const reminders = (await app.store.messages(session.id)).filter((message) => message.role === "user" && message.synthetic)
      check("the verdict does not bring the goal back", after?.goal === undefined, after?.goal)
      check("no reminder is written and the turn is not sent back", reminders.length === 0 && app.turns.length === turnsBefore + 1, [reminders.length, app.turns.length - turnsBefore])
    }

    section("Round 20 (R20-A3): a goal replaced while the judge reads is not marked by the old verdict")
    {
      const session = await pursue("ship it")
      app.script([{ text: "shipped" }])
      app.scriptJudge([{ text: JSON.stringify({ ok: true, reason: "it shipped" }), delay: 800 }])
      const judgedBefore = app.judged.length
      await app.runner.prompt({ sessionID: session.id, text: "go" })
      await app.until(() => app.judged.length > judgedBefore)
      const fresh = { condition: "write the release notes", startedAt: Date.now(), attempts: 0 }
      await app.store.update(session.id, { goal: fresh })
      await app.settled(session.id)
      const after = await app.store.get(session.id)
      check("the new goal is left open", after?.goal?.condition === fresh.condition && after.goal.done === undefined, after?.goal)
    }

    section("Round 20 (R20-A3): a goal left alone is still judged as before")
    {
      const session = await pursue("ship it")
      app.script([{ text: "not yet" }, { text: "now shipped" }])
      app.scriptJudge([{ text: JSON.stringify({ ok: false, reason: "not shipped yet" }) }, { text: JSON.stringify({ ok: true, reason: "it shipped" }) }])
      const turnsBefore = app.turns.length
      await app.runner.prompt({ sessionID: session.id, text: "go" })
      await app.settled(session.id)
      const after = await app.store.get(session.id)
      check("a not-met verdict sends the turn back once", app.turns.length === turnsBefore + 2, app.turns.length - turnsBefore)
      check("and the met one ends the goal with its count kept", after?.goal?.done?.status === "complete" && after.goal.attempts === 1, after?.goal)
    }
  } finally {
    await app.close()
  }
}

/* ---------------------------------------------------------------- R20-A4: the length note leaves once the reply goes on */

/** How many copies of a note one request carried. */
const noteCount = (seen: Seen | undefined, note: string) => (seen?.body.messages ?? []).filter((message) => JSON.stringify(message.content ?? "").includes(note.slice(0, 40))).length

async function lengthNoteChecks(check: Check, section: Section, root: string): Promise<void> {
  const app = await harness(root)
  try {
    section("Round 20 (R20-A4): once a cut reply has gone on, later steps are not told it was cut")
    {
      const file = path.join(app.project, "notes.txt")
      await fs.writeFile(file, "the notes")
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ text: "part one ", finish: "length" }, { calls: [read(file)] }, { text: "fin" }])
      const before = app.turns.length
      await app.runner.prompt({ sessionID: session.id, text: "write and read" })
      await app.settled(session.id)
      const seen = app.turns.slice(before)
      check("three requests were made", seen.length === 3, seen.length)
      check("the one asking for the rest carries the note", noteCount(seen[1], LENGTH_NOTE) === 1, noteCount(seen[1], LENGTH_NOTE))
      check("the step after the reply went on does not", noteCount(seen[2], LENGTH_NOTE) === 0, noteCount(seen[2], LENGTH_NOTE))
    }

    section("Round 20 (R20-A4): a reply cut again is told so again, once")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ text: "part one ", finish: "length" }, { text: "part two ", finish: "length" }, { text: "part three" }])
      const before = app.turns.length
      await app.runner.prompt({ sessionID: session.id, text: "write a lot" })
      await app.settled(session.id)
      const seen = app.turns.slice(before)
      const replies = await app.assistants(session.id)
      check("all three parts are one reply", replies.length === 1 && textOf(replies[0]) === "part one part two part three", replies.map(textOf))
      check("the third request carries the note exactly once", noteCount(seen[2], LENGTH_NOTE) === 1, noteCount(seen[2], LENGTH_NOTE))
    }
  } finally {
    await app.close()
  }
}

/* ---------------------------------------------------------------- R20-A5: a steered message ends a continuation */

async function steeredChecks(check: Check, section: Section, root: string): Promise<void> {
  const app = await harness(root)
  try {
    section("Round 20 (R20-A5): a message typed while a reply was cut is answered below it")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ text: "part one ", finish: "length", delay: 800 }, { text: "the rest, and your point" }])
      const before = app.turns.length
      await app.runner.prompt({ sessionID: session.id, text: "write it" })
      await app.until(() => app.turns.length > before)
      const steered = await app.runner.prompt({ sessionID: session.id, text: "and mention the edge case" })
      await app.settled(session.id)
      const replies = await app.assistants(session.id)
      const first = replies.find((message) => textOf(message).includes("part one"))
      const rest = replies.find((message) => textOf(message).includes("the rest"))
      check("the cut reply keeps only what it wrote before the message came in", textOf(first) === "part one ", textOf(first))
      check("the next step is a message of its own, after the steered one", rest !== undefined && rest.id !== first?.id && rest.id > steered, [rest?.id, steered])
      check("and the model was sent the steered message", app.turns.at(-1)?.text.includes("and mention the edge case") === true)
    }
  } finally {
    await app.close()
  }
}

/* ---------------------------------------------------------------- R20: the judge is sent no tool blocks */

async function judgeChecks(check: Check, section: Section, root: string): Promise<void> {
  const app = await harness(root)
  try {
    section("Round 20 (R20-A judge): the goal judge reads the calls as text, with no tool blocks and no tools")
    {
      const file = path.join(app.project, "evidence.txt")
      await fs.writeFile(file, "judge evidence line")
      const session = await app.store.create({ directory: app.project, model: app.model })
      await app.store.update(session.id, { goal: { condition: "read the evidence", startedAt: Date.now(), attempts: 0 } })
      app.script([{ calls: [read(file)] }, { text: "read it" }])
      app.scriptJudge([{ text: JSON.stringify({ ok: true, reason: "it was read" }) }])
      const before = app.judged.length
      await app.runner.prompt({ sessionID: session.id, text: "read the evidence" })
      await app.settled(session.id)
      const seen = app.judged[before]
      const messages = seen?.body.messages ?? []
      check("the judge was asked", seen !== undefined)
      check("its request carries no tool calls and no tool results", !messages.some((message) => message.role === "tool" || (message.tool_calls?.length ?? 0) > 0), messages.map((message) => message.role))
      check("the call and what it returned are there as text", seen?.text.includes("[Tool call: read]") === true && seen.text.includes("judge evidence line"), seen?.text.slice(0, 400))
      check("and the verdict still lands", (await app.store.get(session.id))?.goal?.done?.status === "complete")
    }

    section("Round 20 (R20-A judge): on an Anthropic model the judge's messages hold no tool_use or tool_result")
    {
      const model = { provider: "anthropic", model: "claude-sonnet-4-5" }
      const call: ToolPart = {
        type: "tool",
        id: "prt_1",
        callID: "toolu_1",
        name: "bash",
        status: "completed",
        input: { command: "npm test" },
        output: "all 12 tests passed",
        time: { created: 1, started: 1, completed: 2 },
      }
      const failed: ToolPart = { ...call, id: "prt_2", callID: "toolu_2", status: "error", output: undefined, error: "exit 1" }
      const history: Message[] = [
        { id: "msg_1", sessionID: "s", role: "user", text: "run the tests", attachments: [], time: { created: 1 } },
        { id: "msg_2", sessionID: "s", role: "assistant", model, agent: "build", parts: [{ type: "text", id: "prt_0", text: "Running them." }, call, failed], time: { created: 2 }, finish: "tool_use" },
        { id: "msg_3", sessionID: "s", role: "assistant", model, agent: "build", parts: [{ type: "text", id: "prt_3", text: "They pass." }], time: { created: 3 }, finish: "end_turn" },
      ]
      const blocks = (messages: ReturnType<typeof toProviderMessages>) =>
        messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content.map((block) => block.type)))
      check("as the turn sends them, the calls are tool blocks", blocks(toProviderMessages(history, undefined, model)).includes("tool_use"))
      const judged = blocks(toProviderMessages(judgeTranscript(history), undefined, model))
      check("as the judge sends them, there are none", !judged.includes("tool_use") && !judged.includes("tool_result"), judged)
      const text = JSON.stringify(toProviderMessages(judgeTranscript(history), undefined, model))
      check("the result and the failure are both still readable", text.includes("all 12 tests passed") && text.includes("Error: exit 1") && text.includes("npm test"), text.slice(0, 400))
    }
  } finally {
    await app.close()
  }
}
