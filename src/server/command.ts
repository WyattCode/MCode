import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { AppConfig, CommandDefinition, CommandInfo, Effort, ModelRef, TurnAgent } from "@shared/protocol"
import { COMMAND_AGENTS, EFFORTS } from "@shared/protocol"
import { MODEL_TIERS, expandTemplate, fileReferences, hints, shellPlaceholders, substituteShell } from "@shared/command"
import type { McpServers } from "./mcp"
import { parseFrontmatter } from "./frontmatter"
import { MAX_DEPTH, PROJECT_CONFIG_DIR, discoverSkills, enabledSkills, scan } from "./skill"
import { shell } from "./tool/bash"
import { builtinCommands } from "./command-builtin"

/**
 * Everything a slash can reach, from the three places the reference looks.
 *
 * Its own command service (node-BBwF64dM.js @32868300) fills one map keyed by
 * name, in this order, so a later source loses a name collision to an earlier
 * one only where it says so:
 *
 *   1. the config document's `command` record, then the markdown files under a
 *      `command` or `commands` folder in each config directory - the file wins,
 *      because config loading merges the loaded files OVER the document
 *      (`result.command = D(result.command ?? {}, await ConfigCommand.load(dir))`
 *      @6844546);
 *   2. MCP prompts, which overwrite a command of the same name;
 *   3. skills, which are SKIPPED when the name is taken (`if (commands[item.name])
 *      continue`) - the one source that yields rather than overwrites.
 *
 * Before all three, the engine's own commands, as MiMo's engine seeds them
 * (`command-builtin.ts`): /init, /review, /dream, /distill and /rebuild,
 * in that order, each in this app's own words.
 *
 * One deliberate departure from it, because this app is not that one:
 *
 * - Templates are resolved EAGERLY here. The reference holds each one behind a
 *   getter and only touches it when the command runs on its server; this app
 *   shows the list in the window, so the text has to be on the wire when the
 *   list is. The only source this actually costs anything for is MCP, where
 *   each prompt is one extra round trip per listing. Listing never runs a
 *   template's shell placeholders: that happens in `expandCommand`, when the
 *   command is sent.
 */

interface Deps {
  /** Only these fields are read, so a check can hand this a plain object. */
  config: { get(): { commands?: Record<string, CommandDefinition>; model?: ModelRef; shell?: string; disabledSkills?: string[] } & Pick<AppConfig, "skillPaths" | "sessionChat"> }
  /** Only the prompt half of the MCP surface is used. */
  mcp: Pick<McpServers, "prompts" | "getPrompt">
  /** The app's data directory, whose `command(s)` and `skill(s)` folders hold the user's global ones. */
  storage?: { directory: string }
  /** The home folder whose `.claude` and `.mcode` folders are read; a check points it somewhere harmless. */
  home?: string
}

/** What finding command files needs: no MCP. */
type Folders = Pick<Deps, "config" | "storage" | "home">

export async function listCommands(deps: Deps, directory: string): Promise<CommandInfo[]> {
  const commands: Record<string, CommandInfo> = {}

  // The app's own come first, as MiMo's engine seeds them; a project or global command of the same name replaces one in place.
  const builtin = builtinCommands(directory)
  for (const [name, entry] of Object.entries(await ownCommands(deps, directory, builtin))) {
    commands[name] = { ...fromDefinition(name, entry), ...(builtin[name] === entry ? { own: true } : {}) }
  }

  for (const [name, prompt] of Object.entries(await promptCommands(deps.mcp, directory))) {
    commands[name] = prompt
  }

  for (const skill of await skillCommands(directory, deps.storage?.directory, deps.config.get(), deps.home)) {
    // The one source that yields: a skill never displaces a command.
    if (commands[skill.name]) continue
    commands[skill.name] = skill
  }

  return Object.values(commands)
}

/**
 * The app's own commands over which the config document's and then the
 * markdown files' are laid: the commands whose placeholders may run.
 */
async function ownCommands(deps: Folders, directory: string, builtin = builtinCommands(directory)): Promise<Record<string, CommandDefinition>> {
  const config = deps.config.get()
  return { ...builtin, ...(config.commands ?? {}), ...(await fileCommands(deps, directory, config.model)) }
}

