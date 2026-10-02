/**
 * Round 42: OpenCode v2 again, from f0ed4f67 to 7e42a897 (2.0.21).
 *
 * 131 commits read; what MCode lacked, one section each:
 *
 * - The overflow phrasings v2 added since, Zhipu's "Prompt 超长" and Qwen's
 *   "Range of input length" among them: a conversation that outgrew the model
 *   on those providers ended red instead of being compacted.
 * - A refusal keeps the provider's own words: a 429 and a 5xx dropped them, so
 *   a key with no balance left read as "rate limited, wait a moment" and was
 *   retried for a quarter of an hour. A 429 that says the allowance is spent
 *   (Zhipu's 余额不足 among them) is now said at once.
 * - The output asked for fits what the window has left. A server that checks
 *   prompt plus output against the window (vLLM, llama.cpp, LM Studio) refused
 *   every request once a 64k model's conversation passed 32k, and so compacted
 *   at half the window instead of 90%.
 * - A command knows it is run by an agent: OpenCode v2's AGENT=1 and AI_AGENT,
 *   and MCode's own marker and conversation id.
 * - MCP over Streamable HTTP: a stopped server's session is ended with a
 *   DELETE rather than left to expire; a session the server forgot (404) is
 *   replaced and the request sent again, where every call failed until the
 *   server was reconnected by hand; and a failed call names its tool, its
 *   server and what the server said.
 *
 * Second look, the same day: a call made while a new MCP session was being
 * started went with no session and was refused; a history that shrank was
 * estimated whole, which runs short on Chinese text, instead of the last
 * report less what went; and the summary request's output fell to the floor
 * on any large conversation, the 1.15 margin on an estimate cut to 90% of the
 * window being over the whole window. And one inherited from v2 itself: the
 * text kept "recent" through a compaction walked back to the start of the
 * turn it cut into, so one large pasted message was kept whole and the
 * conversation came out of its compaction nearly as long as it went in.
 *
 * And the user's pelican (2026-10-02): a local Qwen given 32k of output spent
 * all of it thinking, four times over, and wrote nothing - the continuation
 * dropped the thinking and asked it to go on "from exactly where it stopped",
 * so it planned the drawing again from nothing each time. Measured on the
 * model: it needs ~39k of thought for that drawing. The cut thinking now goes
 * back as a digest with a note to act on it, and that one step goes without
 * thinking where MCode knows the switch - told only to act, the model thought
 * 31k more and was cut again; with thinking off it wrote the file at once. A
 * ceiling set above 32k is kept (OpenCode v2's 256k) rather than held to 32k.
 *
 * smoke.ts calls `roundFortyTwoChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import type { AppConfig, McpServerConfig } from "@shared/protocol"
import type { Check } from "./smoke-round5"
import { engine, say, wireText } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import { McpServers } from "../src/server/mcp"
import { describeAnthropicError } from "../src/server/provider/anthropic"
import { describeHttp } from "../src/server/provider/openai"
import { ProviderHttpError, providerErrorMessage } from "../src/server/provider/types"
import { failureCode } from "../src/server/session/error-map"
import { OUTPUT_FLOOR, OUTPUT_TOKEN_CEILING, fitOutput, isOverflowError, maxOutputTokens, promptSince } from "../src/server/session/overflow"
import { thoughtDigest } from "../src/server/provider/history"
import { thinkingOffExtra } from "../src/server/provider/sampling"
import { messagesRequest } from "../src/server/provider/anthropic"
import { findTool } from "../src/server/tool/registry"
import { isTestDevice } from "./android-test-device"
import { installDemo } from "./smoke-round41-install"
import { LENGTH_NOTE, THOUGHT_LENGTH_NOTE } from "../src/server/session/reminders"
import { estimateTokens } from "../src/server/session/estimate"
import { RECENT_KEEP, splitConversation } from "../src/server/session/summary"
import { isRetryable } from "../src/server/session/retry"
import { BashTool } from "../src/server/tool/bash"
import type { ToolContext } from "../src/server/tool/types"

export async function roundFortyTwoChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 42 (1): the overflow wordings v2 learned since f0ed4f67")
  {
    // Each as its provider sends it, on the status it comes with.
    const said: [string, number, string][] = [
      ["Zhipu / Z.ai (code 1261), Chinese", 400, '{"error":{"code":"1261","message":"Prompt 超长"}}'],
      ["Zhipu / Z.ai (code 1261), English", 400, "Prompt too long"],
      ["Qwen on DashScope", 400, "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 129024]"],
      ["Novita, without the counts", 400, "The input is longer than the model's context length"],
      ["DeepInfra", 400, "Requested input length 140000 exceeds maximum input length 131072"],
      ["Amazon Nova", 400, "The number of input tokens exceeds maximum length"],
      ["Workers AI", 400, "AiError: you have exceeded this model context window limit"],
    ]
    for (const [who, status, message] of said) {
      const err = new ProviderHttpError(message, status, {})
      check(`${who} is an overflow, compacted rather than failed`, isOverflowError(err, message) && failureCode(err)?.code === "error.contextExceeded" && !isRetryable(err), message)
    }
    // The old Novita and Zhipu wordings, which the wider patterns replaced, still match.
    for (const message of ["Input (140000 tokens) is longer than the model's context length (131072 tokens)", "prompt too long; exceeded max context length"]) {
      check(`and so does "${message.slice(0, 40)}…"`, isOverflowError(new ProviderHttpError(message, 400, {}), message))
    }
    const throttle = "Rate limit reached: prompt too long requests are throttled"
    check("a throttle that happens to say it is still not one", !isOverflowError(new ProviderHttpError(throttle, 429, {}), throttle))
  }

  section("Round 42 (2): a refusal keeps the provider's words, and a spent allowance is not waited on")
  {
    const layouts: [string, string][] = [
      ['{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}', "余额不足或无可用资源包,请充值。"],
      ['{"error":"bad model"}', "bad model"],
      ['{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}', "Allocated quota exceeded"],
      ['{"Message":"Too many tokens"}', "Too many tokens"],
      ['{"type":"about:blank","title":"Bad Request","detail":"no such route"}', "no such route"],
      ['{"errors":[{"message":"first"},{"message":"second"}]}', "first"],
    ]
    check("the provider's message is found in each of the usual layouts", layouts.every(([body, said]) => providerErrorMessage(body) === said), layouts.map(([body]) => providerErrorMessage(body)))
    check("and not in a page or a body with none", providerErrorMessage("<html><body>502</body></html>") === undefined && providerErrorMessage('{"error":{"message":"  "}}') === undefined)

    // Zhipu's answer for a key with no balance: 429, a numeric code, Chinese.
    const broke = '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}'
    const brokeSaid = describeHttp(429, broke)
    const brokeErr = new ProviderHttpError(brokeSaid, 429, {}, { code: "1113" })
    check("a 429 carries the provider's reason", brokeSaid.includes("余额不足"), brokeSaid)
    check("one that says the balance is gone is not retried", !isRetryable(brokeErr), brokeSaid)
    check("and the card says the allowance is spent, not to wait", failureCode(brokeErr)?.code === "error.quotaExceeded", failureCode(brokeErr))
    for (const said of ["Insufficient balance or no resource package. Please recharge.", "Your package has expired", "Your plan does not yet include this model", "已达到 5 小时的使用上限"]) {
      check(`nor "${said}"`, !isRetryable(new ProviderHttpError(describeHttp(429, JSON.stringify({ error: { message: said } })), 429, {})))
    }
    // A throttle is still a throttle.
    const slow = describeHttp(429, '{"error":{"type":"rate_limit_error","message":"Rate limit reached for requests per minute"}}')
    const slowErr = new ProviderHttpError(slow, 429, {})
    check("a plain 429 is still waited out", isRetryable(slowErr) && failureCode(slowErr)?.code === "error.rateLimited", slow)
    check("a 429 with no body says what it always said", describeHttp(429, "") === "Rate limited by the provider. Wait a moment and try again.")
    const busy = describeHttp(503, '{"message":"upstream overloaded, retry later"}')
    check("a 5xx carries the provider's reason and is still retried", busy.includes("upstream overloaded") && isRetryable(new ProviderHttpError(busy, 503, {})), busy)
    check("a body with no known layout is passed on as it is", describeHttp(500, "worker crashed").includes("worker crashed"))
    check("a web page is never passed on", !describeHttp(502, "<!DOCTYPE html><html><title>502</title></html>").includes("<"))

    // The same over the Anthropic protocol, which Zhipu, Kimi and MiniMax also serve.
    const body = { type: "error", error: { type: "rate_limit_error", message: "余额不足或无可用资源包,请充值。" } }
    const viaSdk = new Anthropic.RateLimitError(429, body, `429 ${JSON.stringify(body)}`, new Headers())
    const viaSaid = describeAnthropicError(viaSdk) ?? ""
    check("over the Anthropic protocol the reason is kept too", viaSaid.includes("余额不足"), viaSaid)
    check("and it is not retried there either", !isRetryable(viaSdk))
  }

  section("Round 42 (3): the output asked for fits what the window has left")
  {
    const window = { contextWindow: 64_000 }
    check("a short conversation is asked for the whole allowance", fitOutput(32_000, window, { measured: 0, estimated: 1_000 }) === 32_000)
    check("one past half the window is asked for what is left", fitOutput(32_000, window, { measured: 40_000, estimated: 2_000 }) === 64_000 - 40_000 - 2_300)
    check("never less than the floor, which leaves the refusal to bring compaction", fitOutput(32_000, window, { measured: 63_000, estimated: 0 }) === OUTPUT_FLOOR)
    check("and nothing is fitted for a model whose window is unknown", fitOutput(32_000, { contextWindow: 0 }, { measured: 900_000, estimated: 0 }) === 32_000)

    // On the wire: a 64k local model whose first step reports 40k of prompt.
    const e = await engine({ custom: { models: [{ id: "m", name: "M", limit: { context: 64_000, output: 32_000 } }] } as never })
    try {
      const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_r42_read", function: { name: "read", arguments: JSON.stringify({ file_path: "README.md" }) } }] } }] }))
        response.end(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40_000, completion_tokens: 40 } }) + "data: [DONE]\n\n")
      })
      e.replies.push(say("read it"))
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "read the readme" })
      await e.idle(session.id)
      const [first, second] = e.bodies.map((body) => body.max_tokens as number)
      check("the first request asks for the model's whole 32k", first === 32_000, e.bodies.map((body) => body.max_tokens))
      check("the second, 40k into a 64k window, asks for what is left", typeof second === "number" && second < 24_000 && second > 20_000, { first, second })
    } finally {
      await e.close()
    }
  }

  section("Round 42 (4): a command knows an agent is running it")
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r42-env-"))
    const script = path.join(dir, "env.js")
    await fs.writeFile(script, "console.log(JSON.stringify(['AGENT', 'AI_AGENT', 'MCODE', 'MCODE_SESSION_ID'].map((name) => process.env[name] ?? null)))\n")
    const context = { sessionID: "ses_r42_env", messageID: "msg_r42", callID: "call_r42_env", directory: dir, permissions: { ask: async () => undefined }, signal: new AbortController().signal, progress: () => {}, snapshot: async () => {} } as unknown as ToolContext
    const seen = async () => {
      const result = await BashTool.execute({ command: `node "${script}"`, description: "Environment" }, context).catch((error: Error) => ({ output: error.message }))
      return result.output.match(/\[.*\]/)?.[0] ?? result.output
    }
    const before = process.env.AI_AGENT
    try {
      delete process.env.AI_AGENT
      const plain = await seen()
      check("AGENT=1, AI_AGENT names MCode, and the conversation is named", plain === JSON.stringify(["1", "mcode", "1", "ses_r42_env"]), plain)
      process.env.AI_AGENT = "someone-else"
      const kept = await seen()
      check("an AI_AGENT the user's environment already sets is left alone", kept === JSON.stringify(["1", "someone-else", "1", "ses_r42_env"]), kept)
    } finally {
      if (before === undefined) delete process.env.AI_AGENT
      else process.env.AI_AGENT = before
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  section("Round 42 (5-7): MCP sessions over Streamable HTTP, and what a failed call says")
  {
    // A Streamable HTTP server that hands out sessions, can forget one, and records the DELETE that ends one.
    let issued = 0
    let current = ""
    const forgotten = new Set<string>()
    const ended: string[] = []
    const initialized: string[] = []
    const calls: { session: string; tool: string }[] = []
    const server = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", async () => {
        const session = String(request.headers["mcp-session-id"] ?? "")
        if (request.method === "DELETE") {
          ended.push(session)
          response.writeHead(200)
          return response.end()
        }
        if (request.method === "GET") {
          response.writeHead(405)
          return response.end()
        }
        const body = raw ? JSON.parse(raw) : {}
        // As a real server: anything but the handshake needs a session.
        if (body.method !== "initialize" && !session) {
          response.writeHead(400, { "content-type": "application/json" })
          return response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" } }))
        }
        if (body.method !== "initialize" && forgotten.has(session)) {
          response.writeHead(404, { "content-type": "application/json" })
          return response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } }))
        }
        if (body.id === undefined) {
          response.writeHead(202)
          return response.end()
        }
        const reply = (result: unknown, headers: Record<string, string> = {}) => {
          response.writeHead(200, { "content-type": "application/json", ...headers })
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
        }
        if (body.method === "initialize") {
          // A second handshake takes a while, so a request can be made while the new session is coming.
          if (issued > 0) await new Promise((resolve) => setTimeout(resolve, 300))
          current = `s${++issued}`
          initialized.push(current)
          return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "r42", version: "1" } }, { "mcp-session-id": current })
        }
        if (body.method === "tools/list") {
          return reply({ tools: ["echo", "boom"].map((name) => ({ name, inputSchema: { type: "object", properties: { text: { type: "string" } } } })) })
        }
        if (body.method === "tools/call") {
          calls.push({ session, tool: body.params.name })
          if (body.params.name === "boom") {
            response.writeHead(502, { "content-type": "application/json" })
            return response.end(JSON.stringify({ error: { message: "upstream exploded" } }))
          }
          return reply({ content: [{ type: "text", text: `echo: ${body.params.arguments.text}` }] })
        }
        reply({})
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r42-mcp-"))
    const value = { mcpServers: { web: { type: "remote", url, oauth: false } as McpServerConfig }, directory: home }
    const config = { get: () => value as unknown as AppConfig, set: async () => value as unknown as AppConfig }
    const mcp = new McpServers(new Bus(), config as never, undefined, home)
    const context = {
      sessionID: "ses_r42_mcp",
      messageID: "msg_r42_mcp",
      callID: "call_r42_mcp",
      directory: home,
      permissions: { ask: async () => undefined, action: () => "allow" },
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => {},
    } as unknown as ToolContext
    const tool = (name: string) => mcp.tools(home).find((entry) => entry.name === `web_${name}`)
    const run = (name: string, text: string) =>
      tool(name)!.execute({ text }, context).then(
        (result) => result.output,
        (error: Error) => `ERROR ${error.message}`,
      )
    try {
      await mcp.start()
      const first = await run("echo", "one")
      check("the server connects over Streamable HTTP and answers", first === "echo: one" && initialized.length === 1, { first, initialized })

      // The server restarts and forgets the session: the next call is answered from a new one.
      forgotten.add(current)
      const after = await run("echo", "two")
      check("a call into a forgotten session starts a new one and is answered", after === "echo: two", after)
      check("with one new handshake, and the call sent again under the new session", initialized.length === 2 && calls.at(-1)?.session === "s2", { initialized, calls })
      const later = await run("echo", "three")
      check("and the calls after it go on under the new session", later === "echo: three" && calls.at(-1)?.session === "s2", calls.at(-1))

      // Second look: a call made while the new session is still coming waits for it, rather than going with none.
      forgotten.add(current)
      const found = run("echo", "four")
      await new Promise((resolve) => setTimeout(resolve, 100))
      const during = await run("echo", "five")
      check("a call made while a new session is being started waits for it", (await found) === "echo: four" && during === "echo: five" && initialized.length === 3, { during, initialized })

      const failed = await run("boom", "x")
      check("a failed call names its tool and server", failed.includes('MCP tool "boom" on server "web" failed'), failed)
      check("and says what the server said", failed.includes("HTTP 502") && failed.includes("upstream exploded"), failed)
    } finally {
      await mcp.close()
      check("closing ends the server's session rather than leaving it to expire", ended.includes("s3"), ended)
      server.close()
      await fs.rm(home, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  section("Round 42, second look: a shrunk history, and the summary's room")
  {
    const anchor = { model: "fake/m", measured: 40_000, estimated: 30_000 }
    check("with no report, the whole request is estimated", JSON.stringify(promptSince(undefined, "fake/m", 31_000)) === JSON.stringify({ measured: 0, estimated: 31_000 }))
    check("nor with another model's report", JSON.stringify(promptSince(anchor, "other/m", 31_000)) === JSON.stringify({ measured: 0, estimated: 31_000 }))
    check("a history that grew is the report plus the growth", JSON.stringify(promptSince(anchor, "fake/m", 32_000)) === JSON.stringify({ measured: 40_000, estimated: 2_000 }))
    check("one that shrank is the report less what went, with no margin", JSON.stringify(promptSince(anchor, "fake/m", 25_000)) === JSON.stringify({ measured: 35_000, estimated: 0 }))

    // The text kept recent stays within its allowance when the turn it cuts into opens with a large message.
    const said = (id: string, role: "user" | "assistant", text: string) =>
      (role === "user"
        ? { id, sessionID: "s", role, text, attachments: [], time: { created: 1 } }
        : { id, sessionID: "s", role, parts: [{ type: "text", text }], time: { created: 1 } }) as never
    const large = "x ".repeat(RECENT_KEEP * 4)
    const split = splitConversation([said("u1", "user", "hello"), said("a1", "assistant", "hi"), said("u2", "user", large), said("a2", "assistant", "read it"), said("u3", "user", "and the last thing"), said("a3", "assistant", "done")])
    check("a large message before the cut is summarised, not kept whole", Boolean(split) && estimateTokens(split!.recent) <= RECENT_KEEP && split!.older.some((message: { id: string }) => message.id === "u2"), { recent: estimateTokens(split?.recent), older: split?.older.map((message: { id: string }) => message.id) })
    const newest = splitConversation([said("u1", "user", "hello"), said("a1", "assistant", "hi"), said("u2", "user", large), said("a2", "assistant", "read it")])
    check("unless it is the newest turn, which is kept as before", Boolean(newest) && newest!.older.length === 2, newest?.older.map((message: { id: string }) => message.id))

    // A conversation cut to ~88% of its window for its summary leaves the summary its 32k, not the floor.
    // A million-token window, so the system prompt's size, which this check can only approximate, cannot tip it.
    const e = await engine({ custom: { models: [{ id: "m", name: "M", limit: { context: 1_000_000, output: 32_000 } }] } as never })
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "hello" })
      await e.idle(session.id)
      const first = e.bodies[0]!
      const fixed = estimateTokens(String(first.messages?.[0]?.content ?? "")) + estimateTokens(JSON.stringify(first.tools ?? []))
      // The older part is summarised; the last turn is kept as it is.
      await e.runner.prompt({ sessionID: session.id, text: "x ".repeat((880_000 - fixed) * 2) })
      await e.idle(session.id)
      await e.runner.prompt({ sessionID: session.id, text: "and the last thing" })
      await e.idle(session.id)
      await e.runner.compact(session.id)
      const asked = e.summaryBodies.at(-1)?.max_tokens as number | undefined
      const carried = Math.round(JSON.stringify(e.summaryBodies.at(-1)?.messages ?? []).length / 4)
      check("the summary request carries the large part, so the check means something", carried > 800_000, carried)
      check("and its summary is given its 32k, not the floor", asked === 32_000, { asked, fixed })
    } finally {
      await e.close()
    }
  }

  section("Round 42 (8): a reply cut while it was still thinking")
  {
    check("a model's own output ceiling above 32k is kept", maxOutputTokens({ provider: "qw", model: "qwen38-nvfp4" }, { maxOutput: 64_000 }) === 64_000)
    check("up to 256k", maxOutputTokens({ provider: "qw", model: "qwen38-nvfp4" }, { maxOutput: 1_000_000 }) === OUTPUT_TOKEN_CEILING)
    const long = "a".repeat(1_500) + "b".repeat(50_000) + "c".repeat(6_000)
    const digest = thoughtDigest(long)
    check("the digest keeps the thinking's opening and where it had got to", digest.includes("a".repeat(1_500)) && digest.includes("c".repeat(6_000)) && !digest.includes("b".repeat(10)) && digest.length < 8_000, digest.length)

    const off = (provider: string, kind: string, typed: boolean) => JSON.stringify(thinkingOffExtra(provider, kind, typed))
    check("a typed-in or local server is switched off through its chat template", off("qw", "openai-compatible", true) === JSON.stringify({ chat_template_kwargs: { enable_thinking: false, thinking: false } }) && off("vllm", "openai-compatible", false) === off("qw", "openai-compatible", true))
    check("Zhipu and DashScope by their own switches", off("zhipu", "openai-compatible", false) === JSON.stringify({ thinking: { type: "disabled" } }) && off("dashscope", "openai-compatible", false) === JSON.stringify({ enable_thinking: false }))
    check("and a cloud endpoint that refuses unknown fields is left alone", thinkingOffExtra("openai", "openai-compatible", false) === undefined && thinkingOffExtra("deepseek", "openai-compatible", false) === undefined)
    const claude = { apiKey: "", model: { provider: "anthropic", model: "claude-sonnet-4-5" }, system: "s", history: [], tools: [findTool("read")!], effort: "high", variants: ["high", "max"], signal: new AbortController().signal }
    check("over the Anthropic protocol the thinking field is left out for that step", "thinking" in messagesRequest(claude as never) && !("thinking" in messagesRequest({ ...claude, thinkingOff: true } as never)))

    // On the wire: a step of thinking alone, cut at the limit, then the step after it.
    const e = await engine()
    try {
      const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(frame({ choices: [{ delta: { reasoning_content: "PLAN-OPENING: a pelican on a red bike. " + "Detail. ".repeat(3_000) + "PLAN-END: the wheels turn at 1.5s." } }] }))
        response.end(frame({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 32_000 } }) + "data: [DONE]\n\n")
      })
      e.replies.push(say("written"))
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "draw a pelican" })
      await e.idle(session.id)
      const next = wireText(e.bodies[1])
      check("the step after carries where the thinking had got to", next.includes("PLAN-OPENING") && next.includes("PLAN-END") && next.includes("cut off at the output limit"), next.length)
      check("and is told to act on it, not to carry on a reply it cannot see", next.includes(THOUGHT_LENGTH_NOTE.slice(0, 60)) && !next.includes(LENGTH_NOTE.slice(0, 60)))
      check("that step goes without thinking; the first went with it", e.bodies[1]?.chat_template_kwargs?.enable_thinking === false && e.bodies[0]?.chat_template_kwargs === undefined, { first: e.bodies[0]?.chat_template_kwargs, next: e.bodies[1]?.chat_template_kwargs })
      const last = (await e.assistants(session.id)).at(-1)
      check("the turn then ends with the answer, not the output-limit failure", last?.errorCode !== "error.outputLength" && JSON.stringify(last?.parts ?? []).includes("written"), { error: last?.errorCode })

      // Cut inside a tool call: the call cannot run, and the step after it goes without thinking too; the one after that thinks again.
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(frame({ choices: [{ delta: { reasoning_content: "Long plan. " } }] }))
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_r42_cut", function: { name: "write", arguments: '{"file_path":"p.html","content":"<svg' } }] } }] }))
        response.end(frame({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 32_000 } }) + "data: [DONE]\n\n")
      })
      e.replies.push((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_r42_read", function: { name: "read", arguments: JSON.stringify({ file_path: "README.md" }) } }] } }] }))
        response.end(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n")
      })
      e.replies.push(say("done"))
      const sent = e.bodies.length
      await e.runner.prompt({ sessionID: session.id, text: "draw it again" })
      await e.idle(session.id)
      const kwargs = e.bodies.slice(sent).map((body) => body.chat_template_kwargs?.enable_thinking ?? "on")
      check("a step cut inside a tool call is followed by one without thinking, then thinking again", JSON.stringify(kwargs) === JSON.stringify(["on", false, "on"]), kwargs)
    } finally {
      await e.close()
    }
  }

  section("Round 42 (9): the device checks never drive a phone")
  {
    // 2026-10-02: the user's phone was the one device connected, and smoke tapped through its Settings.
    const named = process.env.MCODE_ANDROID_DEVICE
    try {
      delete process.env.MCODE_ANDROID_DEVICE
      check("an emulator is a test device", isTestDevice("emulator-5554") && isTestDevice("127.0.0.1:16384") && isTestDevice("localhost:5555"))
      check("a phone on USB or over Wi-Fi is not", !isTestDevice("0186D460499C3540") && !isTestDevice("192.168.10.30:5555"))
      process.env.MCODE_ANDROID_DEVICE = "0186D460499C3540"
      check("unless it is named on purpose, and then only that one", isTestDevice("0186D460499C3540") && !isTestDevice("emulator-5554"))
      delete process.env.MCODE_ANDROID_DEVICE
      const refused = (() => {
        try {
          installDemo("adb-that-is-never-run", "0186D460499C3540", "demo.apk")
          return "installed"
        } catch (error) {
          return (error as Error).message
        }
      })()
      check("and the demo app is never installed on a phone", refused.includes("not an emulator"), refused)
    } finally {
      if (named === undefined) delete process.env.MCODE_ANDROID_DEVICE
      else process.env.MCODE_ANDROID_DEVICE = named
    }
  }
}
