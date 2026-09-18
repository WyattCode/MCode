/**
 * Round 5: the turn loop, the providers, the context and the prompt, measured
 * against MiMo's engine. Kept apart from smoke.ts so the sections read as one
 * account; smoke.ts calls `roundFiveChecks` with its own check and section.
 *
 * Every request a provider would receive is inspected on the wire or through
 * the pure function that builds it. No model is called.
 */
import { LARGE_OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX, isOverflowByCount, maxOutputTokens, usableContext } from "../src/server/session/overflow"
import { reasoningRequest as anthropicReasoning } from "../src/server/provider/anthropic"
import { costOf } from "../src/server/session/usage"
import { usageOf } from "../src/server/provider/openai"
import { RETRY_BUDGETS, retryDecision, retryHint, retryKind } from "../src/server/session/retry"
import { ProviderError, ProviderHttpError, systemText } from "../src/server/provider/types"
import { ABORTED_TOOL, INTERRUPTED_RESULT, requestHistory } from "../src/server/provider/history"
import { toMessages } from "../src/server/provider/openai"
import { repeatsCall } from "../src/server/session/reminders"
import { UNTITLED, clampTitle, cleanTitle, fallbackTitle } from "../src/server/session/title"
import { providerExtras, samplingFor } from "../src/server/provider/sampling"
import { modelVariants } from "../src/server/provider/variants"
import { OpenAICompatible, cacheMarked, withCacheMarks } from "../src/server/provider/openai"
import { verbose } from "../src/server/provider/chatgpt"
import { interfaceLocale, localeName } from "../src/server/session/locale"
import { messagesRequest } from "../src/server/provider/anthropic"
import { ChatGPTSubscription } from "../src/server/provider/chatgpt"
import { TOOLS } from "../src/server/tool/registry"
import { execFileSync } from "node:child_process"
import { attachmentParts, fittedImage, imageFit, imageSize, setImageShrinker } from "../src/server/provider/attachment-parts"
import { isSummary, touchedFiles } from "../src/server/session/summary"
import { claudeCallID, forWire, mistralCallID } from "../src/server/provider/wire-ids"
import { AnthropicAdapter, toProviderMessages } from "../src/server/provider/anthropic"
import { systemPrompt } from "../src/server/session/prompt"
// plan: the plan file's name, as the runner builds it.
import { planFile, slugOf } from "../src/server/session/plan"
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import type { AssistantMessage, CustomProvider, Message, ServerEvent } from "../src/shared/protocol"

export type Check = (name: string, condition: boolean, detail?: unknown) => void

/** One scripted answer from the fake provider, given the request body. */
type Reply = (response: ServerResponse, body: Record<string, any>) => void | Promise<void>