function fromDefinition(name: string, entry: CommandDefinition): CommandInfo {
  return {
    name,
    description: entry.description,
    agent: entry.agent,
    model: entry.model,
    source: "command",
    template: entry.template,
    subtask: entry.subtask,
    hints: hints(entry.template),
  }
}

/* ------------------------------------------------------ sending a command */

export interface ExpandedCommand {
  prompt: string
  files: { name: string; path: string }[]
}

/**
 * A project or global command filled in the way MiMo's session.command fills it.
 *
 * Measured from MiMo's engine, and followed as it is:
 *
 * - the arguments go in first (`expandTemplate`), unescaped, so words typed
 *   after the name reach a placeholder's command as they were typed;
 * - every ``!`cmd` `` then runs at once in the preferred shell - here the
 *   configured one, with the bash tool's argument forms - and is replaced by
 *   what it wrote to stdout, trailing newline included. Stderr is dropped, the
 *   exit code is ignored, and a command that cannot start gives the empty
 *   string. There is no timeout, no output cap and no permission prompt,
 *   because MiMo has none; the access level does not refuse it either;
 * - the whole prompt is trimmed, and the files it names with `@` are found.
 *
 * One departure: MiMo passes no working directory, so its commands run wherever
 * its engine process was started. They run in the conversation's folder here,
 * which is where a template's relative paths are written from.
 *
 * Only commands from the config document and command folders get here. An MCP
 * prompt and a skill line are filled in by the window and run their commands
 * through `runShellPlaceholders` below, which is the same substitution.
 */
export async function expandCommand(
  deps: Folders,
  input: { directory: string; name: string; arguments: string },
): Promise<ExpandedCommand> {
  const command = (await ownCommands(deps, input.directory))[input.name]
  if (!command) throw new Error(`There is no command /${input.name} in this project`)
  const filled = expandTemplate(command.template, input.arguments)
  const chosen = deps.config.get().shell
  const outputs = await Promise.all(shellPlaceholders(filled).map((script) => runPlaceholder(script, input.directory, chosen)))
  const prompt = substituteShell(filled, outputs).trim()
  return { prompt, files: await referencedFiles(prompt, input.directory, deps.home ?? os.homedir()) }
}

/** One placeholder's stdout; anything that goes wrong is the empty string. */
function runPlaceholder(script: string, cwd: string, chosen?: string): Promise<string> {
  const { command, args, verbatim } = shell(chosen)
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    try {
      // Stderr is not piped at all: it is never read, and an unread pipe that fills would stall the command.
      const child = spawn(command, args(script), {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      })
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.once("error", () => resolve(""))
      child.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")))
    } catch {
      resolve("")
    }
  })
}

/**
 * The ``!`cmd` `` placeholders of a template the window filled in itself.
 *
 * MiMo runs a template's backtick commands whatever the template came from, so
 * an MCP server's prompt and the arguments typed after a skill run theirs as a
 * project command's do - the user's 2026-09-16 decision. Same shell, same
 * folder, same silence about a command that fails, because it is the same
 * substitution; text with no placeholder in it is handed straight back and
 * nothing is started.
 */
export async function runShellPlaceholders(deps: Pick<Deps, "config">, input: { directory: string; text: string }): Promise<string> {
  const scripts = shellPlaceholders(input.text)
  if (!scripts.length) return input.text
  const chosen = deps.config.get().shell
  const outputs = await Promise.all(scripts.map((script) => runPlaceholder(script, input.directory, chosen)))
  return substituteShell(input.text, outputs)
}

/**
 * The existing files a prompt names with `@`, as MiMo resolves them.
 *
 * `~/` starts at the home folder; anything else at the repository root, or at
 * the conversation's folder outside a repository (MiMo's root there is the top
 * of the drive, which no template means). MiMo also attaches a folder, and
 * takes a name that is no file for an agent's; neither has a form in a message
 * here, so both are left as the text they are.
 */
