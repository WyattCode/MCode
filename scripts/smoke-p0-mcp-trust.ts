/**
 * P0-1 / P1: project MCP (local or remote) does not start until the folder is trusted.
 * Run: `npx tsx scripts/smoke-p0-mcp-trust.ts` (or esbuild and node the outfile).
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/server/bus"
import { McpServers, MCP_PROJECT_TRUST_MESSAGE } from "../src/server/mcp"
import { resolveServers } from "../src/server/mcp-sources"
import type { AppConfig, McpServerConfig } from "../src/shared/protocol"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

async function temporary(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

const fixture = () => path.join(process.cwd(), "scripts/fixtures/mcp-lifecycle-server.cjs")

function stubConfig(bus: Bus, initial: { mcpServers: Record<string, McpServerConfig>; directory: string; trustedMcpProjects?: string[]; mcpTimeout?: number }) {
  let value = { ...initial }
  return {
    get: () => value as unknown as AppConfig,
    set: async (patch: Partial<AppConfig>) => {
      value = { ...value, ...(patch as typeof value) }
      bus.publish({ type: "config.updated", config: value as unknown as AppConfig })
      return value as unknown as AppConfig
    },
  }
}

const toolContext = (directory: string, asked: unknown[] = []) =>
  ({
    sessionID: "ses_p0_trust",
    messageID: "msg_p0_trust",
    callID: `call_${Math.random().toString(36).slice(2)}`,
    directory,
    permissions: { ask: async (input: unknown) => void asked.push(input) },
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => {},
  }) as never

async function callTool(mcp: McpServers, directory: string, name: string, input: Record<string, unknown> = {}): Promise<string> {
  const tool = mcp.tools(directory).find((entry) => entry.name === name)
  if (!tool) return `NO TOOL ${name}`
  return tool.execute(input, toolContext(directory)).then(
    (result) => result.output,
    (error: Error) => `ERROR ${error.message}`,
  )
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

async function until(test: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function main() {
  check("the fixture path is the lifecycle server", same(fixture(), path.join(process.cwd(), "scripts/fixtures/mcp-lifecycle-server.cjs")))

  const dir = await temporary("mcode-p0-trust-")
  const bus = new Bus()
  const project = path.join(dir, "project")
  await fs.mkdir(path.join(project, ".git"), { recursive: true })
  await write(path.join(project, "mcode.json"), JSON.stringify({ mcpServers: { extra: { type: "local", command: ["node", fixture(), "--tag", "project"] } } }))
  const config = stubConfig(bus, { mcpServers: {}, directory: project, trustedMcpProjects: [] })
  const mcp = new McpServers(bus, config as never, undefined, path.join(dir, "home"))
  try {
    await mcp.start()
    await mcp.ready(project)

    check("untrusted: the project is not trusted", mcp.isTrusted(project) === false)
    check("untrusted: the project server's tools are absent", !mcp.tools(project).some((tool) => tool.name.startsWith("extra_")))
    const untrusted = mcp.list().find((entry) => entry.name === "extra") as unknown as { status?: string; error?: string } | undefined
    check("untrusted: the project server is reported as failed", untrusted?.status === "failed", untrusted)
    check(
      "untrusted: the failure says the project has not been trusted",
      Boolean(untrusted?.error?.includes(MCP_PROJECT_TRUST_MESSAGE) || untrusted?.error?.includes("have not been trusted")),
      untrusted?.error,
    )

    await mcp.trust(project)
    check("trusted: the project is now trusted", mcp.isTrusted(project) === true)
    await mcp.ready(project)
    const connected = await until(() => {
      const entry = mcp.list().find((item) => item.name === "extra") as unknown as { status?: string } | undefined
      return entry?.status === "connected"
    })
    check("trusted: the project server connects", connected, mcp.list())
    const tag = await callTool(mcp, project, "extra_tag")
    check("trusted: a project tool call works", tag === "project", tag)
  } finally {
    await mcp.close()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  const subDir = await temporary("mcode-p0-trust-sub-")
  try {
    const project = path.join(subDir, "project")
    await fs.mkdir(path.join(project, ".git"), { recursive: true })
    await write(path.join(project, "mcode.json"), JSON.stringify({ mcpServers: { proj: { type: "local", command: ["node", "{file:tool.js}"] } } }))
    const resolved = await resolveServers({ servers: {}, configFile: path.join(subDir, "config.json"), directory: project, home: path.join(subDir, "home") })
    const proj = resolved.find((entry) => entry.name === "proj")
    check(
      "project substitution: {file:…} is refused",
      Boolean(proj?.invalid?.includes("project MCP configs may not use {file:} or {env:} substitution")) && !proj?.config && proj?.origin === "project" && proj?.needsTrust === true,
      proj,
    )
  } finally {
    await fs.rm(subDir, { recursive: true, force: true }).catch(() => {})
  }

  const appDir = await temporary("mcode-p0-trust-app-")
  try {
    const project = path.join(appDir, "project")
    await fs.mkdir(path.join(project, ".git"), { recursive: true })
    await write(path.join(project, "mcode.json"), JSON.stringify({ mcpServers: { shared: { environment: { FROM: "project" } } } }))
    const resolved = await resolveServers({
      servers: { shared: { type: "local", command: ["node", "app.js"], environment: { FROM: "app" } } },
      configFile: path.join(appDir, "config.json"),
      directory: project,
      home: path.join(appDir, "home"),
    })
    const shared = resolved.find((entry) => entry.name === "shared")
    check(
      "app server: a project layer cannot replace its environment",
      JSON.stringify(shared?.config?.environment) === '{"FROM":"app"}' && shared?.origin === "app" && shared?.needsTrust === undefined,
      shared,
    )
  } finally {
    await fs.rm(appDir, { recursive: true, force: true }).catch(() => {})
  }


  // Remote project MCP must also stay gated until trusted (P1 residual from P0).
  const remoteDir = await temporary("mcode-p1-remote-trust-")
  try {
    const project = path.join(remoteDir, "project")
    await fs.mkdir(path.join(project, ".git"), { recursive: true })
    await write(
      path.join(project, "mcode.json"),
      JSON.stringify({ mcpServers: { rem: { type: "remote", url: "https://example.invalid/mcp" } } }),
    )
    const bus = new Bus()
    const config = stubConfig(bus, { mcpServers: {}, directory: project, trustedMcpProjects: [] })
    const mcp = new McpServers(bus, config as never, undefined, path.join(remoteDir, "home"))
    try {
      await mcp.start()
      await mcp.ready(project)
      const resolved = await resolveServers({
        servers: {},
        configFile: path.join(remoteDir, "config.json"),
        directory: project,
        home: path.join(remoteDir, "home"),
      })
      const rem = resolved.find((entry) => entry.name === "rem")
      check("remote project entry needs trust", rem?.needsTrust === true && rem?.config?.type === "remote", rem)
      check("untrusted remote: needsTrustPrompt is true", await mcp.needsTrustPrompt(project) === true)
      const listed = mcp.list().find((entry) => entry.name === "rem") as unknown as { status?: string; error?: string } | undefined
      check("untrusted remote: reported failed", listed?.status === "failed", listed)
      check(
        "untrusted remote: failure mentions trust",
        Boolean(listed?.error?.includes(MCP_PROJECT_TRUST_MESSAGE) || listed?.error?.includes("have not been trusted")),
        listed?.error,
      )
      // Trusting should clear the trust gate; connection to example.invalid may still fail for network — status must not stay on the trust message.
      await mcp.trust(project)
      await mcp.ready(project)
      const after = mcp.list().find((entry) => entry.name === "rem") as unknown as { status?: string; error?: string } | undefined
      check(
        "trusted remote: no longer blocked solely for trust",
        after?.status !== "failed" || !String(after?.error ?? "").includes(MCP_PROJECT_TRUST_MESSAGE),
        after,
      )
    } finally {
      await mcp.close()
    }
  } finally {
    await fs.rm(remoteDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
