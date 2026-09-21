import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AppConfig, McpImportItem, McpImportSource, McpServerConfig } from "@shared/protocol"
import { redactCommand, redactString } from "@shared/mcp-redact"

/**
 * MCP servers other coding tools already have configured, offered for import
 * on the MCP settings page, as MiMo offers them.
 *
 * Three files are read, in this order, and a name seen once is not offered
 * again: Claude Code's ~/.claude.json and Kiro's ~/.kiro/settings/mcp.json (both
 * JSON with a top-level mcpServers map), and Codex's ~/.codex/config.toml
 * ([mcp_servers.<name>] tables). MCODE_IMPORT_HOME stands in for the home
 * directory, so a probe can point the scan at a folder of its own instead of
 * the reader's real files.
 */

const SOURCES: McpImportSource[] = ["claude", "kiro", "codex"]

function sourcePath(source: McpImportSource, home: string): string {
  if (source === "claude") return path.join(home, ".claude.json")
  if (source === "kiro") return path.join(home, ".kiro", "settings", "mcp.json")
  return path.join(home, ".codex", "config.toml")
}

type Raw = Record<string, unknown>

const isRecord = (value: unknown): value is Raw =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

function jsonServers(text: string): Record<string, Raw> {
  try {
    const parsed: unknown = JSON.parse(text)
    const servers = isRecord(parsed) ? parsed.mcpServers : undefined
    if (!isRecord(servers)) return {}
    const out: Record<string, Raw> = {}
    for (const [name, entry] of Object.entries(servers)) if (isRecord(entry)) out[name] = entry
    return out
  } catch {
    return {}
  }
}

/*
 * Just enough TOML for Codex's MCP tables: single-line strings, arrays of
 * strings and inline tables, plus [mcp_servers.<name>.env] style sub-tables.
 * Anything else in the file is skipped rather than failing the whole scan.
 */
