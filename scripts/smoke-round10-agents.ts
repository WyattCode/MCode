/**
 * Round 10: the agent-type tools against MiMo's engine - the task a subagent
 * is started for, its completion gate, what the actor tool hands back, and
 * the rest of part C of the round-ten audit.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundTenAgentChecks` with its own check and section. Turns run through the
 * real runner over a fake provider, which answers by what the latest message
 * asks for, so a rule that stops holding fails here.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import type { Check } from "./smoke-round5"
import type { Message, SessionInfo, ToolPart } from "../src/shared/protocol"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { actorAction, actorTarget, isLegacySubagentCall, noticeText, subagentOutput } from "../src/shared/subagent"
import { stepTitle, stepVerb } from "../src/renderer/src/lib/tool-meta"
import { t } from "../src/renderer/src/lib/i18n"
import { pillStatus, subagentItems } from "../src/renderer/src/lib/subagents"
import { nextOccurrence, parseRRule } from "../src/server/automation/rrule"
import { ToolError } from "../src/server/tool/types"
import { planApprovedRefusal } from "../src/server/session/plan"
import { recallHint } from "../src/server/session/reminders"
import { sampleFiles } from "../src/server/tool/skill"
import { ContactsTool } from "../src/server/tool/session-chat"
import { SessionChat, withChatHeaders } from "../src/server/session/chat"
import { QuestionTool } from "../src/server/tool/question"
import { confirmQueue } from "../src/renderer/src/lib/confirm-queue"
import type { QuestionRequest } from "../src/shared/protocol"
import { HistoryTool } from "../src/server/tool/history"
import { bindHistory, type HistoryService } from "../src/server/history/service"

type Section = (name: string) => void

/** One call the fake model makes. */
type Call = { name: string; input: Record<string, unknown> }

/** What the fake provider saw of one request. */
type Seen = { system: string; tools: string[]; messages: { role: string; content?: unknown; tool_calls?: unknown }[] }

/** A reply: text, or tool calls, or an HTTP error. */
type Reply = { text: string } | { calls: Call[] } | { status: number }

