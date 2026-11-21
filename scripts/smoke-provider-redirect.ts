/*
 * A provider that answers with a redirect must not have its conversation carried off.
 *
 * The two streaming requests used to leave `redirect` unset, which means the platform follows
 * 307/308 with the body and the `Authorization` header intact. For a server that was admitted
 * because its address is on your own network (1.2.5) that turns one redirect into the whole
 * conversation arriving at somebody else's origin, with no key anywhere to notice. These two
 * loopback servers make the difference visible: the first only redirects, and the test passes
 * when the second never sees a request.
 */

import http from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { OpenAIResponses } from "../src/server/provider/chatgpt"
import { OpenAICompatible } from "../src/server/provider/openai"
import type { TurnRequest } from "../src/server/provider/types"

const SSE = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  return (server.address() as AddressInfo).port
}

function request(baseURL: string): TurnRequest {
  return {
    apiKey: "sk-should-not-travel",
    model: { provider: "custom", model: "test-model" },
    system: "test",
    history: [],
    tools: [],
    effort: "low",
    signal: new AbortController().signal,
    baseURL,
  } as unknown as TurnRequest
}

export async function providerRedirectChecks(check: (label: string, ok: boolean, detail?: unknown) => void) {
  const seen: string[] = []
  const target = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      seen.push(`${req.url} auth=${req.headers.authorization ?? "none"} bytes=${body.length}`)
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(SSE)
    })
  })
  const targetPort = await listen(target)

  const redirecting = http.createServer((req, res) => {
    const onward = req.url?.endsWith("/responses") ? "/v1/responses" : "/v1/chat/completions"
    res.writeHead(307, { location: `http://127.0.0.1:${targetPort}${onward}` })
    res.end()
  })
  const redirectPort = await listen(redirecting)

  try {
    let threw = ""
    try {
      await OpenAICompatible.stream(request(`http://127.0.0.1:${redirectPort}/v1`), () => undefined)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check("a chat redirect is refused instead of followed", threw.includes("redirect") && seen.length === 0, { threw, seen })

    const before = seen.length
    try {
      await OpenAIResponses.stream(request(`http://127.0.0.1:${redirectPort}/v1`), () => undefined)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check("a responses redirect is refused instead of followed", threw.includes("redirect") && seen.length === before, { threw, seen })

    // The control group: the same adapter against a server that answers directly still streams.
    const direct = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(SSE)
    })
    const directPort = await listen(direct)
    const events: string[] = []
    let controlError = ""
    try {
      await OpenAICompatible.stream(request(`http://127.0.0.1:${directPort}/v1`), (event) => events.push(event.type))
    } catch (error) {
      controlError = error instanceof Error ? error.message : String(error)
    }
    await new Promise<void>((resolve) => direct.close(() => resolve()))
    check("a provider that answers directly still streams", controlError === "" && events.length > 0, { controlError, events })
  } finally {
    await new Promise<void>((resolve) => target.close(() => resolve()))
    await new Promise<void>((resolve) => redirecting.close(() => resolve()))
  }
}
