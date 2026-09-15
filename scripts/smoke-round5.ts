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
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", async () => {
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {}
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
  return { dir, project, replies, bodies, headers, paths, events, times, storage, bus, config, permissions, store, runner, model, idle, until, assistants, close, port }
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
}