export async function roundTenAgentChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10a-"))
  // The fake provider scripts replies in order; a background title request would take one.
  const titles = process.env.MCODE_GENERATE_TITLES
  process.env.MCODE_GENERATE_TITLES = "0"
  try {
    await agentChecks(check, section, root)
  } finally {
    if (titles === undefined) delete process.env.MCODE_GENERATE_TITLES
    else process.env.MCODE_GENERATE_TITLES = titles
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** A running app over a fake provider: `parent` scripts the conversation, `child` answers subagents. */
async function harness(root: string, child: (seen: Seen) => Reply | Promise<Reply>) {
  const parentSteps: Reply[] = []
  const childRequests: Seen[] = []
  const parentRequests: Seen[] = []
  const titleRequests: Seen[] = []
  const titleReply = { text: "A generated title" }
  let calls = 0
  const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", async () => {
      const asked = JSON.parse(body || "{}") as { messages?: Seen["messages"]; tools?: { function?: { name?: string } }[] }
      const seen: Seen = {
        system: JSON.stringify(asked.messages?.find((message) => message.role === "system")?.content ?? ""),
        tools: (asked.tools ?? []).map((tool) => tool.function?.name ?? ""),
        messages: asked.messages ?? [],
      }
      const subagent = seen.system.includes("Working as a subagent")
      // A title request is answered on its own, so it never takes a scripted step.
      const titling = seen.system.includes("You write the title of a conversation")
      if (titling) titleRequests.push(seen)
      else (subagent ? childRequests : parentRequests).push(seen)
      const reply: Reply = titling ? { text: titleReply.text } : subagent ? await child(seen) : (parentSteps.shift() ?? { text: "parent done" })
      if ("status" in reply) {
        response.writeHead(reply.status, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "refused by the fake provider", type: "invalid_request_error" } }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      if ("text" in reply) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      } else {
        reply.calls.forEach((entry, index) => {
          const frame = { choices: [{ delta: { tool_calls: [{ index, id: `call_r10_${++calls}`, type: "function", function: { name: entry.name, arguments: JSON.stringify(entry.input) } }] } }] }
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
  const config = new Config(storage, bus, path.join(data, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const model = { provider: "fake", model: "m" }

  const settled = (sessionID: string) =>
    new Promise<void>((resolve) => {
      const deadline = Date.now() + 30_000
      const busy = async () => runner.busySessions().some((id) => id === sessionID) || (await store.list()).some((session) => session.parentID === sessionID && runner.busySessions().includes(session.id))
      const look = async () => {
        if ((await busy()) && Date.now() < deadline) return void setTimeout(look, 25)
        setTimeout(async () => ((await busy()) && Date.now() < deadline ? look() : resolve()), 300)
      }
      setTimeout(look, 25)
    })
  const conversation = async (steps: Reply[], text = "go") => {
    parentSteps.splice(0, parentSteps.length, ...steps)
    const session = await store.create({ directory: project, model })
    await runner.prompt({ sessionID: session.id, text })
    await settled(session.id)
    return (await store.get(session.id))!
  }
  const toolParts = async (sessionID: string, name: string) =>
    (await store.messages(sessionID)).flatMap((message) => (message.role === "assistant" ? message.parts.filter((part): part is ToolPart => part.type === "tool" && part.name === name) : []))
  const childrenOf = async (sessionID: string) => (await store.list()).filter((session) => session.parentID === sessionID)
  return {
    store,
    runner,
    bus,
    permissions,
    config,
    project,
    model,
    childRequests,
    parentRequests,
    titleRequests,
    titleReply,
    port,
    conversation,
    script: (steps: Reply[]) => void parentSteps.splice(0, parentSteps.length, ...steps),
    settled,
    toolParts,
    childrenOf,
    close: () => new Promise<void>((resolve) => provider.close(() => resolve())),
  }
}

/** The text of the latest user message a request carries. */
function latestUser(seen: Seen): string {
  return JSON.stringify(seen.messages.filter((message) => message.role === "user").at(-1)?.content ?? "")
}

/** Whether the request ends with a tool result, so the call before it has been answered. */
function answered(seen: Seen): boolean {
  return seen.messages.at(-1)?.role === "tool"
}

/** The first user message, which holds a subagent's orders. */
function orders(seen: Seen): string {
  return JSON.stringify(seen.messages.find((message) => message.role === "user")?.content ?? "")
}

const GATE_WORDS = "assigned to you and are not finished"

async function agentChecks(check: Check, section: Section, root: string): Promise<void> {
  /*
   * Children answer by their orders:
   *  GATEKEEP   - reports success at once; sent back by the gate, marks its task done and reports again.
   *  GATEIGNORE - always reports success and never touches its task.
   *  GATEBLOCK  - blocks its task, then reports success.
   *  GATEFAIL   - reports success; the turn the gate sends it back for is refused by the provider.
   *  PLAIN      - answers without a status header.
   *  FAILS      - its first request is refused.
   *  SLOW       - takes a while, so it can be stopped from outside.
   */
  const taskOf = (seen: Seen) => /TASK=(T[\d.]+)/.exec(orders(seen))?.[1] ?? "T1"
  const snapshots: { tasks: unknown; at: string }[] = []
  let parentOf: (() => Promise<SessionInfo | undefined>) | undefined
  const h = await harness(root, async (seen) => {
    const brief = orders(seen)
    const latest = latestUser(seen)
    const gated = latest.includes(GATE_WORDS)
    if (!answered(seen) && !gated && parentOf) snapshots.push({ tasks: (await parentOf())?.tasks, at: brief.slice(0, 40) })
    if (brief.includes("GATEKEEP")) {
      if (gated && !answered(seen)) return { calls: [{ name: "task", input: { action: "done", id: taskOf(seen) } }] }
      if (gated) return { text: "**Status**: success\n**Summary**: finished for real\n\nall of it" }
      return { text: "**Status**: success\n**Summary**: done early\n\nsome of it" }
    }
    if (brief.includes("GATEIGNORE")) return { text: "**Status**: success\n**Summary**: claims done\n\nnothing really" }
    if (brief.includes("GATEBLOCK")) {
      if (!answered(seen)) return { calls: [{ name: "task", input: { action: "block", id: taskOf(seen), event_summary: "waiting on a key" } }] }
      return { text: "**Status**: success\n**Summary**: stuck\n\nblocked on a key" }
    }
    if (brief.includes("GATEFAIL")) {
      if (gated) return { status: 400 }
      return { text: "**Status**: success\n**Summary**: first pass\n\nfirst words" }
    }
    if (brief.includes("FAILS")) return { status: 400 }
    if (brief.includes("SLOW")) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return { text: "slow done" }
    }
    return { text: "plain answer" }
  })
  try {
    const { store, runner, conversation, toolParts, childrenOf } = h
    const createTask = (summary: string): Reply => ({ calls: [{ name: "task", input: { action: "create", summary } }] })
    const actor = (input: Record<string, unknown>): Reply => ({ calls: [{ name: "actor", input }] })
    const tasksOf = async (session: SessionInfo) => (await store.get(session.id))?.tasks ?? []

    section("Round 10 (T10-16): a subagent's task_id starts the task, and its completion gate checks it at the end")
    {
      let current: SessionInfo | undefined
      parentOf = async () => (current ? store.get(current.id) : undefined)
      // The conversation is made before the first request, so the snapshot can find it.
      const origCreate = store.create.bind(store)
      store.create = (async (input: Parameters<typeof store.create>[0]) => {
        const made = await origCreate(input)
        if (!input.parentID) current = made
        return made
      }) as typeof store.create
      const kept = await conversation([createTask("Write the report"), actor({ action: "run", description: "Report", prompt: "GATEKEEP TASK=T1", subagent_type: "general", task_id: "T1" })])
      const seenAtStart = snapshots.find((entry) => entry.at.includes("GATEKEEP"))?.tasks as { id: string; status: string; owner?: string }[] | undefined
      check(
        "the task is in progress and held by the subagent before its first request",
        seenAtStart?.[0]?.status === "in_progress" && seenAtStart[0].owner === "general-1",
        seenAtStart,
      )
      const [keptChild] = await childrenOf(kept.id)
      const keptMessages = keptChild ? await store.messages(keptChild.id) : []
      const reminders = keptMessages.filter((message) => message.role === "user" && message.text.includes(GATE_WORDS))
      check("ending with the task still open sends it back once, with a reminder the transcript hides", reminders.length === 1 && reminders[0]?.role === "user" && reminders[0].synthetic === true, reminders)
      check("the reminder names the task and its status", reminders[0]?.role === "user" && reminders[0].text.includes("- T1 (in_progress): Write the report"), reminders[0])
      const [keptRun] = await toolParts(kept.id, "actor")
      check("once the task is done the answer is the one given after the reminder", keptRun?.status === "completed" && (keptRun.output ?? "").includes("all of it") && !(keptRun.output ?? "").includes("some of it"), keptRun?.output)
      check("its status and summary are on the result tag", (keptRun?.output ?? "").includes('<actor_result status="success" summary="finished for real">'), keptRun?.output)
      check("the task ends done", (await tasksOf(kept))[0]?.status === "done", await tasksOf(kept))

      const ignored = await conversation([createTask("Fix the bug"), actor({ action: "run", description: "Fix", prompt: "GATEIGNORE TASK=T1", subagent_type: "general", task_id: "T1" })])
      const [ignoredChild] = await childrenOf(ignored.id)
      const ignoredTurns = ignoredChild ? (await store.messages(ignoredChild.id)).filter((message) => message.role === "user" && message.text.includes(GATE_WORDS)).length : -1
      check("a subagent that keeps ignoring it is sent back twice, no more", ignoredTurns === 2, ignoredTurns)
      const [ignoredRun] = await toolParts(ignored.id, "actor")
      check("its reported success is lowered to partial", (ignoredRun?.output ?? "").includes('<actor_result status="partial"'), ignoredRun?.output)
      check("and the unfinished task is named after its answer", (ignoredRun?.output ?? "").includes("**Unfinished tasks**: T1"), ignoredRun?.output)
      const ignoredRecord = ignoredChild ? (await store.get(ignoredChild.id))?.subagent?.reported : undefined
      check("the record keeps what the parent was told", ignoredRecord?.status === "partial" && ignoredRecord.unfinished?.join() === "T1", ignoredRecord)

      const blocked = await conversation([createTask("Deploy"), actor({ action: "run", description: "Deploy", prompt: "GATEBLOCK TASK=T1", subagent_type: "general", task_id: "T1" })])
      const [blockedChild] = await childrenOf(blocked.id)
      const blockedReminders = blockedChild ? (await store.messages(blockedChild.id)).filter((message) => message.role === "user" && message.synthetic).length : -1
      const [blockedRun] = await toolParts(blocked.id, "actor")
      check("a blocked task is not sent back", blockedReminders === 0, blockedReminders)
      check("but the status is lowered to blocked and the task named", (blockedRun?.output ?? "").includes('<actor_result status="blocked"') && (blockedRun?.output ?? "").includes("**Unfinished tasks**: T1"), blockedRun?.output)

      const failedGate = await conversation([createTask("Migrate"), actor({ action: "run", description: "Migrate", prompt: "GATEFAIL TASK=T1", subagent_type: "general", task_id: "T1" })])
      const [failedRun] = await toolParts(failedGate.id, "actor")
      check(
        "a turn the gate sent it back for that fails keeps the earlier answer, as partial",
        failedRun?.status === "completed" && (failedRun.output ?? "").includes("first words") && (failedRun.output ?? "").includes('status="partial"'),
        failedRun,
      )

      const explored = await conversation([createTask("Look around"), actor({ action: "run", description: "Look", prompt: "PLAIN TASK=T1", subagent_type: "explore", task_id: "T1" })])
      const exploredTasks = await tasksOf(explored)
      const [exploredChild] = await childrenOf(explored.id)
      const exploredGate = exploredChild ? (await store.messages(exploredChild.id)).filter((message) => message.role === "user" && message.synthetic).length : -1
      check("an explore subagent takes its task too", exploredTasks[0]?.status === "in_progress" && exploredTasks[0].owner === "explore-1", exploredTasks)
      check("but has no completion gate, and its answer keeps an unknown status", exploredGate === 0 && ((await toolParts(explored.id, "actor"))[0]?.output ?? "").includes('<actor_result status="unknown">'))

      const unknownTask = await conversation([actor({ action: "run", description: "Nothing", prompt: "PLAIN", subagent_type: "general", task_id: "T9" })])
      const [unknownRun] = await toolParts(unknownTask.id, "actor")
      check("a task_id the registry does not hold starts nothing and says so", (unknownRun?.output ?? "").includes("there is no task T9") && (await tasksOf(unknownTask)).length === 0, unknownRun?.output)
      store.create = origCreate
      parentOf = undefined
    }

    section("Round 10 (T10-15): a subagent cannot ask the user questions")
    {
      const asked = h.childRequests.filter((seen) => seen.tools.length)
      check("no subagent request offers the question tool", asked.length > 0 && asked.every((seen) => !seen.tools.includes("question")), asked.map((seen) => seen.tools))
      check("while the conversation's own requests do", h.parentRequests.some((seen) => seen.tools.includes("question")))
      const refused = await QuestionTool.execute(
        { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "" }] }] },
        { sessionID: "s", messageID: "m", callID: "c", directory: h.project, subagent: true } as never,
      ).then(
        () => "",
        (failure: unknown) => (failure instanceof ToolError ? failure.message : String(failure)),
      )
      check("a question call that reaches a subagent anyway is refused before anyone is asked", /A subagent cannot ask the user questions/.test(refused), refused)
      const question = (sessionID: string, loop?: { tool: string }): QuestionRequest => ({ id: `q-${sessionID}-${loop ? "loop" : "tool"}`, sessionID, questions: [], time: 1, ...(loop ? { loop } : {}) })
      const queue = confirmQueue("parent", [], [question("parent"), question("child"), question("child", { tool: "bash" })], (id) => id === "parent" || id === "child")
      check(
        "the dock shows the conversation's own questions and a subagent's repeated-call check, but no subagent question",
        queue.map((item) => item.id).join() === "q-parent-tool,q-child-loop",
        queue.map((item) => item.id),
      )
    }

    section("Round 10 (T10-14): an approved plan is carried out in the same run")
    {
      const unsubscribe = h.bus.subscribe((event) => {
        if (event.type === "question.asked" && event.request.questions[0]?.header === "Plan") runner.questions.reply(event.request.id, [["Yes"]])
        // Build mode asks before writing, as it always does; plan mode would have refused without asking.
        if (event.type === "permission.requested") h.permissions.respond(event.request.id, "once")
      })
      const target = path.join(h.project, "built.txt")
      h.parentRequests.length = 0
      h.script([
        { calls: [{ name: "plan_exit", input: {} }] },
        { calls: [{ name: "write", input: { file_path: target, content: "built" } }] },
        { text: "carried out" },
      ])
      const planned = await store.create({ directory: h.project, model: h.model, agent: "plan" })
      await runner.prompt({ sessionID: planned.id, text: "plan it, then build it" })
      await h.settled(planned.id)
      unsubscribe()
      const messages = await store.messages(planned.id)
      const replies = messages.filter((message) => message.role === "assistant")
      const typed = messages.filter((message) => message.role === "user" && !message.synthetic)
      const [exitPart] = await toolParts(planned.id, "plan_exit")
      const [writePart] = await toolParts(planned.id, "write")
      check("the approval tells the model to carry the plan out now", exitPart?.status === "completed" && /carry the plan out, starting with its first step/.test(exitPart.output ?? ""), exitPart?.output)
      check("the next step runs as build without the user saying anything more", typed.length === 1 && replies.length === 3 && replies[0]?.agent === "plan" && replies[1]?.agent === "build" && replies[2]?.agent === "build", replies.map((message) => message.role === "assistant" && message.agent))
      check("and its write goes through", writePart?.status === "completed" && (await fs.readFile(target, "utf8").catch(() => "")) === "built", writePart)
      check("the conversation is left in build mode", (await store.get(planned.id))?.agent === "build")
      const systems = h.parentRequests.map((seen) => seen.system)
      check("the step after approval is asked with build's system prompt", systems.length === 3 && systems[0] !== systems[1] && systems[1] === systems[2], systems.map((text) => text.length))
      check("the plan-mode refusal names the step, not the turn", /Refused for this step only/.test(planApprovedRefusal("a.ts")) && !/next turn/.test(planApprovedRefusal("a.ts")))
    }

    section("Round 10 (T10-45): task and actor take MiMo's operation object, and actor checks what run and spawn need")
    {
      const wrapped = await conversation([
        { calls: [{ name: "task", input: { operation: { action: "create", summary: "Wrapped work" } } }] },
        { calls: [{ name: "actor", input: { operation: { action: "run", description: "Wrapped", prompt: "GATEKEEP TASK=T1", subagent_type: "general", task_id: "T1" } } }] },
      ])
      const [wrappedRun] = await toolParts(wrapped.id, "actor")
      check("a wrapped task create and a wrapped actor run work together", (await tasksOf(wrapped))[0]?.status === "done" && wrappedRun?.status === "completed" && (wrappedRun.output ?? "").includes("all of it"), { tasks: await tasksOf(wrapped), run: wrappedRun?.output })
      const flat = await conversation([{ calls: [{ name: "task", input: { action: "create", summary: "Written flat" } }] }])
      check("the same fields written flat still work, as MiMo takes them", (await tasksOf(flat))[0]?.summary === "Written flat", await tasksOf(flat))
      const refusals = await conversation([
        {
          calls: [
            { name: "actor", input: { operation: { action: "spawn", prompt: "PLAIN", subagent_type: "general" } } },
            { name: "actor", input: { operation: { action: "run", description: "No type", prompt: "PLAIN" } } },
            { name: "actor", input: { action: "run", description: "Odd type", prompt: "PLAIN", subagent_type: "planner" } },
          ],
        },
      ])
      const [noDescription, noType, oddType] = await toolParts(refusals.id, "actor")
      check("spawn without a description is refused", noDescription?.status === "error" && /spawn needs description/.test(noDescription.error ?? ""), noDescription?.error)
      check("run without a subagent_type is refused rather than taken as general", noType?.status === "error" && /needs subagent_type/.test(noType.error ?? ""), noType?.error)
      check("an unknown subagent_type is refused", oddType?.status === "error", oddType?.error)
      check("and none of them started anything", (await childrenOf(refusals.id)).length === 0)
      const drawn: ToolPart = { type: "tool", id: "p", callID: "c", name: "actor", status: "completed", input: { operation: { action: "wait", actor_id: "general-2" } }, time: { created: 1 } }
      const started: ToolPart = { ...drawn, input: { operation: { action: "spawn", description: "Drawn by name", prompt: "x", subagent_type: "general" } } }
      check(
        "the window reads a wrapped call's action, target and description",
        actorAction(drawn.input) === "wait" && actorTarget(drawn.input) === "general-2" && stepTitle(started) === "Drawn by name" && stepVerb(drawn, "completed") === t("toolLabel.subagentAction.wait.completed"),
        [actorAction(drawn.input), actorTarget(drawn.input), stepTitle(started)],
      )
      check("a wrapped task call is not mistaken for a saved subagent call", !isLegacySubagentCall({ type: "tool", name: "task", input: { operation: { action: "create", summary: "x" } } }))
    }

    section("Round 10 (T10-42): a conversation with memory or tasks is told each step where to look")
    {
      const memoryRoot = path.join(root, "memory")
      bindHistory({ memoryRoot } as unknown as HistoryService)
      try {
        const hinted = (seen: Seen) => {
          const users = seen.messages.filter((message) => message.role === "user")
          return JSON.stringify(users.at(-1)?.content ?? "").includes("keeps memory in")
        }
        h.parentRequests.length = 0
        const tasked = await conversation([createTask("Remember me"), { text: "noted" }])
        const [before, after] = h.parentRequests
        check("no hint before the conversation has memory or tasks", Boolean(before) && !hinted(before!))
        const folder = path.join(memoryRoot, "sessions", tasked.id)
        check("once it has a task, the next step's latest user message carries it, naming its memory folder", Boolean(after) && hinted(after!) && JSON.stringify(after!.messages).includes(JSON.stringify(folder).slice(1, -1)), after?.messages.at(-2))
        check("only in the request: the stored message is unchanged", (await store.messages(tasked.id)).every((message) => message.role !== "user" || !JSON.stringify(message).includes("keeps memory in")))
        h.parentRequests.length = 0
        await conversation([{ text: "nothing kept" }])
        check("a conversation with neither gets no hint", h.parentRequests.length === 1 && !hinted(h.parentRequests[0]!))
        const kept = await store.create({ directory: h.project, model: h.model })
        await fs.mkdir(path.join(memoryRoot, "sessions", kept.id), { recursive: true })
        await fs.writeFile(path.join(memoryRoot, "sessions", kept.id, "notes.md"), "# notes\n")
        h.parentRequests.length = 0
        h.script([{ text: "remembered" }])
        await runner.prompt({ sessionID: kept.id, text: "what did we say" })
        await h.settled(kept.id)
        check("a conversation whose memory folder holds a file gets it from the first step", h.parentRequests.length === 1 && hinted(h.parentRequests[0]!))
        check("and is pointed at actor status, which a subagent is not", JSON.stringify(h.parentRequests[0]!.messages).includes("- actor({ operation:") &&!recallHint("x", false).includes("actor("))
      } finally {
        bindHistory(undefined)
      }
    }

    section("Round 10 (T10-43): a title model that fails is followed by one try on the conversation's own model")
    {
      let refused = 0
      const broken = createServer((request, response) => {
        request.resume()
        request.on("end", () => {
          refused++
          response.writeHead(400, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: { message: "no such model", type: "invalid_request_error" } }))
        })
      })
      await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", () => resolve()))
      const brokenPort = (broken.address() as { port: number }).port
      const fake = { id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${h.port}/v1`, models: [{ id: "m", name: "M" }] }
      await h.config.set({ customProviders: [fake, { id: "broken", name: "Broken", baseURL: `http://127.0.0.1:${brokenPort}/v1`, models: [{ id: "x", name: "X" }] }], titleModel: { provider: "broken", model: "x" } })
      await h.config.setApiKey("broken", "k")
      delete process.env.MCODE_GENERATE_TITLES
      try {
        const titled = async (reply: string) => {
          h.titleRequests.length = 0
          h.titleReply.text = reply
          h.script([{ text: "answered" }])
          const session = await store.create({ directory: h.project, model: h.model })
          await runner.prompt({ sessionID: session.id, text: "Fix the flaky upload test" })
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline && ((await store.get(session.id))?.titleSource === "fallback" || runner.busySessions().includes(session.id))) await new Promise((resolve) => setTimeout(resolve, 50))
          await new Promise((resolve) => setTimeout(resolve, 200))
          return store.get(session.id)
        }
        const before = refused
        const rescued = await titled("Flaky upload test")
        check("the title model was asked first and refused", refused > before, refused - before)
        check("the conversation's own model then named the conversation", rescued?.title === "Flaky upload test" && rescued.titleSource === "generated" && h.titleRequests.length === 1, rescued)
        await h.config.set({ titleModel: { provider: "fake", model: "m" } })
        const plain = await titled("")
        check("when the title model is the conversation's own, an empty answer is not asked twice", h.titleRequests.length === 1 && plain?.titleSource === "fallback", { asked: h.titleRequests.length, plain })
      } finally {
        process.env.MCODE_GENERATE_TITLES = "0"
        await h.config.set({ customProviders: [fake], titleModel: undefined })
        await new Promise<void>((resolve) => broken.close(() => resolve()))
      }
    }

    section("Round 10 (T10-49, T10-55): cross-chat refusals are results, not failed calls, and the tools answer in Chinese")
    {
      const other = await store.create({ directory: h.project, model: h.model, title: "Beta r10" })
      const asked = await conversation([
        {
          calls: [
            { name: "contacts", input: { explanation: "who is there" } },
            { name: "talk_to_session", input: { contact: "Nobody here", message: "hi" } },
            { name: "create_session", input: { name: "G", purpose: "p", workspace: "relative/folder" } },
            { name: "update_session", input: { contact_id: "ses_missing", name: "x" } },
          ],
        },
      ])
      const [contacts] = await toolParts(asked.id, "contacts")
      const [talk] = await toolParts(asked.id, "talk_to_session")
      const [create] = await toolParts(asked.id, "create_session")
      const [update] = await toolParts(asked.id, "update_session")
      check("contacts lists the others in Chinese", contacts?.status === "completed" && (contacts.output ?? "").startsWith("通讯录（") && (contacts.output ?? "").includes(`「Beta r10」 id=${other.id} 空闲`), contacts?.output)
      check("an unknown contact is a completed call saying it was not delivered, with candidates", talk?.status === "completed" && (talk.output ?? "").startsWith("未送达：没有标题为「Nobody here」的联系人") && (talk.output ?? "").includes("候选："), talk)
      check("a bad workspace is a completed call saying the session was not created", create?.status === "completed" && (create.output ?? "").startsWith("会话没有创建："), create)
      check("an unknown session is a completed call saying nothing was updated", update?.status === "completed" && (update.output ?? "").startsWith("会话资料没有更新："), update)
      const header = withChatHeaders([{ id: "u", sessionID: "s", role: "user", text: "hello", attachments: [], inbox: { from: "Alpha", sessionID: "ses_a", direction: "request" }, time: { created: 1 } }])[0]
      check("a message from another conversation is introduced in Chinese", header?.role === "user" && header.text.startsWith("【跨会话消息｜来自会话「Alpha」（contact_id ses_a）】"), header)
      check("a subagent is still refused the tools outright", await ContactsTool.execute({ explanation: "x" }, { sessionID: "s" } as never).then(() => false, (failure: unknown) => failure instanceof ToolError))
    }

    section("Round 10 (T10-44): what the actor tool hands back, in MiMo's shapes")
    {
      const plain = await conversation([actor({ action: "run", description: "Plain", prompt: "PLAIN", subagent_type: "general" })])
      const [plainRun] = await toolParts(plain.id, "actor")
      check("an answer without a status header is tagged unknown", (plainRun?.output ?? "").includes('<actor_result status="unknown">\nplain answer'), plainRun?.output)
      const [plainChild] = await childrenOf(plain.id)
      const statusCall = await conversation([{ calls: [{ name: "actor", input: { action: "status", actor_id: plainChild?.subagent?.id ?? "?" } }] }])
      // A status call in another conversation finds nothing; ask the one that owns it instead.
      const [unknownStatus] = await toolParts(statusCall.id, "actor")
      check("a subagent of another conversation is unknown", JSON.parse(unknownStatus?.output ?? "{}").status === "unknown", unknownStatus?.output)

      const later = await conversation([
        actor({ action: "spawn", description: "Background", prompt: "PLAIN", subagent_type: "general" }),
        { calls: [{ name: "actor", input: { action: "wait", actor_id: "general-1", timeout_ms: 20_000 } }] },
        { calls: [{ name: "actor", input: { action: "status", actor_id: "general-1" } }] },
      ])
      const waited = (await toolParts(later.id, "actor")).find((part) => part.input?.action === "wait")
      const looked = (await toolParts(later.id, "actor")).find((part) => part.input?.action === "status")
      const waitedJSON = JSON.parse(waited?.output ?? "{}") as Record<string, unknown>
      const lookedJSON = JSON.parse(looked?.output ?? "{}") as Record<string, unknown>
      check(
        "wait reports turnCount, lastTurnTime, lastOutcome and time, with the answer",
        waitedJSON.turnCount === 1 && typeof waitedJSON.lastTurnTime === "number" && waitedJSON.lastOutcome === "success" && typeof (waitedJSON.time as { created?: number })?.created === "number" && waitedJSON.result === "plain answer" && waitedJSON.agent === "general",
        waitedJSON,
      )
      check("the old field names are gone", !["turns", "outcome", "started", "ended", "subagent_type"].some((key) => key in waitedJSON), Object.keys(waitedJSON))
      check("status gives the same snapshot without the answer", lookedJSON.lastOutcome === "success" && !("result" in lookedJSON), lookedJSON)

      const failing = await conversation([actor({ action: "run", description: "Fails", prompt: "FAILS", subagent_type: "general" })])
      const [failingRun] = await toolParts(failing.id, "actor")
      check("a run that fails is an error, with no partial result when nothing was said", failingRun?.status === "error" && !(failingRun.error ?? "").includes("Partial result"), failingRun)

      // Stopped from outside rather than by the parent's Stop: a result that says so.
      h.childRequests.length = 0
      const stopping = h.conversation([actor({ action: "run", description: "Slow", prompt: "SLOW", subagent_type: "general" })])
      const deadline = Date.now() + 10_000
      while (!h.childRequests.some((seen) => orders(seen).includes("SLOW")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
      const slowChild = (await store.list()).find((session) => session.title === "Slow" && session.parentID && runner.busySessions().includes(session.id))
      if (slowChild) runner.abort(slowChild.id)
      const stopped = await stopping
      const [stoppedRun] = await toolParts(stopped.id, "actor")
      check(
        "a run whose subagent was stopped answers cancelled rather than failing",
        stoppedRun?.status === "completed" && (stoppedRun.output ?? "").includes('<actor_result status="cancelled">') && stoppedRun.metadata?.cancelled === true,
        stoppedRun,
      )
      const items = stoppedRun ? subagentItems([{ id: "a", sessionID: "s", role: "assistant", model: h.model, agent: "build", parts: [stoppedRun], time: { created: 1 } } as Message], []) : []
      check("the tab and the pill read it as cancelled", items[0]?.status === "rejected" && stoppedRun !== undefined && pillStatus([stoppedRun]) === "cancelled", { items, pill: stoppedRun && pillStatus([stoppedRun]) })

      const notice = (reported?: "success" | "partial" | "failed" | "blocked") =>
        noticeText([{ notice: { subagentID: "general-1", sessionID: "c", description: "Fix", status: reported === "failed" ? "failed" : "completed", summary: "sum", ...(reported ? { reported } : {}) }, result: "body" }])
      check("a notice for a partial answer carries its status and summary", notice("partial").includes("completed.\nStatus: partial\nSummary: sum\nResult:\nbody"), notice("partial"))
      check("a blocked or failed report is said to have finished with that status", notice("blocked").includes("finished and reported blocked.") && notice("failed").includes("finished and reported failed."), [notice("blocked"), notice("failed")])
      const failedNotice = noticeText([{ notice: { subagentID: "general-1", sessionID: "c", description: "Fix", status: "failed", summary: "boom" }, result: "boom", partial: "halfway" }])
      check("a failure notice carries what was said before it", failedNotice.includes("Error: boom\nPartial result:\nhalfway"), failedNotice)
      check("the summary attribute is flattened and its quotes swapped", subagentOutput("x", "a", "partial", 'said "hi"\n  there').includes('summary="said \'hi\' there"'))
    }

    section("Round 10 triage: a subagent cancelled while its first step is being prepared stops at once")
    {
      /*
       * The cancel lands after the step loop last looked at the signal and
       * before the request is sent: here, as the step's empty reply is saved,
       * the last thing before the request. The request must not go out.
       */
      h.childRequests.length = 0
      const origSave = store.saveMessage.bind(store)
      let cancelledAt = 0
      let cancelledID = ""
      store.saveMessage = (async (message: Message, silent?: boolean) => {
        await origSave(message, silent)
        if (cancelledAt || message.role !== "assistant" || message.parts.length) return
        const owner = await store.get(message.sessionID)
        if (owner?.parentID && owner.title === "Early cancel") {
          cancelledAt = Date.now()
          cancelledID = owner.id
          runner.abort(owner.id)
        }
      }) as typeof store.saveMessage
      try {
        const early = await conversation([actor({ action: "run", description: "Early cancel", prompt: "SLOW", subagent_type: "general" })])
        const [earlyRun] = await toolParts(early.id, "actor")
        // The slow subagent's provider takes 1500 ms; a request that went out anyway ends no sooner.
        const settledIn = cancelledAt && earlyRun?.time.completed ? earlyRun.time.completed - cancelledAt : -1
        const sent = h.childRequests.filter((seen) => orders(seen).includes("SLOW")).length
        check("the subagent was cancelled before its request", cancelledID !== "", cancelledID)
        check("no request is sent for the cancelled step", sent === 0, sent)
        check("the run answers cancelled without waiting for the provider", earlyRun?.metadata?.cancelled === true && settledIn >= 0 && settledIn < 1200, { settledIn, output: earlyRun?.output })
        check("the subagent is no longer busy", !runner.busySessions().includes(cancelledID), runner.busySessions())
      } finally {
        store.saveMessage = origSave
      }
    }
  } finally {
    await h.close()
  }
  await automationChecks(check, section)
  await historyChecks(check, section, root)
  await queuedStopChecks(check, section, root)
  await skillChecks(check, section, root)
}

