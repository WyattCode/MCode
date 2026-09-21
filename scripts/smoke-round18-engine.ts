/**
 * Round 18, lane E: the engine and the model-facing text, moved to MiMo
 * 26.920 (R18-E1 onwards).
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundEighteenEngineChecks` with its own check and section.
 *
 * The turn checks run whole turns through the real runner over a fake
 * provider that answers from a script, telling a subagent's and a judge's
 * requests from the conversation's own by the system prompt they carry.
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

type Section = (name: string) => void

export async function roundEighteenEngineChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r18e-"))
  const titles = process.env.MCODE_GENERATE_TITLES
  process.env.MCODE_GENERATE_TITLES = "0"
  try {
    await denyChecks(check, section, path.join(root, "deny"))
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
type Reply = { text: string } | { calls: Call[] }
interface Seen {
  body: { messages?: { role: string; content: unknown }[]; tools?: { function?: { name?: string } }[] }
  system: string
  text: string
}

/**
 * An app over a fake provider. The conversation, its subagents and the goal
 * judge each answer from their own script; every request is kept whole, so a
 * check can read exactly what the model was sent.
 */
async function harness(root: string) {
  const parent: Reply[] = []
  const child: Reply[] = []
  const verdicts: string[] = []
  const turns: Seen[] = []
  const children: Seen[] = []
  const judged: Seen[] = []
  let calls = 0
  const provider = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as Seen["body"]
      const system = (body.messages ?? [])
        .filter((message) => message.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
        .join("\n\n")
      const seen: Seen = { body, system, text: JSON.stringify(body.messages ?? []) }
      let reply: Reply
      if (system.includes(JUDGE_SYSTEM.slice(0, 24))) {
        judged.push(seen)
        reply = { text: verdicts.shift() ?? JSON.stringify({ ok: true, reason: "done" }) }
      } else if (system.includes("Working as a subagent")) {
        children.push(seen)
        reply = child.shift() ?? { text: "**Status**: success\n**Summary**: done\nFinished." }
      } else {
        turns.push(seen)
        reply = parent.shift() ?? { text: "parent done" }
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      if ("text" in reply) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      } else {
        reply.calls.forEach((entry, index) => {
          const frame = { choices: [{ delta: { tool_calls: [{ index, id: `call_r18_${++calls}`, type: "function", function: { name: entry.name, arguments: JSON.stringify(entry.input) } }] } }] }
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
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const model = { provider: "fake", model: "m" }

  const until = async (test: () => boolean | Promise<boolean>, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }
  const busyAnywhere = async (sessionID: string) =>
    runner.busySessions().includes(sessionID) || (await store.list()).some((session) => session.parentID === sessionID && runner.busySessions().includes(session.id))
  const settled = async (sessionID: string) => {
    await until(async () => !(await busyAnywhere(sessionID)), 40_000)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  /** The next permission question raised after `since`, answered as given. */
  const answerPermission = async (since: number, response: "reject" | "once", reason?: string) => {
    let id: string | undefined
    await until(() => {
      const event = events.slice(since).find((entry) => entry.type === "permission.requested")
      id = event?.type === "permission.requested" ? event.request.id : undefined
      return id !== undefined
    })
    if (id) permissions.respond(id, response, reason)
    return id
  }
  const assistants = async (sessionID: string) => (await store.messages(sessionID)).filter((message): message is AssistantMessage => message.role === "assistant")
  const toolParts = async (sessionID: string) => (await assistants(sessionID)).flatMap((message) => message.parts.filter((part): part is ToolPart => part.type === "tool"))
  return {
    store,
    runner,
    permissions,
    config,
    project,
    model,
    events,
    turns,
    children,
    judged,
    until,
    settled,
    answerPermission,
    assistants,
    toolParts,
    script: (steps: Reply[]) => void parent.splice(0, parent.length, ...steps),
    scriptChild: (steps: Reply[]) => void child.splice(0, child.length, ...steps),
    scriptJudge: (steps: string[]) => void verdicts.splice(0, verdicts.length, ...steps),
    close: () => new Promise<void>((resolve) => provider.close(() => resolve())),
  }
}

const write = (file: string): Call => ({ name: "write", input: { file_path: file, content: "x" } })
const ask = (question: string): Call => ({
  name: "question",
  input: { questions: [{ question, header: "Pick", options: [{ label: "Left", description: "" }, { label: "Right", description: "" }] }] },
})
const exists = (file: string) => fs.access(file).then(() => true, () => false)

/* ---------------------------------------------------------------- R18-E1: a refusal is a result, not a stop */

async function denyChecks(check: Check, section: Section, root: string): Promise<void> {
  const app = await harness(root)
  try {
    section("Round 18 (R18-E1): a denied call is handed back and the turn goes on")
    for (const reason of [undefined, "keep it in notes/ instead"]) {
      const session = await app.store.create({ directory: app.project, model: app.model })
      const file = reason ? "reasoned.txt" : "plain.txt"
      app.script([{ calls: [write(file)] }, { text: "worked around it" }])
      const since = app.events.length
      const before = app.turns.length
      await app.runner.prompt({ sessionID: session.id, text: "write the file" })
      const asked = await app.answerPermission(since, "reject", reason)
      await app.settled(session.id)
      const label = reason ? "with a reason" : "without a reason"
      check(`${label}: the write asked`, asked !== undefined)
      const followUp = app.turns[before + 1]
      check(
        `${label}: the model is asked again in the same turn, reading the refusal`,
        app.turns.length === before + 2 && followUp !== undefined && followUp.text.includes("Permission denied by the user") && followUp.text.includes("Do not make the same call again"),
        app.turns.length - before,
      )
      if (reason) check(`${label}: and the reason the user gave`, followUp?.text.includes(reason) === true, followUp?.text.slice(-400))
      const last = (await app.assistants(session.id)).at(-1)
      check(`${label}: the turn ends on the model's own reply, not aborted`, last?.finish === "end_turn" && last.parts.some((part) => part.type === "text" && part.text === "worked around it"), last?.finish)
      const refused = (await app.toolParts(session.id)).find((part) => part.name === "write")
      check(`${label}: the call is kept as an error carrying the refusal`, refused?.status === "error" && String(refused.error).includes("Permission denied by the user"), refused?.status)
      check(`${label}: and nothing was written`, !(await exists(path.join(app.project, file))))
    }

    section("Round 18 (R18-E1): a question card raised beside a denied call stays open")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ calls: [write("beside.txt"), ask("Which side?")] }, { text: "went left" }])
      const since = app.events.length
      await app.runner.prompt({ sessionID: session.id, text: "write and ask" })
      await app.answerPermission(since, "reject")
      const refusedSettled = await app.until(async () => (await app.toolParts(session.id)).some((part) => part.name === "write" && part.status === "error"))
      await new Promise((resolve) => setTimeout(resolve, 300))
      const open = app.runner.questions.outstanding().filter((request) => request.sessionID === session.id)
      check("the refusal is settled while the question is still waiting for its answer", refusedSettled && open.length === 1 && app.runner.busySessions().includes(session.id), open.length)
      if (open[0]) app.runner.questions.reply(open[0].id, [["Left"]])
      await app.settled(session.id)
      const question = (await app.toolParts(session.id)).find((part) => part.name === "question")
      const last = (await app.assistants(session.id)).at(-1)
      check("answering it completes the call and the turn carries on", question?.status === "completed" && last?.finish === "end_turn" && last.parts.some((part) => part.type === "text" && part.text === "went left"), [question?.status, last?.finish])
    }

    section("Round 18 (R18-E1): the plan card raised beside a denied command stays open")
    {
      const session = await app.store.create({ directory: app.project, model: app.model, agent: "plan" })
      app.script([{ calls: [{ name: "bash", input: { command: "echo r18 > r18-plan.txt", description: "Write a marker" } }, { name: "plan_exit", input: {} }] }, { text: "still planning" }])
      const since = app.events.length
      await app.runner.prompt({ sessionID: session.id, text: "plan it" })
      const asked = await app.answerPermission(since, "reject")
      await app.until(async () => (await app.toolParts(session.id)).some((part) => part.name === "bash" && part.status === "error"))
      await new Promise((resolve) => setTimeout(resolve, 300))
      const open = app.runner.questions.outstanding().filter((request) => request.sessionID === session.id)
      check("the command asked and was refused, and the plan card is still up", asked !== undefined && open.length === 1 && open[0]?.questions[0]?.plan !== undefined, open.length)
      if (open[0]) app.runner.questions.reply(open[0].id, [["No"]])
      await app.settled(session.id)
      const planExit = (await app.toolParts(session.id)).find((part) => part.name === "plan_exit")
      const last = (await app.assistants(session.id)).at(-1)
      check("its answer reaches the model and the turn carries on", planExit?.status === "completed" && last?.finish === "end_turn", [planExit?.status, last?.finish])
      check("the refused command did not run", !(await exists(path.join(app.project, "r18-plan.txt"))))
    }

    section("Round 18 (R18-E1): a subagent's denied call is its own to work around")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ calls: [{ name: "actor", input: { operation: { action: "run", description: "Write it", prompt: "Write the file", subagent_type: "general" } } }] }, { text: "the subagent reported" }])
      app.scriptChild([{ calls: [write("child.txt")] }, { text: "**Status**: success\n**Summary**: refused, so I left it\nDone without the file." }])
      const beforeChild = app.children.length
      const since = app.events.length
      await app.runner.prompt({ sessionID: session.id, text: "delegate" })
      const asked = await app.answerPermission(since, "reject")
      await app.settled(session.id)
      const childSeen = app.children.slice(beforeChild)
      check("the subagent's write asked", asked !== undefined)
      check("the subagent is asked again with the refusal in front of it", childSeen.length === 2 && childSeen[1]!.text.includes("Permission denied by the user"), childSeen.length)
      const last = (await app.assistants(session.id)).at(-1)
      check("and the conversation it works for carries on to its own reply", last?.finish === "end_turn" && last.parts.some((part) => part.type === "text" && part.text === "the subagent reported"), last?.finish)
    }

    section("Round 18 (R18-E1): a goal's turn keeps going past a denied call and is judged")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ calls: [write("goal.txt")] }, { text: "done another way" }])
      app.scriptJudge([JSON.stringify({ ok: true, reason: "met another way" })])
      const beforeJudge = app.judged.length
      const since = app.events.length
      await app.runner.prompt({ sessionID: session.id, text: "reach it", goal: "reach it" })
      await app.answerPermission(since, "reject")
      await app.settled(session.id)
      const after = await app.store.get(session.id)
      check("the judge is asked once the turn ends", app.judged.length === beforeJudge + 1, app.judged.length - beforeJudge)
      check("and the goal is marked met", after?.goal?.done?.status === "complete" && after.goal.done.reason === "met another way", after?.goal)
    }

    section("Round 18 (R18-E1): Stop still ends the turn")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ calls: [write("stopped.txt")] }, { text: "should not be asked" }])
      const since = app.events.length
      const before = app.turns.length
      await app.runner.prompt({ sessionID: session.id, text: "write" })
      await app.until(() => app.events.slice(since).some((event) => event.type === "permission.requested"))
      app.runner.abort(session.id)
      await app.settled(session.id)
      const last = (await app.assistants(session.id)).at(-1)
      check("the model is not asked again after a Stop", app.turns.length === before + 1 && last?.finish === "aborted", [app.turns.length - before, last?.finish])
    }
  } finally {
    await app.close()
  }
}
