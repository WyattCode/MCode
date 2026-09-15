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
import { ProviderError, ProviderHttpError } from "../src/server/provider/types"
import { ABORTED_TOOL, INTERRUPTED_RESULT, requestHistory } from "../src/server/provider/history"
import { toMessages } from "../src/server/provider/openai"
import { repeatsCall } from "../src/server/session/reminders"
import { UNTITLED, clampTitle, cleanTitle, fallbackTitle } from "../src/server/session/title"
import { providerExtras, samplingFor } from "../src/server/provider/sampling"
import { modelVariants } from "../src/server/provider/variants"
import { OpenAICompatible } from "../src/server/provider/openai"
import { verbose } from "../src/server/provider/chatgpt"
import { interfaceLocale, localeName } from "../src/server/session/locale"
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
  return { dir, project, replies, bodies, headers, paths, titleBodies, titles, hold, events, times, storage, bus, config, permissions, store, runner, model, idle, until, assistants, close, port }
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
    const budgeted = anthropicReasoning("claude-haiku-4-5", "max", ["high", "max"], false, 20_000, 64_000)
    check(
      "a thinking budget is cut from the model's own limit and kept under max_tokens",
      budgeted.thinking?.type === "enabled" && budgeted.thinking.budget_tokens === 19_999,
      budgeted,
    )
    const high = anthropicReasoning("claude-haiku-4-5", "high", ["high", "max"], false, 64_000, 64_000)
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
    check("a refused key, a missing model and a 400 are never retried", [401, 404, 400, 422, 402, 501].every((status) => retryDecision(new ProviderHttpError("no", status, {}), 1, 0) === undefined))
    check("an upstream stream failure is a stream kind", retryKind(new ProviderError("boom", undefined, undefined, { type: "upstream_error" })) === "stream")
    const overloaded = new ProviderHttpError("overloaded", 503, {}, { code: "server_is_overloaded" })
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

      // A failure after a tool call has started to stream is not replayed.
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_half", function: { name: "read", arguments: "" } }] } }] }))
        response.end(frame({ error: { message: "upstream broke", type: "upstream_error" } }))
      })
      const sent = e.bodies.length
      await e.runner.prompt({ sessionID: session.id, text: "read it" })
      await e.idle(session.id)
      const broken = (await e.assistants(session.id)).at(-1)
      check("a step whose tool call had begun is not retried", e.bodies.length === sent + 1 && broken?.finish === "error", { requests: e.bodies.length - sent, finish: broken?.finish })
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
        calls([{ name: "list", input: { path: "." } }])(response, body)
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
      ({ type: "tool", id: callID, callID, name: "list", status, input, time: { created: 1 } }) as AssistantMessage["parts"][number] & { type: "tool" }
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
      const listThrice = calls([0, 1, 2].map(() => ({ name: "list", input: { path: "." } })))
      const session = await e.store.create({ directory: e.project, model: e.model })

      e.replies.push(listThrice)
      await e.runner.prompt({ sessionID: session.id, text: "LOOP once" })
      check("the third identical call puts a question to the user", await e.until(() => asked().length === 1), asked())
      const first = asked()[0]
      check("naming the tool, with the once / always / reject answers", first?.loop?.tool === "list" && first.questions[0]?.options.map((option) => option.label).join() === "once,always,reject", first)
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
      const one = calls([{ name: "list", input: { path: "src-none" } }])
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
        { apiKey: "k", model: { provider: "zhipu", model: "glm-4.7" }, system: "s", history: [], tools: [], effort: "high", showReasoning: false, signal, baseURL: `http://127.0.0.1:${e.port}/v1`, sampling: { temperature: 1, topP: 0.9, topK: 20 }, extra: providerExtras("zhipu", true) },
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
      check("the transcript keeps the words as typed, the notes apart", stored?.role === "user" && stored.text === "FIRST message" && (stored.reminders?.length ?? 0) === 2, stored)

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
      check("a message from another conversation carries no runtime context", inbound?.role === "user" && !inbound.reminders, inbound)
    } finally {
      await e.close()
    }
  }
}
