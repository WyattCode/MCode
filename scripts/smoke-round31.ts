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
import type { AppConfig, AssistantMessage, McpServerConfig, Message, QuestionPrompt, UserMessage, WebSearchProviderID, WebSearchSelection } from "../src/shared/protocol"
import { McpServers, codeModeTitle } from "../src/server/mcp"
import { checkEntry } from "../src/server/mcp-sources"
import { renderCatalog, searchCatalog, summarize, type CatalogTool } from "../src/server/codemode/catalog"
import { runScript } from "../src/server/codemode/sandbox"
import { jsonSchemaToTypeScript, toolExpression } from "../src/server/codemode/schema-ts"
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
import { systemPromptFrom } from "../src/server/session/prompt"
import { PatchTool } from "../src/server/tool/patch"
import { TOOLS, forModel, reachOf, toolsForTurn, usesPatch } from "../src/server/tool/registry"
import { NO_RESULTS, WEB_SEARCH_ENDPOINTS, WEB_SEARCH_PROVIDERS, WebSearchHttpError, cooldownMillis, resetWebSearch, searchWeb, webSearchText } from "../src/server/websearch"
import { WEB_SEARCH_ALLOW, WEB_SEARCH_CHOOSE, WEB_SEARCH_DISABLE, WebSearchTool } from "../src/server/tool/websearch"
import { language } from "../src/renderer/src/lib/i18n"
import { planHeader, planOptionDescription, planOptionLabel, planQuestionText } from "../src/renderer/src/lib/plan-question"
import { stepTitle, toolVerb } from "../src/renderer/src/lib/tool-meta"
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
  return { bus, store, runner, project, bodies, settled, close, config }
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
        check("and asks for the rest with the continuation note", sent.some((line) => line.startsWith("user:") && line.includes(INTERRUPTED_NOTE)), sent)
        check("the continuation explains that even an unfinished line is appended, never rewritten", sent.some((line) => line.startsWith("user:") && line.includes("appended verbatim") && line.includes("Do not restart or rewrite the unfinished line")))
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
    // --------------------------------------------------------------- R31-3
    section("Round 31 (3): a queued message waits for the turn, then goes as a turn of its own")
    {
      // An answer that starts, then waits to be let go: the turn is running for as long as the test needs.
      const gate = () => {
        let open: () => void = () => undefined
        const opened = new Promise<void>((resolve) => (open = resolve))
        const answer: Answer = (_request, response) => {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`)
          void opened.then(() => {
            if (response.writableEnded || response.destroyed) return
            response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`)
            response.write("data: [DONE]\n\n")
            response.end()
          })
        }
        return { answer, open: () => open() }
      }
      const refused: Answer = (_request, response) => {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }))
      }
      // The words of the newest user message a request carried.
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

      const first = gate()
      const run = await harness(path.join(root, "queue"), [first.answer])
      try {
        const session = await run.store.create({ directory: run.project, model: { provider: "fake", model: "m" } })
        await run.runner.prompt({ sessionID: session.id, text: "first task" })
        await until(() => run.bodies.length === 1)
        const [a, b] = await Promise.all([
          run.runner.prompt({ sessionID: session.id, text: "queued one", delivery: "queue" }),
          run.runner.prompt({ sessionID: session.id, text: "queued two", delivery: "queue" }),
        ])
        const waiting = (await run.store.require(session.id)).queued ?? []
        check("two queued at once are both kept, in order", waiting.map((item) => item.text).join() === "queued one,queued two" && waiting[0]?.id === a && waiting[1]?.id === b, waiting)
        check("and neither reaches the transcript or the model while the turn runs", !(await run.store.messages(session.id)).some((message) => message.role === "user" && message.text.startsWith("queued")) && run.bodies.length === 1)
        first.open()
        await until(() => run.bodies.length >= 3)
        await run.settled(session.id)
        check("when the turn ends, each goes out as a turn of its own, oldest first", run.bodies.length === 3 && lastUser(run.bodies[1]) === "queued one" && lastUser(run.bodies[2]) === "queued two", run.bodies.map(lastUser))
        const users = (await run.store.messages(session.id)).filter((message): message is UserMessage => message.role === "user")
        check("marked as sent from the queue, not steered into the turn", users.filter((message) => message.queued).map((message) => message.text).join() === "queued one,queued two" && users.every((message) => !message.steered), users.map((message) => [message.text, message.queued, message.steered]))
        check("and the queue is empty afterwards", (await run.store.require(session.id)).queued === undefined)

        // Queued while idle: nothing to wait for.
        const before = run.bodies.length
        await run.runner.prompt({ sessionID: session.id, text: "idle queue", delivery: "queue" })
        await run.settled(session.id)
        check("queued with nothing running, it is simply sent", run.bodies.length === before + 1 && lastUser(run.bodies.at(-1)) === "idle queue")
      } finally {
        await run.close()
      }

      // Stop leaves the queue for the user; 立即发送 and 删除 act on it.
      const held = gate()
      const stopped = await harness(path.join(root, "queue-stop"), [held.answer])
      try {
        const session = await stopped.store.create({ directory: stopped.project, model: { provider: "fake", model: "m" } })
        await stopped.runner.prompt({ sessionID: session.id, text: "long task" })
        await until(() => stopped.bodies.length === 1)
        const kept = await stopped.runner.prompt({ sessionID: session.id, text: "after stop", delivery: "queue" })
        const dropped = await stopped.runner.prompt({ sessionID: session.id, text: "never mind", delivery: "queue" })
        stopped.runner.abort(session.id)
        await stopped.settled(session.id)
        await new Promise((resolve) => setTimeout(resolve, 300))
        check("after Stop nothing queued is sent", stopped.bodies.length === 1 && ((await stopped.store.require(session.id)).queued ?? []).length === 2, stopped.bodies.length)
        await stopped.runner.removeQueued(session.id, dropped)
        check("删除 takes one back", ((await stopped.store.require(session.id)).queued ?? []).map((item) => item.text).join() === "after stop")
        const gone = await stopped.runner.removeQueued(session.id, dropped).then(
          () => "",
          (error: Error & { code?: string }) => error.code ?? error.message,
        )
        check("one already gone is said to be", gone === "error.queueGone", gone)
        await stopped.runner.sendQueuedNow(session.id, kept)
        await stopped.settled(session.id)
        check("立即发送 with nothing running starts its turn", stopped.bodies.length === 2 && lastUser(stopped.bodies[1]) === "after stop" && (await stopped.store.require(session.id)).queued === undefined)
      } finally {
        stopped.runner.abort("none")
        await stopped.close()
      }

      // R32: a conversation a review restricted during the turn takes nothing from its queue.
      const locking = gate()
      const locked = await harness(path.join(root, "queue-locked"), [locking.answer])
      try {
        const session = await locked.store.create({ directory: locked.project, model: { provider: "fake", model: "m" } })
        await locked.runner.prompt({ sessionID: session.id, text: "task" })
        await until(() => locked.bodies.length === 1)
        const waiting = await locked.runner.prompt({ sessionID: session.id, text: "after the review", delivery: "queue" })
        await locked.store.update(session.id, { reviewRestricted: true })
        locking.open()
        await locked.settled(session.id)
        await new Promise((resolve) => setTimeout(resolve, 300))
        check("a restricted conversation sends nothing it had queued", locked.bodies.length === 1 && ((await locked.store.require(session.id)).queued ?? []).length === 1, locked.bodies.length)
        const refusedNow = await locked.runner.sendQueuedNow(session.id, waiting).then(
          () => "",
          (error: Error & { code?: string }) => error.code ?? error.message,
        )
        check("and 立即发送 is refused there as a typed message is", refusedNow === "composer.reviewRestricted" && ((await locked.store.require(session.id)).queued ?? []).length === 1, refusedNow)
      } finally {
        await locked.close()
      }

      // 立即发送 while a turn runs joins it; a failed turn leaves the rest waiting.
      const joining = gate()
      const steer = await harness(path.join(root, "queue-steer"), [joining.answer, refused])
      try {
        const session = await steer.store.create({ directory: steer.project, model: { provider: "fake", model: "m" } })
        await steer.runner.prompt({ sessionID: session.id, text: "task" })
        await until(() => steer.bodies.length === 1)
        const now = await steer.runner.prompt({ sessionID: session.id, text: "join now", delivery: "queue" })
        await steer.runner.sendQueuedNow(session.id, now)
        const joined = (await steer.store.messages(session.id)).find((message) => message.role === "user" && message.text === "join now") as UserMessage | undefined
        check("立即发送 during a turn joins it, as a steer", joined?.steered === true && !joined.queued, joined)
        await steer.runner.prompt({ sessionID: session.id, text: "left waiting", delivery: "queue" })
        joining.open()
        await until(() => steer.bodies.length >= 2)
        await steer.settled(session.id)
        await new Promise((resolve) => setTimeout(resolve, 300))
        const after = (await steer.store.require(session.id)).queued ?? []
        check("a turn that fails leaves the queue waiting", after.map((item) => item.text).join() === "left waiting" && steer.bodies.length === 2, { after, bodies: steer.bodies.length })
      } finally {
        await steer.close()
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

        // R32: a move onto a file already there replaces it, and the recorded change says what it held - undo deletes a file recorded as created.
        await fs.writeFile(path.join(folder, "keep.txt"), "kept\n")
        await fs.writeFile(path.join(folder, "mover.txt"), "moving\n")
        const onto = await PatchTool.execute({ patchText: ["*** Begin Patch", "*** Update File: mover.txt", "*** Move to: keep.txt", "@@", "-moving", "+moved", "*** End Patch"].join("\n") }, context)
        const ontoDiff = String((onto.metadata as { diff?: string } | undefined)?.diff ?? "")
        check("a move onto an existing file records what that file held", ontoDiff.includes("-kept") && (await read("keep.txt")) === "moved\n" && (await read("mover.txt")) === undefined, ontoDiff)
        // R32: a file deleted and added again in one patch is recorded from nothing, not twice from what the disk still held.
        await fs.writeFile(path.join(folder, "again.txt"), "old\n")
        const again = await PatchTool.execute({ patchText: ["*** Begin Patch", "*** Delete File: again.txt", "*** Add File: again.txt", "+fresh", "*** End Patch"].join("\n") }, context)
        const againDiff = String((again.metadata as { diff?: string } | undefined)?.diff ?? "")
        check("a file deleted then added in one patch is recorded as gone, then new", (againDiff.match(/^-old$/gm) ?? []).length === 1 && (await read("again.txt")) === "fresh\n", againDiff)
        const self = await PatchTool.execute({ patchText: ["*** Begin Patch", "*** Update File: again.txt", "*** Move to: again.txt", "@@", "-fresh", "+same place", "*** End Patch"].join("\n") }, context)
        check("a move onto itself is an edit in place", (await read("again.txt")) === "same place\n" && !String((self.metadata as { diff?: string } | undefined)?.diff ?? "").includes("+++ /dev/null"), self.metadata)

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
    section("Round 31 (9): OpenCode v2's web search, asked once and kept")
    {
      // The five services' own keys are set aside for this section, so nothing the user set reaches the stand-in.
      const KEY_NAMES = WEB_SEARCH_PROVIDERS.map((provider) => provider.env)
      const savedKeys = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name]]))
      for (const name of KEY_NAMES) delete process.env[name]
      const savedEndpoints = { ...WEB_SEARCH_ENDPOINTS }
      type Seen = { service: string; headers: Record<string, string | string[] | undefined>; query: string; body: Record<string, unknown> }
      const seen: Seen[] = []
      // A status the stand-in answers with next, per service; 200 otherwise.
      const refuse: Record<string, { status: number; retryAfter?: string }[]> = {}
      const standIn = createServer((request, response) => {
        let raw = ""
        request.on("data", (chunk) => (raw += chunk))
        request.on("end", () => {
          const url = new URL(request.url ?? "/", "http://x")
          const service = url.pathname.slice(1)
          seen.push({ service, headers: request.headers, query: url.search, body: JSON.parse(raw || "{}") as Record<string, unknown> })
          const refusal = refuse[service]?.shift()
          if (refusal) {
            response.writeHead(refusal.status, refusal.retryAfter ? { "retry-after": refusal.retryAfter } : {})
            return void response.end("{}")
          }
          const rpc = (result: unknown, sse = false) => {
            const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result })
            response.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" })
            response.end(sse ? `event: message\ndata: ${payload}\n\n` : payload)
          }
          if (service === "exa")
            rpc(
              {
                content: [
                  {
                    type: "text",
                    text: "Title: Exa one\nURL: https://exa.example/1\nPublished: 2026-09-01T00:00:00.000Z\nText: first body\n\n---\n\nTitle: N/A\nURL: https://exa.example/2\nPublished: N/A\nHighlights:\nsecond body",
                  },
                ],
              },
              true,
            )
          else if (service === "firecrawl") rpc({ content: [{ type: "text", text: JSON.stringify({ success: true, data: { web: [{ url: "https://fc.example/", title: "FC", description: "fc body" }] } }) }] })
          else if (service === "parallel")
            rpc({ content: [{ type: "text", text: "" }], structuredContent: { search_id: "s", session_id: "x", results: [{ url: "https://pl.example/", title: "PL", publish_date: "2026-01-02", excerpts: ["a", "b"] }] } })
          else if (service === "tinyfish") rpc({ content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://tf.example/", title: "TF", snippet: "tf body" }] }) }] })
          else if (service === "tavily") {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify({ results: [{ url: "https://tv.example/", title: "TV", content: "tv body" }] }))
          } else {
            response.writeHead(404)
            response.end()
          }
        })
      })
      await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", () => resolve()))
      const base = `http://127.0.0.1:${(standIn.address() as { port: number }).port}`
      for (const provider of WEB_SEARCH_PROVIDERS) WEB_SEARCH_ENDPOINTS[provider.id] = `${base}/${provider.id}`
      try {
        const signal = new AbortController().signal
        const named = (id: WebSearchProviderID, env: Record<string, string> = {}) => searchWeb("mcode", { selection: id, sessionID: "s", signal, env })
        resetWebSearch()

        // Each service is asked the way v2 asks it, and read back into the same shape.
        const exa = await named("exa")
        const exaCall = seen.at(-1)!
        check(
          "Exa is called as an MCP tool, answered as server-sent events",
          exaCall.body.method === "tools/call" && (exaCall.body.params as { name?: string }).name === "web_search_exa" && exa.results.length === 2,
          { exaCall, exa },
        )
        check(
          "its blocks keep their title, date and text; N/A is left out",
          exa.results[0]?.title === "Exa one" &&
            exa.results[0]?.published === Date.parse("2026-09-01T00:00:00.000Z") &&
            exa.results[0]?.content === "first body" &&
            exa.results[1]?.title === undefined &&
            exa.results[1]?.content === "second body",
          exa.results,
        )
        check("without a key, nothing names one", exaCall.query === "")
        await named("exa", { EXA_API_KEY: "exa-test-key" })
        check("with one, Exa takes it in the address", seen.at(-1)!.query === "?exaApiKey=exa-test-key")
        const tavily = await named("tavily")
        check(
          "Tavily is asked keyless unless it has a key",
          seen.at(-1)!.headers["x-tavily-access-mode"] === "keyless" && !seen.at(-1)!.headers.authorization && tavily.results[0]?.content === "tv body",
          seen.at(-1)!.headers,
        )
        await named("tavily", { TAVILY_API_KEY: "tv-test-key" })
        check("and by bearer when it does", seen.at(-1)!.headers.authorization === "Bearer tv-test-key" && !seen.at(-1)!.headers["x-tavily-access-mode"])
        await named("tinyfish", { TINYFISH_API_KEY: "tf-test-key" })
        check("TinyFish takes its key in its own header", seen.at(-1)!.headers["x-api-key"] === "tf-test-key")
        const firecrawl = await named("firecrawl")
        const parallel = await named("parallel")
        check(
          "Firecrawl and Parallel are read too",
          firecrawl.results[0]?.title === "FC" && parallel.results[0]?.content === "a\n\nb" && parallel.results[0]?.published === Date.parse("2026-01-02"),
          { firecrawl, parallel },
        )
        const text = webSearchText(exa.results)
        check(
          "results reach the model as v2 writes them",
          text.startsWith("## [Exa one](https://exa.example/1)\nPublished: 2026-09-01T00:00:00.000Z\n\nfirst body\n\n## [https://exa.example/2](https://exa.example/2)"),
          text,
        )
        check("and no results say so", webSearchText([]) === NO_RESULTS)

        // "auto": the conversation keeps its service; a 429 sets it aside as long as it asked.
        resetWebSearch()
        let clock = 1_000_000
        // The service that answered, or what was thrown - so a search that fails is a failed check, not the end of the round.
        const auto = (sessionID: string) =>
          searchWeb("mcode", { selection: "auto", sessionID, signal, env: {}, now: () => clock, random: () => 0 }).then(
            (found) => found.provider as string,
            (error: unknown) => `threw ${String(error)}`,
          )
        const first = await auto("a")
        const again = await auto("a")
        check("an automatic search keeps the conversation's service", first === "exa" && again === "exa", [first, again])
        refuse.exa = [{ status: 429, retryAfter: "30" }]
        const moved = await auto("a")
        check("a 429 moves it to another service", moved !== "exa" && !moved.startsWith("threw"), moved)
        const stays = await auto("a")
        check("which it keeps while the first is set aside", stays === moved && !stays.startsWith("threw"), stays)
        clock += 31_000
        const other = await auto("b")
        check("the set-aside service comes back once its time is up", other === "exa", other)
        resetWebSearch()
        for (const provider of WEB_SEARCH_PROVIDERS) refuse[provider.id] = [{ status: 429 }]
        const exhausted = await searchWeb("mcode", { selection: "auto", sessionID: "c", signal, env: {}, now: () => clock, random: () => 0 }).then(
          () => undefined,
          (error: unknown) => error,
        )
        check("when every service refuses, the last refusal is reported", exhausted instanceof WebSearchHttpError && exhausted.status === 429, String(exhausted))
        check("after asking each service once", WEB_SEARCH_PROVIDERS.every((provider) => refuse[provider.id]?.length === 0))
        refuse.tavily = [{ status: 401 }]
        const unauthorised = await named("tavily").then(
          () => undefined,
          (error: unknown) => error,
        )
        check("a named service's refusal is not passed to another", unauthorised instanceof WebSearchHttpError && unauthorised.status === 401)
        check(
          "cooldowns are read in seconds or as a date",
          cooldownMillis("5", 0) === 5000 && cooldownMillis(new Date(60_000).toUTCString(), 0) === 60_000 && cooldownMillis("soon", 0) === 60_000,
        )

        // The tool: asked once, kept, and turned off for good.
        resetWebSearch()
        let stored: WebSearchSelection | undefined
        const questions: unknown[][] = []
        const permissionAsks: { kind?: string; subject?: string }[] = []
        let answer: string[][] = []
        const toolContext = (subagent = false) =>
          ({
            sessionID: "ses_ws",
            messageID: "msg_ws",
            callID: `call_${questions.length}_${permissionAsks.length}`,
            directory: root,
            subagent,
            signal,
            permissions: { ask: async (input: { kind?: string; subject?: string }) => void permissionAsks.push(input) },
            questions: {
              ask: async (input: { questions: unknown[] }) => {
                questions.push(input.questions)
                await new Promise((resolve) => setTimeout(resolve, 20))
                return [answer.shift() ?? []]
              },
            },
            webSearch: { selection: () => stored, select: async (value: WebSearchSelection) => void (stored = value) },
            progress: () => {},
            snapshot: async () => {},
          }) as unknown as ToolContext
        const search = (query: string, subagent = false) =>
          WebSearchTool.execute({ query }, toolContext(subagent)).then(
            (result) => result,
            (error: Error) => error,
          )

        const early = await search("from a subagent", true)
        check("a subagent cannot ask, so it is refused until the user has chosen", early instanceof Error && early.message.includes("main conversation") && questions.length === 0, String(early))
        answer = [["Allow"]]
        const [one, two] = await Promise.all([search("first"), search("second")])
        check("the first search asks once, even when two run together", questions.length === 1 && !(one instanceof Error) && !(two instanceof Error), { questions: questions.length, one, two })
        check("allowing keeps automatic search in the settings", stored === "auto")
        const consent = questions[0]?.[0] as QuestionPrompt | undefined
        check(
          "the question is tagged for the window to word",
          consent?.websearch === "consent" && JSON.stringify(consent.options.map((option) => option.label)) === JSON.stringify([WEB_SEARCH_ALLOW, WEB_SEARCH_CHOOSE, WEB_SEARCH_DISABLE]),
          consent,
        )
        check("with nothing to type in", consent?.custom === false, consent)
        await search("third")
        check("and is not asked again", questions.length === 1)
        check(
          "each search is asked about in the network bucket, naming the query",
          permissionAsks.length === 3 && permissionAsks.every((entry) => entry.kind === "webfetch") && permissionAsks.at(-1)?.subject === "third",
          permissionAsks,
        )
        const result = (await search("fourth")) as { output: string; title?: string; metadata?: { provider?: string } }
        check("the result is the service's findings, titled with the query", result.title === "fourth" && result.output.startsWith("## [") && typeof result.metadata?.provider === "string", result)

        stored = undefined
        questions.length = 0
        answer = [["Choose another provider"], ["Tavily"]]
        const picked = (await search("picked")) as { metadata?: { provider?: string } }
        const second = questions[1]?.[0] as QuestionPrompt | undefined
        check(
          "choosing asks which service, by name",
          questions.length === 2 && second?.websearch === "provider" && second.options.map((option) => option.label).join() === "Exa,Firecrawl,Parallel,Tavily,TinyFish",
          second,
        )
        check("and searches with that one from then on", stored === "tavily" && picked.metadata?.provider === "tavily", { stored, picked })

        stored = undefined
        questions.length = 0
        answer = [[]]
        const dismissed = await search("dismissed")
        check("a question left unanswered searches nothing and keeps nothing", dismissed instanceof Error && stored === undefined, String(dismissed))
        answer = [["Disable web search"]]
        const off = await search("off")
        check("turning it off is kept, and the model is told not to search", off instanceof Error && off.message.includes("turned web search off") && stored === false, String(off))
        refuse.tavily = [{ status: 401 }]
        stored = "tavily"
        const denied = await search("denied")
        check("a refusal is named as v2 names it", denied instanceof Error && denied.message === "Web search authentication failed (HTTP 401) [Tavily]", String(denied))
        // R32: a service name typed by hand that this build does not know is asked about again, not failed on every search.
        stored = "google" as WebSearchSelection
        questions.length = 0
        answer = [["Allow"]]
        const retold = await search("unknown value")
        check("a setting naming an unknown service is asked about again", questions.length === 1 && stored === "auto" && !(retold instanceof Error), { questions: questions.length, stored, retold: String(retold) })

        // Offered last, and not at all once turned off.
        // R36's app tool came after it; websearch is still after everything that came before it.
        check("websearch comes after every earlier tool, so every cached order stays", TOOLS.at(-2)?.name === "websearch" && TOOLS.at(-1)?.name === "app")
        const offered = (webSearch?: boolean) => toolsForTurn("build", { voiceFeedback: false, webSearch }).map((tool) => tool.name)
        check("it is offered until the user turns it off", offered(undefined).includes("websearch") && offered(true).includes("websearch") && !offered(false).includes("websearch"))
        check("it counts as a tool that only reads", reachOf("websearch") === "reads")
        const run = await harness(path.join(root, "websearch-offer"), [finish("ok"), finish("ok")])
        try {
          const offeredNow = async () => {
            const session = await run.store.create({ directory: run.project, model: { provider: "fake", model: "m" } })
            await run.runner.prompt({ sessionID: session.id, text: "hi" })
            await run.settled(session.id)
            return ((JSON.parse(run.bodies.at(-1) ?? "{}") as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((tool) => tool.function?.name)
          }
          check("a turn carries it", (await offeredNow()).includes("websearch"))
          await run.config.set({ websearch: false })
          check("and a turn after it was turned off does not", !(await offeredNow()).includes("websearch"))
        } finally {
          await run.close()
        }

        // The window says both questions in the user's language.
        const before = language.value
        language.value = "zh-CN"
        try {
          check("the consent question is the window's own", planQuestionText(consent!) === "允许 MCode 联网搜索最新信息吗？" && planHeader(consent!) === "网络搜索", planQuestionText(consent!))
          check("its options too", planOptionLabel(consent!, "Allow") === "允许" && planOptionLabel(consent!, "Disable web search") === "关闭网络搜索")
          check(
            "naming the services",
            planOptionDescription(consent!, consent!.options[0]!) === "搜索词会发送给 Exa, Firecrawl, Parallel, Tavily, TinyFish",
            planOptionDescription(consent!, consent!.options[0]!),
          )
          check("the service question is too, and its names stay", planQuestionText(second!) === "选择用于网络搜索的服务。" && planOptionLabel(second!, "Tavily") === "Tavily")
          check("the row says what it did", toolVerb("websearch", "completed") === "已搜索网络" && toolVerb("websearch", "running") === "正在搜索网络")
        } finally {
          language.value = before
        }
      } finally {
        Object.assign(WEB_SEARCH_ENDPOINTS, savedEndpoints)
        for (const [name, value] of Object.entries(savedKeys)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
        resetWebSearch()
        await new Promise<void>((resolve) => standIn.close(() => resolve()))
      }
    }

    section("Round 31 (10): OpenCode v2's system prompt, where MCode's lacked it")
    {
      // The rest of v2's harness prompt MCode's already says; its per-family prompts replace the identity, so they are not taken.
      const prompt = systemPromptFrom("build", { standing: "", project: "", skills: "" })
      check("shell chains are not padded with separator lines", prompt.includes('Do not pad such a chain with separator lines like `echo "===="`'))
    }

    section("Round 31 (11): Code Mode - a server's tools called from a sandboxed script")
    {
      const home = path.join(root, "cm-home")
      const project = path.join(root, "cm-project")
      await fs.mkdir(project, { recursive: true })
      const serversFor = (mcpServers: Record<string, McpServerConfig>) => {
        const value = { mcpServers, directory: project }
        const config = { get: () => value as unknown as AppConfig, set: async () => value as unknown as AppConfig }
        return new McpServers(new Bus(), config as never, undefined, home)
      }
      const fixture = { type: "local" as const, command: ["node", path.join(process.cwd(), "scripts/fixtures/mcp-server.cjs")] }
      const asked: { kind?: string; scope?: string; title?: string }[] = []
      const context = (signal = new AbortController().signal) =>
        ({
          sessionID: "ses_r31_cm",
          messageID: "msg_r31_cm",
          callID: "call_r31_cm",
          directory: project,
          permissions: { ask: async (input: { kind?: string; scope?: string; title?: string }) => void asked.push(input), action: () => "ask" },
          signal,
          progress: () => {},
          snapshot: async () => {},
        }) as unknown as ToolContext

      const off = serversFor({ plain: fixture })
      try {
        await off.start()
        const names = off.tools(project).map((tool) => tool.name)
        check("Code Mode is off unless a server turns it on", names.includes("plain_add") && !names.includes("execute"), names)
      } finally {
        await off.close()
      }

      const mcp = serversFor({ plain: fixture, calc: { ...fixture, codemode: true } })
      try {
        await mcp.start()
        const tools = mcp.tools(project)
        const names = tools.map((tool) => tool.name)
        check("its tools leave the list, and one execute tool is offered last", !names.some((name) => name.startsWith("calc_")) && names.includes("plain_add") && names.at(-1) === "execute", names)
        const execute = tools.find((tool) => tool.name === "execute")!
        check(
          "the catalog is on its description, with v2's signatures",
          execute.description.includes("# Code Mode") && execute.description.includes("- calc (2 tools)") && execute.description.includes("tools.calc.add({") && execute.description.includes("// Adds two numbers.") && execute.description.includes("The catalog is complete"),
          execute.description,
        )
        const run = (code: string, signal?: AbortSignal) =>
          execute.execute({ code }, context(signal)).then(
            (result) => result,
            (error: Error) => ({ output: `THREW ${error.message}`, metadata: undefined, title: undefined }),
          )

        const composed = await run(`const [sum, said] = await Promise.all([tools.calc.add({ a: 2, b: 3 }), tools.calc.echo({ text: "hi" })])\nconsole.log("sum was", sum)\nreturn { sum: Number(sum) * 10, said }`)
        check("a script calls tools together and composes their results", composed.output.startsWith('{\n  "sum": 50,\n  "said": "hi"\n}'), composed.output)
        check("what it logged comes back after the result", composed.output.includes("Logs:\nsum was 5"), composed.output)
        const recorded = (composed.metadata as { toolCalls?: { tool: string; status: string }[] } | undefined)?.toolCalls ?? []
        check("the step is titled by the tools the script called, not by its source", composed.title === "calc.add, calc.echo" && codeModeTitle(["a.x", "a.y", "a.x", "b.z", "c.w"]) === "a.x, a.y, b.z +1", composed.title)
        check(
          "and the window shows that title",
          stepTitle({ type: "tool", name: "execute", input: { code: "return 1" }, title: "calc.add", status: "completed" } as never) === "calc.add",
        )
        check("each call is recorded", recorded.map((call) => `${call.tool}:${call.status}`).sort().join() === "calc.add:completed,calc.echo:completed", recorded)
        check("and each is asked about under the server's approval, as a direct call is", asked.length === 2 && asked.every((entry) => entry.kind === "mcp" && entry.scope === "mcp:calc"), asked)

        const sealed = await run(`return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof XMLHttpRequest, typeof tools.plain]`)
        check("the sandbox reaches no module, process, network or timer, nor a server left out of it", sealed.output.replace(/\s/g, "") === '["undefined","undefined","undefined","undefined","undefined","undefined"]', sealed.output)
        const thrown = await run(`throw new Error("boom")`)
        check("an error is the result, marked as one", thrown.output.startsWith("Error: boom") && (thrown.metadata as { error?: boolean } | undefined)?.error === true, thrown)
        const found = await run(`return search({ query: "echo" }).items[0].path`)
        check("search works inside a script, without await", found.output === "tools.calc.echo", found.output)
        const plain = await run(`return 1 + 1`)
        check("a plain value comes back as JSON", plain.output === "2", plain.output)
      } finally {
        await mcp.close()
      }

      // The sandbox's limits, on their own.
      const host = { tools: new Set(["s\u0000t"]), search: () => ({}), call: async () => new Promise<unknown>(() => undefined) }
      const spin = await runScript("while (true) {}", host, { limits: { timeoutMs: 200 } })
      check("a script that never stops is stopped at its time limit", !spin.ok && spin.error.includes("time limit"), spin)
      const waiting = await runScript("return await tools.s.t({})", host, { limits: { timeoutMs: 300 } })
      check("so is one waiting on a call that never answers", !waiting.ok && waiting.error.includes("time limit"), waiting)
      const counted = await runScript("for (let i = 0; i < 3; i++) await tools.s.t({})", { ...host, call: async () => "ok" }, { limits: { maxToolCalls: 2 } })
      check("calls past the limit are refused", !counted.ok && counted.error.includes("at most 2 calls"), counted)
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)
      const stopped = await runScript("return await tools.s.t({})", host, { signal: controller.signal })
      check("Stop ends a running script", !stopped.ok && stopped.error === "The script was stopped.", stopped)
      const syntax = await runScript("return (", host)
      check("a script that does not parse says so", !syntax.ok && syntax.error.includes("SyntaxError"), syntax)
      // A short limit: were the bridge reachable, the call below would wait on the host for ever.
      const unknown = await runScript('return await globalThis.__mcode_call?.("s", "t", "{}") ?? "gone"', host, { limits: { timeoutMs: 1000 } })
      check("the host's own bridge is not left where a script can reach it", unknown.ok && unknown.value === "gone", unknown)

      // A catalog too large for its budget points at search.
      const many: CatalogTool[] = Array.from({ length: 60 }, (_, at) => ({
        segments: ["big", `tool_${String(at).padStart(2, "0")}`],
        description: `Does thing number ${at} with a fairly long description that takes room`,
        inputSchema: { type: "object", properties: { id: { type: "string", description: "Which one" } }, required: ["id"] },
      }))
      const summary = summarize(many)
      check("past about 2,000 tokens the catalog is partial", summary.shown > 0 && summary.shown < 60 && summary.total === 60, [summary.shown, summary.total])
      const rendered = renderCatalog(summary)
      check("and says to search, with search's signature", rendered.includes("The catalog is partial") && rendered.includes("- search(input?:") && rendered.includes(`- big (60 tools, ${summary.shown} shown)`), rendered.slice(0, 600))
      const hit = searchCatalog(many, { query: "tool_42" })
      check("search finds a tool by name first", hit.items[0]?.path === "tools.big.tool_42", hit.items.slice(0, 2))
      const page = searchCatalog(many, { namespace: "big", limit: 5 })
      check("and pages through a namespace", page.items.length === 5 && page.remaining === 55 && page.next?.offset === 5, [page.items.length, page.remaining, page.next])
      check(
        "schemas render as TypeScript",
        jsonSchemaToTypeScript({ type: "object", properties: { mode: { enum: ["a", "b"] }, tags: { type: "array", items: { type: "string" } }, "odd-key": { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["mode"] }) ===
          '{ mode: "a" | "b"; tags?: Array<string>; "odd-key"?: string | null }',
        jsonSchemaToTypeScript({ type: "object", properties: { mode: { enum: ["a", "b"] }, tags: { type: "array", items: { type: "string" } }, "odd-key": { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["mode"] }),
      )
      check("names that are not identifiers are bracketed", toolExpression(["my-server", "resolve-id"]) === 'tools["my-server"]["resolve-id"]')
      check("codemode must be true or false in the config", "invalid" in checkEntry({ type: "local", command: ["x"], codemode: "yes" }) && "config" in checkEntry({ type: "local", command: ["x"], codemode: true }))
    }
  } finally {
    if (titles === undefined) delete process.env.MCODE_GENERATE_TITLES
    else process.env.MCODE_GENERATE_TITLES = titles
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}
