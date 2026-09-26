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
import type { AssistantMessage, Message } from "../src/shared/protocol"
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
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }], directory: project })
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

      // A checkpoint in MCode's earlier format is rewritten once at v2's level of detail.
      check("a checkpoint in MCode's earlier format is recognised", legacySummary("## Task overview\n- old"))
      check("and the update prompt asks for it to be rewritten", summaryPrompt(true, true).includes("written with an earlier format"))
      check("which a first summary never does", !summaryPrompt(false, true).includes("earlier format"))
    }
  } finally {
    if (titles === undefined) delete process.env.MCODE_GENERATE_TITLES
    else process.env.MCODE_GENERATE_TITLES = titles
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}
