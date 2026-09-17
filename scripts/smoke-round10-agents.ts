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
import { noticeText, subagentOutput } from "../src/shared/subagent"
import { pillStatus, subagentItems } from "../src/renderer/src/lib/subagents"

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
      ;(subagent ? childRequests : parentRequests).push(seen)
      const reply: Reply = subagent ? await child(seen) : (parentSteps.shift() ?? { text: "parent done" })
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
    conversation,
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
  } finally {
    await h.close()
  }
}