const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`

/** What the fake answers a summary request with unless told otherwise: MCode's sections, in their tags. */
const DEFAULT_SUMMARY = "<summary>\n## Task overview\n- probe task\n\n## Current state\n- probe done\n\n## Next steps\n1. finish the probe\n</summary>"

/** A streamed text answer, OpenAI chat-completions shape. */
export const say =
  (text: string, finish = "stop", usage = { prompt_tokens: 10, completion_tokens: 5 }): Reply =>
  (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(frame({ choices: [{ delta: { content: text } }] }))
    response.end(frame({ choices: [{ delta: {}, finish_reason: finish }], usage }) + "data: [DONE]\n\n")
  }

/** A streamed set of tool calls. */
export const calls =
  (list: { name: string; input: Record<string, unknown> }[], text = ""): Reply =>
  (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (text) response.write(frame({ choices: [{ delta: { content: text } }] }))
    list.forEach((entry, index) =>
      response.write(frame({ choices: [{ delta: { tool_calls: [{ index, id: `call_r5_${Math.random().toString(36).slice(2, 8)}`, function: { name: entry.name, arguments: JSON.stringify(entry.input) } }] } }] })),
    )
    response.end(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n")
  }

/** An HTTP failure with headers and a JSON body. */
export const failure =
  (status: number, headers: Record<string, string>, body: unknown): Reply =>
  (response) => {
    response.writeHead(status, { "content-type": "application/json", ...headers })
    response.end(JSON.stringify(body))
  }

/**
 * The real runner over a fake OpenAI-compatible provider: every request body
 * is kept, and each request takes the next scripted reply (a plain "done" when
 * none is left).
 */
export async function engine(options: { custom?: Partial<CustomProvider>; language?: string } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r5-"))
  const project = path.join(dir, "project")
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, "README.md"), "# round five\n")
  const replies: Reply[] = []
  const bodies: Record<string, any>[] = []
  const headers: IncomingHttpHeaders[] = []
  const paths: string[] = []
  /* Title requests go apart: they run beside a turn's own, and would otherwise take its scripted replies. */
  const titleBodies: Record<string, any>[] = []
  const titles: string[] = []
  /* Summary requests go apart too, answered from their own queue: a reply's text, or a scripted reply. */
  const summaryBodies: Record<string, any>[] = []
  const summaries: (string | Reply)[] = []
  /* Set to hold a title reply back until a check has done what it needs first. */
  const hold: { gate?: Promise<void> } = {}
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", async () => {
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {}
      if (JSON.stringify(body.messages?.[0]?.content ?? body.system ?? "").includes("title of a conversation")) {
        titleBodies.push(body)
        await hold.gate
        return say(titles.shift() ?? "A probe title")(response, body)
      }
      const lastMessage = (body.messages as Record<string, unknown>[] | undefined)?.at(-1)
      if (JSON.stringify(lastMessage?.content ?? "").includes("this conversation is about to be compacted")) {
        summaryBodies.push(body)
        const next = summaries.shift() ?? DEFAULT_SUMMARY
        return (typeof next === "string" ? say(next) : next)(response, body)
      }
      bodies.push(body)
      headers.push(request.headers)
      paths.push(request.url ?? "")
      await (replies.shift() ?? say("done"))(response, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as { port: number }).port
  const storage = new Storage(path.join(dir, "data", "storage"))
  const bus = new Bus()
  const events: ServerEvent[] = []
  /** When each event was published, by its index in `events`. */
  const times: number[] = []
  bus.subscribe((event) => {
    events.push(event)
    times.push(Date.now())
  })
  const config = new Config(storage, bus, path.join(dir, "data", "credentials.json"))
  await config.load()
  await config.set({
    customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }], ...options.custom }],
    directory: project,
    ...(options.language ? { language: options.language } : {}),
  })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const model = { provider: "fake", model: "m" }
  const idle = (sessionID: string, quiet = 200) =>
    new Promise<void>((resolve) => {
      const deadline = Date.now() + 30_000
      const look = () => {
        if (runner.busySessions().includes(sessionID) && Date.now() < deadline) return void setTimeout(look, 25)
        setTimeout(() => (runner.busySessions().includes(sessionID) && Date.now() < deadline ? look() : resolve()), quiet)
      }
      setTimeout(look, 25)
    })
  const until = async (test: () => boolean | Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }
  const assistants = async (sessionID: string) =>
    (await store.messages(sessionID)).filter((message): message is AssistantMessage => message.role === "assistant")
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return { dir, project, replies, bodies, headers, paths, titleBodies, titles, hold, summaryBodies, summaries, events, times, storage, bus, config, permissions, store, runner, model, idle, until, assistants, close, port }
}

/** The text of a request's messages, for looking for something in it. */
export function wireText(body: Record<string, any> | undefined): string {
  return JSON.stringify(body?.messages ?? body ?? {})
}

export type { Message }

export async function roundFiveChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 5: max output tokens (E15)")
  {
    check("a Claude model is asked for 128k whatever its ceiling", maxOutputTokens({ provider: "anthropic", model: "claude-haiku-4-5" }, { maxOutput: 64_000 }) === LARGE_OUTPUT_TOKEN_MAX)
    check("so is a GPT model on any provider", maxOutputTokens({ provider: "openrouter", model: "openai/gpt-5.5" }, undefined) === LARGE_OUTPUT_TOKEN_MAX)
    check("and anything on a MiMo provider", maxOutputTokens({ provider: "xiaomi", model: "anything" }, { maxOutput: 8_000 }) === LARGE_OUTPUT_TOKEN_MAX)
    check("another model keeps a smaller ceiling of its own", maxOutputTokens({ provider: "lmstudio", model: "qwen3" }, { maxOutput: 16_000 }) === 16_000)
    check("but no more than 32k", maxOutputTokens({ provider: "lmstudio", model: "qwen3" }, { maxOutput: 100_000 }) === OUTPUT_TOKEN_MAX)
    check("and 32k when its ceiling is unknown", maxOutputTokens({ provider: "lmstudio", model: "qwen3" }, { maxOutput: 0 }) === OUTPUT_TOKEN_MAX)
    const budgeted = anthropicReasoning("claude-haiku-4-5", "max", ["high", "max"], 20_000, 64_000)
    check(
      "a thinking budget is cut from the model's own limit and kept under max_tokens",
      budgeted.thinking?.type === "enabled" && budgeted.thinking.budget_tokens === 19_999,
      budgeted,
    )
    const high = anthropicReasoning("claude-haiku-4-5", "high", ["high", "max"], 64_000, 64_000)
    check("high is min(16000, limit / 2 - 1)", high.thinking?.type === "enabled" && high.thinking.budget_tokens === 16_000, high)
  }

  section("Round 5: the compaction trigger (E9)")
  {
    check("a 200k model compacts at 180k, not 168k", usableContext({ contextWindow: 200_000 }) === 180_000, usableContext({ contextWindow: 200_000 }))
    check("an unknown window never compacts by count", usableContext({ contextWindow: 0 }) === 0)
    const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    check("179,999 tokens is under the line", !isOverflowByCount({ ...zero, input: 100_000, cacheRead: 79_999 }, { contextWindow: 200_000 }))
    check("180,000 reaches it, reasoning and cache writes counted", isOverflowByCount({ ...zero, input: 100_000, reasoning: 30_000, cacheWrite: 50_000 }, { contextWindow: 200_000 }))
  }

  section("Round 5: usage and cost for cached and reasoning tokens (E11)")
  {
    const million = { input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
    const priced = costOf(million, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    check("cache reads and writes have their own prices and reasoning is billed as output", Math.abs(priced - 61.75) < 1e-9, priced)
    check("a missing cache price counts as nothing", Math.abs(costOf(million, { input: 5, output: 25 }) - 55) < 1e-9)
    check("a model with no pricing costs nothing", costOf(million, undefined) === 0)
    const local = usageOf({ prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 } }, "lmstudio")
    check(
      "a chat-completions prompt count no longer bills its cached tokens as fresh input",
      local.input === 600 && local.cacheRead === 400 && local.output === 300 && local.reasoning === 0,
      local,
    )
    const routed = usageOf(
      { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 50 } },
      "openrouter",
    )
    check(
      "OpenRouter's cache writes and reasoning are split out as well",
      routed.input === 500 && routed.cacheWrite === 100 && routed.output === 250 && routed.reasoning === 50,
      routed,
    )
  }

  section("Round 5: retry budgets per kind, Retry-After honoured (E14)")
  {
    const limited = new ProviderHttpError("Rate limited", 429, { "retry-after": "12" })
    check("a 429 is a rate limit", retryKind(limited) === "rate_limit")
    check("its retry-after seconds are the wait", retryDecision(limited, 1, 0)?.wait === 12_000, retryDecision(limited, 1, 0))
    check("retry-after-ms wins over it", retryHint(new ProviderHttpError("x", 429, { "retry-after-ms": "250.4", "retry-after": "9" })) === 251)
    check("a wait named in words is honoured", retryHint(new Error("Rate limit reached, please try again in 20s")) === 20_000)
    check("a named wait past five minutes is held there", retryHint(new Error("try again in 2 hours")) === 5 * 60_000)
    check("a server error's hint is held to thirty seconds", retryDecision(new ProviderHttpError("busy", 503, { "retry-after": "600" }), 1, 0)?.wait === 30_000)
    check("a rate limit may wait up to five minutes", retryDecision(new ProviderHttpError("slow", 429, { "retry-after": "600" }), 1, 0)?.wait === 5 * 60_000)
    const server = new ProviderHttpError("busy", 500, {})
    const first = retryDecision(server, 1, 0, 0.5)
    check("a server error first waits two seconds, give or take a tenth", first?.wait === 2000 && retryDecision(server, 1, 0, 1)?.wait === 2200 && retryDecision(server, 1, 0, 0)?.wait === 1800, [first, retryDecision(server, 1, 0, 1), retryDecision(server, 1, 0, 0)])
    check("nothing is retried past a kind's deadline", retryDecision(server, 2, RETRY_BUDGETS.server.deadline) === undefined)
    check("a rate limit gives up after five attempts", retryDecision(limited, 5, 0) !== undefined && retryDecision(limited, 6, 0) === undefined)
    check("a refused key and a 400 are never retried", [401, 400, 422, 402, 501].every((status) => retryDecision(new ProviderHttpError("no", status, {}), 1, 0) === undefined))
    check("an upstream stream failure is a stream kind", retryKind(new ProviderError("boom", undefined, undefined, { type: "upstream_error" })) === "stream")
    // MiMo reads both fields of the parsed body, not the wording: a service_unavailable_error that is server_is_overloaded.
    const overloaded = new ProviderHttpError("overloaded", 503, {}, { type: "service_unavailable_error", code: "server_is_overloaded" })
    check("GPT's overload answer is tried at once, three times at most", retryDecision(overloaded, 1, 0)?.wait === 0 && retryDecision(overloaded, 4, 0) === undefined, retryDecision(overloaded, 1, 0))

    // On the wire: a 429 with retry-after-ms, then an answer.
    const e = await engine()
    try {
      e.replies.push(failure(429, { "retry-after-ms": "150" }, { error: { message: "slow down", type: "rate_limit_error" } }))
      const session = await e.store.create({ directory: e.project, model: e.model })
      const before = e.events.length
      await e.runner.prompt({ sessionID: session.id, text: "hello" })
      await e.idle(session.id)
      const rows = e.events.flatMap((event, index) =>
        index >= before && event.type === "message.updated" && event.message.role === "assistant" && event.message.retry
          ? [{ ...event.message.retry, waited: event.message.retry.next - (e.times[index] ?? 0) }]
          : [],
      )
      const last = (await e.assistants(session.id)).at(-1)
      check(
        "the retry row names the kind and waits what the provider asked",
        rows.length === 1 && rows[0]?.kind === "rate_limit" && rows[0].waited >= 140 && rows[0].waited <= 400,
        rows,
      )
      check("the turn went on after the named wait", e.bodies.length === 2 && last?.finish === "end_turn", { requests: e.bodies.length, finish: last?.finish })

      /*
       * A failure while a tool call's arguments were still streaming IS
       * replayed. MiMo's retrySafe turns false on the assembled tool-call
       * event, not on the input-start or the deltas before it, and nothing has
       * run yet - tools execute after the stream returns.
       */
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_half", function: { name: "read", arguments: "" } }] } }] }))
        response.end(frame({ error: { message: "upstream broke", type: "upstream_error" } }))
      })
      const sent = e.bodies.length
      await e.runner.prompt({ sessionID: session.id, text: "read it" })
      await e.idle(session.id)
      const broken = (await e.assistants(session.id)).at(-1)
      check("a step cut off while a tool call was still streaming is sent again", e.bodies.length === sent + 2 && broken?.finish === "end_turn", { requests: e.bodies.length - sent, finish: broken?.finish })
    } finally {
      await e.close()
    }
  }

  section("Round 5: plan mode writes one file and leaves through a question (E5)")
  {
    const e = await engine()
    try {
      // Writing is allowed outright, so what refuses a write here is the plan rule and nothing else.
      await e.config.set({ permissions: { ...e.config.get().permissions, write: "allow", edit: "allow" } })
      const session = await e.store.create({ directory: e.project, model: e.model, agent: "plan" })
      const plan = planFile({ directory: e.project, dataRoot: path.join(e.dir, "data", "storage"), repo: false }, { created: session.created, slug: slugOf(session) })
      const planName = path.basename(plan)

      /*
       * Read off the newest user message's notes rather than the whole wire:
       * every request replays the conversation, so the first turn's long note
       * is in all of them, and only the notes on this turn's own message say
       * what this turn was told.
       */
      const told = async () => {
        const messages = await e.store.messages(session.id)
        const last = messages.filter((message) => message.role === "user").at(-1)
        return last?.role === "user" ? (last.context ?? []).join("\n\n") : ""
      }

      e.replies.push(say("reading first"))
      await e.runner.prompt({ sessionID: session.id, text: "plan the work" })
      await e.idle(session.id)
      const firstTurn = await told()
      check(
        "a conversation's first planning turn is told the rules and where its plan goes",
        firstTurn.includes("Plan mode is on.") && firstTurn.includes("No plan file exists yet") && firstTurn.includes(planName),
        firstTurn.slice(0, 300),
      )
      check("and the note reaches the model with the message", wireText(e.bodies.at(-1)).includes("Plan mode is on."))
      check("and its folder is made, so the first write lands", await fs.stat(path.dirname(plan)).then(() => true, () => false))

      // A write anywhere else is refused before anyone is asked, and nothing appears on disk.
      e.replies.push(calls([{ name: "write", input: { file_path: "src/app.ts", content: "export const x = 1\n" } }]))
      await e.runner.prompt({ sessionID: session.id, text: "write the code" })
      await e.idle(session.id)
      const writes = (await e.assistants(session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.name === "write")
      const refusal = writes.at(-1)
      check(
        "a write outside the plan file is refused while planning",
        refusal?.type === "tool" && refusal.status === "error" && refusal.errorCode === "tool.err.planOnly",
        refusal,
      )
      check("and the file is not there", await fs.stat(path.join(e.project, "src", "app.ts")).then(() => false, () => true))
      check("the model is told where it may write instead", refusal?.type === "tool" && String(refusal.error).includes(planName), refusal?.type === "tool" ? refusal.error : undefined)

      // The plan file itself goes through.
      e.replies.push(calls([{ name: "write", input: { file_path: plan, content: "# the plan\n\n1. do it\n" } }]))
      await e.runner.prompt({ sessionID: session.id, text: "write the plan" })
      await e.idle(session.id)
      check("the plan file is written", (await fs.readFile(plan, "utf8").catch(() => "")).includes("# the plan"))
      const laterTurn = await told()
      check("a later planning turn gets the one-line reminder, not the long one", laterTurn.includes("Plan mode is still on") && !laterTurn.includes("Plan mode is on."), laterTurn.slice(0, 200))

      const asked = () => e.events.flatMap((event) => (event.type === "question.asked" ? [event.request] : []))

      // No keeps the conversation planning.
      const before = asked().length
      e.replies.push(calls([{ name: "plan_exit", input: {} }]))
      void e.runner.prompt({ sessionID: session.id, text: "is it ready" })
      check("plan_exit raises a question", await e.until(() => asked().length > before))
      const first = asked().at(-1)!
      check("the card is tagged with the plan file, so the window can name it and open it", first.questions[0]?.plan === path.relative(e.project, plan).split(path.sep).join("/") || first.questions[0]?.plan === plan, first.questions[0])
      check("with a Yes and a No, and nothing to fill in", first.questions[0]?.options.map((option) => option.label).join() === "Yes,No", first.questions[0]?.options)
      e.runner.questions.reply(first.id, [["No"]])
      await e.idle(session.id)
      check("No leaves the conversation planning", (await e.store.require(session.id)).agent === "plan")
      const staying = (await e.assistants(session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.name === "plan_exit").at(-1)
      check("and the model is told to keep refining rather than to build", staying?.type === "tool" && String(staying.output).includes("do not start implementing"), staying?.type === "tool" ? staying.output : undefined)

      // Yes switches the conversation and leaves the approval where the user's next message would be.
      const second = asked().length
      e.replies.push(calls([{ name: "plan_exit", input: {} }]))
      /*
       * Round 10 (T10-14, the user's decision of 2026-09-17): as MiMo, the
       * approved plan is carried out in the same run. MiMo picks each step's
       * agent from the latest user message, and the approval is one from the
       * build agent, so the next step builds - and may write.
       */
      e.replies.push(calls([{ name: "write", input: { file_path: "src/eager.ts", content: "export const eager = 1\n" } }]))
      // Asked again in build mode, plan_exit has nothing to do and asks nobody.
      e.replies.push(calls([{ name: "plan_exit", input: {} }]))
      e.replies.push(say("building"))
      void e.runner.prompt({ sessionID: session.id, text: "now is it ready" })
      check("plan_exit asks again", await e.until(() => asked().length > second))
      const approving = asked().at(-1)!
      e.runner.questions.reply(approving.id, [["Yes"]])
      await e.idle(session.id)
      check("Yes switches the conversation to build", (await e.store.require(session.id)).agent === "build")
      const approvedExit = (await e.assistants(session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.name === "plan_exit").at(-2)
      check(
        "and tells the model to carry the plan out now rather than to wait",
        approvedExit?.type === "tool" && String(approvedExit.output).includes("carry the plan out") && !String(approvedExit.output).includes("wait"),
        approvedExit?.type === "tool" ? approvedExit.output : undefined,
      )
      const eager = (await e.assistants(session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.name === "write").at(-1)
      check("the next step of the same run writes, and the file is there", eager?.type === "tool" && eager.status === "completed" && (await fs.stat(path.join(e.project, "src", "eager.ts")).then(() => true, () => false)), eager)
      const replies = await e.assistants(session.id)
      check("that step ran as build", Boolean(eager) && replies.find((message) => message.parts.some((part) => part.id === eager?.id))?.agent === "build")
      const asking = asked().length
      const again = replies.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.name === "plan_exit").at(-1)
      check(
        "plan_exit called again after the switch asks nobody and says there is nothing to leave",
        asking === second + 1 && again?.type === "tool" && again.status === "completed" && String(again.output).includes("not in plan mode"),
        { asked: asking - second, output: again?.type === "tool" ? again.output : undefined },
      )
      const approval = (await e.store.messages(session.id)).filter((message) => message.role === "user").at(-1)
      check(
        "the approval is the word that build mode is on and which plan to carry out, marked as the app's rather than the user's",
        approval?.role === "user" && approval.synthetic === true && approval.text.includes("approved") && approval.text.includes("build mode") && approval.text.includes(planName),
        approval,
      )

      // The run already built, so the next turn carries no planning note at all.
      e.replies.push(say("still building"))
      await e.runner.prompt({ sessionID: session.id, text: "carry on" })
      await e.idle(session.id)
      check("and the turn after that is told nothing about planning at all", !(await told()).includes("plan mode to build mode") && !(await told()).includes("Plan mode"), (await told()).slice(0, 200))
    } finally {
      await e.close()
    }
  }

  section("Round 5: interrupted tool calls stay in history (E17)")
  {
    const user = (id: string, text: string): Message => ({ id, sessionID: "s", role: "user", text, attachments: [], time: { created: 1 } })
    const reply = (id: string, parts: AssistantMessage["parts"]): Message => ({
      id,
      sessionID: "s",
      role: "assistant",
      model: { provider: "p", model: "m" },
      agent: "build",
      parts,
      time: { created: 2 },
    })
    const tool = (callID: string, status: "pending" | "running" | "error" | "completed", extra: Record<string, unknown> = {}) =>
      ({ type: "tool", id: callID, callID, name: "bash", status, input: { command: "x" }, time: { created: 1 }, ...extra }) as AssistantMessage["parts"][number]

    const wire = toMessages("sys", [user("u1", "run it"), reply("a1", [tool("call_run", "running")])]) as Record<string, any>[]
    check(
      "a call left running is sent with its call and an interrupted result",
      wire.some((m) => m.role === "assistant" && m.tool_calls?.[0]?.id === "call_run") && wire.some((m) => m.role === "tool" && m.tool_call_id === "call_run" && m.content === INTERRUPTED_RESULT),
      wire,
    )
    const kept = requestHistory([user("u1", "go"), reply("a1", [tool("call_kept", "error", { error: ABORTED_TOOL, output: "half the log", metadata: { interrupted: true } })])])
    const keptPart = kept[1]?.role === "assistant" ? kept[1].parts[0] : undefined
    check("an interrupted call that had output hands the model that output", keptPart?.type === "tool" && keptPart.status === "completed" && keptPart.output === "half the log", keptPart)
    const trailing = requestHistory([user("u1", "hi"), reply("a1", [{ type: "text", id: "t", text: "Hello." }])])
    check("a conversation ending on the model's words gets a trailing Continue.", trailing.length === 3 && trailing[2]?.role === "user" && trailing[2].text === "Continue.", trailing)
    const blank = requestHistory([user("u1", "hi"), reply("a1", [{ type: "text", id: "t", text: "  " }])])
    check("a trailing reply with nothing in it is dropped instead", blank.length === 1 && blank[0]?.role === "user", blank)
    const empty = requestHistory([user("u1", "")])
    check("a user message with nothing to send says Continue.", empty[0]?.role === "user" && empty[0].text === "Continue.", empty)
    const afterTools = requestHistory([user("u1", "hi"), reply("a1", [tool("call_done", "completed", { output: "ok" })])])
    check("a reply that ends on a call is answered by its result, not by Continue.", afterTools.length === 2, afterTools)

    // Settled in storage at the next prompt, and sent as aborted.
    const e = await engine()
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.store.saveMessage({ id: "msg_r5_u", sessionID: session.id, role: "user", text: "start", attachments: [], time: { created: 1 } })
      await e.store.saveMessage({ ...(reply("msg_r5_a", [tool("call_stuck", "running")]) as AssistantMessage), sessionID: session.id, finish: "aborted" })
      await e.runner.prompt({ sessionID: session.id, text: "carry on" })
      await e.idle(session.id)
      const stored = (await e.assistants(session.id)).find((message) => message.id === "msg_r5_a")?.parts[0]
      check(
        "the next prompt stores the unfinished call as aborted and interrupted",
        stored?.type === "tool" && stored.status === "error" && stored.error === ABORTED_TOOL && stored.metadata?.interrupted === true && stored.metadata?.aborted === true,
        stored,
      )
      const sentTools = (e.bodies[0]?.messages ?? []).filter((m: Record<string, unknown>) => m.role === "tool")
      check("and the model reads it as a call that did not complete", sentTools.length === 1 && sentTools[0].content === ABORTED_TOOL, sentTools)
    } finally {
      await e.close()
    }
  }

  section("Round 5: messages sent during a turn are framed for the model (E16)")
  {
    const e = await engine()
    try {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      e.replies.push(async (response, body) => {
        await gate
        calls([{ name: "glob", input: { pattern: "*" } }])(response, body)
      })
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "look around" })
      await e.until(() => e.bodies.length === 1)
      await e.runner.prompt({ sessionID: session.id, text: "STEER: also check the tests" })
      release()
      await e.idle(session.id)
      const second = wireText(e.bodies[1])
      check(
        "the next step carries the message inside a note that it was sent mid-task",
        e.bodies.length >= 2 && second.includes("system-reminder") && second.includes("while you were working") && second.includes("STEER: also check the tests"),
        second.slice(-600),
      )
      check("the first request had nothing to frame", !wireText(e.bodies[0]).includes("while you were working"))
      const stored = (await e.store.messages(session.id)).find((message) => message.role === "user" && message.text.startsWith("STEER"))
      check("the transcript keeps the words as typed", stored?.role === "user" && stored.text === "STEER: also check the tests", stored)
    } finally {
      await e.close()
    }
  }

  section("Round 5: loop detection asks the user (E13)")
  {
    const tool = (callID: string, status: "pending" | "running", input: Record<string, unknown>) =>
      ({ type: "tool", id: callID, callID, name: "glob", status, input, time: { created: 1 } }) as AssistantMessage["parts"][number] & { type: "tool" }
    const same = [tool("a", "running", { path: ".", depth: 1 }), tool("b", "running", { path: ".", depth: 1 }), tool("c", "running", { path: ".", depth: 1 })]
    check("the third identical call in a row is a repeat", repeatsCall(same, same[2]!))
    check("two are not", !repeatsCall(same.slice(0, 2), same[1]!))
    const differs = [same[0]!, tool("b2", "running", { path: "src", depth: 1 }), same[2]!]
    check("a different input breaks the run", !repeatsCall(differs, same[2]!))
    const broken = [same[0]!, { type: "text", id: "t", text: "hmm" } as AssistantMessage["parts"][number], same[1]!, same[2]!]
    check("so does any part in between", !repeatsCall(broken, same[2]!))

    const e = await engine()
    try {
      const asked = () => e.events.flatMap((event) => (event.type === "question.asked" && event.request.loop ? [event.request] : []))
      const listThrice = calls([0, 1, 2].map(() => ({ name: "glob", input: { pattern: "*" } })))
      const session = await e.store.create({ directory: e.project, model: e.model })

      e.replies.push(listThrice)
      await e.runner.prompt({ sessionID: session.id, text: "LOOP once" })
      check("the third identical call puts a question to the user", await e.until(() => asked().length === 1), asked())
      const first = asked()[0]
      check("naming the tool, with the once / always / reject answers", first?.loop?.tool === "glob" && first.questions[0]?.options.map((option) => option.label).join() === "once,always,reject", first)
      if (first) e.runner.questions.reply(first.id, [["once"]])
      await e.idle(session.id)
      let parts = (await e.assistants(session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool")
      check("once lets the call run", parts.length === 3 && parts.every((part) => part.type === "tool" && part.status === "completed"), parts.map((part) => part.type === "tool" && part.status))

      e.replies.push(listThrice)
      await e.runner.prompt({ sessionID: session.id, text: "LOOP reject" })
      await e.until(() => asked().length === 2)
      const second = asked()[1]
      if (second) e.runner.questions.reply(second.id, [["reject"]])
      await e.idle(session.id)
      const refused = (await e.assistants(session.id)).at(-1)
      const refusedCall = refused?.parts.filter((part) => part.type === "tool").at(-1)
      check("a refusal stops the call and the turn", refused?.finish === "aborted" && refusedCall?.type === "tool" && refusedCall.status === "error" && String(refusedCall.error).includes("repeated"), refused)

      e.replies.push(listThrice)
      await e.runner.prompt({ sessionID: session.id, text: "LOOP always" })
      await e.until(() => asked().length === 3)
      const third = asked()[2]
      if (third) e.runner.questions.reply(third.id, [["always"]])
      await e.idle(session.id)
      e.replies.push(listThrice)
      await e.runner.prompt({ sessionID: session.id, text: "LOOP again" })
      await e.idle(session.id)
      check("always lets that tool repeat for the rest of the conversation", asked().length === 3, asked().length)

      // Three steps making the very same call bring a note, in the request only.
      const one = calls([{ name: "glob", input: { pattern: "src-none/*" } }])
      e.replies.push(one, one, one)
      const sent = e.bodies.length
      const steps = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: steps.id, text: "STEPS" })
      await e.idle(steps.id)
      const fourth = wireText(e.bodies[sent + 3])
      check("the fourth request carries the same-steps note", fourth.includes("last three steps made exactly the same tool calls"), fourth.slice(-400))
      check("the third did not", !wireText(e.bodies[sent + 2]).includes("last three steps made exactly the same tool calls"))
      const storedSteps = (await e.store.messages(steps.id)).find((message) => message.role === "user")
      check("and the transcript is untouched", storedSteps?.role === "user" && storedSteps.text === "STEPS")
    } finally {
      await e.close()
    }
  }

  section("Round 5: auto-continue after truncated, empty or text-form tool-call output (E12)")
  {
    const e = await engine()
    const quiet = (finish: string): Reply => (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(frame({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 0 } }) + "data: [DONE]\n\n")
    }
    const turn = async (text: string) => {
      const session = await e.store.create({ directory: e.project, model: e.model })
      const from = e.bodies.length
      await e.runner.prompt({ sessionID: session.id, text })
      await e.idle(session.id)
      return { sent: e.bodies.slice(from), last: (await e.assistants(session.id)).at(-1), all: await e.assistants(session.id) }
    }
    try {
      e.replies.push(say("first half", "length"))
      let run = await turn("LENGTH once")
      check(
        "a reply cut at the output limit is continued, with a note after it",
        run.sent.length === 2 && wireText(run.sent[1]).includes("reached the output limit") && run.last?.finish === "end_turn",
        { requests: run.sent.length, finish: run.last?.finish },
      )
      check("the note is in the request only", run.all.length === 2 && !(await e.store.messages(run.all[0]!.sessionID)).some((m) => m.role === "user" && m.text.includes("output limit")))

      e.replies.push(say("1", "length"), say("2", "length"), say("3", "length"), say("4", "length"))
      run = await turn("LENGTH four")
      check("three continuations, then the step ends on the output limit", run.sent.length === 4 && run.last?.finish === "max_tokens" && run.last.errorCode === "error.outputLength", { requests: run.sent.length, last: run.last })

      e.replies.push(say('<function_calls><invoke name="read"><parameter name="path">a.ts</parameter></invoke></function_calls>', "tool_calls"))
      run = await turn("TEXT TOOL")
      check(
        "tool calls written as prose are asked for again as real calls",
        run.sent.length === 2 && wireText(run.sent[1]).includes("real tool call") && run.all[0]?.error !== undefined && run.last?.finish === "end_turn",
        { requests: run.sent.length, first: run.all[0]?.error, finish: run.last?.finish },
      )

      e.replies.push(quiet("stop"))
      run = await turn("EMPTY once")
      check("an empty reply is asked to answer", run.sent.length === 2 && wireText(run.sent[1]).includes("no answer and no tool call") && run.last?.finish === "end_turn", { requests: run.sent.length, finish: run.last?.finish })

      e.replies.push(quiet("stop"), quiet("stop"), quiet("stop"))
      run = await turn("EMPTY thrice")
      check("twice, then it ends as no usable output", run.sent.length === 3 && run.last?.finish === "error" && run.last.errorCode === "error.emptyOutput", { requests: run.sent.length, last: run.last })

      e.replies.push(say("", "content_filter"))
      run = await turn("FILTERED")
      check("a content-filter finish ends the turn in error", run.sent.length === 1 && run.last?.finish === "refusal" && String(run.last.error).includes("content filter"), run.last)
    } finally {
      await e.close()
    }
  }

  section("Round 5: generated titles (E6)")
  {
    check("the fallback is the first non-empty line", fallbackTitle("\n  \n  Fix the login bug  \nand more") === "Fix the login bug")
    check("then the attachments' names", fallbackTitle("   ", [{ path: "C:/work/report.pdf" }, { path: "shot.png" }]) === "report.pdf, shot.png")
    check("then untitled", fallbackTitle("", []) === UNTITLED)
    const long = "x".repeat(60)
    check("48 code points at most, ending in an ellipsis", clampTitle(long) === `${"x".repeat(47)}\u2026` && [...clampTitle("\u{1F600}".repeat(50))].length === 48, clampTitle(long))
    check("quotes and a title prefix are taken off", cleanTitle('Title: "Fix the login bug"') === "Fix the login bug" && cleanTitle("「修复登录问题」") === "修复登录问题")
    check("reasoning tags go, and the first line is the title", cleanTitle("<think>hmm</think>\nRename the users table\nextra") === "Rename the users table")
    check(
      "tool calls, JSON, markup, placeholders, ids and titles with no letters are refused",
      [
        '<tool_call>{"name":"x"}</tool_call>',
        '{"name": "set_title", "arguments": {}}',
        "<div>Hi</div>",
        "New session",
        "未命名",
        "ses_01ABCDEF",
        "1234 !!",
        "to=functions.title",
      ].every((raw) => cleanTitle(raw) === undefined),
    )
    check("trailing punctuation is kept", cleanTitle("Why does the build fail?") === "Why does the build fail?")

    const e = await engine({ language: "de" })
    try {
      e.titles.push("Deploy pipeline repair")
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "The deploy pipeline fails on step three\nplease look" })
      const fallback = await e.store.get(session.id)
      check("the first prompt sets the fallback at once", fallback?.title === "The deploy pipeline fails on step three" && fallback.titleSource === "fallback", fallback)
      await e.idle(session.id)
      check("and the generated title replaces it", await e.until(async () => (await e.store.get(session.id))?.title === "Deploy pipeline repair"), await e.store.get(session.id))
      check("once", (await e.store.get(session.id))?.titleSource === "generated" && e.titleBodies.length === 1, e.titleBodies.length)
      const asked = wireText(e.titleBodies[0])
      check("the request quotes the first message as data, with the interface language as a hint", asked.includes("The deploy pipeline fails") && asked.includes("<conversation>") && asked.includes("prefer de"), asked.slice(0, 500))
      await e.runner.prompt({ sessionID: session.id, text: "second message" })
      await e.idle(session.id)
      check("a later prompt asks for no title", e.titleBodies.length === 1)

      // A rename made while the title is being written wins.
      let release: () => void = () => {}
      e.hold.gate = new Promise<void>((resolve) => (release = resolve))
      e.titles.push("Too late")
      const renamed = await e.store.create({ directory: e.project, model: e.model })
      const titled = e.titleBodies.length
      await e.runner.prompt({ sessionID: renamed.id, text: "Tidy the readme" })
      // The title request is on its way and held; the rename lands before its answer.
      await e.until(() => e.titleBodies.length > titled)
      await e.store.update(renamed.id, { title: "My own name", titleSource: "user" })
      release()
      e.hold.gate = undefined
      await e.idle(renamed.id)
      await new Promise((resolve) => setTimeout(resolve, 300))
      check("a title the user chose is never replaced", (await e.store.get(renamed.id))?.title === "My own name", await e.store.get(renamed.id))

      e.titles.push('{"name": "set_title", "arguments": {"title": "x"}}')
      const refused = await e.store.create({ directory: e.project, model: e.model })
      const before = e.titleBodies.length
      await e.runner.prompt({ sessionID: refused.id, text: "Check the logs" })
      await e.idle(refused.id)
      await e.until(() => e.titleBodies.length > before)
      await new Promise((resolve) => setTimeout(resolve, 300))
      check("a refused title leaves the fallback", (await e.store.get(refused.id))?.title === "Check the logs", await e.store.get(refused.id))
    } finally {
      await e.close()
    }
  }

  section("Round 5: sampling parameters and effort mapping (E19)")
  {
    check("qwen samples at 0.55 with top-p 1 when it takes a temperature", JSON.stringify(samplingFor("qwen3-coder-plus", true)) === JSON.stringify({ temperature: 0.55, topP: 1 }))
    check("without the capability only top-p goes", JSON.stringify(samplingFor("qwen3-coder-plus", false)) === JSON.stringify({ topP: 1 }))
    check("Claude gets none", JSON.stringify(samplingFor("claude-opus-5", true)) === "{}")
    check("Gemini is 1 / 0.95 / 64", JSON.stringify(samplingFor("gemini-3-pro", true)) === JSON.stringify({ temperature: 1, topP: 0.95, topK: 64 }))
    check("MiniMax-M2.5 takes top-k 40, M2 20", samplingFor("minimax-m2.5", true).topK === 40 && samplingFor("minimax-m2", true).topK === 20)
    check("Kimi K2 is 0.6, its thinking model 1", samplingFor("kimi-k2-instruct", true).temperature === 0.6 && samplingFor("kimi-k2-thinking", true).temperature === 1)
    check("MiMo samples at 1", samplingFor("mimo-v2.5", true).temperature === 1)

    const reasoner = (id: string) => ({ id, name: id, contextWindow: 0, input: 0, output: 0, reasoning: true })
    check("GLM, Mistral and Grok offer no effort", ["glm-5.2", "mistral-medium-3", "grok-4"].every((id) => modelVariants("openai-compatible", reasoner(id)).length === 0))
    check("grok-3-mini keeps low and high", modelVariants("openai-compatible", reasoner("grok-3-mini")).join() === "low,high")
    check("DeepSeek reasons at high and max on its own provider", modelVariants("openai-compatible", reasoner("deepseek-v4"), "deepseek").join() === "high,max")
    check("and offers none elsewhere", modelVariants("openai-compatible", reasoner("deepseek-v4"), "openrouter").length === 0)
    check("north-mini-code gets the three widely supported levels", modelVariants("openai-compatible", reasoner("north-mini-code")).join() === "low,medium,high")
    check("Zhipu turns thinking on, DashScope for a reasoner", JSON.stringify(providerExtras("zhipu", false)) === JSON.stringify({ thinking: { type: "enabled", clear_thinking: false } }) && providerExtras("dashscope", true).enable_thinking === true && Object.keys(providerExtras("dashscope", false)).length === 0)
    check("GPT-5.x asks for low verbosity, codex and chat do not", !verbose("gpt-5.5") && verbose("gpt-5.3-codex") && verbose("gpt-5.1-chat"))

    // On the wire.
    const e = await engine()
    try {
      const signal = new AbortController().signal
      await OpenAICompatible.stream(
        { apiKey: "k", model: { provider: "zhipu", model: "glm-4.7" }, system: "s", history: [], tools: [], effort: "high", signal, baseURL: `http://127.0.0.1:${e.port}/v1`, sampling: { temperature: 1, topP: 0.9, topK: 20 }, extra: providerExtras("zhipu", true) },
        () => {},
      )
      const body = e.bodies.at(-1)
      check("temperature and top_p reach the request, top_k does not", body?.temperature === 1 && body.top_p === 0.9 && body.top_k === undefined, body)
      check("and Zhipu's thinking switch rides along", body?.thinking?.type === "enabled", body?.thinking)
    } finally {
      await e.close()
    }
  }

  section("Round 5: reply language and runtime context each turn (E7)")
  {
    check("the language is named in its own words and in English", localeName("de") === "de (Deutsch / German)", localeName("de"))
    check("the machine's Chinese maps by region", interfaceLocale("", "zh-Hant-TW") === "zh-TW" && interfaceLocale("", "zh-CN") === "zh-CN" && interfaceLocale("system", "pt-PT") === "pt-BR")
    check("a language the interface lacks falls back to English", interfaceLocale("", "sw-KE") === "en")
    check("a chosen language wins over the machine", interfaceLocale("ja", "en-US") === "ja")

    const e = await engine({ language: "zh-CN" })
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "FIRST message" })
      await e.idle(session.id)
      const first = wireText(e.bodies[0])
      check("every prompt carries the reply language in a system-reminder", first.includes("<system-reminder>") && first.includes("Response language: zh-CN"), first.slice(0, 600))
      check("the first also carries the working directory", first.includes(`Working directory: ${JSON.stringify(e.project).slice(1, -1)}`), first.slice(0, 600))
      check("and the app note: MCP servers, where skills go, the question tool", first.includes("About this app") && first.includes("MCP servers") && first.includes(".mcode/skills") && first.includes("question tool"), first.slice(0, 900))
      check("before what the user typed", first.indexOf("Response language") < first.indexOf("FIRST message"))
      const stored = (await e.store.messages(session.id)).find((message) => message.role === "user")
      check("the transcript keeps the words as typed, the notes apart", stored?.role === "user" && stored.text === "FIRST message" && (stored.context?.length ?? 0) === 2, stored)

      await e.config.set({ language: "fr" })
      await e.runner.prompt({ sessionID: session.id, text: "SECOND message" })
      await e.idle(session.id)
      const second = wireText(e.bodies.at(-1))
      check("a later prompt takes the language the interface has now", second.includes("Response language: fr"), second.slice(-900))
      check("while the earlier message keeps what it was sent with", second.includes("Response language: zh-CN"))
      check("and only the first carries the app note and the directory", second.split("About this app").length === 2 && second.split("Working directory").length === 2)

      const chat = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: chat.id, text: "from elsewhere", inbox: { from: "Other", sessionID: session.id, direction: "request" } })
      await e.idle(chat.id)
      const inbound = (await e.store.messages(chat.id)).find((message) => message.role === "user")
      check("a message from another conversation carries no runtime context", inbound?.role === "user" && !inbound.context, inbound)
    } finally {
      await e.close()
    }
  }

  section("Round 5: prompt caching - a stable prefix and MiMo's cache marks (E10)")
  {
    const user = (id: string, text: string): Message => ({ id, sessionID: "s", role: "user", text, attachments: [], time: { created: 1 } })
    const base = {
      apiKey: "k",
      model: { provider: "anthropic", model: "claude-opus-5" },
      system: "SYSTEM",
      tools: TOOLS.slice(0, 3),
      effort: "high",
      signal: new AbortController().signal,
    }
    const body = messagesRequest({ ...base, history: [user("u1", "one"), user("u2", "two"), user("u3", "three")] }) as unknown as Record<string, any>
    const marked = (block: Record<string, any> | undefined) => block?.cache_control?.type === "ephemeral"
    check("the system block is marked", marked(body.system?.[0]))
    check("the last tool definition is marked, and only it", marked(body.tools?.at(-1)) && !body.tools.slice(0, -1).some(marked), body.tools?.map((tool: Record<string, unknown>) => Boolean(tool.cache_control)))
    const blocks = (body.messages as Record<string, any>[]).map((message) => (Array.isArray(message.content) ? marked(message.content.at(-1)) : false))
    check("the last two messages are marked, earlier ones are not", JSON.stringify(blocks) === JSON.stringify([false, true, true]), blocks)
    const hour = messagesRequest({ ...base, cacheTTL: "1h", history: [user("u1", "one")] }) as unknown as Record<string, any>
    check("a model that asks for the hour-long cache gets it", hour.system?.[0]?.cache_control?.ttl === "1h")
    // memory: what names one conversation's notes follows the marked prefix, unmarked, so the prefix is shared.
    const tailed = messagesRequest({ ...base, systemTail: "MEMORY TAIL", history: [user("u1", "one")] }) as unknown as Record<string, any>
    check(
      "a conversation's own system tail is a second, unmarked block after the marked prefix",
      tailed.system?.length === 2 && tailed.system[0]?.text === "SYSTEM" && marked(tailed.system[0]) && tailed.system[1]?.text === "MEMORY TAIL" && !tailed.system[1]?.cache_control,
      tailed.system,
    )
    check("and other providers read it at the end of the system text", systemText({ system: "SYSTEM", systemTail: "MEMORY TAIL" }) === "SYSTEM\n\nMEMORY TAIL" && systemText({ system: "SYSTEM" }) === "SYSTEM")

    check("chat-completions requests are marked only for Claude through OpenRouter or Alibaba", cacheMarked("openrouter", "anthropic/claude-sonnet-5") && !cacheMarked("openrouter", "openai/gpt-5.5") && !cacheMarked("lmstudio", "claude-local"))
    const messages: Record<string, unknown>[] = [
      { role: "system", content: "s" },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "data:x" } }] },
      { role: "assistant", content: "plain" },
      { role: "user", content: [{ type: "text", text: "b" }] },
    ]
    const tools: Record<string, unknown>[] = [{ type: "function" }, { type: "function" }]
    withCacheMarks(messages, tools)
    const parts = (at: number) => messages[at]?.content as Record<string, unknown>[]
    check(
      "the last two messages take a mark on their last part, a plain string none, and so does the last tool",
      !parts(1).at(-1)?.cache_control && messages[2]?.content === "plain" && Boolean(parts(3).at(-1)?.cache_control) && Boolean(tools[1]?.cache_control) && !tools[0]?.cache_control,
      { messages, tools },
    )

    const e = await engine()
    try {
      // ChatGPT: the prompt cache key is the conversation.
      await ChatGPTSubscription.stream({ ...base, model: { provider: "chatgpt", model: "gpt-5.5" }, tools: [], history: [user("u1", "hi")], baseURL: `http://127.0.0.1:${e.port}`, sessionID: "ses_cache" }, () => {}).catch(() => undefined)
      check("ChatGPT is sent the conversation as its prompt cache key", e.bodies.at(-1)?.prompt_cache_key === "ses_cache" && e.headers.at(-1)?.["x-session-affinity"] === "ses_cache", { key: e.bodies.at(-1)?.prompt_cache_key })

      // The runner: the same system prompt across turns, whatever the working tree does.
      execFileSync("git", ["init", "-q"], { cwd: e.project })
      execFileSync("git", ["-c", "user.email=r5@example.com", "-c", "user.name=r5", "add", "-A"], { cwd: e.project })
      execFileSync("git", ["-c", "user.email=r5@example.com", "-c", "user.name=r5", "commit", "-q", "-m", "first"], { cwd: e.project })
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "PREFIX one" })
      await e.idle(session.id)
      const firstSystem = e.bodies.at(-1)?.messages?.[0]?.content
      await fs.writeFile(path.join(e.project, "added-later.txt"), "new\n")
      await fs.writeFile(path.join(e.project, "README.md"), "# changed\n")
      await e.runner.prompt({ sessionID: session.id, text: "PREFIX two" })
      await e.idle(session.id)
      const later = e.bodies.at(-1)
      check("the system prompt is sent unchanged after the working tree moved", typeof firstSystem === "string" && later?.messages?.[0]?.content === firstSystem, String(later?.messages?.[0]?.content).slice(-300))
      check("it carries neither the date nor the repository", !String(firstSystem).includes("Today:") && !String(firstSystem).includes("## Repository"))
      const lastUser = (later?.messages as Record<string, any>[]).filter((m) => m.role === "user").at(-1)
      check("the prompt that follows the change carries them instead", String(lastUser?.content).includes("Today:") && String(lastUser?.content).includes("Branch:") && String(lastUser?.content).includes("README.md"), String(lastUser?.content).slice(0, 500))
      check("and the conversation's requests carry its session affinity", e.headers.at(-1)?.["x-session-affinity"] === session.id)
    } finally {
      await e.close()
    }
  }

  section("Round 5: attachments by path, sent by what the model reads (E1, R27, E44)")
  {
    const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const file = (path: string, mime: string, data = "x", extra: Record<string, unknown> = {}) => ({ path, mime, data, ...extra })
    const texts = (parts: ReturnType<typeof attachmentParts>) => parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
    check("an image the model cannot read is a note, not base64", texts(attachmentParts([file("a.png", "image/png", PNG_1x1)], { image: false }, "chat"))[0]?.includes("cannot read image input") === true)
    check("one it reads goes as an image", attachmentParts([file("a.png", "image/png", PNG_1x1)], { image: true }, "chat")[0]?.kind === "image")
    check("an empty image is said to be empty", texts(attachmentParts([file("a.png", "image/png", "")], { image: true }, "chat"))[0]?.includes("empty or damaged") === true)
    check("a PDF goes as a document to a model that reads PDFs", attachmentParts([file("r.pdf", "application/pdf", "JVBER")], { pdf: true }, "anthropic")[0]?.kind === "pdf")
    check("audio goes natively only over chat completions", attachmentParts([file("v.wav", "audio/wav")], { audio: true }, "chat")[0]?.kind === "audio" && attachmentParts([file("v.wav", "audio/wav")], { audio: true }, "anthropic")[0]?.kind === "text")
    check("any other file is named by its path", texts(attachmentParts([file("C:/w/data.zip", "application/zip")], { image: true }, "chat"))[0]?.includes("C:/w/data.zip") === true)
    const wide = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(wide)
    wide.write("IHDR", 12)
    wide.writeUInt32BE(3000, 16)
    wide.writeUInt32BE(100, 20)
    check("an image's size is read from its header", JSON.stringify(imageSize(wide)) === JSON.stringify({ width: 3000, height: 100 }))
    check("over 2000 px an Anthropic route gets a note instead", texts(attachmentParts([file("w.png", "image/png", wide.toString("base64"))], { image: true }, "anthropic"))[0]?.startsWith("[Image omitted") === true)
    check("the same image is sent to a route with no such limit", attachmentParts([file("w.png", "image/png", wide.toString("base64"))], { image: true }, "chat")[0]?.kind === "image")
    const pdfWire = toMessages("s", [{ id: "u", sessionID: "s", role: "user", text: "read", attachments: [file("r.pdf", "application/pdf", "JVBER")], time: { created: 1 } }], { pdf: true }) as Record<string, any>[]
    check("chat completions carry a PDF as a file part", pdfWire[1]?.content?.some((part: Record<string, any>) => part.type === "file" && String(part.file?.file_data).startsWith("data:application/pdf;base64,")), pdfWire[1]?.content)

    const e = await engine({ custom: { models: [{ id: "m", name: "M", attachment: true }] } })
    try {
      const log = path.join(e.project, "big.log")
      await fs.writeFile(log, "line of the log\n".repeat(20_000))
      await fs.writeFile(path.join(e.project, "shot.png"), Buffer.from(PNG_1x1, "base64"))
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({
        sessionID: session.id,
        text: "ATTACH these",
        attachments: [
          { path: log, mime: "", data: "", byPath: true },
          { path: "shot.png", mime: "", data: "", byPath: true },
          { path: path.join(e.project, "missing.txt"), mime: "", data: "", byPath: true },
        ],
      })
      await e.idle(session.id)
      const stored = (await e.store.messages(session.id)).find((message) => message.role === "user")
      check(
        "a file attached by path is stored as a path with its type, no data",
        stored?.role === "user" && stored.attachments[0]?.mime === "text/plain" && stored.attachments[1]?.mime === "image/png" && stored.attachments.every((entry) => entry.data === ""),
        stored?.role === "user" ? stored.attachments : stored,
      )
      const sent = (e.bodies[0]?.messages as Record<string, any>[]).find((m) => m.role === "user")
      const sentText = JSON.stringify(sent?.content)
      check("a 320 KB log is read from disk and sent up to 50 KB, with where the rest is", sentText.includes("line of the log") && sentText.includes("read the rest of") && sentText.length < 120_000, sentText.length)
      check("the picture is read and sent to a model that reads images", Array.isArray(sent?.content) && sent.content.some((part: Record<string, any>) => part.type === "image_url"))
      check("a file that is gone is named as unreadable", sentText.includes("missing.txt was attached but could not be read"))
      check("and the message says where the files are", sentText.includes("# Attached files") && sentText.includes("big.log"))
    } finally {
      await e.close()
    }
  }

  section("Round 5: compaction's summary, continuation and trigger (E8)")
  {
    const call = (id: string, name: string, input: Record<string, unknown>, metadata?: Record<string, unknown>) =>
      ({ type: "tool", id, callID: id, name, status: "completed", input, output: "ok", ...(metadata ? { metadata } : {}), time: { created: 1 } }) as AssistantMessage["parts"][number]
    const work: Message = {
      id: "a1",
      sessionID: "s",
      role: "assistant",
      model: { provider: "p", model: "m" },
      agent: "build",
      parts: [
        call("c1", "read", { file_path: "src/a.ts", offset: 3, limit: 5 }),
        call("c2", "edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" }),
        call("c3", "write", { file_path: "notes.md", content: "n" }, { created: true }),
        ...["b", "c", "d", "e", "f"].map((name, index) => call(`r${index}`, "read", { file_path: `${name}.ts` })),
        call("c4", "read", { file_path: "src/a.ts" }),
      ],
      time: { created: 1 },
    }
    const manifest = touchedFiles([work], "/proj")
    check("the manifest keeps the five files most recently touched, newest last", manifest.length === 5 && manifest.at(-1)?.startsWith("src/a.ts:") === true && !manifest.some((line) => line.startsWith("b.ts")), manifest)
    check("with each one's last three events", manifest.at(-1) === "src/a.ts: read: lines 3-7 then edited then read: full", manifest.at(-1))
    const created: Message = { ...work, parts: [call("w1", "write", { file_path: "notes.md", content: "n" }, { created: true }), call("w2", "write", { file_path: "old.md", content: "o" })] } as Message
    check("a file a write created is written, one it replaced is edited", JSON.stringify(touchedFiles([created], "/proj")) === JSON.stringify(["notes.md: written", "old.md: edited"]), touchedFiles([created], "/proj"))
    check("a summary is known by its sections, a sentence is not", isSummary(DEFAULT_SUMMARY.replace(/<\/?summary>/g, "")) && !isSummary("Let me look at one more file first."))

    const e = await engine({ custom: { models: [{ id: "m", name: "M", limit: { context: 1000 } }] } })
    try {
      // Manual: the conversation replayed as messages, under its own system prompt and tools.
      const manual = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: manual.id, text: "FIRST request" })
      await e.idle(manual.id)
      await e.runner.prompt({ sessionID: manual.id, text: "SECOND request" })
      await e.idle(manual.id)
      const turnSystem = e.bodies.at(-1)?.messages?.[0]?.content
      await e.runner.compact(manual.id)
      const asked = e.summaryBodies.at(-1)
      const replayed = (asked?.messages as Record<string, any>[]) ?? []
      check("the summary request carries the conversation's own system prompt and tools", asked !== undefined && replayed[0]?.content === turnSystem && (asked.tools?.length ?? 0) > 0, { tools: asked?.tools?.length })
      check(
        "and replays the conversation as its messages, the instruction last",
        replayed.some((message) => message.role === "user" && JSON.stringify(message.content).includes("FIRST request")) &&
          JSON.stringify(replayed.at(-1)?.content).includes("## Task overview") &&
          !JSON.stringify(replayed.at(-1)?.content).includes("FIRST request"),
        replayed.map((message) => message.role),
      )
      check("with the model's usual output cap", asked?.max_tokens === 32_000, asked?.max_tokens)
      const stored = await e.store.get(manual.id)
      check("the summary is stored with its trigger", stored?.compacted?.trigger === "manual" && stored.compacted.summary.startsWith("## Task overview"), stored?.compacted)
      await e.runner.prompt({ sessionID: manual.id, text: "THIRD request" })
      await e.idle(manual.id)
      const third = wireText(e.bodies.at(-1))
      check("the next request opens with the tagged summary instead of the conversation", third.includes('<compacted-context trigger=\\"manual\\">') && !third.includes("FIRST request") && third.includes("THIRD request"), third.slice(0, 600))
      check("and a manual compaction brings no continue message", !third.includes("was just compacted"))

      // A reply that is not a summary, or a tool call, leaves the conversation as it was.
      e.summaries.push("Let me look at one more file first.")
      const before = (await e.store.get(manual.id))?.compacted?.at
      const refused = await e.runner.compact(manual.id).then(() => "", (error: Error) => error.message)
      check("a sentence is refused as a summary", refused.includes("did not return a summary") && (await e.store.get(manual.id))?.compacted?.at === before, refused)
      e.summaries.push(calls([{ name: "glob", input: { pattern: "*" } }]))
      const called = await e.runner.compact(manual.id).then(() => "", (error: Error) => error.message)
      check("so is a tool call while summarising", called.includes("called a tool"), called)

      // Automatic: a turn that ends over the line is compacted when the next one starts, and told to carry on.
      const auto = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(say("a big answer", "stop", { prompt_tokens: 950, completion_tokens: 10 }))
      await e.runner.prompt({ sessionID: auto.id, text: "AUTO first" })
      await e.idle(auto.id)
      check("a turn that ends over the line is not compacted there", !(await e.store.get(auto.id))?.compacted)
      await e.runner.prompt({ sessionID: auto.id, text: "AUTO next" })
      await e.idle(auto.id)
      const autoAfter = await e.store.get(auto.id)
      const autoWire = wireText(e.bodies.at(-1))
      check("the next turn starts with an automatic compaction", autoAfter?.compacted?.trigger === "automatic", autoAfter?.compacted)
      check("and its request is the summary and a note to carry on", autoWire.includes('trigger=\\"automatic\\"') && autoWire.includes("was just compacted"), autoWire.slice(0, 600))

      // Overflow: the provider refuses for length, the conversation is compacted and the request posted again.
      const over = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(failure(400, {}, { error: { message: "This model's maximum context length is 1000 tokens. However, your messages resulted in 2400 tokens." } }))
      await e.runner.prompt({ sessionID: over.id, text: "OVERFLOW request" })
      await e.idle(over.id)
      const overAfter = await e.store.get(over.id)
      const asks = (await e.store.messages(over.id)).filter((message) => message.role === "user" && message.text === "OVERFLOW request")
      const retry = wireText(e.bodies.at(-1))
      check("a refusal for length compacts as an overflow", overAfter?.compacted?.trigger === "provider-overflow", overAfter?.compacted)
      check("and posts the request again after the summary", asks.length === 2 && retry.includes('trigger=\\"provider-overflow\\"') && retry.includes("OVERFLOW request"), { asks: asks.length, retry: retry.slice(0, 400) })
      check("and the step runs to an answer", (await e.assistants(over.id)).at(-1)?.finish === "end_turn")
    } finally {
      await e.close()
    }
  }

  section("Round 5: reasoning replayed where required, tool-call ids sanitised (E42)")
  {
    check("Claude's ids keep letters, digits, _ and -", claudeCallID("call:1/x.y-z_2") === "call_1_x_y-z_2")
    check("Mistral's are nine letters and digits", mistralCallID("call_ab-12") === "callab120" && mistralCallID("toolu_0123456789xyz") === "toolu0123")
    const user = (id: string, text: string): Message => ({ id, sessionID: "s", role: "user", text, attachments: [], time: { created: 1 } })
    const reply = (id: string, parts: AssistantMessage["parts"], model = { provider: "p", model: "m" }): Message => ({ id, sessionID: "s", role: "assistant", model, agent: "build", parts, time: { created: 2 }, finish: "end_turn" })
    const done = (callID: string) => ({ type: "tool", id: callID, callID, name: "read", status: "completed", input: { path: "a" }, output: "ok", time: { created: 1 } }) as AssistantMessage["parts"][number]
    const history = [user("u1", "go"), reply("a1", [done("call:odd/1")]), user("u2", "and then")]
    const claude = forWire(history, { provider: "openrouter", model: "anthropic/claude-sonnet-5" })
    const claudePart = claude[1]?.role === "assistant" ? claude[1].parts[0] : undefined
    check("a Claude request carries sanitised ids, the transcript its own", claudePart?.type === "tool" && claudePart.callID === "call_odd_1" && (history[1] as AssistantMessage).parts[0]?.type === "tool" && ((history[1] as AssistantMessage).parts[0] as { callID: string }).callID === "call:odd/1")
    const onMistral = forWire(history, { provider: "mistral", model: "mistral-large" })
    check("a tool result followed by a user message gets Mistral a Done. between", onMistral.length === 4 && onMistral[2]?.role === "assistant" && JSON.stringify(onMistral[2]).includes("Done."), onMistral.map((m) => m.role))
    check("any other model is left alone", forWire(history, { provider: "lmstudio", model: "qwen3" }) === history)

    const thought = reply("a2", [{ type: "reasoning", id: "r", text: "because", time: { created: 1 } }, { type: "text", id: "t", text: "answer" }])
    const replayed = toMessages("s", [user("u1", "q"), thought], undefined, "reasoning_content") as Record<string, any>[]
    check("an interleaved model reads its reasoning back in its own field", replayed[2]?.reasoning_content === "because" && replayed[2].content === "answer", replayed[2])
    check("other models are sent none", !("reasoning_content" in ((toMessages("s", [user("u1", "q"), thought]) as Record<string, any>[])[2] ?? {})))

    const signedModel = { provider: "anthropic", model: "claude-opus-5" }
    const signed = reply("a3", [{ type: "text", id: "t1", text: "first" }, done("toolu_1"), { type: "reasoning", id: "r1", text: "", time: { created: 1 }, signature: "sig" }], signedModel)
    const back = toProviderMessages([user("u1", "q"), signed], undefined, signedModel) as Record<string, any>[]
    const blocks = back[1]?.content as Record<string, any>[]
    check("signed thinking goes back to the model that signed it", blocks?.some((block) => block.type === "thinking" && block.signature === "sig"), blocks?.map((block) => block.type))
    check("and a reply's calls come after its other parts", blocks?.at(-1)?.type === "tool_use", blocks?.map((block) => block.type))
    const elsewhere = toProviderMessages([user("u1", "q"), signed], undefined, { provider: "anthropic", model: "claude-sonnet-5" }) as Record<string, any>[]
    check("but not to another model", !(elsewhere[1]?.content as Record<string, any>[]).some((block) => block.type === "thinking"))

    // On the wire: a DeepSeek model's reasoning is kept as it streams and sent back next time.
    const e = await engine({ custom: { models: [{ id: "deepseek-v4", name: "DeepSeek" }] } })
    try {
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(frame({ choices: [{ delta: { reasoning_content: "thinking it over" } }] }))
        response.write(frame({ choices: [{ delta: { content: "an answer" } }] }))
        response.end(frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "data: [DONE]\n\n")
      })
      const model = { provider: "fake", model: "deepseek-v4" }
      const session = await e.store.create({ directory: e.project, model })
      await e.runner.prompt({ sessionID: session.id, text: "think first" })
      await e.idle(session.id)
      const kept = (await e.assistants(session.id)).at(-1)?.parts.find((part) => part.type === "reasoning")
      check("its reasoning is kept though reasoning is not shown", kept?.type === "reasoning" && kept.text === "thinking it over", kept)
      await e.runner.prompt({ sessionID: session.id, text: "and again" })
      await e.idle(session.id)
      const assistantSent = (e.bodies.at(-1)?.messages as Record<string, any>[]).find((m) => m.role === "assistant")
      check("and sent back in reasoning_content", assistantSent?.reasoning_content === "thinking it over", assistantSent)
    } finally {
      await e.close()
    }
  }

  section("Round 5: a custom provider on the Anthropic protocol (E41)")
  {
    const e = await engine({ custom: { protocol: "anthropic" } })
    try {
      check("a custom provider marked anthropic is reached over the Messages API", e.config.definition("fake")?.kind === "anthropic", e.config.definition("fake")?.kind)
      await e.config.set({ customProviders: [{ id: "plain", name: "Plain", baseURL: "http://127.0.0.1:1/v1", models: [{ id: "m", name: "M" }] }] })
      check("one with no protocol stays OpenAI-compatible", e.config.definition("plain")?.kind === "openai-compatible")

      // On the wire: the gateway's address, key and headers reach the Messages endpoint.
      await AnthropicAdapter.stream(
        {
          apiKey: "gateway-key",
          model: { provider: "gw", model: "claude-sonnet-5" },
          system: "s",
          history: [{ id: "u", sessionID: "s", role: "user", text: "hi", attachments: [], time: { created: 1 } }],
          tools: [],
          effort: "high",
          signal: new AbortController().signal,
          baseURL: `http://127.0.0.1:${e.port}/v1/`,
          headers: { "x-route": "claude" },
          retries: 0,
        },
        () => {},
      ).catch(() => undefined)
      check("the request goes to the gateway's /v1/messages", e.paths.at(-1) === "/v1/messages", e.paths.at(-1))
      check("with its key as x-api-key and its own headers", e.headers.at(-1)?.["x-api-key"] === "gateway-key" && e.headers.at(-1)?.["x-route"] === "claude", { key: Boolean(e.headers.at(-1)?.["x-api-key"]), route: e.headers.at(-1)?.["x-route"] })
      check("and a Messages body", e.bodies.at(-1)?.model === "claude-sonnet-5" && Array.isArray(e.bodies.at(-1)?.messages) && e.bodies.at(-1)?.system?.[0]?.text === "s", e.bodies.at(-1))
    } finally {
      await e.close()
    }
  }

  section("Round 5: instruction files up to the repository's top (E50)")
  {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r5-instr-"))
    try {
      await fs.mkdir(path.join(repo, ".git"), { recursive: true })
      await fs.mkdir(path.join(repo, "packages", "web"), { recursive: true })
      await fs.mkdir(path.join(repo, "docs"), { recursive: true })
      await fs.writeFile(path.join(repo, "AGENTS.md"), "ROOT-AGENTS short")
      await fs.writeFile(path.join(repo, "packages", "web", "AGENTS.md"), "WEB-AGENTS short")
      await fs.writeFile(path.join(repo, "CLAUDE.md"), "ROOT-CLAUDE")
      await fs.writeFile(path.join(repo, "docs", "style.md"), "DOCS-STYLE")
      const inPackage = await systemPrompt({ directory: path.join(repo, "packages", "web"), agent: "build" })
      check("a package reads its own AGENTS.md and the repository root's, nearest first", inPackage.indexOf("WEB-AGENTS") >= 0 && inPackage.indexOf("WEB-AGENTS") < inPackage.indexOf("ROOT-AGENTS"), inPackage.slice(-600))
      check("short AGENTS.md files bring CLAUDE.md along", inPackage.includes("ROOT-CLAUDE"))
      check("each file is labelled with its path", inPackage.includes(`source="${path.join(repo, "AGENTS.md")}"`))
      await fs.writeFile(path.join(repo, "AGENTS.md"), `ROOT-AGENTS ${"long ".repeat(120)}`)
      const longAgents = await systemPrompt({ directory: repo, agent: "build" })
      check("but not once they say 500 characters or more", longAgents.includes("ROOT-AGENTS") && !longAgents.includes("ROOT-CLAUDE"))
      await fs.rm(path.join(repo, "AGENTS.md"))
      await fs.rm(path.join(repo, "packages", "web", "AGENTS.md"))
      await fs.rm(path.join(repo, "CLAUDE.md"))
      await fs.writeFile(path.join(repo, "CONTEXT.md"), "ROOT-CONTEXT")
      const contextOnly = await systemPrompt({ directory: repo, agent: "build" })
      check("with neither, CONTEXT.md stands in", contextOnly.includes("ROOT-CONTEXT"))
      const globbed = await systemPrompt({ directory: path.join(repo, "packages", "web"), agent: "build", instructionFiles: ["docs/*.md", "https://example.com/rules.md"] })
      check("the instructions setting's globs are found up to the repository's top", globbed.includes("DOCS-STYLE"), globbed.slice(-400))
      check("and a web address is not fetched", !globbed.includes("example.com"))
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r5-plain-"))
      await fs.writeFile(path.join(outside, "AGENTS.md"), "PLAIN-AGENTS")
      check("a folder outside any repository still reads its own", (await systemPrompt({ directory: outside, agent: "build" })).includes("PLAIN-AGENTS"))
      await fs.rm(outside, { recursive: true, force: true })
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  }

  section("Round 5: the auto-worktree notice (E40)")
  {
    const e = await engine()
    try {
      await e.config.set({ permissions: { ...e.config.get().permissions, write: "allow", edit: "allow" } })
      execFileSync("git", ["init", "-q"], { cwd: e.project })
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "write", input: { file_path: "note.txt", content: "first" } }]))
      await e.runner.prompt({ sessionID: session.id, text: "WORKTREE write" })
      await e.idle(session.id)
      const noted = wireText(e.bodies.at(-1))
      check("a change to a main worktree brings the note at the next step", noted.includes("main worktree of a git repository") && noted.includes("ask the user"), noted.slice(0, 700))
      check("stored on the user's message, and the conversation marked", (await e.store.get(session.id))?.worktreeNotice === true && (await e.store.messages(session.id)).some((message) => message.role === "user" && message.context?.some((note) => note.includes("main worktree"))))
      e.replies.push(calls([{ name: "write", input: { file_path: "note.txt", content: "second" } }]))
      await e.runner.prompt({ sessionID: session.id, text: "WORKTREE again" })
      await e.idle(session.id)
      check("once per conversation", wireText(e.bodies.at(-1)).split("main worktree of a git repository").length === 2)

      await fs.mkdir(path.join(e.project, ".git", "worktrees", "feature"), { recursive: true })
      const linked = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "write", input: { file_path: "other.txt", content: "x" } }]))
      await e.runner.prompt({ sessionID: linked.id, text: "WORKTREE linked" })
      await e.idle(linked.id)
      check("with linked worktrees already there, it says to work in a new one", wireText(e.bodies.at(-1)).includes("create a new worktree for the task"))

      const reads = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "glob", input: { pattern: "*" } }]))
      await e.runner.prompt({ sessionID: reads.id, text: "WORKTREE only reads" })
      await e.idle(reads.id)
      check("reading alone brings no note", !wireText(e.bodies.at(-1)).includes("main worktree") && !(await e.store.get(reads.id))?.worktreeNotice)

      /* L4: a change made through bash brings the same notice, and only once the command has actually run. */
      await e.config.set({ permissions: { ...e.config.get().permissions, bash: "allow" } })
      const shelled = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "bash", input: { command: "echo hi > shelled.txt", description: "write a file" } }]))
      await e.runner.prompt({ sessionID: shelled.id, text: "WORKTREE bash write" })
      await e.idle(shelled.id)
      check(
        "a change made through bash brings the note as a write tool's change does",
        (await e.store.get(shelled.id))?.worktreeNotice === true && wireText(e.bodies.at(-1)).includes("main worktree of a git repository"),
        wireText(e.bodies.at(-1)).slice(0, 400),
      )

      const looked = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "bash", input: { command: "git status", description: "look" } }]))
      await e.runner.prompt({ sessionID: looked.id, text: "WORKTREE bash reads" })
      await e.idle(looked.id)
      check("a command that only looks brings none", !(await e.store.get(looked.id))?.worktreeNotice)

      const failed = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "bash", input: { command: "echo x > failed.txt; exit 3", description: "write then fail" } }]))
      await e.runner.prompt({ sessionID: failed.id, text: "WORKTREE bash failed" })
      await e.idle(failed.id)
      check("a command that ended badly brings none either", !(await e.store.get(failed.id))?.worktreeNotice)
    } finally {
      await e.close()
    }
  }

  section("Round 6: an oversized picture is made smaller rather than dropped (L12)")
  {
    /* A PNG header is all this needs: the size is read from it, and the byte count from the payload. */
    const pngOf = (width: number, height: number) => {
      const bytes = Buffer.alloc(24)
      bytes[0] = 0x89
      bytes.write("PNG", 1, "latin1")
      bytes.writeUInt32BE(width, 16)
      bytes.writeUInt32BE(height, 20)
      return bytes.toString("base64")
    }
    const roomy = { maxBytes: 1_000_000, maxPixels: 2000 }
    check("a picture inside both caps needs nothing done to it", imageFit("image/png", pngOf(100, 100), roomy) === undefined)
    check("one too wide has to be made smaller", Boolean(imageFit("image/png", pngOf(4000, 100), roomy)), imageFit("image/png", pngOf(4000, 100), roomy))
    check("so does one too heavy", Boolean(imageFit("image/png", pngOf(100, 100), { maxBytes: 10, maxPixels: 2000 })))
    check("anything that is not a picture, or has no bytes, is not measured", imageFit("text/plain", "abc") === undefined && imageFit("image/png", "") === undefined)
    check("the caps it measures against by default are the Anthropic route's, the strictest it knows", Boolean(imageFit("image/png", pngOf(3000, 100))))

    let asked: { maxBytes: number; maxPixels: number } | undefined
    setImageShrinker(async ({ fit }) => {
      asked = fit
      return { data: "c2hydW5r", mime: "image/jpeg" }
    })
    const shrunk = await fittedImage({ mime: "image/png", data: pngOf(3000, 100) })
    check(
      "an oversized picture is handed to the decoder and comes back smaller",
      shrunk?.mime === "image/jpeg" && shrunk.data === "c2hydW5r" && asked?.maxPixels === 2000,
      { shrunk, asked },
    )
    check("one already within the caps is never re-encoded", (await fittedImage({ mime: "image/png", data: pngOf(100, 100) })) === undefined)
    setImageShrinker(undefined)
    check(
      "with no decoder to hand it is left exactly as it was, and the wire's own note explains it",
      (await fittedImage({ mime: "image/png", data: pngOf(3000, 100) })) === undefined,
    )
  }

  section("Round 6: a command's agent and model run its turn (L3)")
  {
    const e = await engine()
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "COMMAND on another model", model: { provider: "fake", model: "other" } })
      await e.idle(session.id)
      check("the turn runs on the model the command named", e.bodies.at(-1)?.model === "other", e.bodies.at(-1)?.model)
      check("and the conversation keeps its own", (await e.store.get(session.id))?.model.model === "m", (await e.store.get(session.id))?.model)

      await e.runner.prompt({ sessionID: session.id, text: "COMMAND as another agent", agent: "plan" })
      await e.idle(session.id)
      check("the turn runs as the agent the command named", (await e.assistants(session.id)).at(-1)?.agent === "plan", (await e.assistants(session.id)).at(-1)?.agent)
      check("and the conversation is still the agent it was", (await e.store.get(session.id))?.agent === "build", (await e.store.get(session.id))?.agent)

      await e.runner.prompt({ sessionID: session.id, text: "COMMAND on a provider nobody configured", model: { provider: "nobody", model: "x" } })
      await e.idle(session.id)
      /* The request has to be the one this message made: a turn that threw instead would leave the turn before it as the last body. */
      check(
        "a model whose provider is not configured is ignored rather than failing the turn",
        e.bodies.at(-1)?.model === "m" && wireText(e.bodies.at(-1)).includes("nobody configured"),
        e.bodies.at(-1)?.model,
      )

      await e.runner.prompt({ sessionID: session.id, text: "PLAIN message naming nothing" })
      await e.idle(session.id)
      check(
        "a message that names neither runs as the conversation is set",
        e.bodies.at(-1)?.model === "m" && (await e.assistants(session.id)).at(-1)?.agent === "build",
        { model: e.bodies.at(-1)?.model, agent: (await e.assistants(session.id)).at(-1)?.agent },
      )
    } finally {
      await e.close()
    }
  }
}