async function skillChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 10 (T10-46): a skill's file list respects ignore files, as MiMo's ripgrep listing does")
  const repo = path.join(root, "skill-repo")
  const skill = path.join(repo, "skills", "tidy")
  await fs.mkdir(path.join(repo, ".git"), { recursive: true })
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true })
  await fs.mkdir(path.join(skill, "build"), { recursive: true })
  await fs.writeFile(path.join(repo, ".gitignore"), "build/\n*.log\n")
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: tidy\ndescription: x\n---\n")
  await fs.writeFile(path.join(skill, "scripts", "run.py"), "print(1)\n")
  await fs.writeFile(path.join(skill, "debug.log"), "noise\n")
  await fs.writeFile(path.join(skill, "build", "out.bin"), "x")
  await fs.writeFile(path.join(skill, ".env.example"), "A=1\n")
  const listed = (await sampleFiles(skill)).map((file) => path.relative(skill, file).split(path.sep).join("/")).sort()
  check("ignored files and folders are left out, hidden ones and scripts are listed, SKILL.md is not", listed.join() === ".env.example,scripts/run.py", listed)
  for (let at = 0; at < 14; at++) await fs.writeFile(path.join(skill, "scripts", `extra-${at}.py`), "")
  check("at most ten are listed", (await sampleFiles(skill)).length === 10)
}