async function referencedFiles(prompt: string, directory: string, home: string): Promise<ExpandedCommand["files"]> {
  const root = repositoryRoot(directory) ?? directory
  const out: ExpandedCommand["files"] = []
  for (const name of fileReferences(prompt)) {
    const target = name.startsWith("~/") ? path.join(home, name.slice(2)) : path.resolve(root, name)
    const stat = await fs.stat(target).catch(() => undefined)
    if (stat?.isFile()) out.push({ name, path: target })
  }
  return out
}

function repositoryRoot(directory: string): string | undefined {
  let at = path.resolve(directory)
  for (;;) {
    if (existsSync(path.join(at, ".git"))) return at
    const parent = path.dirname(at)
    if (parent === at) return undefined
    at = parent
  }
}

/* -------------------------------------------------------- markdown commands */

/**
 * The folders command files are read from, in the order they are merged - a
 * later folder wins a name.
 *
 * MiMo's own order: the home `.claude` folder and the `.claude` folders from the
 * conversation's directory up to the repository root; then the global config
 * folder; the `.mcode` folders over the same walk; and the home `.mcode`. Each
 * walk lists the nearest folder first, so of two project folders defining the
 * same name the OUTER one wins - the reverse of skills, and measured rather
 * than chosen. MiMo's desktop turns `.claude` skills off but not `.claude`
 * commands, so those are read.
 */
async function commandRoots(deps: Folders, directory: string): Promise<string[]> {
  const home = deps.home ?? os.homedir()
  const roots = [
    path.join(home, ".claude"),
    ...upward(directory, ".claude"),
    ...(deps.storage ? [deps.storage.directory] : []),
    ...upward(directory, PROJECT_CONFIG_DIR),
    path.join(home, PROJECT_CONFIG_DIR),
  ].map((root) => path.resolve(root))
  // A folder met twice keeps its first place.
  return [...new Set(roots)].filter((root) => existsSync(root))
}

/** Each `<dir>/<target>` from `directory` up to the repository root (or the top of the drive), nearest first. */
function upward(directory: string, target: string): string[] {
  const found: string[] = []
  let at = path.resolve(directory)
  for (;;) {
    const candidate = path.join(at, target)
    if (existsSync(candidate)) found.push(candidate)
    if (existsSync(path.join(at, ".git"))) break
    const parent = path.dirname(at)
    if (parent === at) break
    at = parent
  }
  return found
}

/**
 * The commands a project and the user carry as files.
 *
 * The reference scans `{command,commands}/**\/*.md` in each config directory
 * with `dot: true` and names each one after its path below that folder, minus
 * the extension - so `command/deploy/web.md` is `/deploy/web` and not `/web`
 * (`configEntryNameFromPath` stripping the `command/` or `commands/` prefix,
 * @3239300). The nesting is kept because two folders can each hold a `web.md`.
 */
async function fileCommands(deps: Folders, directory: string, defaultModel?: ModelRef): Promise<Record<string, CommandDefinition>> {
  const out: Record<string, CommandDefinition> = {}
  for (const base of await commandRoots(deps, directory)) {
    for (const folder of ["command", "commands"]) {
      const root = path.join(base, folder)
      for (const file of await markdownFiles(root, MAX_DEPTH)) {
        const parsed = await readDocument(file)
        if (!parsed) continue
        const relative = path.relative(root, file).split(path.sep).join("/")
        const name = relative.replace(/\.md$/i, "")
        if (!name) continue
        const template = parsed.body.trim()
        if (!template) continue
        out[name] = {
          template,
          description: text(parsed.data.description),
          agent: agent(parsed.data.agent),
          model: model(parsed.data.model, defaultModel),
          variant: variant(parsed.data.variant),
          subtask: boolean(parsed.data.subtask),
        }
      }
    }
  }
  return out
}

/* ------------------------------------------------------------ MCP prompts */

/**
 * One command per prompt every connected MCP server offers.
 *
 * `hints` is `$1`, `$2` - one per declared argument, and the template is the
 * prompt fetched with those same tokens standing in for its arguments - so the
 * words typed after the slash land in the places the server left for them.
 * That substitution is the reference's (@32868400) and it is why an MCP prompt
 * needs no placeholder syntax of its own.
 */
