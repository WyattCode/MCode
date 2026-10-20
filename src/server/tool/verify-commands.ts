import fs from "node:fs/promises"
import path from "node:path"

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

export interface DiscoverVerifyCommandsInput {
  packageScripts?: Record<string, string>
  agentsMd?: string
  packageManager?: PackageManager
}

const MAX_COMMANDS = 4
const MAX_AGENT_COMMANDS = 2
const AGENTS_MD_CAP = 64 * 1024

function isPackageManager(value: unknown): value is PackageManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun"
}

function runCommand(packageManager: PackageManager, script: string): string {
  return `${packageManager} run ${script}`
}

function scriptFromRunCommand(command: string): string | undefined {
  const match = /^(?:npm|pnpm|yarn|bun)\s+run\s+([\w:-]+)$/.exec(command.trim())
  return match?.[1]
}

function lowerKeyMap(scripts: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const key of Object.keys(scripts)) {
    const lower = key.toLowerCase()
    if (!out.has(lower)) out.set(lower, key)
  }
  return out
}

function isTestLike(key: string): boolean {
  return /^test(?:$|:)/i.test(key)
}

function isLowSignalTestScript(key: string): boolean {
  return /^test:(?:e2e|watch)$/i.test(key)
}

/**
 * A tail of bare English words after the binary name is prose, not an
 * invocation ("pytest before every commit"). Flags, paths, globs and options
 * reset the streak so real command lines pass.
 */
function looksLikeProseTail(command: string): boolean {
  const tokens = command.split(/\s+/).slice(1)
  let streak = 0
  for (const token of tokens) {
    if (/^[-@]/.test(token) || /[\\/=.*[\]"'`{}$<>|&:,;()]/.test(token)) {
      streak = 0
      continue
    }
    if (/^[A-Za-z][\w-]*$/.test(token)) streak++
    else streak = 0
    if (streak >= 2) return true
  }
  return false
}

export function discoverVerifyCommands(input: DiscoverVerifyCommandsInput): string[] {
  const packageManager = isPackageManager(input.packageManager) ? input.packageManager : "npm"
  const scripts = input.packageScripts ?? {}
  const out: string[] = []
  const seenCommands = new Set<string>()
  const seenScripts = new Set<string>()

  const addRun = (script: string): void => {
    if (out.length >= MAX_COMMANDS) return
    const command = runCommand(packageManager, script)
    if (seenCommands.has(command)) return
    seenCommands.add(command)
    seenScripts.add(script.toLowerCase())
    out.push(command)
  }

  const keys = Object.keys(scripts)
  const lowerToKey = lowerKeyMap(scripts)

  for (const name of ["typecheck", "type-check", "tsc"]) {
    const key = lowerToKey.get(name)
    if (key) addRun(key)
  }

  const lintKey = lowerToKey.get("lint")
  if (lintKey) addRun(lintKey)

  const testKey = lowerToKey.get("test")
  if (testKey) {
    addRun(testKey)
  } else {
    const testLike = keys.filter(isTestLike)
    const preferred = testLike.filter((key) => !isLowSignalTestScript(key))
    const chosen = preferred[0] ?? testLike[0]
    if (chosen) addRun(chosen)
  }

  const checkKey = lowerToKey.get("check")
  if (checkKey) addRun(checkKey)

  const buildKey = lowerToKey.get("build")
  if (buildKey) addRun(buildKey)

  const agentsMd = input.agentsMd?.slice(0, AGENTS_MD_CAP)
  if (agentsMd) {
    interface AgentCommand {
      command: string
      index: number
    }

    const agentCommands: AgentCommand[] = []

    const runPattern = /(?:^|[\s`"'(])(npm|pnpm|yarn|bun)\s+run\s+([\w:-]+)/g
    let runMatch: RegExpExecArray | null
    while ((runMatch = runPattern.exec(agentsMd))) {
      const command = `${runMatch[1]} run ${runMatch[2]}`
      agentCommands.push({ command, index: runMatch.index + Math.max(0, runMatch[0].length - command.length) })
    }

    const otherPattern = /(?:^|[\s`"'(])(npx\s+tsc\b[^`\n"']*|pytest\b[^`\n"']*)/g
    let otherMatch: RegExpExecArray | null
    while ((otherMatch = otherPattern.exec(agentsMd))) {
      const command = otherMatch[1].trim().replace(/[.,;:]+$/u, "")
      if (!command || looksLikeProseTail(command)) continue
      agentCommands.push({ command, index: otherMatch.index + Math.max(0, otherMatch[0].length - command.length) })
    }

    agentCommands.sort((a, b) => a.index - b.index)

    let addedFromAgents = 0
    for (const { command } of agentCommands) {
      if (out.length >= MAX_COMMANDS || addedFromAgents >= MAX_AGENT_COMMANDS) break

      const trimmed = command.trim()
      if (!trimmed || seenCommands.has(trimmed)) continue

      const script = scriptFromRunCommand(trimmed)
      if (script && seenScripts.has(script.toLowerCase())) continue

      seenCommands.add(trimmed)
      if (script) seenScripts.add(script.toLowerCase())
      out.push(trimmed)
      addedFromAgents++
    }
  }

  return out.slice(0, MAX_COMMANDS)
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

async function readPackageScripts(projectDir: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = await fs.readFile(path.join(projectDir, "package.json"), "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return undefined

    const scripts = (parsed as { scripts?: unknown }).scripts
    if (!scripts || typeof scripts !== "object") return undefined

    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch {
    return undefined
  }
}

async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  if (await exists(path.join(projectDir, "pnpm-lock.yaml"))) return "pnpm"
  if (await exists(path.join(projectDir, "yarn.lock"))) return "yarn"
  if (await exists(path.join(projectDir, "bun.lockb")) || await exists(path.join(projectDir, "bun.lock"))) return "bun"
  return "npm"
}

async function readAgentsMd(projectDir: string): Promise<string | undefined> {
  const file = path.join(projectDir, "AGENTS.md")

  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size === 0) return undefined

    const handle = await fs.open(file, "r")
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, AGENTS_MD_CAP))
      await handle.read(buffer, 0, buffer.length, 0)
      return buffer.toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

export async function loadVerifyCommands(projectDir: string): Promise<string[]> {
  const packageScripts = await readPackageScripts(projectDir)
  const packageManager = await detectPackageManager(projectDir)
  const agentsMd = await readAgentsMd(projectDir)
  return discoverVerifyCommands({ packageScripts, agentsMd, packageManager })
}
