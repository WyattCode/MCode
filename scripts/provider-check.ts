/**
 * What reaches the provider, and what a removed provider leaves behind.
 *
 * Three things this file exists to hold still, all of which were wrong or
 * absent before and none of which any other check can see:
 *
 *   1. The reasoning level. Three adapters send it three different ways, and
 *      until now only one of them asked whether the model would accept it. The
 *      Anthropic path shapes it as adaptive thinking or a token budget; the
 *      Codex path as a `reasoning` block; the OpenAI-compatible path as a
 *      `reasoning_effort` field. Each has its own function here and its own
 *      case for "the model does not take this level, so send nothing".
 *   2. The effort vocabulary. `EFFORTS` carries all seven ids the reference
 *      uses, and the models this app ships have to offer the levels the
 *      reference's own table gives them - including `none`, which all seven
 *      of its Codex models accept and which this app used to hide.
 *   3. Removal. The reference disables a custom provider rather than deleting
 *      it, which is what lets a removed id be re-added. Nothing about that is
 *      visible in a type: it is an invariant of the config store, and the way
 *      to see it is to remove one and look at what is still there.
 *
 * Each case says what a person would expect, so a surprise reads as a finding
 * rather than as a number.
 */
// First of all, so nothing here can read the person's own home directory.
import "./fenced-home"
import assert from "node:assert/strict"
import { IndexDatabase } from "../src/server/history/database"
import { MemoryIndex } from "../src/server/memory/index"
import { SMART_THRESHOLD, scoreComplexity, tierForScore } from "../src/shared/smart"
import { SessionRunner } from "../src/server/session/runner"
import { SessionStore } from "../src/server/session/store"
import { Permissions } from "../src/server/permission"
import { handle } from "../src/server/handlers"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { COMMAND_SOURCES, EFFORTS, type AssistantMessage, type Attachment, type Effort, type UserMessage } from "@shared/protocol"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config, customModelOf } from "../src/server/config"
import { modelVariants } from "../src/server/provider/variants"
import { reasoningRequest as anthropicReasoning } from "../src/server/provider/anthropic"
import { reasoningRequest as codexReasoning } from "../src/server/provider/chatgpt"
import { adapterFor } from "../src/server/provider/adapter"
import { AnthropicAdapter, toProviderMessages, messagesRequest } from "../src/server/provider/anthropic"
import { ChatGPTSubscription, OpenAIResponses, toInput } from "../src/server/provider/chatgpt"
import { OpenAICompatible } from "../src/server/provider/openai"
import { compatibleOptions, geminiCapabilities } from "../src/server/provider/gemini"
import { transformMessages, transformTool } from "../src/server/provider/transform"
import type { TurnEvent, TurnRequest } from "../src/server/provider/types"
import { requestHistory } from "../src/server/provider/history"

const findings: string[] = []
function note(name: string, ok: boolean, detail: unknown = ""): void {
  const shown = detail === "" ? "" : " - " + JSON.stringify(detail)
  console.log(`  ${ok ? "ok  " : "??  "} ${name}${shown}`)
  if (!ok) findings.push(name + shown)
}

function section(title: string): void {
  console.log("")
  console.log(title)
}

section("Custom provider settings")
const { providerIdProblem } = await import("../src/shared/provider-id")
const { normalizeProviderProtocol, modelLimitProblem } = await import("../src/shared/custom-endpoint")
const { probeModels } = await import("../src/server/provider/discover")
note("provider ids distinguish reserved, taken, slash and empty",
  providerIdProblem(" MiMoRouter ", []) === "reserved" && providerIdProblem("MIFY", []) === "reserved" &&
  providerIdProblem("OpenAI", ["openai"]) === "exists" && providerIdProblem("a/b", []) === "slash" &&
  providerIdProblem("  ", []) === "empty")
for (const [input, expected] of [
  ["", "chat-completions"], ["@ai-sdk/openai-compatible", "chat-completions"], ["chat-completions", "chat-completions"],
  ["@ai-sdk/anthropic", "messages"], ["messages", "messages"], ["responses", "responses"],
  ["@ai-sdk/openai", "responses"], ["@vendor/openai", "responses"],
]) note(`protocol ${input || "(empty)"} maps to ${expected}`, normalizeProviderProtocol(input) === expected)
note("model limits must be paired positive integers",
  modelLimitProblem("", "") === undefined && modelLimitProblem("128000", "4096") === undefined &&
  modelLimitProblem("128000", "") === "pair" && modelLimitProblem("", "4096") === "pair" &&
  ["0", "-1", "1.5", "abc", "9007199254740992"].every((value) => modelLimitProblem(value, "4096") === "integer"))
const legacyModel = { id: "legacy", name: "Legacy", limit: { context: 4096 } }
assert.throws(() => customModelOf(legacyModel), { code: "set.models.limitPair" })
assert.throws(() => customModelOf({ id: " ", name: "Blank" }), { code: "set.models.modelIdRequired" })
note("a saved context-only limit survives an unrelated edit",
  customModelOf({ ...legacyModel, name: "Edited" }, legacyModel).limit?.context === 4096)
for (const protocol of ["chat-completions", "messages", "responses"] as const) {
  let matched = false
  const result = await probeModels({
    baseURL: "https://example.invalid/v1/?region=cn", apiKey: "fixture-key", protocol,
    fetcher: async (url, init) => {
      const headers = new Headers(init?.headers)
      matched = String(url) === "https://example.invalid/v1/models?region=cn" && init?.method === "GET" &&
        (protocol === "messages"
          ? !headers.has("authorization") && headers.get("x-api-key") === "fixture-key" && headers.get("anthropic-version") === "2023-06-01"
          : headers.get("authorization") === "Bearer fixture-key" && !headers.has("x-api-key"))
      return Response.json({ data: [{ id: "one" }, { id: "one" }, { id: "two" }] })
    },
  })
  note(`${protocol} probes the models URL with the matching auth headers`, matched && result.ok && result.models.join(",") === "one,two")
}
const failedProbe = await probeModels({
  baseURL: "https://example.invalid", apiKey: "fixture-key",
  fetcher: async () => { throw new Error("unsafe diagnostic fixture-key") },
})
note("probe errors keep request secrets out of diagnostics", !JSON.stringify(failedProbe).includes("fixture-key"))

