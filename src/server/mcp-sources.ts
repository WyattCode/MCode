import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { McpServerConfig } from "@shared/protocol"
import { parseJsonc } from "./jsonc"

/**
 * Where a project's MCP servers come from, and what an entry must look like
 * before anything is started for it - MiMo's engine config rules, with
 * MCode's own file names.
 *
 * A project directory is served by the app's own `mcpServers`, then the
 * project's `mcode.json` / `mcode.jsonc` files found walking up from the
 * directory to its repository root (the outermost first, so the nearest
 * wins), then `mcode.json(c)` in each `.mcode` folder on that walk and in the
 * home folder, and last Claude Code's `mcpServers` from `~/.claude.json` and
 * `<directory>/.claude.json`, which never displace a server of MCode's own.
 *
 * Project files may add servers and may merge into earlier project layers, but
 * they never merge into or replace an app server. They also may not use
 * `{file:…}` or `{env:…}` substitution; only MCode's own app config does.
 */

type Raw = Record<string, unknown>

const isRecord = (value: unknown): value is Raw => Boolean(value) && typeof value === "object" && !Array.isArray(value)

/** The home folder the project and Claude Code files are looked for in; a probe points it elsewhere. */
export function sourceHome(): string {
  return process.env.MCODE_IMPORT_HOME || os.homedir()
}

/** One server as a project directory is offered it. */
export interface ResolvedServer {
  name: string
  /** The entry with `{env:…}` and `{file:…}` filled in, when it is valid. */
  config?: McpServerConfig
  /** Why the entry cannot be started; the server is shown as failed with it. */
  invalid?: string
  /** "app" for MCode's own settings, "project" for a project file, "claude" for Claude Code's. */
  origin: "app" | "project" | "claude"
  /** True when this entry came from the project tree and should be trusted before starting. */
  needsTrust?: boolean
}

/** True when any string in `value` still contains a substitution marker. */
export function containsSubstitution(value: unknown): boolean {
  if (typeof value === "string") return /\{(?:file|env):/.test(value)
  if (Array.isArray(value)) return value.some(containsSubstitution)
  if (isRecord(value)) return Object.values(value).some(containsSubstitution)
  return false
}

/**
 * `{env:NAME}` becomes that variable (empty when unset) and `{file:path}` the
 * file's trimmed text, a relative path counted from the config file's folder
 * and `~/` from the home folder - MiMo's substitution, applied to every string
 * of the entry. A file that cannot be read makes the entry invalid.
 */
export async function substituteEntry(entry: unknown, configDirectory: string, home = sourceHome()): Promise<unknown> {
  if (typeof entry === "string") {
    const text = entry.replace(/\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] || "")
    let out = ""
    let cursor = 0
    for (const match of text.matchAll(/\{file:([^}]+)\}/g)) {
      out += text.slice(cursor, match.index)
      let file = match[1]
      if (file.startsWith("~/")) file = path.join(home, file.slice(2))
      const resolved = path.isAbsolute(file) ? file : path.resolve(configDirectory, file)
      const content = await fs.readFile(resolved, "utf8").catch((error: NodeJS.ErrnoException) => {
        throw new Error(
          error.code === "ENOENT" ? `the file named by ${match[0]} does not exist (${resolved})` : `the file named by ${match[0]} could not be read`,
        )
      })
      out += content.trim()
      cursor = match.index + match[0].length
    }
    return out + text.slice(cursor)
  }
  if (Array.isArray(entry)) return Promise.all(entry.map((item) => substituteEntry(item, configDirectory, home)))
  if (isRecord(entry)) {
    const out: Raw = {}
    for (const [key, value] of Object.entries(entry)) out[key] = await substituteEntry(value, configDirectory, home)
    return out
  }
  return entry
}

const stringRecord = (value: unknown) => value === undefined || (isRecord(value) && Object.values(value).every((item) => typeof item === "string"))

/**
 * What an entry is: a server, nothing (no `type` - MiMo's engine skips those),
 * or a mistake to report. A command must be a list, the program first; a
 * single string is refused rather than split, as MiMo's schema refuses it.
 */
