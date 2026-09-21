/**
 * Round 11: what happens to a model's answer after the request goes out
 * (S11-1 … S11-17), measured against MiMo 26.914. Kept apart from smoke.ts the
 * way the earlier rounds are; smoke.ts calls `roundElevenStreamChecks` with its
 * own check and section.
 *
 * Every stream here comes from a local server started by this file. No provider
 * is called, and no credential is read.
 */
import { createServer, type ServerResponse } from "node:http"
import type { Check } from "./smoke-round5"
import { engine } from "./smoke-round5"
import { anthropicStop } from "../src/server/provider/anthropic"
import { ChatGPTSubscription, toInput } from "../src/server/provider/chatgpt"
import { OpenAICompatible, usageOf } from "../src/server/provider/openai"
import { readData, readEvents } from "../src/server/provider/sse"
import { STALL } from "../src/server/provider/stall"
import { ProviderError } from "../src/server/provider/types"
import { RETRY_BUDGETS, retryDecision, retryKind } from "../src/server/session/retry"
import { TEXT_TOOL_NOTE, continuationFor } from "../src/server/session/reminders"
import { costOf } from "../src/server/session/usage"
import { parseToolArguments, repairUnicodeEscapes } from "../src/server/tool/repair"
import type { AssistantMessage, Message, TurnEvent as _TurnEvent } from "../src/shared/protocol"
import type { TurnEvent } from "../src/server/provider/types"

