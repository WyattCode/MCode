/**
 * Drives the MCP client against a real server.
 *
 * The fixture next door is a genuine MCP server speaking JSON-RPC over its
 * pipes, so this exercises the whole path - spawn, handshake, tools/list,
 * tools/call - rather than a stub of it. It also points at a command that
 * cannot start, because reporting that clearly is half of what the dialog is
 * for.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/server/bus"
import { McpServers } from "../src/server/mcp"
import type { AppConfig } from "../src/shared/protocol"

// Resolved from the working directory, not from import.meta.url: this file is
// bundled into out/ before it runs, so its own path no longer points here.
const fixture = path.join(process.cwd(), "scripts/fixtures/mcp-server.cjs")

const problems: string[] = []
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`)
  if (!ok) problems.push(label + (detail ? " - " + detail : ""))
}

/** Just enough Config for the client: it only ever reads and writes this key. */
class StubConfig {
  private value = {
    mcpServers: {
      probe: { type: "local" as const, command: ["node", fixture] },
      broken: { type: "local" as const, command: ["definitely-not-a-real-command-xyz"] },
    },
  }
  get() {
    return this.value as unknown as AppConfig
  }
  async set(patch: Partial<AppConfig>) {
    this.value = { ...this.value, ...(patch as typeof this.value) }
    bus.publish({ type: "config.updated", config: this.get() })
    return this.get()
  }
}

/*
 * A context that records what was asked rather than approving silently: an MCP
 * call reaches code this app did not write, and the check is here to prove the
 * user gets a say before it runs.
 */
const asked: { kind: string; title: string; scope?: string }[] = []
const context = {
  sessionID: "ses_check",
  messageID: "msg_check",
  callID: "call_check",
  directory: process.cwd(),
  permissions: {
    ask: async (input: { kind: string; title: string; scope?: string }) => {
      asked.push({ kind: input.kind, title: input.title, scope: input.scope })
    },
  },
} as never

const bus = new Bus()
const config = new StubConfig()
// A home of its own: the reader's ~/.claude.json servers are never started by a check.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-mcpcheck-"))
const mcp = new McpServers(bus, config as never, undefined, home)

await mcp.start()

const byName = Object.fromEntries(mcp.list().map((entry) => [entry.name, entry]))
check(
  "a working server connects",
  byName.probe?.status === "connected",
  `${byName.probe?.status} ${byName.probe?.error ?? ""}`.trim(),
)
check("it reports its tools", byName.probe?.tools === 2, String(byName.probe?.tools))
check("a broken command fails", byName.broken?.status === "failed", byName.broken?.status)
check(
  "the failure explains itself",
  Boolean(byName.broken?.error && byName.broken.error.length > 0),
  byName.broken?.error?.slice(0, 60),
)

const tools = mcp.tools()
check("tools reach the agent namespaced", tools.some((tool) => tool.name === "probe_echo"))
check("a disconnected server offers none", !tools.some((tool) => tool.name.startsWith("broken_")))

const echo = tools.find((tool) => tool.name === "probe_echo")
if (echo) {
  const result = await echo.execute({ text: "hello mcp" }, context)
  check("a call round-trips", result.output === "hello mcp", JSON.stringify(result.output))
}

const add = tools.find((tool) => tool.name === "probe_add")
if (add) {
  const result = await add.execute({ a: 2, b: 40 }, context)
  check("arguments arrive intact", result.output === "42", JSON.stringify(result.output))
}

check("a call asks first", asked.length === 2, JSON.stringify(asked[0]))
check(
  "approval is scoped to the server",
  asked.every((entry) => entry.kind === "mcp" && entry.scope === "mcp:probe"),
)

// Switching a server off is saved at once and reaches the servers when the next conversation starts, as in MiMo.
const probeStatus = () => mcp.list().find((entry) => entry.name === "probe")?.status
await mcp.toggle("probe")
check("toggling off is saved", config.get().mcpServers.probe?.enabled === false)
// Long enough for a reconnect that should not happen to have happened.
await new Promise((resolve) => setTimeout(resolve, 500))
check("a running conversation keeps the server until the next one starts", probeStatus() === "connected", probeStatus())
await mcp.commitIfDirty()
check("the next conversation has it disconnected", probeStatus() === "disabled", probeStatus())
check("and its tools withdrawn", !mcp.tools().some((tool) => tool.name.startsWith("probe_")))

await mcp.toggle("probe")
await mcp.commitIfDirty()
check("toggling back on reconnects it for the conversation after", probeStatus() === "connected", probeStatus())

mcp.close()

if (problems.length) {
  console.error(`\nFAILED: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log("\nMCP client works against a real server.")