export function checkEntry(value: unknown): { config: McpServerConfig } | { skip: true } | { invalid: string } {
  if (!isRecord(value) || !("type" in value)) return { skip: true }
  const entry = value as Raw
  if (entry.type !== "local" && entry.type !== "remote") return { invalid: `unsupported type ${JSON.stringify(entry.type)}: use "local" or "remote"` }
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") return { invalid: "enabled must be true or false" }
  if (entry.timeout !== undefined && !(typeof entry.timeout === "number" && Number.isInteger(entry.timeout) && entry.timeout > 0)) {
    return { invalid: "timeout must be a positive whole number of milliseconds" }
  }
  if (entry.codemode !== undefined && typeof entry.codemode !== "boolean") return { invalid: "codemode must be true or false" }
  if (entry.type === "local") {
    if (typeof entry.command === "string") return { invalid: "command must be a list: the program, then each argument" }
    if (!Array.isArray(entry.command) || !entry.command.length || !entry.command.every((part) => typeof part === "string")) {
      return { invalid: "command must be a non-empty list of strings" }
    }
    if (!stringRecord(entry.environment)) return { invalid: "environment must map names to strings" }
  } else {
    if (typeof entry.url !== "string" || !entry.url) return { invalid: "url must be a string" }
    if (!stringRecord(entry.headers)) return { invalid: "headers must map names to strings" }
  }
  if (entry.tools !== undefined) {
    const rules = entry.tools
    const known = (rule: unknown) => rule === true || rule === false || rule === "allow" || rule === "ask" || rule === "deny"
    if (!isRecord(rules) || !Object.values(rules).every(known)) return { invalid: 'tools must map tool names to true, false, "allow", "ask" or "deny"' }
  }
  return { config: entry as unknown as McpServerConfig }
}

/** Objects merged key by key, anything else replaced - MiMo's merge of config layers. */
function mergeDeep(base: unknown, over: unknown): unknown {
  if (!isRecord(base) || !isRecord(over)) return over
  const out: Raw = { ...base }
  for (const [key, value] of Object.entries(over)) out[key] = key in base ? mergeDeep(base[key], value) : value
  return out
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

const samePath = (a: string, b: string): boolean => {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}


/** The folders from `directory` up to its repository root, nearest first; to the drive root outside a repository. */
async function walkUp(directory: string): Promise<string[]> {
  const folders: string[] = []
  let current = path.resolve(directory)
  for (;;) {
    folders.push(current)
    if (await exists(path.join(current, ".git"))) return folders
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  // Not in a repository: MiMo's walk then stops at the root, which is where this one already is.
  return folders
}

/** The project's own config files, in the order they are merged (later wins). */
export async function projectFiles(directory: string, home = sourceHome()): Promise<string[]> {
  const walk = await walkUp(directory)
  const files: string[] = []
  for (const folder of walk) {
    for (const name of ["mcode.jsonc", "mcode.json"]) {
      const file = path.join(folder, name)
      if (await exists(file)) files.push(file)
    }
  }
  files.reverse()
  const folders = [...walk.map((folder) => path.join(folder, ".mcode")), path.join(home, ".mcode")]
  const seen = new Set<string>()
  for (const folder of folders) {
    const key = path.resolve(folder).toLowerCase()
    if (seen.has(key) || !(await exists(folder))) continue
    seen.add(key)
    for (const name of ["mcode.json", "mcode.jsonc"]) {
      const file = path.join(folder, name)
      if (await exists(file)) files.push(file)
    }
  }
  return files
}

/**
 * Claude Code's servers from one file. Only `mcpServers` is taken - the rest
 * of that file can hold sign-in state and is never looked at or logged. An
 * SSE server is skipped, as MiMo skips it, and so is anything malformed.
 */
export async function claudeServers(file: string): Promise<Record<string, McpServerConfig>> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!text) return {}
  let servers: unknown
  try {
    servers = (JSON.parse(text) as Raw | null)?.mcpServers
  } catch {
    return {}
  }
  if (!isRecord(servers)) return {}
  const out: Record<string, McpServerConfig> = {}
  for (const [name, input] of Object.entries(servers)) {
    if (!isRecord(input) || input.type === "sse") continue
    if (input.args !== undefined && !(Array.isArray(input.args) && input.args.every((arg) => typeof arg === "string"))) continue
    const args = (input.args as string[] | undefined) ?? []
    const enabled = input.disabled === true || input.enabled === false ? false : true
    const pick = (value: unknown) =>
      isRecord(value) ? (Object.fromEntries(Object.entries(value).filter((pair) => typeof pair[1] === "string")) as Record<string, string>) : undefined
    const environment = pick(input.environment) ?? pick(input.env)
    const timeout = typeof input.timeout === "number" ? input.timeout : undefined
    const type = typeof input.type === "string" ? input.type : undefined
    if (typeof input.command === "string" && (!type || type === "stdio" || type === "local")) {
      out[name] = { type: "local", command: [input.command, ...args], ...(environment ? { environment } : {}), enabled, ...(timeout !== undefined ? { timeout } : {}) }
      continue
    }
    if (input.command !== undefined) continue
    if (typeof input.url === "string" && (!type || type === "http" || type === "streamable-http" || type === "remote")) {
      const headers = pick(input.headers)
      const oauth = input.oauth === false ? false : isRecord(input.oauth) ? pick(input.oauth) : undefined
      out[name] = {
        type: "remote",
        url: input.url,
        enabled,
        ...(headers ? { headers } : {}),
        ...(oauth !== undefined && (oauth === false || Object.keys(oauth).length) ? { oauth } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      }
    }
  }
  return out
}

async function readProjectFile(file: string): Promise<Raw | undefined> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const read = parseJsonc(text)
  const servers = isRecord(read.value) ? read.value.mcpServers : undefined
  return isRecord(servers) ? servers : undefined
}