const timedOutProbe = await probeModels({
  baseURL: "https://example.invalid", apiKey: "fixture-key", timeout: 5,
  fetcher: async (_url, init) => {
    const body = new ReadableStream({ start(controller) {
      const keepAlive = setTimeout(() => controller.close(), 200)
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive)
        controller.error(init.signal?.reason)
      }, { once: true })
    } })
    return new Response(body)
  },
})
note("the probe deadline includes reading the response body", !timedOutProbe.ok && timedOutProbe.reason === "timeout")

/** A 64k output limit, which is what the Anthropic adapter sends. */
const MAX_TOKENS = 64_000

async function main(): Promise<void> {
  section("Provider breadth characterization")
  {
    note("all four kinds select their adapter", adapterFor("anthropic") === AnthropicAdapter && adapterFor("chatgpt") === ChatGPTSubscription && adapterFor("openai-responses") === OpenAIResponses && adapterFor("openai-compatible") === OpenAICompatible)
    const user: UserMessage = { id: "u", sessionID: "s", role: "user", text: "", attachments: [], time: { created: 1 } }
    const assistant = { id: "a", sessionID: "s", role: "assistant", model: { provider: "anthropic", model: "claude" }, parts: [{ type: "reasoning", text: "thought", signature: "proof" }, { type: "text", text: "answer" }], time: { created: 1 } } as AssistantMessage
    note("empty user becomes Continue", (requestHistory([user])[0] as UserMessage).text === "Continue.")
    note("assistant ending gets Continue", (requestHistory([assistant]).at(-1) as UserMessage).text === "Continue.")
    const wire = JSON.stringify(toProviderMessages([user, assistant], undefined, assistant.model))
    note("Anthropic replays signed thinking", wire.includes('"signature":"proof"') && wire.includes('"thinking":"thought"'))
    note("Anthropic drops foreign signatures", !JSON.stringify(toProviderMessages([user, assistant], undefined, { provider: "anthropic", model: "other" })).includes("proof"))
    const pending = { ...assistant, parts: [{ type: "tool", callID: "call", name: "read", input: {}, status: "running" }] } as AssistantMessage
    const tools = JSON.stringify(toProviderMessages([user, pending], undefined, assistant.model))
    note("unfinished tools get paired interrupted results", tools.includes('"tool_use"') && tools.includes('"tool_result"') && tools.includes("[Tool execution was interrupted]"))
    note("history shaping leaves stored tools untouched", pending.parts[0]?.type === "tool" && pending.parts[0].status === "running")
  }

  section("Model-scoped native reasoning metadata")
  {
    const model = { provider: "anthropic", model: "claude" }
    const message = { id: "native", sessionID: "s", role: "assistant", model, agent: "build", parts: [
      { type: "reasoning", id: "r", text: "thought", native: { signature: "native-proof", extra: { opaque: true } }, time: { created: 0 } },
      { type: "text", id: "t", text: "answer" },
    ], time: { created: 0 } } as AssistantMessage
    const before = JSON.stringify(message)
    const same = requestHistory([message], undefined, model)[0] as AssistantMessage
    note("same model keeps native metadata intact", same.parts[0].native?.signature === "native-proof" && JSON.stringify(same.parts[0].native) === JSON.stringify(message.parts[0].native))
    for (const target of [{ provider: "anthropic", model: "other" }, { provider: "gateway", model: "claude" }]) {
      const other = requestHistory([message], undefined, target)[0] as AssistantMessage
      note(`switch to ${target.provider}/${target.model} strips native but keeps readable reasoning`, !other.parts[0].native && other.parts[0].type === "reasoning" && other.parts[0].text === "thought")
    }
    note("unknown destination never replays native", !(requestHistory([message])[0] as AssistantMessage).parts[0].native)
    note("Anthropic consumes native signature", JSON.stringify(toProviderMessages([message], undefined, model)).includes('"signature":"native-proof"'))
    const responses = { ...message, model: { provider: "openai", model: "gpt" }, parts: [
      { type: "reasoning", id: "r", text: "", native: { encrypted_content: "cipher", id: "rs_1" }, time: { created: 0 } },
      { type: "text", id: "t", text: "answer" },
    ] } as AssistantMessage
    const replay = toInput([responses], undefined, responses.model)
    note("Responses replays native ciphertext and id even without summary", replay.some((item) => item.type === "reasoning" && item.encrypted_content === "cipher" && item.id === "rs_1"))
    note("Responses never replays foreign ciphertext", !JSON.stringify(toInput([responses], undefined, model)).includes("cipher"))
    note("native request shaping never mutates stored transcript", JSON.stringify(message) === before)

    // Exercise the producer's real SSE parser; no credentials or network leave the process.
    const originalFetch = globalThis.fetch
    const events: TurnEvent[] = []
    try {
      globalThis.fetch = async () => new Response([
        { type: "response.output_item.done", item: { type: "reasoning", id: "rs_stream", encrypted_content: "stream-cipher" } },
        { type: "response.output_text.delta", delta: "answer" },
        { type: "response.completed", response: { usage: {} } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      await OpenAIResponses.stream({ apiKey: "test", model: responses.model, system: "test", history: [], tools: [], effort: "low", signal: new AbortController().signal, baseURL: "https://example.test/v1" }, (event) => events.push(event))
      note("Responses stream emits native payload for persistence", events.some((event) => event.type === "reasoning.signature" && event.native?.encrypted_content === "stream-cipher" && event.native.id === "rs_stream"))
      events.length = 0
      globalThis.fetch = async () => new Response([
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "anthropic-proof" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      await AnthropicAdapter.stream({ apiKey: "test", model, system: "test", history: [], tools: [], effort: "low", signal: new AbortController().signal, baseURL: "https://example.test/v1", retries: 0 }, (event) => events.push(event))
      note("Anthropic stream emits native signature for persistence", events.some((event) => event.type === "reasoning.signature" && event.native?.signature === "anthropic-proof"))
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  section("Cross-provider message invariants")
  {
    const model = { provider: "openai", model: "gpt" }
    const user: UserMessage = { id: "u", sessionID: "s", role: "user", text: " ", attachments: [], time: { created: 0 } }
    const assistant = { id: "a", sessionID: "s", role: "assistant", model, agent: "build", parts: [
      { type: "text", id: "blank", text: " " },
      { type: "reasoning", id: "empty", text: "", time: { created: 0 } },
      { type: "text", id: "answer", text: "answer" },
    ], time: { created: 0 } } as AssistantMessage
    const empty = { ...assistant, id: "empty", parts: assistant.parts.slice(0, 2) }
    const before = JSON.stringify([user, empty, assistant])
    const normalized = transformMessages([user, empty, assistant])
    const reply = normalized.find((message) => message.role === "assistant") as AssistantMessage
    note("empty text and reasoning blocks are removed", reply.parts.length === 1 && reply.parts[0].type === "text" && reply.parts[0].text === "answer")
    note("empty assistant messages are removed even in the middle", normalized.every((message) => message.id !== "empty"))
    note("empty content gets Continue before prefill is checked", (normalized[0] as UserMessage).text === "Continue." && (normalized.at(-1) as UserMessage).text === "Continue.")
    note("transform is idempotent", JSON.stringify(transformMessages(normalized)) === JSON.stringify(normalized))
    note("transform never changes the stored transcript", JSON.stringify([user, empty, assistant]) === before)
    const encrypted = { ...assistant, parts: [{ type: "reasoning", id: "r", text: "", native: { encrypted_content: "proof" }, time: { created: 0 } }] } as AssistantMessage
    note("empty summary with ciphertext is not empty content", (transformMessages([encrypted])[0] as AssistantMessage).parts[0].native?.encrypted_content === "proof")
    const toolReply = { ...assistant, parts: [{ type: "tool", id: "t", name: "read", callID: "c", status: "completed", input: {}, output: "", time: { created: 0 } }] } as AssistantMessage
    note("empty tool results remain paired without an extra Continue", transformMessages([toolReply]).length === 1 && JSON.stringify(toProviderMessages([toolReply], undefined, model)).includes('"tool_result"'))
    for (const wire of [toProviderMessages([user, empty, assistant], undefined, model), toInput([user, empty, assistant], undefined, model)]) {
      note("adapter request has no empty text/reasoning blocks and ends with user", !JSON.stringify(wire).includes('"text":""') && wire.at(-1)?.role === "user")
    }
    const tool = { name: "probe", description: "Optional argument", parameters: { type: "object", properties: { optional: { type: "string" } }, required: [] }, execute: async () => { throw new Error("not executed") } }
    const schemaBefore = JSON.stringify(tool.parameters)
    note("Responses explicitly disables strict without making optional fields required", transformTool(tool, model, "responses").strict === false && JSON.stringify(transformTool(tool, model, "responses").parameters) === schemaBefore)
    note("Messages and compatible transports do not gain unsupported strict flags", !("strict" in transformTool(tool, model, "anthropic")) && !("strict" in transformTool(tool, model, "chat")))
    const request: TurnRequest = { apiKey: "test", model, system: "test", history: [user, empty, assistant], tools: [tool], effort: "low", signal: new AbortController().signal, baseURL: "https://example.test/v1" }
    note("Messages tool builder uses common schema normalization without strict", !JSON.stringify(messagesRequest(request).tools).includes('"strict"'))
    const originalFetch = globalThis.fetch
    try {
      for (const [adapter, response] of [
        [OpenAIResponses, 'data: {"type":"response.completed","response":{"usage":{}}}\n\n'],
        [OpenAICompatible, 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'],
      ] as const) {
        let body: Record<string, unknown> = {}
        globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(response, { headers: { "content-type": "text/event-stream" } }) }
        await adapter.stream(request, () => undefined)
        const tools = body.tools as { strict?: boolean; function?: { strict?: boolean } }[]
        note("strict normalization reaches the actual request body", adapter === OpenAIResponses ? tools[0].strict === false : !("strict" in tools[0].function!))
        if (adapter === OpenAICompatible) {
          const messages = body.messages as { role: string; content?: unknown }[]
          note("compatible adapter uses the same cleanup and continuation", messages.at(-1)?.role === "user" && messages.filter((message) => message.role === "assistant").length === 1)
        }
      }
    } finally { globalThis.fetch = originalFetch }
    note("tool schema is unchanged after all three builders", JSON.stringify(tool.parameters) === schemaBefore)
  }

  section("Gemini through OpenAI compatibility")
  {
    const model = (id: string) => ({ provider: "google", model: id })
    const options = (id: string, effort: string, more: Partial<Pick<TurnRequest, "variants" | "thinkingOff" | "extra">> = {}) => compatibleOptions({ model: model(id), effort, ...more })
    const families = [
      ["gemini-2.5-pro", "low,medium,high"],
      ["gemini-2.5-flash", "none,low,medium,high"],
      ["gemini-2.5-flash-lite", "none,low,medium,high"],
      ["gemini-3-pro-preview", "low,high"],
      ["gemini-3.1-pro-preview", "low,medium,high"],
      ["gemini-3-flash-preview", "minimal,low,medium,high"],
      ["gemini-3.1-flash-lite", "minimal,low,medium,high"],
      ["gemini-2.0-flash", ""],
      ["gemini-unknown", ""],
      ["gemini-3-pro-image-preview", ""],
    ] as const
    for (const [id, efforts] of families) {
      const capabilities = geminiCapabilities(model(id))
      note(`${id} advertises only mapped efforts`, capabilities?.reasoningEfforts.join() === efforts)
      note(`${id} menu uses compatible capabilities`, modelVariants("openai-compatible", { id, name: id, reasoning: true, contextWindow: 0, input: 0, output: 0 }, "google").join() === efforts)
      note(`${id} never claims native protocol or signature replay`, capabilities?.nativeProtocol === false && capabilities.thoughtSignatureReplay === false)
    }
    note("Gemini 2.5 flash can turn thinking off", options("gemini-2.5-flash", "none").reasoning_effort === "none" && geminiCapabilities(model("gemini-2.5-flash"))?.canDisableThinking === true)
    for (const id of ["gemini-2.5-pro", "gemini-3-pro-preview", "gemini-3-flash-preview"]) {
      note(`${id} never pretends thinking can be disabled`, !geminiCapabilities(model(id))?.canDisableThinking && options(id, "none").reasoning_effort === undefined && options(id, "high", { thinkingOff: true }).reasoning_effort === undefined)
    }
    note("thinkingOff maps to none on flash", options("gemini-2.5-flash", "high", { thinkingOff: true, variants: ["high"] }).reasoning_effort === "none")
    note("minimal budget maps to low and Gemini 3 Pro medium maps to high", options("gemini-2.5-pro", "minimal").reasoning_effort === "low" && options("gemini-3-pro-preview", "medium").reasoning_effort === "high")
    note("newer Pro retains medium and Flash retains minimal", options("gemini-3.1-pro-preview", "medium").reasoning_effort === "medium" && options("gemini-3-flash-preview", "minimal").reasoning_effort === "minimal")
    note("xhigh and max clamp to high", options("gemini-2.5-pro", "xhigh").reasoning_effort === "high" && options("gemini-3-flash-preview", "max").reasoning_effort === "high")
    note("unknown Gemini generation keeps server default", options("gemini-unknown", "high").reasoning_effort === undefined)
    note("declared effort restrictions still apply", options("gemini-2.5-pro", "high", { variants: [] }).reasoning_effort === undefined && options("gemini-2.5-pro", "max", { variants: ["low"] }).reasoning_effort === undefined)
    note("gateways and case variants get the same family detection", compatibleOptions({ model: { provider: "gateway", model: "Google/GEMINI-2.5-PRO" }, effort: "max" }).reasoning_effort === "high")
    const extra = { extra_body: { google: { thinking_config: { thinking_budget: 2048, include_thoughts: true } } }, reasoning_effort: "xhigh", custom: true }
    const before = JSON.stringify(extra)
    note("native budget wins over conflicting reasoning_effort", options("gemini-2.5-pro", "high", { extra }).reasoning_effort === undefined)
    note("native level also excludes reasoning_effort", options("gemini-3-flash-preview", "high", { extra: { extra_body: { google: { thinking_config: { thinking_level: "low" } } } } }).reasoning_effort === undefined)
    note("include_thoughts alone still permits effort", options("gemini-3-flash-preview", "low", { extra: { extra_body: { google: { thinking_config: { include_thoughts: true } } } } }).reasoning_effort === "low")
    note("extras cannot bypass Gemini effort allowlist", options("gemini-unknown", "high", { extra: { reasoning_effort: "max" } }).reasoning_effort === undefined)
    note("Gemini options do not mutate extras", JSON.stringify(extra) === before)
    note("generic compatible behavior and overrides are unchanged", compatibleOptions({ model: { provider: "local", model: "plain" }, effort: "max" }).reasoning_effort === "max" && compatibleOptions({ model: { provider: "local", model: "plain" }, effort: "high", variants: [] }).reasoning_effort === undefined && compatibleOptions({ model: { provider: "local", model: "plain" }, effort: "high", extra: { reasoning_effort: "custom" } }).reasoning_effort === "custom")
    const originalFetch = globalThis.fetch
    try {
      let body: Record<string, unknown> = {}
      globalThis.fetch = async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
      }
      const request: TurnRequest = { apiKey: "test", model: model("gemini-2.5-flash"), system: "test", history: [], tools: [], effort: "max", signal: new AbortController().signal, baseURL: "https://example.test/v1" }
      await OpenAICompatible.stream(request, () => undefined)
      note("Gemini mapping reaches the actual compatible request", body.reasoning_effort === "high" && !("thinking" in body) && !("top_k" in body))
      await OpenAICompatible.stream({ ...request, extra }, () => undefined)
      note("actual request never combines native config and effort", body.reasoning_effort === undefined && JSON.stringify(body.extra_body) === JSON.stringify(extra.extra_body) && body.custom === true)
    } finally { globalThis.fetch = originalFetch }
  }

  section("The effort vocabulary")
  {
    /*
     * The reference's constants at node-BBwF64dM.js @22219232, plus `max` from
     * the Anthropic and DeepSeek-V4 arms. Seven, in ascending order.
     */
    note(
      "all seven of the reference's levels exist, in its order",
      EFFORTS.join() === "none,minimal,low,medium,high,xhigh,max",
      EFFORTS,
    )
  }

  section("The surface the question tool and the slash menu stand on")
  {
    /*
     * Types vanish at runtime, so the only honest way to assert that this
     * surface is still here is to read the file - the same thing i18n-check
     * does to protocol.ts for its permission families. It was landed ahead of
     * the screens that use it, which means nothing else in the project would
     * notice if a member went missing.
     */
    note(
      "the three sources the reference badges",
      COMMAND_SOURCES.join() === "command,mcp,skill",
      COMMAND_SOURCES,
    )
    const protocol = await fs.readFile("src/shared/protocol.ts", "utf8")
    const declares = (needle: string) => protocol.includes(needle)
    for (const member of [
      'type: "question.list"',
      'type: "question.reply"; requestID: string; answers: QuestionAnswer[]',
      'type: "command.list"; directory: string',
      'type: "question.asked"; request: QuestionRequest',
      'type: "question.replied"',
      'type: "question.rejected"',
      '"question.list": { questions: QuestionRequest[] }',
      '"command.list": { commands: CommandInfo[] }',
    ]) {
      note(`the protocol still declares ${member}`, declares(member))
    }
    for (const shape of ["interface QuestionPrompt", "interface QuestionRequest", "interface QuestionMetadata", "interface CommandInfo", "interface CommandDefinition"]) {
      note(`and ${shape}`, declares(shape))
    }
  }

  section("Which levels each model offers")
  {
    const anthropic = (id: string): Effort[] =>
      modelVariants("anthropic", { id, name: id, contextWindow: 0, input: 0, output: 0, reasoning: true })

    // The snapshot's own `anthropic` provider record, read model by model.
    note("Claude 5 offers five levels", anthropic("claude-opus-5").join() === "low,medium,high,xhigh,max")
    note("Claude 4.6 has no xhigh", anthropic("claude-opus-4-6").join() === "low,medium,high,max")
    note("Haiku 4.5 falls back to the budget pair", anthropic("claude-haiku-4-5").join() === "high,max")
    note(
      "no Anthropic model is offered none or minimal",
      !["claude-opus-5", "claude-opus-4-6", "claude-haiku-4-5"].some((id) =>
        anthropic(id).some((level) => level === "none" || level === "minimal"),
      ),
    )

    /*
     * And the Codex models, which is the half that was wrong. Each list is the
     * `reasoning_options` the snapshot's `openai` provider record carries, so
     * these assertions are against the reference's table and not against this
     * app's own heuristic.
     */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-provider-"))
    const bus = new Bus()
    const config = new Config(new Storage(root), bus, path.join(root, "credentials.json"))
    await config.load()

    const codex = (id: string) => config.variants({ provider: "chatgpt", model: id })?.join()
    note("gpt-5.5 offers none", codex("gpt-5.5") === "none,low,medium,high,xhigh", codex("gpt-5.5"))
    note("gpt-5.4-mini offers none", codex("gpt-5.4-mini") === "none,low,medium,high,xhigh", codex("gpt-5.4-mini"))
    note(
      "the gpt-5.6 tier reaches max, which the heuristic alone would miss",
      codex("gpt-5.6-sol") === "none,low,medium,high,xhigh,max",
      codex("gpt-5.6-sol"),
    )
    note(
      "gpt-5.3-codex-spark has an effort control after all",
      codex("gpt-5.3-codex-spark") === "none,low,medium,high,xhigh",
      codex("gpt-5.3-codex-spark"),
    )

    section("A fetched model list does not override what a person typed into a custom provider")
    {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-provider-thinking-"))
      const own = new Config(new Storage(home), new Bus(), path.join(home, "credentials.json"))
      await own.load()
      await own.set({
        customProviders: [
          {
            id: "lan",
            name: "LAN",
            baseURL: "https://example.test/v1",
            models: [
              { id: "thinker", name: "Thinker", limit: { context: 1048576, output: 32000 }, thinking: { efforts: ["low", "high"], canOff: true, default: "high" } },
              { id: "plain", name: "Plain" },
            ],
          },
        ],
      })
      const levels = () => own.providers().find((row) => row.id === "lan")?.models.find((row) => row.id === "thinker")
      note("before a refresh the menu is the model's own", levels()?.variants.join() === "none,low,high", levels()?.variants)

      // What 刷新模型列表 stores: the server's ids, with nothing but the id known.
      await own.setDiscovered(
        "lan",
        ["thinker", "plain"].map((id) => ({ id, name: id, contextWindow: 0, input: 0, output: 0 })),
      )
      note("after a refresh the menu is still there", levels()?.variants.join() === "none,low,high", levels()?.variants)
      note("and so is its default", levels()?.defaultEffort === "high", levels()?.defaultEffort)
      note(
        "the turn is clamped against that menu as well, so a level is still sent",
        own.menu({ provider: "lan", model: "thinker" }).levels.join() === "none,low,high",
        own.menu({ provider: "lan", model: "thinker" }),
      )
      note("a model that named no thinking still has no menu", own.menu({ provider: "lan", model: "plain" }).levels.length === 0)
      note("the limit typed in is not replaced by the 0 of a bare id", levels()?.contextWindow === 1048576, levels()?.contextWindow)

      // A model typed in after the list was last fetched is still the person's model.
      await own.set({
        customProviders: [
          {
            id: "lan",
            name: "LAN",
            baseURL: "https://example.test/v1",
            models: [
              { id: "thinker", name: "Thinker", thinking: { efforts: ["low", "high"], canOff: true, default: "high" } },
              { id: "added-later", name: "Added later", thinking: { efforts: ["low", "high"] } },
            ],
          },
        ],
      })
      const ids = () => own.providers().find((row) => row.id === "lan")?.models.map((row) => row.id).join()
      note("a model typed in after a refresh is offered", ids()?.split(",").includes("added-later") === true, ids())
      note("and the ones the server listed still are", ids()?.split(",").includes("thinker") === true, ids())
      note("a model taken out of the form is no longer offered, whatever the stale list says", ids()?.split(",").includes("plain") === false, ids())
      note(
        "with its own levels",
        own.providers().find((row) => row.id === "lan")?.models.find((row) => row.id === "added-later")?.variants.join() === "low,high",
      )
      await fs.rm(home, { recursive: true, force: true })
    }

    section("Removal disables a custom provider rather than deleting it")
    {
      /*
       * The behaviour lives in the config store, not in the handler, so this
       * exercises the store - but only the handler's own expression, read out
       * of the handler, so the two cannot drift apart silently. If someone
       * rewrites `provider.removeCustom` to stop going through `set`, the
       * assertions below would keep passing while the app stopped disabling.
       */
      const handlers = await fs.readFile("src/server/handlers.ts", "utf8")
      note(
        "the remove handler still removes by rewriting the list through the store",
        /case "provider\.removeCustom":[\s\S]{0,400}config\.set\(\{[\s\S]{0,200}customProviders: config\.customProviders\.filter/.test(
          handlers,
        ),
      )

      const entry = { id: "probe", name: "Probe", baseURL: "https://example.test/v1", models: [{ id: "m", name: "M" }] }
      await config.set({ customProviders: [entry] })
      note("it is listed once added", Boolean(config.definition("probe")))

      // What the remove handler does: rewrite the list without that entry.
      await config.set({ customProviders: config.get().customProviders.filter((row) => row.id !== "probe") })
      note("it is gone from the list", !config.definition("probe"))
      note("its id is disabled", config.get().disabledProviders.join() === "probe", config.get().disabledProviders)
      note(
        "but its record survives, which is what the reference keeps",
        config.get().customProviders.some((row) => row.id === "probe" && row.baseURL === entry.baseURL),
        config.get().customProviders,
      )
      note("and it is absent from the provider list", !config.providers().some((row) => row.id === "probe"))

      // Re-adding under the same id: allowed, replaces the record, un-disables.
      const again = { ...entry, name: "Probe II", baseURL: "https://example.test/v2", models: [{ id: "m2", name: "M2" }] }
      await config.set({ customProviders: [...config.get().customProviders, again] })
      note("re-adding is not refused by the id-collision rule", Boolean(config.definition("probe")))
      note("the record is replaced, not duplicated", config.get().customProviders.length === 1, config.get().customProviders)
      note("the new values won", config.definition("probe")?.baseURL === "https://example.test/v2")
      note("and the id is no longer disabled", config.get().disabledProviders.length === 0)

      // The user's own removal forgets the record: nothing is left to turn up in the config page.
      await config.set({ customProviders: config.get().customProviders.filter((row) => row.id !== "probe") }, ["probe"])
      note("a removal the user asked for leaves no record", !config.get().customProviders.some((row) => row.id === "probe"), config.get().customProviders)
      note("and no disabled id", !config.get().disabledProviders.includes("probe"), config.get().disabledProviders)
      note("the remove handler passes the id to forget", /customProviders\.filter\(\(entry\) => entry\.id !== request\.provider\) \}, \[request\.provider\]\)/.test(handlers))

      // A record an older build left disabled is dropped at the next start, and a disabled built-in is not touched.
      await config.set({ customProviders: [entry] })
      await config.set({ customProviders: [] })
      await config.set({ disabledProviders: [...config.get().disabledProviders, "anthropic"] })
      note("an older removal still left a disabled record", config.get().customProviders.some((row) => row.id === "probe"))
      const restarted = new Config(new Storage(root), new Bus(), path.join(root, "credentials.json"))
      await restarted.load()
      note("a start drops the leftover record", !restarted.get().customProviders.some((row) => row.id === "probe"), restarted.get().customProviders)
      note("and keeps a disconnected built-in disabled", restarted.get().disabledProviders.join() === "anthropic", restarted.get().disabledProviders)
    }
  }

  section("Anthropic: adaptive thinking, a token budget, or nothing")
  {
    const five = ["low", "medium", "high", "xhigh", "max"]

    const modern = anthropicReasoning("claude-opus-5", "xhigh", five, MAX_TOKENS)
    note(
      "a modern Claude gets adaptive thinking and the level in output_config",
      modern.thinking?.type === "adaptive" && modern.output_config?.effort === "xhigh",
      modern,
    )
    /*
     * S11-10. Every caller used to pass showReasoning: false and this asked
     * for `omitted`, so the server sent no thinking at all - and a step that
     * thought and said nothing then looked exactly like a step that produced
     * nothing. The reference asks for the summary on every such request; the
     * interface still draws none of it.
     */
    note(
      "the thinking is always asked for, summarized",
      anthropicReasoning("claude-opus-5", "high", five, MAX_TOKENS).thinking?.display === "summarized" &&
        anthropicReasoning("claude-haiku-4-5", "high", ["high", "max"], MAX_TOKENS).thinking?.display === "summarized",
    )

    const four6 = anthropicReasoning("claude-sonnet-4-6", "max", ["low", "medium", "high", "max"], MAX_TOKENS)
    note("4.6 is adaptive too", four6.thinking?.type === "adaptive" && four6.output_config?.effort === "max", four6)

    /*
     * The budget branch. `Math.min(16e3, Math.floor(output / 2 - 1))` for high
     * and `Math.min(31999, output - 1)` for max, against the 64k this app
     * sends - the reference's own arithmetic at @22216297.
     */
    const budgetHigh = anthropicReasoning("claude-haiku-4-5", "high", ["high", "max"], MAX_TOKENS)
    const budgetMax = anthropicReasoning("claude-haiku-4-5", "max", ["high", "max"], MAX_TOKENS)
    note(
      "an older Claude gets a thinking budget and no effort field",
      budgetHigh.thinking?.type === "enabled" &&
        budgetHigh.thinking.budget_tokens === 16_000 &&
        budgetHigh.output_config === undefined,
      budgetHigh,
    )
    note(
      "and max is the larger budget",
      budgetMax.thinking?.type === "enabled" && budgetMax.thinking.budget_tokens === 31_999,
      budgetMax,
    )

    note(
      "a level the model does not accept is sent as nothing at all",
      Object.keys(anthropicReasoning("claude-opus-4-6", "xhigh", ["low", "medium", "high", "max"], MAX_TOKENS))
        .length === 0,
    )
    note(
      "a model with no effort control gets no thinking either",
      Object.keys(anthropicReasoning("some-chat-model", "high", [], MAX_TOKENS)).length === 0,
    )
    note(
      "a caller that says nothing about the model still sends the level",
      anthropicReasoning("claude-opus-5", "high", undefined, MAX_TOKENS).output_config?.effort === "high",
    )
  }

  section("History media the target model cannot read")
  {
    const user = (attachments: Attachment[]): UserMessage => ({
      id: "u1",
      sessionID: "s1",
      role: "user",
      text: "look",
      attachments,
      time: { created: 0 },
    })
    const image: Attachment = { path: "/pictures/photo.png", mime: "image/png", data: "cGl4ZWw=", byPath: true }
    const pdf: Attachment = { path: "/papers/paper.pdf", mime: "application/pdf", data: "JVBERi0=", byPath: true }

    const textOnly = requestHistory([user([image, pdf])], { text: true })
    const replaced = (textOnly[0] as UserMessage).attachments
    note("an image the model cannot read is not sent", replaced[0]?.data === "" && replaced[0]?.byPath === false, replaced[0])
    note("and it reads as one line saying why", /cannot read image input/.test(replaced[0]?.note ?? ""), replaced[0]?.note)
    note("a PDF is replaced the same way", /cannot read PDF input/.test(replaced[1]?.note ?? ""), replaced[1]?.note)

    const vision = requestHistory([user([image])], { text: true, image: true })
    note("a model that reads the picture keeps it", (vision[0] as UserMessage).attachments[0]?.data === image.data, (vision[0] as UserMessage).attachments[0])

    const tool: AssistantMessage = {
      id: "a1",
      sessionID: "s1",
      role: "assistant",
      model: { provider: "anthropic", model: "claude-opus-5" },
      agent: "build",
      parts: [
        { type: "tool", id: "t1", callID: "c1", name: "read", status: "completed", input: {}, attachments: [pdf], time: { created: 0 } },
      ],
      time: { created: 0 },
    }
    const toolOnly = requestHistory([tool], { text: true })
    const part = (toolOnly[0] as AssistantMessage).parts[0]
    note("a tool result's PDF is replaced too", part.type === "tool" && /cannot read PDF input/.test(part.attachments?.[0]?.note ?? ""), part)
  }

  section("Codex: a reasoning block, or nothing")
  {
    const five = ["none", "low", "medium", "high", "xhigh"]
    note(
      "an accepted level is sent",
      codexReasoning("high", five).reasoning?.effort === "high",
      codexReasoning("high", five),
    )
    note("none is a level, not an absence", codexReasoning("none", five).reasoning?.effort === "none")
    // S11-10: the reference asks for `auto` on every such request, whatever the interface draws.
    note("the summary is always asked for", codexReasoning("high", five).reasoning?.summary === "auto")
    note(
      "a level the model does not accept withholds the whole block",
      codexReasoning("max", five).reasoning === undefined,
      codexReasoning("max", five),
    )
    note("a model with no effort control gets no reasoning block", codexReasoning("high", []).reasoning === undefined)
    note("a caller that says nothing still sends it", codexReasoning("high", undefined).reasoning?.effort === "high")
  }

  console.log("")
  if (findings.length) {
    console.error(`${findings.length} case(s) behaved unexpectedly:`)
    for (const finding of findings) console.error("  " + finding)
    process.exit(1)
  }
  console.log("Every level offered is one the model takes, and a removed provider is disabled rather than lost.")
  process.exit(0)
}

async function checkSmartRouting() {
  const greeting = "你好"
  const complex = "请重构架构 src/a.ts 和 src/b.ts\n```ts\nTypeError: broken\n    at main (src/a.ts:12:3)\n```"
  const greetingScore = scoreComplexity(greeting)
  const complexScore = scoreComplexity(complex)
  note("Smart defaults to confidence 0.90", SMART_THRESHOLD === 0.90)
  note("confidence is normalized and higher on simpler prompts", greetingScore === 1 && complexScore >= 0 && complexScore < greetingScore)
  note("confidence at the threshold uses lightweight", tierForScore(0.89) === "main" && tierForScore(0.90) === "fast")
  note("threshold endpoints are inclusive", tierForScore(0, 0) === "fast" && tierForScore(0.99, 1) === "main" && tierForScore(1, 1) === "fast")
  note("recent tools, references and failed retries lower confidence", scoreComplexity(greeting, { tools: 4, files: 2, retry: true }) === 0.60)

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smart-check-"))
  const project = path.join(root, "project")
  await fs.mkdir(project)
  const storage = new Storage(path.join(root, "data"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "credentials.json"))
  const sessions = new SessionStore(storage, bus)
  const runner = new SessionRunner(sessions, bus, config, new Permissions(bus, config), { accessToken: async () => undefined } as never, storage)
  const model = (id: string) => ({ provider: "smart-fixture", model: id })
  const requests: Array<{ model: string; authorization: string | null }> = []
  let failNext = false
  const fetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (input !== "https://smart-fixture.invalid/v1/chat/completions") throw new Error(`Unexpected fixture URL: ${input}`)
    requests.push({ model: JSON.parse(String(init?.body)).model, authorization: new Headers(init?.headers).get("authorization") })
    if (failNext) {
      failNext = false
      return new Response(JSON.stringify({ error: { message: "fixture failure" } }), { status: 400 })
    }
    const events = [
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  }
  try {
    const configFile = path.join(storage.directory, "config.json")
    await fs.mkdir(storage.directory, { recursive: true })
    await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 1, smartThreshold: 60 }))
    await config.load()
    const migrated = new Config(storage, new Bus(), path.join(root, "credentials.json"))
    await migrated.load()
    note("legacy 60/100 becomes 0.60 in memory and on disk",
      config.get().smartThreshold === 0.60 && migrated.get().smartThreshold === 0.60
        && JSON.parse(await fs.readFile(configFile, "utf8")).smartThreshold === 0.60)
    await config.set({ smartThreshold: 1 })
    await migrated.load()
    note("a saved version 2 threshold of 1 stays 1 on reload", migrated.get().smartThreshold === 1)
    await config.set({
      customProviders: [{ id: "smart-fixture", name: "Smart Fixture", baseURL: "https://smart-fixture.invalid/v1", models: ["manual", "fast", "main"].map((id) => ({ id, name: id })) }],
      model: model("manual"), smartFast: model("fast"), smartMain: model("main"),
    })
    await config.setApiKey("smart-fixture", "fixture-key")
    const session = await sessions.create({ directory: project, model: model("manual"), title: "Smart fixture", smart: true })

    async function settled(target = session) {
      const deadline = Date.now() + 5000
      while (runner.busySessions().includes(target.id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return sessions.messages(target.id)
    }
    async function turn(text: string, target = session) {
      const count = requests.length
      const id = await runner.prompt({ sessionID: target.id, text })
      const messages = await settled(target)
      const user = messages.find((message) => message.role === "user" && message.id === id)
      const reply = messages.filter((message) => message.role === "assistant").at(-1)
      assert.ok(user?.role === "user" && reply, "the runner persisted the user message and reply")
      note("turn sends one request with the selected model", requests.length === count + 1 && requests.at(-1)?.model === reply.model.model && requests.at(-1)?.authorization === "Bearer fixture-key", requests)
      return { reply, route: user.route }
    }

    const off = await turn(greeting)
    note("default-off Smart keeps the manual model and ordinary usage", off.reply.model.model === "manual" && off.reply.usage?.input === 10 && !off.reply.usage.route && !off.route)
    await config.set({ smart: true, smartThreshold: SMART_THRESHOLD })
    for (const [kind, prompt] of [["development", "Fix the bug"], ["research", "Research this topic"]]) {
      const fresh = await sessions.create({ directory: project, model: model("manual"), title: "Task fixture" })
      const standard = await turn(prompt!, fresh)
      note(`${kind} is standard even with a simple prompt`, standard.reply.model.model === "main" && standard.route?.score === undefined)
    }
    const light = await turn(greeting)
    await config.set({ smartThreshold: 1 })
    const continued = await turn(complex)
    note("an assigned session keeps its tier despite a new task and threshold",
      light.reply.model.model === "fast" && continued.reply.model.model === "fast"
        && (await sessions.require(session.id)).model.model === "manual"
        && (await new SessionStore(storage, new Bus()).require(session.id)).smartRoute === "fast")
    note("confidence and tier survive in transcript usage",
      light.reply.usage?.route?.tier === "fast" && light.reply.usage.route.score === greetingScore
        && JSON.stringify(continued.reply.usage?.route) === JSON.stringify(continued.route))
    const runtime = { sessions } as Parameters<typeof handle>[0]
    await handle(runtime, { type: "session.model", sessionID: session.id, model: model("manual") })
    const reopened = new SessionStore(storage, new Bus())
    note("manual selection persists a session-only override", (await reopened.require(session.id)).smart === false && config.get().smart === true)
    const pinned = await turn(complex)
    note("the session override bypasses routing", pinned.reply.model.model === "manual" && !pinned.reply.usage?.route)
    await handle(runtime, { type: "session.smart", sessionID: session.id })
    note("restoring Smart routes the next turn", (await turn(greeting)).reply.usage?.route?.tier === "fast")
    failNext = true
    const failed = await turn(greeting)
    note("an unsuccessful first attempt still carries its routing decision", failed.reply.finish === "error" && failed.route?.tier === "fast")
    await runner.resumeTurn(session.id)
    const resumed = (await settled()).filter((message) => message.role === "assistant").at(-1)
    note("an explicit retry preserves the assigned tier", resumed?.model.model === "fast" && resumed.usage?.route?.tier === "fast", resumed)
    await config.set({ smartThreshold: 150 })
    note("threshold patches persist within the allowed range", config.get().smartThreshold === 1)
    const onDisk = (await reopened.messages(session.id)).filter((message) => message.role === "assistant").at(-1)
    note("route usage survives opening the transcript from storage", onDisk?.usage?.route?.tier === "fast")
    await config.set({ smart: false })
    note("turning Smart off after routing restores the manual model", (await turn(complex)).reply.model.model === "manual")
    note("Smart routing produces no background model request", !(await runner.backgroundUsage.list()).some((entry) => entry.kind === "smart"))
  } finally {
    globalThis.fetch = fetch
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function checkMemoryReset() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-memory-reset-"))
  const database = await IndexDatabase.open(path.join(root, "search.db"))
  try {
    const memory = new MemoryIndex(database, path.join(root, "memory"))
    for (const entry of ["global/MEMORY.md", "projects/p/MEMORY.md", "sessions/s/notes.md", "sessions/s/checkpoint-1.md", "sessions/s/tasks/T1/progress.md"]) {
      const file = path.join(memory.root, entry)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, "resetfixture")
    }
    note("all memory scopes and checkpoints are searchable before reset", (await memory.search({ query: "resetfixture" })).length === 5)
    const backup = path.join(root, "backup", "memory-projects-2026-11-18T00-00-00-000Z")
    await fs.mkdir(backup, { recursive: true })
    await fs.writeFile(path.join(backup, "old.md"), "backup")
    await fs.writeFile(path.join(root, "backup", "other.json"), "{}")
    try {
      await memory.reset()
      note("reset removes the memory migration backup only", JSON.stringify(await fs.readdir(path.dirname(backup))) === '["other.json"]')
      note("reset immediately clears the persistent index", (await database.db.all("SELECT id FROM memory_doc")).length === 0)
      note("reset empties the memory directory", (await fs.readdir(memory.root)).length === 0)
      note("reset clears memory search results", (await memory.search({ query: "resetfixture" })).length === 0)
    } catch (failure) {
      note("reset empties the memory directory and clears search", false, failure)
    }
  } finally {
    await database.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}

/*
 * A server on the person's own network answers without a key, and being told to
 * type one anyway teaches the wrong habit. Measured against a DeepSeek server on
 * 192.168.10.131:8020: `/models` and chat both answered 200 with no
 * Authorization header at all, while the app refused to list the model until a
 * placeholder key was stored — which leaves a config that lies about the setup.
 * A public address keeps the old rule, because there a missing key really is a
 * missing credential.
 */
async function checkSelfHostedKeyless(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-selfhost-"))
  try {
    const storage = new Storage(path.join(root, "data"))
    const config = new Config(storage, new Bus(), path.join(root, "credentials.json"))
    await fs.mkdir(storage.directory, { recursive: true })
    await config.load()
    const at = (id: string, baseURL: string) => ({ id, name: id, baseURL, models: [{ id: "tiny", name: "tiny" }] })
    await config.set({
      customProviders: [
        at("lan", "http://192.168.10.131:8020/v1"),
        at("loopback", "http://127.0.0.1:8020/v1"),
        at("loopback-v6", "http://[::1]:8020/v1"),
        at("tailscale", "http://100.127.4.9:8080/v1"),
        at("carrier", "http://172.20.1.5:8000/v1"),
        at("public-ip", "http://8.8.8.8/v1"),
        at("public-host", "https://api.example.com/v1"),
      ],
    })
    note("a hand-entered provider on a LAN address is selectable without a key", config.usable("lan") === true)
    note("loopback is selectable without a key", config.usable("loopback") === true && config.usable("loopback-v6") === true)
    note("a tailnet address is selectable without a key", config.usable("tailscale") === true && config.usable("carrier") === true)
    note("a public address still needs a key or a header", config.usable("public-ip") === false && config.usable("public-host") === false)
    const listed = config.enabled().map((entry) => entry.provider)
    note("the picker offers the LAN provider and not the public one", listed.includes("lan") && !listed.includes("public-host"), listed)
    await config.setApiKey("public-host", "a-key")
    note("a public address with a key becomes selectable", config.usable("public-host") === true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

await checkSmartRouting()
await checkMemoryReset()
await checkSelfHostedKeyless()
void main()
