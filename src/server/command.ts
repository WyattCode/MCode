import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AgentName, CommandDefinition, CommandInfo, Effort, ModelRef } from "@shared/protocol"
import { AGENT_NAMES, EFFORTS } from "@shared/protocol"
import { hints } from "@shared/command"
import type { McpServers } from "./mcp"

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
 * Two deliberate departures from it, both because this app is not that one:
 *
 * - The reference seeds two built-in commands, `init` and `review`, whose
 *   templates are bundled prompt files. They are not copied. `initialize_default`
 *   is a prompt about writing `AGENTS.md` for "future OpenCode sessions" and
 *   naming `opencode.json`, so transcribing it would put the other product's
 *   name and config format into this app's prompts, and `review` duplicates a
 *   panel this app already has. Their absence is reported rather than hidden.
 * - Templates are resolved EAGERLY here. The reference holds each one behind a
 *   getter and only touches it when the command runs on its server; this app
 *   expands the template in the window, so the text has to be on the wire when
 *   the list is. The only source this actually costs anything for is MCP,
 *   where each prompt is one extra round trip per listing.
 */

/** Where a project keeps its own commands and skills, the way `.opencode` does. */
const PROJECT_CONFIG_DIR = ".mcode"

/**
 * The folders the reference reads skills out of, minus its remote sources.
 *
 * `EXTERNAL_SKILL_PATTERN` is `skills/**\/SKILL.md` under `.claude` and
 * `.agents` (@22131300), and `OPENCODE_SKILL_PATTERN` is
 * `{skill,skills}/**\/SKILL.md` under each config directory. Its
 * `skills.urls` puller, which downloads a remote index into a cache, is not
 * replicated: nothing in this app configures one.
 */
const EXTERNAL_SKILL_DIRS = [".claude", ".agents"]

/** How deep any of these scans will walk before giving up. */
const MAX_DEPTH = 8

interface Deps {
  /** Only `get()` is used, so a check can hand this a plain object. */
  config: { get(): { commands?: Record<string, CommandDefinition> } }
  /** Only the prompt half of the MCP surface is used. */
  mcp: Pick<McpServers, "prompts" | "getPrompt">
}

export async function listCommands(deps: Deps, directory: string): Promise<CommandInfo[]> {
  const commands: Record<string, CommandInfo> = {}

  for (const [name, entry] of Object.entries(deps.config.get().commands ?? {})) {
    commands[name] = fromDefinition(name, entry)
  }

  for (const [name, entry] of Object.entries(await fileCommands(directory))) {
    commands[name] = fromDefinition(name, entry)
  }

  for (const [name, prompt] of Object.entries(await promptCommands(deps.mcp))) {
    commands[name] = prompt
  }

  for (const skill of await skillCommands(directory)) {
    // The one source that yields: a skill never displaces a command.
    if (commands[skill.name]) continue
    commands[skill.name] = skill
  }

  return Object.values(commands)
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

/* -------------------------------------------------------- markdown commands */

/**
 * The commands a project carries as files.
 *
 * The reference scans `{command,commands}/**\/*.md` in each config directory
 * with `dot: true` and names each one after its path below that folder, minus
 * the extension - so `command/deploy/web.md` is `/deploy/web` and not `/web`
 * (`configEntryNameFromPath` stripping the `command/` or `commands/` prefix,
 * @3239300). The nesting is kept because two folders can each hold a `web.md`.
 */
async function fileCommands(directory: string): Promise<Record<string, CommandDefinition>> {
  const out: Record<string, CommandDefinition> = {}
  for (const folder of ["command", "commands"]) {
    const root = path.join(directory, PROJECT_CONFIG_DIR, folder)
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
        model: model(parsed.data.model),
        variant: variant(parsed.data.variant),
        subtask: boolean(parsed.data.subtask),
      }
    }
  }
  return out
}

/* ------------------------------------------------------------ MCP prompts */

/**
 * One command per prompt every connected MCP server offers.
 *
 * `hints` is `$1`, `$2` … one per declared argument, and the template is the
 * prompt fetched with those same tokens standing in for its arguments - so the
 * words typed after the slash land in the places the server left for them.
 * That substitution is the reference's (@32868400) and it is why an MCP prompt
 * needs no placeholder syntax of its own.
 */