/**
 * T10-50: a sync message still queued when its sender is stopped is delivered
 * all the same, as MiMo's is, and its reply goes nowhere. The target is made
 * to look free when the call checks and busy when the queue would start it, so
 * the message is waiting when Stop lands.
 */
async function queuedStopChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 10 (T10-50): stopping the sender leaves its queued message to be delivered, as MiMo's is")
  const storage = new Storage(path.join(root, "queued-stop", "storage"))
  const bus = new Bus()
  const store = new SessionStore(storage, bus)
  const model = { provider: "fake", model: "m" }
  const project = path.join(root, "project")
  const sender = await store.create({ directory: project, model, title: "Sender" })
  const target = await store.create({ directory: project, model, title: "Target" })
  let checks = 0
  let targetBusy = false
  const prompted: { sessionID: string; text: string; direction?: string }[] = []
  const turns = {
    // The first look (the call's own) sees it free; the queue's look sees its own turn still running.
    isRunning: (id: string) => id === target.id && (targetBusy || checks++ > 0),
    prompt: async (input: { sessionID: string; text: string; inbox: { direction?: string } }) => {
      prompted.push({ sessionID: input.sessionID, text: input.text, direction: input.inbox.direction })
      return `msg_${prompted.length}`
    },
    create: async () => sender,
  }
  const chat = new SessionChat(store, bus, turns as never, 60_000)
  const stop = new AbortController()
  const call = chat.talk({ from: sender.id, contactID: target.id, message: "please do it", mode: "sync", signal: stop.signal })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check("the message is waiting for the target's own turn to end", prompted.length === 0, prompted)
  stop.abort()
  const settled = await call
  check("the stopped call settles as stopped", settled.status === "stopped", settled)
  // The target's own turn ends: the queue moves on.
  checks = -1_000_000
  targetBusy = false
  bus.publish({ type: "session.idle", sessionID: target.id })
  await new Promise((resolve) => setTimeout(resolve, 100))
  check("the queued message is still delivered to the target", prompted.some((entry) => entry.sessionID === target.id && entry.text === "please do it"), prompted)
  await store.saveMessage({ id: "msg_0r10z", sessionID: target.id, role: "assistant", model, agent: "build", parts: [{ type: "text", id: "prt_0r10z", text: "done it" }], finish: "end_turn", time: { created: Date.now() } }, true)
  bus.publish({ type: "session.idle", sessionID: target.id })
  await new Promise((resolve) => setTimeout(resolve, 100))
  check("and its reply is not sent back to the sender that stopped", !prompted.some((entry) => entry.sessionID === sender.id), prompted)
}

