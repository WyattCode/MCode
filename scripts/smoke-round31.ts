/**
 * Round 31: OpenCode v2's engine capabilities, ported one by one.
 *
 * The user chose on 2026-09-27 to follow OpenCode's v2 branch for the engine
 * and the agent's coding abilities, porting each capability into MCode's own
 * engine rather than swapping v2 in (it is unreleased). Each section here is
 * one capability, driven through the real runner against a fake provider.
 *
 * smoke.ts calls `roundThirtyOneChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AppConfig, AssistantMessage, McpServerConfig, Message } from "../src/shared/protocol"
import { McpServers } from "../src/server/mcp"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { ProviderHttpError } from "../src/server/provider/types"
import { retryKind, wakeWaiters } from "../src/server/session/retry"
import { INTERRUPTED_NOTE } from "../src/server/session/reminders"
import { SUMMARY_NUDGE, legacySummary, summaryPrompt } from "../src/server/session/summary"
import { PatchTool } from "../src/server/tool/patch"
import { TOOLS, forModel, usesPatch } from "../src/server/tool/registry"
import type { ToolContext } from "../src/server/tool/types"
import { turnFilePaths } from "../src/server/session/turn-revert"
import { parseUnifiedDiff } from "../src/shared/unified-diff"
import { sessionFiles } from "../src/shared/session-files"
import type { Check } from "./smoke-round5"

type Answer = (request: IncomingMessage, response: ServerResponse, body: string) => void

/** A runner over a fake OpenAI-compatible provider whose every answer the test writes. */
async function harness(root: string, answers: Answer[]) {
  const bodies: string[] = []
  const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      bodies.push(body)
      const answer = answers.shift()
      if (answer) return answer(request, response, body)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  const storage = new Storage(path.join(root, "data", "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "data", "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }, { id: "gpt-5.1", name: "GPT" }] }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const settled = (sessionID: string) =>
    new Promise<void>((resolve) => {
      const deadline = Date.now() + 30_000
      const look = () => {
        if (runner.busySessions().includes(sessionID) && Date.now() < deadline) return void setTimeout(look, 25)
        setTimeout(() => (runner.busySessions().includes(sessionID) && Date.now() < deadline ? look() : resolve()), 200)
      }
      setTimeout(look, 25)
    })
  const close = () => new Promise<void>((resolve) => provider.close(() => resolve()))
  return { bus, store, runner, project, bodies, settled, close }
}

/** Streams these words, then cuts the connection as a dropped link would. */
const cutAfter =
  (words: string): Answer =>
  (request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words } }] })}\n\n`)
    setTimeout(() => request.socket.destroy(), 50)
  }

const finish =
  (words: string): Answer =>
  (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words } }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`)
    response.write("data: [DONE]\n\n")
    response.end()
  }

const textOf = (message: Message | undefined) =>
  message?.role === "assistant" ? (message as AssistantMessage).parts.map((part) => (part.type === "text" ? part.text : "")).join("") : ""