async function promptCommands(mcp: Deps["mcp"]): Promise<Record<string, CommandInfo>> {
  const out: Record<string, CommandInfo> = {}
  let listed: Awaited<ReturnType<McpServers["prompts"]>> = {}
  try {
    listed = await mcp.prompts()
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
 * Every SKILL.md this project can see, as a command that sends its body.
 *
 * The two lines appended after the body are the reference's, verbatim
 * (@32871000). They are what makes a skill's own `scripts/` and `references/`
 * paths resolvable, and a skill whose file sits at `<built-in>` gets neither -
 * this app has no built-in skill, so the branch is simply absent.
 *
 * Frontmatter must carry a `name`; the reference's `isSkillFrontmatter` accepts
 * exactly `name: string` with an optional `description: string`, and a file
 * failing that is skipped rather than named after its folder.
 */
async function skillCommands(directory: string): Promise<CommandInfo[]> {
  const roots: string[] = []
  for (const folder of ["skill", "skills"]) {
    roots.push(path.join(directory, PROJECT_CONFIG_DIR, folder))
  }
  for (const external of EXTERNAL_SKILL_DIRS) {
    roots.push(path.join(directory, external, "skills"))
    roots.push(path.join(os.homedir(), external, "skills"))
  }

  const out: CommandInfo[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const file of await skillFiles(root, MAX_DEPTH)) {
      const parsed = await readDocument(file)
      if (!parsed) continue
      const name = text(parsed.data.name)
      if (!name) continue
      // The reference logs a duplicate skill name and keeps the first; the
      // second is dropped either way, so only the keeping is replicated.
      if (seen.has(name)) continue
      seen.add(name)
      const base = path.dirname(file)
      out.push({
        name,
        description: text(parsed.data.description),
        source: "skill",
        template: [
          parsed.body,
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
        ].join("\n"),
        hints: [],
      })
    }
  }
  return out
}

/* --------------------------------------------------------------- scanning */

async function markdownFiles(root: string, depth: number): Promise<string[]> {
  return scan(root, depth, (name) => /\.md$/i.test(name))
}

async function skillFiles(root: string, depth: number): Promise<string[]> {
  return scan(root, depth, (name) => name === "SKILL.md")
}

/**
 * Walks a folder for the files a scan wants, in a stable order.
 *
 * Sorted because the order decides which of two skills with the same declared
 * name is kept, and an unsorted `readdir` would make that answer depend on the
 * filesystem. A missing folder is not an error: most projects have none of
 * these, and the slash menu still has to open.
 */
async function scan(root: string, depth: number, wanted: (name: string) => boolean): Promise<string[]> {
  if (depth <= 0) return []
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await scan(full, depth - 1, wanted)))
      continue
    }
    if (entry.isFile() && wanted(entry.name)) found.push(full)
  }
  return found
}

/* ------------------------------------------------------------ frontmatter */

interface Document {
  data: Record<string, unknown>
  body: string
}

/**
 * A markdown file split into its frontmatter and its body.
 *
 * Deliberately not a YAML parser. Every key either of these two documents can
 * carry is a scalar - name, description, agent, model, variant, subtask - so
 * `key: value` with optional quotes is the whole grammar that is needed, and a
 * file using anything richer loses only the key it wrote that way. Bringing in
 * a YAML dependency to read six strings would be the larger mistake.
 */
async function readDocument(file: string): Promise<Document | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
  const text = raw.replace(/^﻿/, "")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data: Record<string, unknown> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    data[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "")
  }
  return { data, body: text.slice(match[0].length) }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function boolean(value: unknown): boolean | undefined {
  if (value === "true" || value === true) return true
  if (value === "false" || value === false) return false
  return undefined
}

function agent(value: unknown): AgentName | undefined {
  const name = text(value)
  return name && (AGENT_NAMES as readonly string[]).includes(name) ? (name as AgentName) : undefined
}

function variant(value: unknown): Effort | undefined {
  const level = text(value)
  return level && (EFFORTS as readonly string[]).includes(level) ? (level as Effort) : undefined
}

/**
 * `provider/model`, which is how the reference writes a model in frontmatter.
 *
 * Split on the FIRST slash only: a model id can contain one - `openai/gpt-oss`
 * behind a gateway - and splitting on all of them would lose half the name.
 */
function model(value: unknown): ModelRef | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const at = raw.indexOf("/")
  if (at <= 0 || at === raw.length - 1) return undefined
  return { provider: raw.slice(0, at), model: raw.slice(at + 1) }
}
