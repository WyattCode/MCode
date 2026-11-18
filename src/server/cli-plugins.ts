import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import type { AppConfig, CliPlugin } from "@shared/protocol"
import { CodedError } from "@shared/errors"
import type { Config } from "./config"
import { killTree } from "./kill-tree"
import { windowsLaunch } from "./mcp-launch"
import { which } from "./shell-path"

const INSTALLERS = new Set(["npm", "npx", "pnpm", "yarn", "brew", "pip", "cargo", "go"])
const INSTALL_TIMEOUT = 10 * 60_000
const OUTPUT_LIMIT = 8192

export function parseInstallCommand(input: string): string[] {
  const command = input.trim()
  const first = command.split(/\s+/, 1)[0]
  if (!INSTALLERS.has(first)) {
    throw new CodedError("Only npm, npx, pnpm, yarn, brew, pip, cargo and go commands are supported", "set.plugins.allowlist")
  }
  // Parse quoted arguments, then launch with argv. No shell expansion or operators.
  const args: string[] = []
  const argument = /(?:[^\s"';&|<>`$\\]+|"[^"\r\n]*"|'[^'\r\n]*')+/y
  let offset = 0
  while (offset < command.length) {
    argument.lastIndex = offset
    const match = argument.exec(command)
    if (!match || /[^ \t]/.test(command.slice(argument.lastIndex, argument.lastIndex + 1))) {
      throw new Error("Use a single command with literal arguments")
    }
    args.push(match[0].replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single))
    offset = argument.lastIndex
    while (/[ \t]/.test(command[offset] ?? "")) offset++
  }
  return args
}

function records(config: AppConfig): CliPlugin[] {
  const data = config.cliPlugins
  if (data?.version !== 1 || !Array.isArray(data.entries)) return []
  return data.entries.filter(plugin => plugin && typeof plugin.id === "string"
    && typeof plugin.name === "string" && typeof plugin.enabled === "boolean"
    && (plugin.binary === undefined || typeof plugin.binary === "string"))
}

function writableRecords(config: AppConfig): CliPlugin[] {
  if (config.cliPlugins && config.cliPlugins.version !== 1) throw new Error("Unsupported CLI plugin settings version")
  return records(config)
}

function executable(plugin: CliPlugin): string {
  return plugin.binary ?? plugin.name
}

function available(binary: string): boolean {
  if (!/^[\w][\w.+-]*$/.test(binary)) return false
  try {
    const file = which(binary)
    if (!file) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function listPlugins(config: AppConfig) {
  return records(config).map(plugin => ({ ...plugin, available: available(executable(plugin)) }))
}

export function pluginPrompt(config: AppConfig): string {
  const entries = records(config).filter(plugin => plugin.enabled && available(executable(plugin)))
  if (!entries.length) return ""
  const lines = entries.map(plugin => `- ${JSON.stringify(plugin.name)}：通过 bash 工具调用 \`${executable(plugin)}\`。`)
  return ["## 可用命令行工具", ...lines].join("\n")
}

async function runInstaller(command: string, args: string[], log: (output: string) => void): Promise<void> {
  const resolved = process.platform === "win32" ? which(command) : command
  if (!resolved) throw new Error(`Command not found: ${command}`)
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved) && [resolved, ...args].some(value => /["%!\r\n]/.test(value))) {
    throw new Error("Unsupported characters in Windows batch command arguments")
  }
  const launch = windowsLaunch(resolved, args)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: homedir(),
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let tail = ""
    const output = (chunk: string) => {
      tail = (tail + chunk).slice(-OUTPUT_LIMIT)
      log(chunk)
    }
    child.stdout.setEncoding("utf8").on("data", output)
    child.stderr.setEncoding("utf8").on("data", output)
    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error("Installer timed out after 10 minutes"))
    }, INSTALL_TIMEOUT)
    child.once("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(tail.trim().split(/[\r\n]+/).at(-1)?.slice(-1000) || `Installer exited with code ${code}`))
    })
  })
}

export async function installPlugin(config: Config, input: { name: string; command: string; binary?: string }, log: (output: string) => void): Promise<CliPlugin> {
  const name = typeof input.name === "string" ? input.name.trim() : ""
  const command = typeof input.command === "string" ? input.command.trim() : ""
  if (!name) throw new CodedError("请填写名称", "set.plugins.nameRequired")
  if (!command) throw new CodedError("请填写安装命令", "set.plugins.commandRequired")
  const [installer, ...args] = parseInstallCommand(command)
  writableRecords(config.get())
  await runInstaller(installer, args, log)
  const normalized = name.toLowerCase()
  const binary = input.binary ?? (normalized === "ripgrep" ? "rg" : available(name) ? name : normalized)
  const plugin: CliPlugin = { id: randomUUID(), name, binary, enabled: false }
  await config.update(current => ({
    cliPlugins: { version: 1, entries: [...writableRecords(current), plugin] },
  }))
  return plugin
}

export async function setPlugin(config: Config, id: string, action: boolean | "delete"): Promise<void> {
  await config.update(current => {
    const entries = writableRecords(current)
    if (!entries.some(plugin => plugin.id === id)) {
      if (action === "delete") return {}
      throw new Error("CLI plugin no longer exists")
    }
    return {
      cliPlugins: {
        version: 1,
        entries: action === "delete"
          ? entries.filter(plugin => plugin.id !== id)
          : entries.map(plugin => plugin.id === id ? { ...plugin, enabled: action } : plugin),
      },
    }
  })
}