async function historyChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 10 (T10-17): history get lists media by locator and hands over one only when asked, never a file on disk")
  const storage = new Storage(path.join(root, "history", "storage"))
  const store = new SessionStore(storage, new Bus())
  const project = path.join(root, "project")
  const picture = path.join(project, "shot.png")
  await fs.writeFile(picture, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"))
  const model = { provider: "fake", model: "m" }
  const session = await store.create({ directory: project, model, title: "Pictures" })
  const png = Buffer.alloc(64, 7).toString("base64")
  await store.saveMessage({ id: "msg_0r10a", sessionID: session.id, role: "user", text: `look at this data:image/png;base64,${png} please`, attachments: [{ path: picture, mime: "image/png", data: "", byPath: true }], time: { created: 1 } }, true)
  await store.saveMessage(
    {
      id: "msg_0r10b",
      sessionID: session.id,
      role: "assistant",
      model,
      agent: "build",
      parts: [
        {
          type: "tool",
          id: "prt_0r10",
          callID: "c1",
          name: "webfetch",
          status: "completed",
          input: { url: "https://example.com/a.png" },
          output: "fetched",
          attachments: [
            { path: "a.png", mime: "image/png", data: png },
            { path: picture, mime: "image/png", data: "", byPath: true },
          ],
          time: { created: 2 },
        },
      ],
      time: { created: 2 },
    },
    true,
  )
  bindHistory({ storage, store } as unknown as HistoryService)
  try {
    const context = { sessionID: session.id, messageID: "m", callID: "c", directory: project } as never
    const get = (input: Record<string, unknown>) => HistoryTool.execute({ operation: "get", ...input }, context)
    const file = await get({ part_id: `${session.id}/msg_0r10a/file:0` })
    check("a user's attached picture is listed, not attached", !file.attachments?.length && file.output.includes("attachment=file:0 mime=image/png") && file.output.includes("file: file:0 to file:0"), file)
    const refusedFile = await get({ part_id: `${session.id}/msg_0r10a/file:0`, attachment: "file:0" })
    check("asked for, it is refused and read is named instead", !refusedFile.attachments?.length && /read tool/.test(refusedFile.output) && /nothing was read/.test(refusedFile.output), refusedFile)
    const typed = await get({ part_id: `${session.id}/msg_0r10a/text` })
    check("inline media in a part's text is replaced in the page and listed as inline:0", !typed.attachments?.length && typed.output.includes("[media image/png]") && typed.output.includes("attachment=inline:0 mime=image/png") && !typed.output.includes(png), typed.output)
    const inline = await get({ part_id: `${session.id}/msg_0r10a/text`, attachment: "inline:0" })
    check("asked for by its locator, the inline picture comes with the result", inline.attachments?.length === 1 && inline.attachments[0]?.data === png && inline.attachments[0].mime === "image/png", inline)
    const tool = await get({ part_id: `${session.id}/msg_0r10b/prt_0r10` })
    check("a tool call's media is listed as tool:0 and tool:1", !tool.attachments?.length && tool.output.includes("attachment=tool:0") && tool.output.includes("attachment=tool:1") && tool.output.includes("tool: tool:0 to tool:1"), tool.output)
    const bytes = await get({ part_id: `${session.id}/msg_0r10b/prt_0r10`, attachment: "tool:0" })
    check("the one it carries the bytes of is handed over", bytes.attachments?.[0]?.data === png, bytes)
    const byPath = await get({ part_id: `${session.id}/msg_0r10b/prt_0r10`, attachment: "tool:1" })
    check("the one it names only by path is not", !byPath.attachments?.length && /read tool/.test(byPath.output), byPath)
    const missing = await get({ part_id: `${session.id}/msg_0r10b/prt_0r10`, attachment: "tool:7" })
    check("an unknown locator says how to list them", !missing.attachments?.length && /list them/.test(missing.output), missing.output)
    check("the tool offers the attachment parameter", "attachment" in ((HistoryTool.parameters as { properties: Record<string, unknown> }).properties ?? {}))
  } finally {
    bindHistory(undefined)
  }
}