async function promptCommands(mcp: Deps["mcp"], directory: string): Promise<Record<string, CommandInfo>> {
  const out: Record<string, CommandInfo> = {}
  let listed: Awaited<ReturnType<McpServers["prompts"]>> = {}
  try {
    listed = await mcp.prompts(directory)
  } catch {
    return out
  }
  for (const [name, prompt] of Object.entries(listed)) {
    const args = prompt.arguments ?? []
    let template = ""
    try {
      template = await mcp.getPrompt(
        prompt.client,
        prompt.name,
        Object.fromEntries(args.map((argument, index) => [argument.name, `$${index + 1}`])),
        directory,
      )
    } catch {
      // A prompt that cannot be fetched is still listed, with nothing to send.
      // The reference reaches the same state: its template getter rejects and
      // the command is left in the map.
      template = ""
    }
    out[name] = {
      name,
      description: prompt.description,
      source: "mcp",
      template,
      hints: args.map((_argument, index) => `$${index + 1}`),
    }
  }
  return out
}

/* ----------------------------------------------------------------- skills */

/**
 * Every skill this conversation can reach, as a command that sends its body.
 *
 * MiMo's command service lists a skill with its content as the whole template
 * - no base-directory lines after it, those belong to the skill tool's output -
 * and marks the shipped ones `bundled`, which is `builtin` here.
 */
async function skillCommands(
  directory: string,
  storageDirectory: string | undefined,
  settings: Pick<AppConfig, "skillPaths" | "sessionChat" | "disabledSkills">,
  home?: string,
): Promise<CommandInfo[]> {
  const { skills } = await discoverSkills({ directory, storageDirectory, settings, home })
  // A switched-off skill is not offered after a slash, as MiMo's list leaves out a denied one.
  return enabledSkills(skills, settings.disabledSkills).map((skill) => ({
    name: skill.name,
    description: skill.description || undefined,
    source: "skill" as const,
    ...(skill.builtin ? { builtin: true } : {}),
    // The window labels a skill chip from these, as MiMo labels one from the skill rather than the command.
    ...(skill.localizations ? { localizations: skill.localizations } : {}),
    template: skill.content,
    hints: [],
  }))
}

/* --------------------------------------------------------------- scanning */

async function markdownFiles(root: string, depth: number): Promise<string[]> {
  return scan(root, depth, (name) => /\.md$/i.test(name))
}

/* ------------------------------------------------------------ frontmatter */

interface Document {
  data: Record<string, unknown>
  body: string
}

/** A command file split into its frontmatter and its body; one whose frontmatter cannot be read is skipped. */
async function readDocument(file: string): Promise<Document | undefined> {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  const parsed = parseFrontmatter(raw)
  return parsed.error ? undefined : { data: parsed.data, body: parsed.body }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function boolean(value: unknown): boolean | undefined {
  if (value === "true" || value === true) return true
  if (value === "false" || value === false) return false
  return undefined
}

function agent(value: unknown): TurnAgent | undefined {
  const name = text(value)
  return name && (COMMAND_AGENTS as readonly string[]).includes(name) ? (name as TurnAgent) : undefined
}

function variant(value: unknown): Effort | undefined {
  const level = text(value)
  return level && (EFFORTS as readonly string[]).includes(level) ? (level as Effort) : undefined
}

/**
 * `provider/model`, or one of MiMo's model tier names.
 *
 * Split on the FIRST slash only: a model id can contain one - `openai/gpt-oss`
 * behind a gateway - and splitting on all of them would lose half the name. A
 * name without a slash is a model group in MiMo; this app configures no groups,
 * so, as MiMo does without them, `ultra`, `standard` and `lite` are the default
 * model and any other group name maps to nothing.
 */
function model(value: unknown, defaultModel?: ModelRef): ModelRef | undefined {
  const raw = text(value)
  if (!raw) return undefined
  if (!raw.includes("/")) return (MODEL_TIERS as readonly string[]).includes(raw) && defaultModel ? { ...defaultModel } : undefined
  const at = raw.indexOf("/")
  if (at <= 0 || at === raw.length - 1) return undefined
  return { provider: raw.slice(0, at), model: raw.slice(at + 1) }
}
