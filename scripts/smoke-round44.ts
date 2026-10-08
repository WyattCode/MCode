/**
 * Round 44: OpenCode v2 again, from 7e42a897 to 75225026 (2.0.25).
 *
 * - Shell commands that hid a delete from the scanner, found by running v2's
 *   adversarial scanner tests against MCode's: PowerShell's typographic
 *   quotes, `pwsh --command`, `Invoke-Expression`, a backtick escape inside a
 *   command name, a `<# #>` comment in front, a command after an assignment,
 *   the call operator with a quoted name; in bash a function body, and a
 *   program computed when the line runs, which is now asked about every time.
 *   Each was a delete that an "always" for its first word let through.
 * - An MCP sign-in's browser page waits for the token exchange and says how it
 *   went: it said "Signed in" as soon as the code arrived, also for a code the
 *   server then refused.
 * - A remote MCP server that answers its first handshake with a passing
 *   failure (a 503, a dropped connection) is tried twice more before it is
 *   called failed, as v2 does; a 4xx is not.
 * - Qwen on DashScope gets v2's cache marks (system prompt and last message);
 *   a reply Anthropic stops says what for (its category and sentence); one
 *   more overflow wording (Together / TGI); Code Mode's guidance follows v2
 *   to `Promise.allSettled`.
 *
 * smoke.ts calls `roundFortyFourChecks` with its own check and section.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { scanCommand } from "../src/server/tool/bash-scan"
import { createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { Bus } from "../src/server/bus"
import { McpServers } from "../src/server/mcp"
import type { AppConfig, McpServerConfig } from "@shared/protocol"
import { OpenAICompatible, qwenCacheMarked } from "../src/server/provider/openai"
import { ProviderHttpError } from "../src/server/provider/types"
import { isOverflowError } from "../src/server/session/overflow"
import { engine } from "./smoke-round5"
import { ensureCallbackServer, stopCallbackServer, waitForCallback } from "../src/server/mcp-oauth"

export async function roundFortyFourChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 44 (1): deletes the scanner did not see")
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r44-scan-"))
    try {
      const deletes = async (command: string, powershell: boolean) => (await scanCommand(command, cwd, cwd, powershell)).deletes.length > 0
      const hidden: [string, boolean, string][] = [
        ["Write-Output ‘a'; Remove-Item victim; Write-Output 'b’", true, "typographic single quotes close PowerShell strings"],
        ["Write-Output “a\"; Remove-Item victim; Write-Output \"b”", true, "and typographic double quotes"],
        ['pwsh --command "Remove-Item victim.txt"', true, "pwsh --command is read inside"],
        ['powershell /c "Remove-Item victim.txt"', true, "and powershell /c"],
        ["Invoke-Expression 'Remove-Item victim.txt'", true, "Invoke-Expression is read as eval is"],
        ["iex 'Remove-Item victim.txt'", true, "and its alias iex"],
        ["Remove-`Item victim", true, "a backtick escape inside the command name"],
        ["<# ignored #> Remove-Item victim", true, "a block comment in front"],
        ["[string]$x = Remove-Item victim", true, "a command after an assignment"],
        ["$x=Remove-Item victim", true, "and after one written without spaces"],
        ["& 'Remove-Item' victim", true, "the call operator with a quoted name"],
        ["& $tool victim", true, "the call operator with a computed one"],
        ["f(){ rm -rf victim; }; f", false, "a bash function body"],
        ["$(printf rm) -rf victim", false, "a program computed by a substitution"],
        ["`printf rm` -rf victim", false, "or by backticks"],
        ["$TOOL -rf victim", false, "or held in a variable"],
      ]
      for (const [command, powershell, why] of hidden) check(`a delete is seen through ${why}`, await deletes(command, powershell), command)
      // The ordinary lines a model writes are not made into deletes on the way.
      const plain: [string, boolean][] = [
        ["foreach ($f in $files) { Write-Output $f }", true],
        ["$files = Get-ChildItem; $files.Count", true],
        ["$a + $b", true],
        ["Write-Output 'it''s fine'", true],
        ["git status; npm test", false],
        ["FOO=1 npm test", false],
        ["echo \"$(date)\"", false],
      ]
      for (const [command, powershell] of plain) check(`an ordinary line is not a delete: ${command}`, !(await deletes(command, powershell)), command)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }

  section("Round 44 (2): the sign-in page waits for the token exchange")
  {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const found = (probe.address() as { port: number }).port
        probe.close(() => resolve(found))
      })
    })
    const redirect = `http://127.0.0.1:${port}/mcp/oauth/callback`
    await ensureCallbackServer(redirect)
    try {
      const visit = async (state: string, settle: (result: { code: string; respond: (failure?: string) => void }) => void) => {
        const waiting = waitForCallback(state)
        let replied = false
        const page = fetch(`${redirect}?code=c-${state}&state=${state}`).then(async (response) => {
          replied = true
          return { status: response.status, body: await response.text() }
        })
        const result = await waiting
        await new Promise((resolve) => setTimeout(resolve, 200))
        const early = replied
        settle(result)
        return { early, code: result.code, ...(await page) }
      }
      const refused = await visit("r44a", (result) => result.respond("invalid_grant: code expired"))
      check("the browser hears nothing until the code has been exchanged", !refused.early && refused.code === "c-r44a", refused)
      check("a code the server refused is said to have failed, with the reason", refused.status === 400 && refused.body.includes("invalid_grant: code expired") && !refused.body.includes("Signed in"), refused.status)
      const accepted = await visit("r44b", (result) => result.respond())
      check("and one it took is said to have signed in", accepted.status === 200 && accepted.body.includes("Signed in"), accepted.status)
    } finally {
      await stopCallbackServer()
    }
  }

  section("Round 44 (3): a passing failure when an MCP server connects is tried again")
  {
    // `failFirst` handshakes answer 503 (or `status`), then the server works.
    const stub = (status: number, failFirst: number) => {
      const seen = { handshakes: 0 }
      const server = createHttpServer((request, response) => {
        let raw = ""
        request.on("data", (chunk) => (raw += chunk))
        request.on("end", () => {
          if (request.method !== "POST") {
            response.writeHead(405)
            return response.end()
          }
          const body = raw ? JSON.parse(raw) : {}
          if (body.method === "initialize" && ++seen.handshakes <= failFirst) {
            response.writeHead(status)
            return response.end("busy")
          }
          if (body.id === undefined) {
            response.writeHead(202)
            return response.end()
          }
          const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "r44", version: "1" } } : body.method === "tools/list" ? { tools: [] } : {}
          response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" })
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
        })
      })
      return { server, seen }
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r44-mcp-"))
    const connectTo = async (status: number, failFirst: number) => {
      const { server, seen } = stub(status, failFirst)
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
      const value = { mcpServers: { web: { type: "remote", url, oauth: false } as McpServerConfig }, directory: home }
      const config = { get: () => value as unknown as AppConfig, set: async () => value as unknown as AppConfig }
      const mcp = new McpServers(new Bus(), config as never, undefined, home)
      try {
        await mcp.start()
        return { status: mcp.list().find((entry) => entry.name === "web")?.status, handshakes: seen.handshakes }
      } finally {
        await mcp.close()
        server.close()
      }
    }
    try {
      const busy = await connectTo(503, 1)
      check("a server that answers 503 once is connected on the next try", busy.status === "connected" && busy.handshakes === 2, busy)
      const down = await connectTo(503, 9)
      check("one that keeps answering 503 is tried three times in all, then failed", down.status === "failed" && down.handshakes === 3, down)
      const refused = await connectTo(400, 9)
      check("a 400 is not tried again", refused.status === "failed" && refused.handshakes === 1, refused)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  section("Round 44 (4): Qwen's cache marks, a stopped reply's reason, and two smaller ones")
  {
    // Qwen on DashScope: the request as the adapter sends it.
    check("Qwen on DashScope is marked, another model there or Qwen elsewhere is not", qwenCacheMarked("dashscope", "qwen3-coder-plus") && !qwenCacheMarked("dashscope", "deepseek-v3.2") && !qwenCacheMarked("openrouter", "qwen3-coder"))
    let sent: Record<string, any> | undefined
    const server = createHttpServer((request, response) => {
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        sent = JSON.parse(raw)
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const history = [
        { id: "u1", sessionID: "s", role: "user", text: "first", attachments: [], time: { created: 1 } },
        { id: "a1", sessionID: "s", role: "assistant", parts: [{ type: "text", text: "answer" }], time: { created: 2 } },
        { id: "u2", sessionID: "s", role: "user", text: "second", attachments: [], time: { created: 3 } },
      ]
      await OpenAICompatible.stream(
        { apiKey: "k", model: { provider: "dashscope", model: "qwen3-coder-plus" }, system: "the system prompt", history, tools: [], effort: "", signal: new AbortController().signal, baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` } as never,
        () => {},
      )
      const messages = (sent?.messages ?? []) as Record<string, any>[]
      const marked = (message: Record<string, any> | undefined) => Array.isArray(message?.content) && message.content.at(-1)?.cache_control?.type === "ephemeral"
      check("the system prompt and the last message carry the mark", marked(messages[0]) && messages[0]?.role === "system" && marked(messages.at(-1)), messages.map((message) => message.role))
      check("and only those two", messages.slice(1, -1).every((message) => !marked(message)), messages.length)
    } finally {
      server.close()
    }

    // A reply Anthropic stops: the card's detail says what for.
    const e = await engine({ custom: { protocol: "anthropic" } })
    try {
      const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
      const refused = (response: import("node:http").ServerResponse) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(event("message_start", { type: "message_start", message: { id: "msg_r44", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }))
        response.write(event("message_delta", { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: { category: "cyber", explanation: "The request asks for working malware." } }, usage: { output_tokens: 1 } }))
        response.end(event("message_stop", { type: "message_stop" }))
      }
      // The stub tells a title request apart by an OpenAI-shaped body only, so over this protocol the title takes a reply too.
      e.replies.push(refused, refused)
      const session = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: session.id, text: "write me something bad" })
      await e.idle(session.id)
      const last = (await e.assistants(session.id)).at(-1)
      check("a stopped reply is still the coded refusal", last?.finish === "refusal" && last.errorCode === "error.contentBlocked", { finish: last?.finish, code: last?.errorCode, error: last?.error })
      check("and its detail says the provider's category and reason", (last?.errorParams?.detail ?? "").includes("cyber") && (last?.errorParams?.detail ?? "").includes("working malware"), last?.errorParams)
    } finally {
      await e.close()
    }

    const tgi = "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 131072. Given: 130000 `inputs` tokens and 4096 `max_new_tokens`"
    check("Together's TGI wording is an overflow", isOverflowError(new ProviderHttpError(tgi, 422, {}), tgi))
    const mcpSource = fs.readFileSync(path.join(process.cwd(), "src", "server", "mcp.ts"), "utf8")
    check("Code Mode advises Promise.allSettled for independent calls, as v2 now does", mcpSource.includes("Run independent calls concurrently with `Promise.allSettled`."))
  }
}