/**
 * The recurrence rules MiMo reads, beyond what the file-tools lane's automation checks
 * (smoke-round10-desktop) already cover: phase from 1970 for every frequency, and the
 * stricter DTSTART and UNTIL.
 */
async function automationChecks(check: Check, section: Section): Promise<void> {
  section("Round 10 (T10-51): recurrence rules as MiMo reads them")
  {
    const friday = new Date(2026, 0, 2, 10, 0).getTime()
    const next = (rule: string, after = friday) => {
      const parsed = parseRRule(rule)
      return parsed ? nextOccurrence(parsed, after) : "refused"
    }
    check("every fourth Monday counts weeks from the week of 1 January 1970", next("RRULE:FREQ=WEEKLY;INTERVAL=4;BYDAY=MO;BYHOUR=9;BYMINUTE=0") === new Date(2026, 0, 12, 9, 0).getTime())
    check("every fifth month counts from January 1970", next("RRULE:FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0") === new Date(2026, 3, 1, 9, 0).getTime())
    check("every seventh hour counts from midnight on 1 January 1970", next("RRULE:FREQ=HOURLY;INTERVAL=7;BYMINUTE=0") === new Date(2026, 0, 2, 11, 0).getTime())
    check("a DTSTART still sets the phase", next("DTSTART:20260103T0900\nRRULE:FREQ=DAILY;INTERVAL=3") === new Date(2026, 0, 3, 9, 0).getTime() && next("DTSTART:20260103T0900\nRRULE:FREQ=DAILY;INTERVAL=3", new Date(2026, 0, 3, 9, 0).getTime()) === new Date(2026, 0, 6, 9, 0).getTime())
    check("a rule every ten years is found, past five years", next("RRULE:FREQ=YEARLY;INTERVAL=10;BYMONTH=1;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0") === new Date(2030, 0, 1, 9, 0).getTime())
    check("a leap day every four years from a DTSTART is found four years on", next("DTSTART:20240229T0900\nRRULE:FREQ=YEARLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29", new Date(2028, 2, 1).getTime()) === new Date(2032, 1, 29, 9, 0).getTime())
    // Counted from 1970, every fourth year is 1970, 1974, ... - never a leap year - so without DTSTART it never runs.
    check("and without one it never runs, the search ending after a 400-year cycle", next("RRULE:FREQ=YEARLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29;BYHOUR=9;BYMINUTE=0") === undefined)
    check("a rule that can never run ends the search", next("RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=XX") === "refused" && next("RRULE:FREQ=MONTHLY;BYMONTHDAY=31;BYMONTH=4") === "refused")
    check("DTSTART in UTC is refused", next("DTSTART:20260103T0900Z\nRRULE:FREQ=DAILY") === "refused")
    check("DTSTART with seconds other than 00 is refused, and :00 is accepted", next("DTSTART:20260103T090030\nRRULE:FREQ=DAILY") === "refused" && next("DTSTART:20260103T090000\nRRULE:FREQ=DAILY") !== "refused")
    check("UNTIL without a time is refused", next("RRULE:FREQ=DAILY;UNTIL=20260301") === "refused")
    check("UNTIL with a time, in UTC or local, is accepted", next("RRULE:FREQ=DAILY;UNTIL=20260301T0000Z") !== "refused" && next("RRULE:FREQ=DAILY;UNTIL=20260301T0930") !== "refused")
    check("UNTIL without seconds lasts to the end of its minute", next("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260103T0900") === new Date(2026, 0, 3, 9, 0).getTime())
  }

}
