/**
 * An MCP server that exposes resources, for OpenCode v2's resource tools
 * (round 31, section 8).
 *
 * Its listing comes in two pages, so the client has to follow nextCursor; it
 * has one template; and reading serves text, a picture, a PDF and other bytes,
 * the four kinds read_mcp_resource treats differently. An unknown URI is an
 * error, as a real server's would be.
 */
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
const answer = (id, result) => send({ jsonrpc: "2.0", id, result })

// A 1x1 transparent PNG, and a few bytes standing for a PDF and a zip.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const PDF = Buffer.from("%PDF-1.4 fixture").toString("base64")
const ZIP = Buffer.from("PK\u0003\u0004 twelve bytes").toString("base64")

const READS = {
  "note://readme": [{ uri: "note://readme", mimeType: "text/plain", text: "The fixture's readme." }],
  "note://two": [
    { uri: "note://two", mimeType: "text/plain", text: "first part" },
    { uri: "note://two#2", mimeType: "text/plain", text: "second part" },
  ],
  "img://dot": [{ uri: "img://dot", mimeType: "image/png", blob: PNG }],
  "doc://spec": [{ uri: "doc://spec", mimeType: "application/pdf", blob: PDF }],
  "bin://archive": [{ uri: "bin://archive", mimeType: "application/zip", blob: ZIP }],
}

function handle(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.id === undefined) return
  const { id, method, params = {} } = request
  if (method === "initialize") {
    answer(id, { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "resource-fixture", version: "1" } })
  } else if (method === "tools/list") {
    answer(id, { tools: [{ name: "ping", description: "Answers pong.", inputSchema: { type: "object", properties: {} } }] })
  } else if (method === "tools/call") {
    answer(id, { content: [{ type: "text", text: "pong" }] })
  } else if (method === "resources/list") {
    if (params.cursor === "page-2") {
      answer(id, { resources: [{ uri: "img://dot", name: "dot", mimeType: "image/png" }, { uri: "doc://spec", name: "spec", mimeType: "application/pdf" }, { uri: "bin://archive", name: "archive", mimeType: "application/zip" }] })
    } else {
      answer(id, {
        resources: [
          { uri: "note://readme", name: "readme", title: "Read me", mimeType: "text/plain", description: "What this fixture is" },
          { uri: "note://two", name: "two" },
        ],
        nextCursor: "page-2",
      })
    }
  } else if (method === "resources/templates/list") {
    answer(id, { resourceTemplates: [{ uriTemplate: "record://{id}", name: "record", description: "One record by its ID" }] })
  } else if (method === "resources/read") {
    const contents = READS[params.uri]
    if (contents) answer(id, { contents })
    else send({ jsonrpc: "2.0", id, error: { code: -32002, message: `Resource not found: ${params.uri}` } })
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}
