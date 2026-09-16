#!/usr/bin/env node
/*
 * A stdio MCP server for the lifecycle checks: where it runs, what it was
 * started with, paged tool lists, and the ways a server can fail or linger.
 *
 *   --pages N        tools/list answers in N pages (one tool per page)
 *   --fail CODE      prints to stderr and exits with CODE before answering
 *   --stubborn       ignores its stdin closing and SIGTERM, so only a hard kill ends it
 *   --linger         exits by itself 300ms after its stdin closes
 *   --pid-file PATH  writes its process id there on start
 *   --end-file PATH  writes there when its stdin closes
 *   --tag TEXT       answers `tag` with TEXT, so a check can tell two starts apart
 *
 * Every tool answers with text: `where` the working directory, `argv` the
 * arguments as JSON, `env` the variable named by its `name` argument, `tag`
 * the tag, `slow` after two seconds.
 */
const fs = require("node:fs")

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const flag = (name) => args.includes(name)

const pidFile = option("--pid-file")
if (pidFile) fs.writeFileSync(pidFile, String(process.pid))

const failCode = option("--fail")
if (failCode !== undefined) {
  process.stderr.write("lifecycle fixture: refusing to start on purpose\n")
  process.exit(Number(failCode))
}

if (flag("--stubborn")) process.on("SIGTERM", () => {})

const pages = Number(option("--pages") ?? 1)
const tag = option("--tag") ?? ""
const names = ["where", "argv", "env", "tag", "slow"]
const tools = names.map((name) => ({ name, description: `lifecycle ${name}`, inputSchema: { type: "object", properties: { name: { type: "string" } } } }))

function page(cursor) {
  if (pages <= 1) return { tools }
  const index = cursor === undefined ? 0 : Number(cursor)
  const size = Math.ceil(tools.length / pages)
  const slice = tools.slice(index * size, (index + 1) * size)
  return index + 1 < pages ? { tools: slice, nextCursor: String(index + 1) } : { tools: slice }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")

function answer(name, input) {
  if (name === "where") return process.cwd()
  if (name === "argv") return JSON.stringify(args)
  if (name === "env") return process.env[String(input.name)] ?? ""
  if (name === "tag") return tag
  return ""
}

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8")
  let index = buffer.indexOf("\n")
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf("\n")
    if (!line) continue
    const message = JSON.parse(line)
    if (message.id === undefined || !message.method) continue
    const { id, method, params = {} } = message
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "lifecycle", version: "1" } } })
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: page(params.cursor) })
    } else if (method === "tools/call") {
      const reply = () => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: answer(params.name, params.arguments ?? {}) }] } })
      if (params.name === "slow") setTimeout(reply, 2000)
      else reply()
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
    }
  }
})

process.stdin.on("end", () => {
  const endFile = option("--end-file")
  if (endFile) fs.writeFileSync(endFile, "input closed")
  if (flag("--stubborn")) return
  if (flag("--linger")) setTimeout(() => process.exit(0), 300)
  else process.exit(0)
})

// Kept alive by stdin; a stubborn one also by this.
if (flag("--stubborn")) setInterval(() => {}, 1000)