function unquote(text: string): string {
  return text.replace(/\\(["\\nt])/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char))
}

function tomlScalar(value: string): string | undefined {
  const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value)
  if (quoted) return quoted[1] !== undefined ? unquote(quoted[1]) : quoted[2]
  const bare = /^(true|false|[-+]?[\d._]+)\s*(?:#.*)?$/.exec(value)
  return bare ? bare[1] : undefined
}

function tomlArray(value: string): string[] | undefined {
  const inner = /^\[(.*)\]/.exec(value)
  if (!inner) return undefined
  const out: string[] = []
  const item = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g
  let match: RegExpExecArray | null
  while ((match = item.exec(inner[1]))) out.push(match[1] !== undefined ? unquote(match[1]) : match[2])
  return out
}

function tomlTable(value: string): Record<string, string> | undefined {
  const inner = /^\{(.*)\}/.exec(value)
  if (!inner) return undefined
  const out: Record<string, string> = {}
  const pair = /(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pair.exec(inner[1]))) {
    out[match[1] ?? match[2] ?? match[3]] = match[4] !== undefined ? unquote(match[4]) : match[5]
  }
  return out
}

function tomlServers(text: string): Record<string, Raw> {
  const servers: Record<string, Raw> = {}
  const header = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:\.\s*([A-Za-z0-9_-]+)\s*)?\]\s*(?:#.*)?$/
  let current: { name: string; sub: string } | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("[")) {
      const match = header.exec(line)
      current = match ? { name: match[1] ?? match[2] ?? match[3], sub: match[4] ?? "" } : undefined
      if (current && !servers[current.name]) servers[current.name] = {}
      continue
    }
    if (!current) continue
    const at = line.indexOf("=")
    if (at <= 0) continue
    const key = line.slice(0, at).trim().replace(/^["']|["']$/g, "")
    const value = line.slice(at + 1).trim()
    const server = servers[current.name]
    if (current.sub === "env" || current.sub === "http_headers") {
      const scalar = tomlScalar(value)
      if (scalar === undefined) continue
      const field = current.sub === "env" ? "env" : "headers"
      server[field] = { ...(isRecord(server[field]) ? server[field] : {}), [key]: scalar }
      continue
    }
    if (current.sub) continue
    if (key === "command" || key === "url") {
      const scalar = tomlScalar(value)
      if (scalar !== undefined) server[key] = scalar
    } else if (key === "args") {
      const list = tomlArray(value)
      if (list) server.args = list
    } else if (key === "env" || key === "http_headers") {
      const table = tomlTable(value)
      if (table) server[key === "env" ? "env" : "headers"] = table
    } else if (key === "enabled" && tomlScalar(value) === "false") {
      server.disabled = true
    }
  }
  return servers
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() && (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")) {
      out[key.trim()] = String(entry)
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** One entry in this app's own shape, or nothing when it names neither a usable address nor a command. */
function toConfig(raw: Raw): McpServerConfig | undefined {
  const enabled = raw.disabled !== true && raw.enabled !== false
  const url = typeof raw.url === "string" ? raw.url.trim() : ""
  if (url) {
    try {
      const protocol = new URL(url).protocol
      if (protocol !== "http:" && protocol !== "https:") return undefined
    } catch {
      return undefined
    }
    const headers = stringMap(raw.headers)
    return { type: "remote", url, ...(headers ? { headers } : {}), enabled }
  }
  const command = typeof raw.command === "string" ? raw.command.trim() : ""
  if (!command) return undefined
  const args = Array.isArray(raw.args) ? raw.args.map(String).filter((arg) => arg !== "") : []
  const environment = stringMap(raw.env)
  return { type: "local", command: [command, ...args], ...(environment ? { environment } : {}), enabled }
}

interface Found extends McpImportItem {
  entry: McpServerConfig
}

export async function scanMcpImports(existing: Record<string, McpServerConfig>): Promise<Found[]> {
  const home = process.env.MCODE_IMPORT_HOME || os.homedir()
  const seen = new Set<string>()
  const found: Found[] = []
  for (const source of SOURCES) {
    let text: string
    try {
      text = await fs.readFile(sourcePath(source, home), "utf8")
    } catch {
      continue
    }
    const servers = source === "codex" ? tomlServers(text) : jsonServers(text)
    for (const [rawName, raw] of Object.entries(servers)) {
      const name = rawName.trim()
      if (!name || seen.has(name)) continue
      const entry = toConfig(raw)
      if (!entry) continue
      seen.add(name)
      found.push({
        source,
        name,
        type: entry.type,
        // Shown in the import list, so a token in an address or after a flag is masked as MiMo masks it.
        summary: entry.type === "remote" ? redactString(entry.url ?? "") : redactCommand(entry.command ?? []).join(" "),
        exists: name in existing,
        entry,
      })
    }
  }
  return found
}

/** What the page is sent: everything but the entry itself, whose variables and headers may be secrets. */
export function importItem(found: Found): McpImportItem {
  return { source: found.source, name: found.name, type: found.type, summary: found.summary, exists: found.exists }
}

/**
 * Adds the picked servers that are not already configured. The scan is run
 * again here rather than trusting the page, so only what is on disk now - and
 * never an entry the page made up - is written.
 */
export async function applyMcpImports(
  config: { get(): AppConfig; set(patch: Partial<AppConfig>): Promise<unknown> },
  picks: { source: string; name: string }[],
): Promise<string[]> {
  const existing = config.get().mcpServers ?? {}
  const wanted = new Set(picks.map((pick) => `${pick.source}:${pick.name}`))
  const chosen = (await scanMcpImports(existing)).filter(
    (item) => !item.exists && wanted.has(`${item.source}:${item.name}`),
  )
  if (!chosen.length) return []
  const servers = { ...existing }
  for (const item of chosen) servers[item.name] = item.entry
  await config.set({ mcpServers: servers })
  return chosen.map((item) => item.name)
}