export async function roundThirtyOneChecks(check: Check, section: (name: string) => void): Promise<void> {
  const titles = process.env.MCODE_GENERATE_TITLES
  process.env.MCODE_GENERATE_TITLES = "0"
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r31-"))
  try {
    // --------------------------------------------------------------- R31-1
    section("Round 31 (1): the provider's x-should-retry has the last word")
    {
      const said = (value: string | undefined, status: number) =>
        retryKind(new ProviderHttpError("failed", status, value === undefined ? {} : { "x-should-retry": value }))
      check("a 503 the provider marks final is not retried", said("false", 503) === undefined, said("false", 503))
      check("a 400 the provider marks transient is retried", said("true", 400) !== undefined, said("true", 400))
      check("without the header the usual classification stands", said(undefined, 503) === "server" && said(undefined, 400) === undefined)
      check("a 401 marked transient is the provider's call to make", said("true", 401) !== undefined)
    }

    // --------------------------------------------------------------- R31-2
    section("Round 31 (2): a reply cut part-way is continued, not written again from the start")
    {
      /*
       * The link drops after "The answer is forty" has streamed. MCode used to
       * throw those words away and ask for the whole reply again; now they are
       * kept, and the next request carries them with OpenCode v2's note
       * asking for the rest, so the reply ends as one message.
       */
      const run = await harness(path.join(root, "cut"), [cutAfter("The answer is forty"), finish("-two.")])
      const stop = run.bus.subscribe((event) => {
        if (event.type === "message.updated" && (event.message as AssistantMessage & { retry?: unknown }).retry) setTimeout(() => wakeWaiters("r31 test"), 20)
      })
      try {
        const session = await run.store.create({ directory: run.project, model: { provider: "fake", model: "m" } })
        await run.runner.prompt({ sessionID: session.id, text: "What is the answer?" })
        await run.settled(session.id)
        const messages = await run.store.messages(session.id)
        const replies = messages.filter((message) => message.role === "assistant")
        check("the turn ends as one reply", replies.length === 1, replies.length)
        check("which reads as one piece, the words before the cut kept", textOf(replies[0]) === "The answer is forty-two.", textOf(replies[0]))
        check("two requests: the cut one and its continuation", run.bodies.length === 2, run.bodies.length)
        const second = JSON.parse(run.bodies[1] ?? "{}") as { messages?: { role?: string; content?: unknown }[] }
        const sent = (second.messages ?? []).map((message) => `${message.role}:${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`)
        check("the continuation carries what was already written", sent.some((line) => line.startsWith("assistant:") && line.includes("The answer is forty")), sent)
        check("and asks for the rest in OpenCode v2's words", sent.some((line) => line.startsWith("user:") && line.includes(INTERRUPTED_NOTE)), sent)
        check("the reply is not left in error", !(replies[0] as AssistantMessage | undefined)?.error, (replies[0] as AssistantMessage | undefined)?.error)
      } finally {
        stop()
        await run.close()
      }
    }

    {
      // Nothing had streamed: the request is simply sent again, as before, with no note.
      const run = await harness(path.join(root, "early"), [(request) => request.socket.destroy(), finish("Hello.")])
      const stop = run.bus.subscribe((event) => {
        if (event.type === "message.updated" && (event.message as AssistantMessage & { retry?: unknown }).retry) setTimeout(() => wakeWaiters("r31 test"), 20)
      })
      try {
        const session = await run.store.create({ directory: run.project, model: { provider: "fake", model: "m" } })
        await run.runner.prompt({ sessionID: session.id, text: "Hi" })
        await run.settled(session.id)
        const replies = (await run.store.messages(session.id)).filter((message) => message.role === "assistant")
        check("a request that failed before any word is simply sent again", replies.length === 1 && textOf(replies[0]) === "Hello.", replies.map(textOf))
        check("with no continuation note", !run.bodies.some((body) => body.includes(INTERRUPTED_NOTE)))
      } finally {
        stop()
        await run.close()
      }
    }
    // --------------------------------------------------------------- R31-4
    section("Round 31 (4): rolling compaction keeps the newest exchange word for word and updates its checkpoint")
    {
      /*
       * A provider that answers a summary request with OpenCode v2's
       * template and everything else with a short reply naming the turn, so
       * each request's contents can be read back afterwards.
       */
      const V2_SUMMARY = "## Objective\n- keep the probe going\n\n## Work State\n### Completed\n- (none)\n\n## Next Move\n1. (none)"
      const summaries: string[] = []
      const answer: Answer = (_request, response, body) => {
        const summarising = body.includes("You MUST use this format for your response")
        const reply = summarising ? (summaries.shift() ?? V2_SUMMARY) : "answered"
        finish(reply)(_request, response, body)
      }
      const run = await harness(path.join(root, "rolling"), Array.from({ length: 40 }, () => answer))
      try {
        const session = await run.store.create({ directory: run.project, model: { provider: "fake", model: "m" } })
        for (const text of ["FIRST question", "SECOND question", "THIRD question"]) {
          await run.runner.prompt({ sessionID: session.id, text })
          await run.settled(session.id)
        }
        const before = run.bodies.length
        await run.runner.compact(session.id)
        const asked = run.bodies[before] ?? ""
        check("the summary request carries the older exchanges", asked.includes("FIRST question") && asked.includes("SECOND question"))
        check("but not the newest, which is kept rather than summarised", !asked.includes("THIRD question"))
        check("and asks for a first summary, not an update", asked.includes("You MUST summarize the conversation above") && !asked.includes("Update the existing checkpoint"))
        const mark = (await run.store.get(session.id))?.compacted
        check("the newest exchange is stored word for word beside the summary", mark?.recent?.includes("[User]: THIRD question") === true && mark.recent.includes("[Assistant]: answered"), mark?.recent)
        check("and the summary is v2's", mark?.summary.startsWith("## Objective") === true, mark?.summary)

        await run.runner.prompt({ sessionID: session.id, text: "FOURTH question" })
        await run.settled(session.id)
        const next = run.bodies.at(-1) ?? ""
        check("the next request opens with the checkpoint", next.includes("<conversation-checkpoint>") && next.includes("<recent-context>"))
        check("which holds the newest exchange as it was said", next.includes("[User]: THIRD question"))
        check("and none of what the summary replaced", !next.includes("FIRST question") && !next.includes("SECOND question"))

        // A second compaction folds into the first rather than summarising a summary.
        await run.runner.prompt({ sessionID: session.id, text: "FIFTH question" })
        await run.settled(session.id)
        const again = run.bodies.length
        await run.runner.compact(session.id)
        const updated = run.bodies[again] ?? ""
        check("a second compaction asks to update the checkpoint", updated.includes("Update the existing checkpoint"))
        check("with that checkpoint in the request, its kept exchange now among what is summarised", updated.includes("<conversation-checkpoint>") && updated.includes("THIRD question"))
        check("and not the legacy rewrite, for a checkpoint already in v2's format", !updated.includes("earlier format"))
      } finally {
        await run.close()
      }

      // A reply that skips the template is reminded once, and a summary after the reminder is taken.
      const nudged = await harness(path.join(root, "nudge"), Array.from({ length: 20 }, () => answer))
      try {
        const session = await nudged.store.create({ directory: nudged.project, model: { provider: "fake", model: "m" } })
        for (const text of ["ONE", "TWO"]) {
          await nudged.runner.prompt({ sessionID: session.id, text })
          await nudged.settled(session.id)
        }
        summaries.push("Let me look at one more file first.", V2_SUMMARY)
        const before = nudged.bodies.length
        // Caught and reported, so a compaction that throws fails these checks instead of skipping them.
        const refused = await nudged.runner.compact(session.id).then(() => "", (error: Error) => error.message)
        check("the compaction is not refused", refused === "", refused)
        const second = nudged.bodies[before + 1] ?? ""
        check("a reply that skipped the template gets v2's reminder", second.includes(SUMMARY_NUDGE), second.slice(-400))
        check("and the summary written after it is taken", (await nudged.store.get(session.id))?.compacted?.summary.startsWith("## Objective") === true)
      } finally {
        await nudged.close()
      }

      /*
       * A summary request too long for the model is squeezed, not given up
       * on. The provider here refuses any summary request that still carries
       * the oldest exchange, as a real one refuses one over its window; MCode
       * used to stop at the first refusal.
       */
      const squeeze: Answer = (request, response, body) => {
        const summarising = body.includes("You MUST use this format for your response")
        if (summarising && body.includes("OLDEST exchange")) {
          response.writeHead(400, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: { message: "This model's maximum context length is 1000 tokens. However, your messages resulted in 2400 tokens." } }))
          return
        }
        finish(summarising ? V2_SUMMARY : "answered")(request, response, body)
      }
      const tight = await harness(path.join(root, "squeeze"), Array.from({ length: 40 }, () => squeeze))
      try {
        const session = await tight.store.create({ directory: tight.project, model: { provider: "fake", model: "m" } })
        const filler = " and some more words to give it weight".repeat(40)
        for (const text of [`OLDEST exchange${filler}`, `SECOND exchange${filler}`, `THIRD exchange${filler}`, `FOURTH exchange${filler}`, "NEWEST exchange"]) {
          await tight.runner.prompt({ sessionID: session.id, text })
          await tight.settled(session.id)
        }
        const before = tight.bodies.length
        const refused = await tight.runner.compact(session.id).then(() => "", (error: Error) => error.message)
        check("a summary request refused for length is squeezed and sent again, not given up on", refused === "" && (await tight.store.get(session.id))?.compacted !== undefined, refused)
        const attempts = tight.bodies.slice(before).filter((body) => body.includes("You MUST use this format for your response"))
        const accepted = attempts.at(-1) ?? ""
        check("the first attempt went whole, since it was estimated to fit", attempts.length >= 2 && !attempts[0]!.includes("older exchange"), attempts.length)
        check("the one taken dropped the oldest exchange and says how many went", !accepted.includes("OLDEST exchange") && /\[\d+ older exchanges? omitted\]/.test(accepted), accepted.slice(-600))
        check("and kept the newer ones, as a transcript", accepted.includes("[User]: FOURTH exchange"))
      } finally {
        await tight.close()
      }

      // A checkpoint in MCode's earlier format is rewritten once at v2's level of detail.
      check("a checkpoint in MCode's earlier format is recognised", legacySummary("## Task overview\n- old"))
      check("and the update prompt asks for it to be rewritten", summaryPrompt(true, true).includes("written with an earlier format"))
      check("which a first summary never does", !summaryPrompt(false, true).includes("earlier format"))
    }
    // --------------------------------------------------------------- R31-5
    section("Round 31 (5): a turn the app was cut off in carries on at the next start")
    {
      const run = await harness(path.join(root, "restart"), Array.from({ length: 30 }, () => finish("carried on")))
      try {
        const model = { provider: "fake", model: "m" }
        const dead = 999_999_999
        run.runner.alive = (pid) => pid === process.pid
        // A turn that ends clears its claim.
        const plain = await run.store.create({ directory: run.project, model })
        await run.runner.prompt({ sessionID: plain.id, text: "an ordinary question" })
        await run.settled(plain.id)
        check("a turn that ends leaves no claim behind", (await run.store.get(plain.id))?.claim === undefined, (await run.store.get(plain.id))?.claim)

        /*
         * The app went away mid-turn: the user's question is on disk, the reply
         * never finished, and the claim the turn wrote is still there.
         */
        const cutOff = async (claim: { at: number; resumes: number; pid?: number }, extra: Partial<Parameters<typeof run.store.update>[1]> = {}) => {
          const session = await run.store.create({ directory: run.project, model })
          await run.store.saveMessage({ id: `msg_${session.id}_q`, sessionID: session.id, role: "user", text: `CUT OFF question ${session.id}`, attachments: [], time: { created: Date.now() } })
          await run.store.update(session.id, { claim, ...extra })
          return session.id
        }
        const crashed = await cutOff({ at: Date.now() - 1000, resumes: 0, pid: dead })
        const other = await cutOff({ at: Date.now() - 1000, resumes: 0, pid: 424_242 })
        const tired = await cutOff({ at: Date.now() - 1000, resumes: 10, pid: dead })
        const child = await cutOff({ at: Date.now() - 1000, resumes: 0, pid: dead }, { parentID: plain.id })
        run.runner.alive = (pid) => pid === process.pid || pid === 424_242
        const before = run.bodies.length
        const carried = await run.runner.resumeClaimed()
        await run.settled(crashed)
        check("the cut-off turn is carried on", carried.includes(crashed), carried)
        const sent = run.bodies.slice(before).find((body) => body.includes(`CUT OFF question ${crashed}`)) ?? ""
        check("told the app restarted, in OpenCode v2's words", sent.includes("The app restarted while you were working"), sent.slice(-500))
        const replies = (await run.store.messages(crashed)).filter((message) => message.role === "assistant")
        check("and it runs to an answer", textOf(replies.at(-1)) === "carried on", replies.map(textOf))
        check("which releases its claim", (await run.store.get(crashed))?.claim === undefined)
        check("a claim whose process is still alive is another instance's turn, left alone", !carried.includes(other) && (await run.store.get(other))?.claim !== undefined)
        check("a turn cut off ten times in a row is left for the reader", !carried.includes(tired) && (await run.store.get(tired))?.claim === undefined)
        check("a subagent's claim is its parent's business, released and not carried on", !carried.includes(child) && (await run.store.get(child))?.claim === undefined)

        // The count goes up with each carrying-on, so a turn that keeps bringing the app down stops.
        const again = await cutOff({ at: Date.now(), resumes: 3, pid: dead })
        const bodies = run.bodies.length
        let seen: number | undefined
        const stop = run.bus.subscribe((event) => {
          if (event.type === "session.updated" && event.session.id === again && event.session.claim) seen ??= event.session.claim.resumes
        })
        await run.runner.resumeClaimed()
        await run.settled(again)
        stop()
        check("carrying a turn on counts it, before the turn runs", seen === 4 && run.bodies.length > bodies, seen)
      } finally {
        await run.close()
      }

      /*
       * The quit: a turn the app is closing under keeps its claim, where one
       * the reader stops releases it.
       */
      const hang: Answer = (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`)
      }
      const quit = await harness(path.join(root, "quit"), [hang, hang])
      try {
        const model = { provider: "fake", model: "m" }
        const stopped = await quit.store.create({ directory: quit.project, model })
        await quit.runner.prompt({ sessionID: stopped.id, text: "stop me" })
        await new Promise((resolve) => setTimeout(resolve, 300))
        check("a running turn holds a claim, with its process", (await quit.store.get(stopped.id))?.claim?.pid === process.pid, (await quit.store.get(stopped.id))?.claim)
        await quit.runner.abort(stopped.id)
        await quit.settled(stopped.id)
        check("Stop releases it: the reader ended that turn", (await quit.store.get(stopped.id))?.claim === undefined)

        const closing = await quit.store.create({ directory: quit.project, model })
        await quit.runner.prompt({ sessionID: closing.id, text: "the app closes on me" })
        await new Promise((resolve) => setTimeout(resolve, 300))
        quit.runner.closeTurns()
        await quit.runner.abort(closing.id)
        await quit.settled(closing.id)
        check("a turn the quit cuts off keeps it, for the next start", (await quit.store.get(closing.id))?.claim !== undefined)
      } finally {
        await quit.close()
      }
    }
    // --------------------------------------------------------------- R31-6
    section("Round 31 (6): an instruction change is told as a change, and the cached prompt stays")
    {
      const V2_SUMMARY = "## Objective\n- follow the rules\n\n## Next Move\n1. (none)"
      const answer: Answer = (request, response, body) =>
        finish(body.includes("You MUST use this format for your response") ? V2_SUMMARY : "answered")(request, response, body)
      const run = await harness(path.join(root, "instructions"), Array.from({ length: 30 }, () => answer))
      try {
        const agents = path.join(run.project, "AGENTS.md")
        await fs.writeFile(agents, "RULE ONE: write tests first.\n", "utf8")
        const session = await run.store.create({ directory: run.project, model: { provider: "fake", model: "m" } })
        const turn = async (text: string) => {
          await run.runner.prompt({ sessionID: session.id, text })
          await run.settled(session.id)
          const body = JSON.parse(run.bodies.at(-1) ?? "{}") as { messages?: { role?: string; content?: unknown }[] }
          const messages = body.messages ?? []
          const system = messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message.content)).join("\n")
          const last = JSON.stringify(messages.filter((message) => message.role === "user").at(-1)?.content ?? "")
          return { system, last }
        }
        const first = await turn("first")
        check("the first turn's prompt carries the project's instructions", first.system.includes("RULE ONE"))
        check("and tells of no change", !first.last.includes("instruction files have changed"))

        await fs.writeFile(agents, "RULE TWO: never skip review.\n", "utf8")
        const second = await turn("second")
        check("an edited AGENTS.md reaches the model now, not after a restart", second.last.includes("RULE TWO"), second.last.slice(0, 300))
        check("told as a change, at the message it happened before", second.last.includes("The project's instruction files have changed"))
        check("while the system prompt keeps its baseline, so the provider's cache is not started over", second.system.includes("RULE ONE") && !second.system.includes("RULE TWO"))

        const third = await turn("third")
        const reminded = (await run.store.messages(session.id)).filter((message) => message.role === "user" && (message.reminders ?? []).some((line) => line.includes("instruction files have changed")))
        check("nothing changed since: no second telling", reminded.length === 1 && !third.last.includes("have changed"), reminded.length)

        await fs.rm(agents)
        const fourth = await turn("fourth")
        check("instructions removed are said to no longer apply", fourth.last.includes("no longer apply"), fourth.last.slice(0, 300))

        // A compaction starts the prompt over, and its baseline with it.
        await run.runner.compact(session.id)
        const fifth = await turn("fifth")
        check("after a compaction the prompt is built from what the model was last told", !fifth.system.includes("RULE ONE") && !fifth.system.includes("RULE TWO"), fifth.system.slice(0, 200))
        const state = (await run.store.get(session.id))?.instructions
        check("and the baseline has moved to it", state !== undefined && state.initial.project === state.current.project && state.current.project === "", state)
      } finally {
        await run.close()
      }
    }
    // --------------------------------------------------------------- R31-7
    section("Round 31 (7): OpenCode v2's patch, for the models trained on it")
    {
      check("a GPT model edits with patch", usesPatch("gpt-5.1") && usesPatch("openai/gpt-5-codex"))
      check("GPT-4 and the open-weight gpt-oss do not", !usesPatch("gpt-4o") && !usesPatch("gpt-4.1") && !usesPatch("gpt-oss-120b"))
      check("nor any other family", !usesPatch("claude-sonnet-5") && !usesPatch("deepseek-v4.1-flash") && !usesPatch("qwen38-nvfp4"))
      const names = (model: string) => forModel(TOOLS, model).map((tool) => tool.name)
      check("patch stands in for edit and write", names("gpt-5.1").includes("patch") && !names("gpt-5.1").includes("edit") && !names("gpt-5.1").includes("write"))
      check("and is not offered beside them", !names("claude-sonnet-5").includes("patch") && names("claude-sonnet-5").includes("edit"))

      // What a real turn on a GPT model is offered.
      const run = await harness(path.join(root, "patch-offer"), [finish("ok")])
      try {
        const session = await run.store.create({ directory: run.project, model: { provider: "fake", model: "gpt-5.1" } })
        await run.runner.prompt({ sessionID: session.id, text: "hi" })
        await run.settled(session.id)
        const offered = ((JSON.parse(run.bodies.at(-1) ?? "{}") as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((tool) => tool.function?.name)
        const asked = JSON.parse(run.bodies.at(-1) ?? "{}") as { model?: string }
        check("a turn on a GPT model carries patch and not edit or write", offered.includes("patch") && !offered.includes("edit") && !offered.includes("write"), { model: asked.model, offered })
      } finally {
        await run.close()
      }

      // The tool itself, over a folder of its own.
      const folder = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r31-patch-"))
      const asked: { kind: string; preview?: string }[] = []
      const snapped: string[] = []
      const context = {
        sessionID: "ses_patch",
        messageID: "msg_patch",
        callID: "call_patch",
        directory: folder,
        permissions: { ask: async (question: { kind: string; preview?: string }) => void asked.push(question) },
        questions: { ask: async () => undefined },
        signal: new AbortController().signal,
        progress: () => {},
        snapshot: async (file: string) => void snapped.push(file),
      } as unknown as ToolContext
      try {
        await fs.writeFile(path.join(folder, "a.txt"), "one\r\ntwo\r\nthree\r\n", "utf8")
        await fs.writeFile(path.join(folder, "b.txt"), "move me\n", "utf8")
        await fs.writeFile(path.join(folder, "d.txt"), "gone soon\n", "utf8")
        const result = await PatchTool.execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Add File: new.txt",
              "+fresh",
              "*** Update File: a.txt",
              "@@ one",
              "-two",
              "+TWO",
              "*** Update File: b.txt",
              "*** Move to: sub/c.txt",
              "-move me",
              "+moved",
              "*** Delete File: d.txt",
              "*** End Patch",
            ].join("\n"),
          },
          context,
        )
        const read = (name: string) => fs.readFile(path.join(folder, name), "utf8").catch(() => undefined)
        check("a file is added", (await read("new.txt")) === "fresh\n")
        check("a file is updated, keeping its CRLF line endings", (await read("a.txt")) === "one\r\nTWO\r\nthree\r\n", JSON.stringify(await read("a.txt")))
        check("a file is moved with its change", (await read("sub/c.txt")) === "moved\n" && (await read("b.txt")) === undefined)
        check("a file is deleted", (await read("d.txt")) === undefined)
        check("and v2's own summary says which", result.output === "Success. Updated the following files:\nA new.txt\nM a.txt\nM sub/c.txt\nD d.txt", result.output)
        check("the whole patch is asked about once, as an edit", asked.length === 1 && asked[0]!.kind === "edit", asked.length)
        check("its preview shows every file", ["new.txt", "a.txt", "b.txt", "sub/c.txt", "d.txt"].every((name) => asked[0]!.preview?.includes(name)), asked[0]?.preview)
        check("every file is recorded for undo before it is touched", ["new.txt", "a.txt", "b.txt", "sub/c.txt", "d.txt"].every((name) => snapped.includes(path.join(folder, name))), snapped)
        const patchText = (result.metadata?.filediff as { patch?: string } | undefined)?.patch ?? ""
        const turn = {
          id: "m",
          sessionID: "s",
          role: "assistant",
          model: { provider: "p", model: "gpt-5.1" },
          agent: "build",
          time: { created: 0 },
          parts: [{ type: "tool", id: "t", callID: "c", name: "patch", status: "completed", input: {}, metadata: result.metadata, time: { created: 0, completed: 0 } }],
        } as unknown as Message
        const undoable = turnFilePaths(folder, [turn]).map((file) => path.relative(folder, file).replace(/\\/g, "/")).sort()
        check("撤销 finds every file the patch changed", JSON.stringify(undoable) === JSON.stringify(["a.txt", "b.txt", "d.txt", "new.txt", "sub/c.txt"]), undoable)
        check("the recorded diff is one section per file", parseUnifiedDiff(patchText).length === 5, parseUnifiedDiff(patchText).map((section) => section.file))
        // A file moved away or deleted was changed as surely as one written.
        check("and the conversation's record of changed files names them", sessionFiles([turn], folder).written.map((entry) => entry.path).sort().join() === "a.txt,b.txt,d.txt,new.txt,sub/c.txt", sessionFiles([turn], folder).written)

        // A patch that does not apply to one file changes none.
        asked.length = 0
        const failed = await PatchTool.execute(
          { patchText: ["*** Begin Patch", "*** Add File: never.txt", "+nope", "*** Update File: a.txt", "-not in the file", "+x", "*** End Patch"].join("\n") },
          context,
        ).then(() => "", (error: Error) => error.message)
        check("a hunk that does not match is refused", failed.includes("Failed to find expected lines"), failed)
        check("before anything is written or asked", (await read("never.txt")) === undefined && asked.length === 0)
        const malformed = await PatchTool.execute({ patchText: "*** Add File: x.txt\n+x" }, context).then(() => "", (error: Error) => error.message)
        check("a patch without its envelope is refused with what is missing", malformed.includes("*** Begin Patch"), malformed)
      } finally {
        await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    section("Round 31 (8): an MCP server's resources can be listed and read")
    {
      const home = path.join(root, "mcp-home")
      const project = path.join(root, "mcp-project")
      await fs.mkdir(project, { recursive: true })
      const serversFor = (mcpServers: Record<string, McpServerConfig>) => {
        const bus = new Bus()
        const value = { mcpServers, directory: project }
        const config = { get: () => value as unknown as AppConfig, set: async () => value as unknown as AppConfig }
        return new McpServers(bus, config as never, undefined, home)
      }
      const fixture = (name: string) => ({ type: "local" as const, command: ["node", path.join(process.cwd(), "scripts/fixtures", name)] })
      const asked: { kind?: string; scope?: string; title?: string }[] = []
      const context = {
        sessionID: "ses_r31_mcp",
        messageID: "msg_r31_mcp",
        callID: "call_r31_mcp",
        directory: project,
        permissions: { ask: async (input: { kind?: string; scope?: string; title?: string }) => void asked.push(input), action: () => "ask" },
        signal: new AbortController().signal,
        progress: () => {},
        snapshot: async () => {},
      } as unknown as ToolContext

      // A server that has no resources adds nothing: the request's tools stay as they were.
      const plain = serversFor({ plain: fixture("mcp-server.cjs") })
      try {
        await plain.start()
        const names = plain.tools(project).map((tool) => tool.name)
        check("without a server that has resources, neither tool is offered", names.length > 0 && !names.includes("list_mcp_resources") && !names.includes("read_mcp_resource"), names)
      } finally {
        await plain.close()
      }

      const mcp = serversFor({ plain: fixture("mcp-server.cjs"), res: fixture("mcp-resource-server.cjs") })
      try {
        await mcp.start()
        const tools = mcp.tools(project)
        const names = tools.map((tool) => tool.name)
        const tool = (name: string) => tools.find((entry) => entry.name === name)!
        check("with one, both are offered", names.includes("list_mcp_resources") && names.includes("read_mcp_resource"), names)
        check("after every server's own tools, so their cached order is untouched", names.slice(-2).join() === "list_mcp_resources,read_mcp_resource", names)

        const listed = await tool("list_mcp_resources").execute({}, context)
        check("listing follows the server's pages to the end", ["note://readme", "note://two", "img://dot", "doc://spec", "bin://archive"].every((uri) => listed.output.includes(uri)), listed.output)
        check("and names its templates", listed.output.includes("template record://{id}"), listed.output)
        check("a title and description are shown with the URI", listed.output.includes("note://readme - Read me (text/plain): What this fixture is"), listed.output)
        check("only servers that have resources are listed", listed.output.includes("## res") && !listed.output.includes("## plain"), listed.output)
        check("it is asked about under the server's own MCP approval", asked.length === 1 && asked[0]?.kind === "mcp" && asked[0]?.scope === "mcp:res", asked)
        const unknown = await tool("list_mcp_resources").execute({ server: "plain" }, context).then(() => "", (error: Error) => error.message)
        check("a server without resources is named in the refusal", unknown === 'MCP server "plain" is not connected or does not expose resources', unknown)

        const read = (uri: string) => tool("read_mcp_resource").execute({ server: "res", uri }, context)
        check("a text resource is read as its text", (await read("note://readme")).output === "The fixture's readme.")
        check("several parts are joined", (await read("note://two")).output === "first part\n\nsecond part")
        const picture = await read("img://dot")
        check("a picture is handed to the model as itself", picture.attachments?.length === 1 && picture.attachments[0]?.mime === "image/png" && picture.attachments[0]?.path === "img://dot", picture.attachments)
        const pdf = await read("doc://spec")
        check("so is a PDF", pdf.attachments?.[0]?.mime === "application/pdf", pdf.attachments)
        const archive = await read("bin://archive")
        check("other bytes are described, not dumped", !archive.attachments && archive.output.startsWith("[application/zip resource left out:"), archive)
        const missing = await read("note://nowhere").then(() => "", (error: Error) => error.message)
        check("a URI the server does not have says which, and why", missing.startsWith("Unable to read MCP resource res:note://nowhere:") && missing.includes("Resource not found"), missing)
        const nowhere = await tool("read_mcp_resource").execute({ server: "gone", uri: "x://y" }, context).then(() => "", (error: Error) => error.message)
        check("and an unknown server is refused before anything is asked", nowhere.includes('"gone" is not connected') && !asked.some((entry) => entry.scope === "mcp:gone"), nowhere)
      } finally {
        await mcp.close()
      }
    }
  } finally {
    if (titles === undefined) delete process.env.MCODE_GENERATE_TITLES
    else process.env.MCODE_GENERATE_TITLES = titles
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}