/** A stream of raw bytes, exactly as written, from a local server. */
async function bodyOf(raw: string | Buffer): Promise<ReadableStream<Uint8Array>> {
  const server = createServer((_request, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(raw)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as { port: number }).port
  const answer = await fetch(`http://127.0.0.1:${port}/`)
  const stream = answer.body!
  server.close()
  return stream
}

/** Everything a stream of raw bytes parses to. */
async function eventsOf(raw: string | Buffer): Promise<{ event?: string; data: string }[]> {
  const out: { event?: string; data: string }[] = []
  for await (const event of readEvents(await bodyOf(raw))) out.push(event)
  return out
}

/** A local chat-completions server that answers every request with `raw`, byte for byte. */
async function rawProvider(raw: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    request.on("data", () => {})
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(raw)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** The request body a Responses-shaped server was handed, and the stream it answered with. */
async function codexProvider(frames: string): Promise<{ port: number; bodies: Record<string, any>[]; close: () => Promise<void> }> {
  const bodies: Record<string, any>[] = []
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      bodies.push(raw ? JSON.parse(raw) : {})
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(frames)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  return {
    port: (server.address() as { port: number }).port,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const baseRequest = {
  apiKey: "k",
  system: "s",
  history: [] as Message[],
  tools: [],
  effort: "",
  variants: [] as string[] | undefined,
}

const assistant = (parts: AssistantMessage["parts"], model = { provider: "codex", model: "gpt-5.5" }): AssistantMessage =>
  ({
    id: "msg_r11",
    sessionID: "ses_r11",
    role: "assistant",
    model,
    agent: "build",
    parts,
    time: { created: 1 },
  }) as AssistantMessage

export async function roundElevenStreamChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 11 (S11-1, S11-2): what an Anthropic stop_reason means for the turn")
  {
    check("a reply cut at the output limit mid tool call still runs the call", anthropicStop("max_tokens", 1) === "tool_use")
    check("and the limit is still the answer when there was no call", anthropicStop("max_tokens", 0) === "max_tokens")
    check("a refusal wins over everything", anthropicStop("refusal", 2) === "refusal")
    check("tool_use with calls is a tool step", anthropicStop("tool_use", 1) === "tool_use")
    check("end_turn with none is the end", anthropicStop("end_turn", 0) === "end_turn")
    check(
      "a reply the server cut for want of context is the length case, not a finished answer (S11-2)",
      anthropicStop("model_context_window_exceeded", 0) === "max_tokens",
    )
    check("and it too yields to a call that was already announced", anthropicStop("model_context_window_exceeded", 1) === "tool_use")
  }

  section("Round 11 (S11-3): the codes an error frame inside a 200 stream carries")
  {
    const wire = (code: string) => new ProviderError("busy", undefined, undefined, { code })
    const typed = (type: string) => new ProviderError("busy", undefined, undefined, { type })
    check("overloaded_error is a server failure worth waiting out", retryKind(wire("overloaded_error")) === "server")
    check("so is server_is_overloaded", retryKind(wire("server_is_overloaded")) === "server")
    check("and server_error", retryKind(wire("server_error")) === "server")
    check("it is read off the type as well as the code", retryKind(typed("overloaded_error")) === "server")
    check("stream_read_error stays a stream failure", retryKind(wire("stream_read_error")) === "stream")
    check("a spent quota is never retried", retryKind(wire("insufficient_quota")) === undefined)
    check("nor a plan that does not include this model", retryKind(wire("usage_not_included")) === undefined)
    check("nor a prompt the provider refuses", retryKind(wire("invalid_prompt")) === undefined)
    check("a code nobody recognises is still terminal", retryKind(wire("something_else")) === undefined)
  }

  section("Round 11 (S11-4): the shared SSE reader follows the format")
  {
    const two = await eventsOf("data: {\"a\":1,\ndata: \"b\":2}\n\n")
    check("several data lines make one event, joined with newlines", two.length === 1 && two[0]!.data === "{\"a\":1,\n\"b\":2}", two)
    check("and that event parses", two.length === 1 && JSON.parse(two[0]!.data).b === 2)

    // A byte-order mark belongs to the encoding; TextDecoder takes it off the stream for us.
    const bom = await eventsOf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("data: first\n\ndata: second\n\n")]))
    check("a byte-order mark does not eat the first event", bom.length === 2 && bom[0]!.data === "first", bom)

    const crlf = await eventsOf("event: ping\r\ndata: one\r\n\r\ndata: two\r\n\r\n")
    check("CRLF line ends are line ends", crlf.length === 2 && crlf[0]!.data === "one" && crlf[1]!.data === "two", crlf)
    check("an event name is kept", crlf[0]!.event === "ping")

    const bare = await eventsOf("data: one\rdata: two\r\r")
    check("so is a bare CR", bare.length === 1 && bare[0]!.data === "one\ntwo", bare)

    const commented = await eventsOf(": OPENROUTER PROCESSING\n\ndata: real\n\n")
    check("a comment is not an event and does not end one", commented.length === 1 && commented[0]!.data === "real", commented)

    const tight = await eventsOf("data:tight\n\n")
    check("field:value without the space is the same field", tight.length === 1 && tight[0]!.data === "tight", tight)
    const spaced = await eventsOf("data:  two spaces\n\n")
    check("only one space belongs to the separator", spaced[0]!.data === " two spaces", spaced)

    const unterminated = await eventsOf("data: {\"usage\":1}\n\ndata: {\"finish\":\"stop\"}")
    check(
      "the last frame is not lost when the provider omits its final newline",
      unterminated.length === 2 && unterminated[1]!.data === "{\"finish\":\"stop\"}",
      unterminated,
    )

    const blank = await eventsOf("\n\n\ndata: only\n\n\n\n")
    check("blank lines with no data dispatch nothing", blank.length === 1 && blank[0]!.data === "only", blank)

    const payloads: string[] = []
    for await (const data of readData(await bodyOf("data: a\n\ndata: b\n\n"))) payloads.push(data)
    check("readData yields the payloads alone", payloads.join() === "a,b", payloads)
  }

  section("Round 11 (S11-5): a keep-alive counts as the provider being alive")
  {
    let reads = 0
    const seen: string[] = []
    for await (const data of readData(await bodyOf(": keep-alive\n\nevent: ping\ndata: {}\n\ndata: real\n\n"), { onRead: () => (reads += 1) })) {
      seen.push(data)
    }
    check("every read refreshes the timer, before anything is parsed", reads >= 1, reads)
    check("a named event is read like any other, and the words still arrive", seen.includes("{}") && seen.includes("real"), seen)

    /*
     * The whole point, end to end: a provider that says nothing but comments
     * for longer than the stall window, then answers. With the timer hung on
     * the parsed events alone this was cut off and retried.
     */
    const chunkMs = STALL.chunkMs
    STALL.chunkMs = 300
    const slow = createServer((request, response) => {
      request.on("data", () => {})
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        let beats = 0
        const timer = setInterval(() => {
          beats += 1
          response.write(": still working\n\n")
          if (beats < 6) return
          clearInterval(timer)
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "late" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
        }, 100)
      })
    })
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", () => resolve()))
    const slowPort = (slow.address() as { port: number }).port
    const said: string[] = []
    const outcome = await OpenAICompatible.stream(
      { ...baseRequest, model: { provider: "x", model: "m" }, signal: new AbortController().signal, baseURL: `http://127.0.0.1:${slowPort}/v1` },
      (event: TurnEvent) => {
        if (event.type === "text.delta") said.push(event.text)
      },
    ).catch((err: unknown) => err as Error)
    STALL.chunkMs = chunkMs
    await new Promise<void>((resolve) => slow.close(() => resolve()))
    check(
      "600ms of comments under a 300ms stall window is not a stall",
      !(outcome instanceof Error) && said.join("") === "late",
      outcome instanceof Error ? outcome.message : said,
    )
  }

  section("Round 11 (S11-9): reasoning tokens are split out for every server, not only OpenRouter")
  {
    const local = usageOf(
      // A cache_write_tokens no such server sends, to show it is not read here.
      { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 70 }, completion_tokens_details: { reasoning_tokens: 120 } },
      "deepseek",
    )
    check(
      "a chat-completions reasoning model no longer has its thinking counted as output",
      local.reasoning === 120 && local.output === 180 && local.input === 600 && local.cacheRead === 400,
      local,
    )
    check("and its cache writes stay zero, because no such server reports them", local.cacheWrite === 0)
    const routed = usageOf(
      { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 50 } },
      "openrouter",
    )
    check("OpenRouter is unchanged", routed.input === 500 && routed.cacheWrite === 100 && routed.output === 250 && routed.reasoning === 50, routed)
  }

  section("Round 11 (S11-11): a stream cut between reads is not a reply")
  {
    /*
     * The whole answer arrives in one chunk and Stop is pressed while it is
     * being handed out, so the reader never sits in a read that could reject:
     * it simply runs out of lines and ends. That is the case the adapter used
     * to answer with a perfectly ordinary outcome, half-assembled call and all.
     */
    const cut = new AbortController()
    const chat = await rawProvider(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_cut", function: { name: "bash", arguments: "{\"command\":\"rm -rf x\"}" } }] } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    )
    const chatResult = await OpenAICompatible.stream(
      { ...baseRequest, model: { provider: "x", model: "m" }, signal: cut.signal, baseURL: `http://127.0.0.1:${chat.port}/v1` },
      (event: TurnEvent) => {
        if (event.type === "tool") cut.abort()
      },
    ).then(
      (value) => value,
      (err: unknown) => err as Error,
    )
    await chat.close()
    check(
      "chat completions: a half-assembled call is never handed back as a finished turn",
      chatResult instanceof Error && chatResult.name === "AbortError",
      chatResult instanceof Error ? chatResult.name : chatResult,
    )

    const stopCodex = new AbortController()
    const codex = await codexProvider(
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_cut", name: "bash", arguments: "{}" } })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
    )
    const codexResult = await ChatGPTSubscription.stream(
      { ...baseRequest, model: { provider: "codex", model: "gpt-5.5" }, signal: stopCodex.signal, baseURL: `http://127.0.0.1:${codex.port}` },
      (event: TurnEvent) => {
        if (event.type === "tool") stopCodex.abort()
      },
    ).then(
      (value) => value,
      (err: unknown) => err as Error,
    )
    await codex.close()
    check(
      "and neither does the Responses path, which had no signal check at all",
      codexResult instanceof Error && codexResult.name === "AbortError",
      codexResult instanceof Error ? codexResult.name : codexResult,
    )
  }

  section("Round 11 (S11-12): finish_reason function_call ends a step on a tool call")
  {
    const wrote = assistant([{ type: "text", id: "p1", text: "<invoke name=\"read\">x</invoke>" }])
    const counts = { length: 0, textTool: 0, empty: 0 }
    const older = continuationFor(wrote, "end_turn", "function_call", "some-model", counts)
    check("an older gateway's word for it is answered the same way", older.note === TEXT_TOOL_NOTE, older)
    const modern = continuationFor(wrote, "end_turn", "tool_calls", "some-model", { length: 0, textTool: 0, empty: 0 })
    check("as tool_calls always was", modern.note === TEXT_TOOL_NOTE)
    const plain = continuationFor(wrote, "end_turn", "stop", "some-model", { length: 0, textTool: 0, empty: 0 })
    check("and a plain stop is not", plain.note === undefined, plain)
  }

  section("Round 11 (S11-13): tool arguments whose \\u escapes the model got wrong")
  {
    check("whitespace inside an escape is not part of it", repairUnicodeEscapes("\\u4f 60") === "\\u4f60")
    check("a good escape is left alone", repairUnicodeEscapes("\\u4f60\\u597d") === "\\u4f60\\u597d")
    check("an escaped backslash is not the start of one", repairUnicodeEscapes("C:\\\\users\\\\x") === "C:\\\\users\\\\x")
    check("and neither is a newline escape", repairUnicodeEscapes("a\\nb") === "a\\nb")
    check("too few digits are left as they were", repairUnicodeEscapes("\\u4f") === "\\u4f")

    const broken = parseToolArguments("{\"path\":\"\\u4f 60\\u597d.txt\"}")
    check("so a path with Chinese in it survives a botched escape", broken.input.path === "你好.txt" && !broken.inputError, broken)
    const good = parseToolArguments("{\"a\":1}")
    check("ordinary arguments are unaffected", good.input.a === 1 && !good.inputError)
    const hopeless = parseToolArguments("{\"a\":")
    check("a truncated object still reports why, so the call is refused with a reason", hopeless.inputError?.includes("not valid JSON") === true, hopeless)
    const array = parseToolArguments("[1,2]")
    check("a JSON array is not a set of arguments", array.inputError === "the arguments were not a JSON object")
    check("nothing at all is an empty input", Object.keys(parseToolArguments("   ").input).length === 0 && !parseToolArguments("   ").inputError)
  }

  section("Round 11 (S11-14): the dearer prices past 200k of context")
  {
    const rates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, over200K: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } }
    const million = { input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
    const under = costOf({ input: 100_000, output: 1_000, reasoning: 0, cacheRead: 50_000, cacheWrite: 0 }, rates)
    check("a short conversation keeps the ordinary prices", Math.abs(under - (100_000 * 5 + 1_000 * 25 + 50_000 * 0.5) / 1e6) < 1e-9, under)
    const over = costOf({ input: 150_000, output: 1_000, reasoning: 0, cacheRead: 100_000, cacheWrite: 0 }, rates)
    check(
      "past 200k of prompt, input and cache reads together, the whole step is priced at the long-context rates",
      Math.abs(over - (150_000 * 10 + 1_000 * 50 + 100_000 * 1) / 1e6) < 1e-9,
      over,
    )
    check("exactly 200k is still under the line, as MiMo's strict comparison has it", costOf({ input: 200_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, rates) === 1)
    check("a model with no long-context tier is unchanged", Math.abs(costOf(million, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }) - 61.75) < 1e-9)
  }

  section("Round 11 (S11-15): a request that failed before the first word is tried again quickly")
  {
    const dropped = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })
    const cold = retryDecision(dropped, 1, 0, 0.5, "request")
    const warm = retryDecision(dropped, 1, 0, 0.5, "stream")
    check("nothing had arrived yet, so it waits 200ms", cold?.wait === RETRY_BUDGETS.request.initial, cold)
    check("part-way through a reply it waits out its kind", warm?.wait === RETRY_BUDGETS.network.initial, warm)
    check("the kind is the same either way", cold?.kind === "network" && warm?.kind === "network")
    check("and so is how many attempts it gets", cold?.max === warm?.max)
    const server = retryDecision(new ProviderError("busy", undefined, undefined, { code: "server_error" }), 2, 0, 0.5, "request")
    check("the quick curve still doubles", server?.wait === RETRY_BUDGETS.request.initial * 2, server)
  }

  section("Round 11 (S11-6, S11-8): what an incomplete Responses answer means")
  {
    const usage = { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
    const filtered = await codexProvider(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "half a " })}\n\n` +
        `data: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, usage } })}\n\n`,
    )
    const stoppedByFilter = await ChatGPTSubscription.stream(
      { ...baseRequest, model: { provider: "codex", model: "gpt-5.5" }, signal: new AbortController().signal, baseURL: `http://127.0.0.1:${filtered.port}` },
      () => {},
    )
    await filtered.close()
    check(
      "a filtered reply is a refusal, not an answer that ran out of room",
      stoppedByFilter.stop === "refusal" && stoppedByFilter.finishReason === "content_filter",
      stoppedByFilter,
    )

    const truncated = await codexProvider(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "and on and" })}\n\n` +
        `data: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage } })}\n\n`,
    )
    const ranOut = await ChatGPTSubscription.stream(
      { ...baseRequest, model: { provider: "codex", model: "gpt-5.5" }, signal: new AbortController().signal, baseURL: `http://127.0.0.1:${truncated.port}` },
      () => {},
    )
    await truncated.close()
    check("the output ceiling still is one", ranOut.stop === "max_tokens" && ranOut.finishReason === "max_output_tokens", ranOut)

    const called = await codexProvider(
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" } })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}\n\n`,
    )
    const withCall = await ChatGPTSubscription.stream(
      { ...baseRequest, model: { provider: "codex", model: "gpt-5.5" }, signal: new AbortController().signal, baseURL: `http://127.0.0.1:${called.port}` },
      () => {},
    )
    await called.close()
    check("a finished response that made calls says so (S11-8)", withCall.finishReason === "tool_calls" && withCall.stop === "tool_use", withCall)

    const spoke = await codexProvider(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "done" })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}\n\n`,
    )
    const plain = await ChatGPTSubscription.stream(
      { ...baseRequest, model: { provider: "codex", model: "gpt-5.5" }, signal: new AbortController().signal, baseURL: `http://127.0.0.1:${spoke.port}` },
      () => {},
    )
    await spoke.close()
    check("and one that just answered carries its own status", plain.finishReason === "completed" && plain.stop === "end_turn", plain)
  }

  section("Round 11 (S11-7): the Responses path asks for encrypted thinking and hands it back")
  {
    const usage = { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } }
    const provider = await codexProvider(
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "weighing it up" })}\n\n` +
        `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: "CIPHER" } })}\n\n` +
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer" })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}\n\n`,
    )
    const events: TurnEvent[] = []
    await ChatGPTSubscription.stream(
      // `variants` unset is "nobody worked the list out", which is what sends the reasoning block.
      { ...baseRequest, variants: undefined, effort: "high", model: { provider: "codex", model: "gpt-5.5" }, signal: new AbortController().signal, baseURL: `http://127.0.0.1:${provider.port}` },
      (event: TurnEvent) => events.push(event),
    )
    await provider.close()
    check("the request asks for it", JSON.stringify(provider.bodies[0]?.include) === JSON.stringify(["reasoning.encrypted_content"]), provider.bodies[0]?.include)
    check("the summary is asked for as auto", provider.bodies[0]?.reasoning?.summary === "auto", provider.bodies[0]?.reasoning)
    const signed = events.find((event) => event.type === "reasoning.signature")
    check(
      "the ciphertext and the item's id reach the reasoning part",
      signed?.type === "reasoning.signature" && signed.signature === "CIPHER" && signed.itemID === "rs_1",
      signed,
    )
    check("and the thinking itself is kept, though nothing draws it", events.some((event) => event.type === "reasoning.delta" && event.text === "weighing it up"))

    const model = { provider: "codex", model: "gpt-5.5" }
    const kept = toInput(
      [
        { id: "u1", sessionID: "s", role: "user", text: "go", attachments: [], time: { created: 1 } } as Message,
        assistant(
          [
            { type: "reasoning", id: "r1", text: "weighing it up", time: { created: 1 }, signature: "CIPHER", itemID: "rs_1" },
            { type: "text", id: "t1", text: "answer" },
          ],
          model,
        ),
      ],
      undefined,
      model,
    )
    const item = kept.find((entry) => entry.type === "reasoning") as Record<string, any> | undefined
    check(
      "it goes back in order, before the words it led to",
      item?.encrypted_content === "CIPHER" && item.id === "rs_1" && kept.indexOf(item as never) < kept.findIndex((entry) => entry.type === "message" && entry.role === "assistant"),
      kept,
    )
    check("with the summary beside it", JSON.stringify(item?.summary) === JSON.stringify([{ type: "summary_text", text: "weighing it up" }]))

    const unsigned = toInput(
      [assistant([{ type: "reasoning", id: "r1", text: "thought", time: { created: 1 } }, { type: "text", id: "t1", text: "a" }], model)],
      undefined,
      model,
    )
    check("thinking with no ciphertext is dropped, as MiMo drops it when nothing is stored", !unsigned.some((entry) => entry.type === "reasoning"), unsigned)

    const other = toInput(
      [assistant([{ type: "reasoning", id: "r1", text: "t", time: { created: 1 }, signature: "CIPHER" }, { type: "text", id: "t1", text: "a" }], { provider: "codex", model: "gpt-5.4" })],
      undefined,
      model,
    )
    check("and so is another model's", !other.some((entry) => entry.type === "reasoning"), other)
  }

  section("Round 11 (S11-10, S11-16): the thinking is kept, and watched for a loop")
  {
    const e = await engine()
    try {
      const session = await e.store.create({ directory: e.project, model: e.model, title: "reasoning" })
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "let me think about it" } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Here it is." } }] })}\n\n`)
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
      })
      await e.runner.prompt({ sessionID: session.id, text: "think", attachments: [] })
      await e.idle(session.id)
      const reply = (await e.assistants(session.id)).at(-1)
      check(
        "a chat-completions model's reasoning is stored even though the interface draws none of it (S11-10)",
        reply?.parts.some((part) => part.type === "reasoning" && part.text === "let me think about it") === true,
        reply?.parts,
      )

      const looping = await e.store.create({ directory: e.project, model: e.model, title: "looping" })
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        // The same sentence over and over, in the thinking alone - never in the reply.
        for (let n = 0; n < 60; n++) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "I will try the same thing again. " } }] })}\n\n`)
        }
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
      })
      await e.runner.prompt({ sessionID: looping.id, text: "loop", attachments: [] })
      await e.idle(looping.id)
      const cut = (await e.assistants(looping.id)).at(-1)
      check(
        "a model repeating itself inside its own thinking has the stream cut, as MiMo cuts it (S11-16)",
        cut?.errorCode === "error.replyLoop",
        { finish: cut?.finish, errorCode: cut?.errorCode },
      )
    } finally {
      await e.close()
    }
  }

  section("Round 11 (S11-17): usage is asked for on every chat-completions request")
  {
    /*
     * Recorded, not changed. MiMo only sends `stream_options` where its own
     * config sets `includeUsage`, and its generic OpenAI-compatible provider
     * does not - so MiMo gets no usage at all from a self-hosted model. MCode
     * asks every time, which is the better behaviour and is why the usage card
     * has numbers for a local model. Kept here so the difference is deliberate
     * rather than forgotten.
     */
    const provider = await rawProvider(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
    let body: Record<string, any> = {}
    const listener = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        body = raw ? JSON.parse(raw) : {}
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()))
    const port = (listener.address() as { port: number }).port
    await OpenAICompatible.stream(
      { ...baseRequest, model: { provider: "lmstudio", model: "qwen3" }, signal: new AbortController().signal, baseURL: `http://127.0.0.1:${port}/v1` },
      () => {},
    )
    await provider.close()
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    check("MCode asks for it unconditionally, which MiMo does not (recorded difference)", body.stream_options?.include_usage === true, body.stream_options)
  }
}
