/**
 * A minimal MCP server, for testing the client against something real.
 *
 * Speaks the same newline-delimited JSON-RPC the client expects: initialize,
 * tools/list, tools/call. Prints a banner on stdout first, deliberately - a
 * client that cannot skip non-JSON lines would fall over on it, and several
 * real servers do exactly this.
 */
process.stdout.write("fake-mcp starting\n")

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8")
  let index = buffer.indexOf("\n")
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(line)
    index = buffer.indexOf("\n")
  }
})

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")

function handle(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.id === undefined) return // a notification; nothing to answer

  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      },
    })
    return
  }

  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Repeats what it is given.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "add",
            description: "Adds two numbers.",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
          },
        ],
      },
    })
    return
  }

  if (request.method === "tools/call") {
    const { name, arguments: args } = request.params ?? {}
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: String(args?.text ?? "") }] },
      })
      return
    }
    if (name === "add") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: String((args?.a ?? 0) + (args?.b ?? 0)) }] },
      })
      return
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: `no such tool: ${name}` }], isError: true },
    })
    return
  }

  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } })
}
