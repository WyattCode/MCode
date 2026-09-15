/**
 * An MCP server that speaks first as well as answering, for the smoke checks.
 *
 * Tools: `echo` (a schema with no type), `shape` (every kind of content plus
 * structured content), `where` (its working folder), `grow` (adds a tool and
 * says the list changed), `slow` (never answers), `cancelled` (the ids it was
 * told to stop), `collide` (sends its own ping with the id of the call it is
 * answering) and `ask-model` (a sampling request, answered with what came back).
 */
let buffer = ""
let grown = false
let serverID = 0
const cancelled = []
const waiting = new Map()

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8")
  let index = buffer.indexOf("\n")
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
    index = buffer.indexOf("\n")
  }
})

/** Sends a request of the server's own and resolves with the client's reply. */
function ask(method, params, id = `srv-${++serverID}`) {
  return new Promise((resolve) => {
    waiting.set(String(id), resolve)
    send({ jsonrpc: "2.0", id, method, params })
  })
}

const text = (id, value) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: value }] } })

function tools() {
  const list = [
    { name: "echo", description: "Repeats what it is given.", inputSchema: { properties: { text: { type: "string" } } } },
    { name: "shape", inputSchema: { type: "object", properties: {} } },
    { name: "where", inputSchema: { type: "object" } },
    { name: "grow", inputSchema: { type: "object" } },
    { name: "slow", inputSchema: { type: "object" } },
    { name: "cancelled", inputSchema: { type: "object" } },
    { name: "collide", inputSchema: { type: "object" } },
    { name: "ask-model", inputSchema: { type: "object" } },
  ]
  if (grown) list.push({ name: "extra", inputSchema: { type: "object" } })
  return list
}

async function handle(message) {
  if (message.method === undefined) {
    const resolve = waiting.get(String(message.id))
    if (resolve) {
      waiting.delete(String(message.id))
      resolve(message)
    }
    return
  }
  if (message.id === undefined) {
    if (message.method === "notifications/cancelled") cancelled.push(message.params?.requestId)
    return
  }
  const { id, method, params } = message
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "rich", version: "1" } } })
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: tools() } })
  } else if (method === "tools/call") {
    const name = params?.name
    if (name === "echo") text(id, String(params.arguments?.text ?? ""))
    else if (name === "shape") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: "alpha" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "resource", resource: { uri: "file:///r.txt", mimeType: "text/plain", text: "resource body" } },
            { type: "resource_link", uri: "https://example.com/doc", name: "doc" },
          ],
          structuredContent: { answer: 42 },
        },
      })
    } else if (name === "where") text(id, process.cwd())
    else if (name === "grow") {
      grown = true
      text(id, "grown")
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    } else if (name === "slow") {
      // Never answered.
    } else if (name === "cancelled") text(id, JSON.stringify(cancelled))
    else if (name === "collide") {
      const reply = await ask("ping", {}, id)
      text(id, `pong:${JSON.stringify(reply.result ?? reply.error)}`)
    } else if (name === "ask-model") {
      const reply = await ask("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 50 })
      text(id, JSON.stringify(reply.result ?? reply.error))
    } else send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "no such tool" }], isError: true } })
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
  }
}