/**
 * Every server a project directory is offered, in the order its first layer
 * named it: MCode's own list, then project additions, then Claude Code's.
 */
export async function resolveServers(input: {
  servers: Record<string, unknown>
  /** The file MCode's own list lives in; `{file:…}` there counts from its folder. */
  configFile: string
  /** The project; absent, only MCode's own list is read. */
  directory?: string
  home?: string
}): Promise<ResolvedServer[]> {
  const home = input.home ?? sourceHome()
  const homeMcodeFolder = path.join(home, ".mcode")
  const homeClaudeFile = path.join(home, ".claude.json")
  const projectClaudeFile = input.directory ? path.join(input.directory, ".claude.json") : undefined
  const layers = new Map<string, { value: unknown; origin: ResolvedServer["origin"]; broken?: string; trust?: boolean }>()
  /* Each file's strings are filled in against that file's own folder before the layers merge, as MiMo fills in each file's text. */
  const add = async (name: string, raw: unknown, folder: string, origin: ResolvedServer["origin"]) => {
    const before = layers.get(name)
    // A project layer must never rewrite an app server, even key by key.
    if (before?.origin === "app") return
    let value: unknown = raw
    let broken = before?.broken
    let trust = before?.trust
    if (origin === "app") {
      try {
        value = await substituteEntry(raw, folder, home)
      } catch (error) {
        broken ??= error instanceof Error ? error.message : String(error)
      }
    } else if (origin === "project") {
      if (containsSubstitution(raw)) broken ??= "project MCP configs may not use {file:} or {env:} substitution"
      // Any project-tree file (including ancestors walked from the working
      // directory) needs trust; only the user's own ~/.mcode is exempt.
      if (!samePath(folder, homeMcodeFolder)) trust = true
    }
    layers.set(name, { value: before ? mergeDeep(before.value, value) : value, origin: before?.origin ?? origin, ...(broken ? { broken } : {}), ...(trust ? { trust } : {}) })
  }
  for (const [name, value] of Object.entries(input.servers)) await add(name, value, path.dirname(input.configFile), "app")
  if (input.directory) {
    for (const file of await projectFiles(input.directory, home)) {
      for (const [name, value] of Object.entries((await readProjectFile(file)) ?? {})) await add(name, value, path.dirname(file), "project")
    }
    // Claude Code's file is plain JSON with no substitution of its own, and it never displaces one of MCode's.
    for (const file of [homeClaudeFile, path.join(input.directory, ".claude.json")]) {
      const fromProject = Boolean(projectClaudeFile && samePath(file, projectClaudeFile) && !samePath(file, homeClaudeFile))
      for (const [name, value] of Object.entries(await claudeServers(file))) {
        const before = layers.get(name)
        if (before && before.origin !== "claude") continue
        layers.set(name, { value, origin: "claude", ...(fromProject ? { trust: true } : {}) })
      }
    }
  }
  const out: ResolvedServer[] = []
  for (const [name, layer] of layers) {
    const checked = checkEntry(layer.value)
    if ("skip" in checked) continue
    const needsTrust = layer.trust ? { needsTrust: true } : {}
    if (layer.broken) out.push({ name, invalid: layer.broken, origin: layer.origin, ...needsTrust })
    else if ("invalid" in checked) out.push({ name, invalid: checked.invalid, origin: layer.origin, ...needsTrust })
    else out.push({ name, config: checked.config, origin: layer.origin, ...needsTrust })
  }
  return out
}
