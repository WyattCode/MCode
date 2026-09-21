import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { globToRegExp } from "../tool/ignore"
import { foldersUp } from "./worktree"
import { modelInvocable, type SkillInfo } from "../skill"
import { agentPrompt } from "./prompts"

/** MiMo reads CLAUDE.md beside AGENTS.md only while the AGENTS.md files say less than this. */
const AGENTS_SHORT = 500

export interface PromptContext {
  directory: string
  agent: string
  /** The reader's standing instructions, if they have written any. */
  instructions?: string
  /** The global AGENTS.md, read into every conversation while it is there (switched off, it has been renamed). */
  globalAgentsFile?: string
  /**
   * MiMo's `instructions` setting: more instruction files, by glob, looked for
   * up to the repository's top, and web addresses, which are fetched.
   */
  instructionFiles?: string[]
  /** The home folder whose `.claude/CLAUDE.md` is read; a check points it somewhere harmless. */
  home?: string
  /** How a web address in `instructionFiles` is fetched; a check answers without a network. */
  fetchInstruction?: (url: string) => Promise<string>
  /** skills: every skill the conversation can reach; the ones kept from the model are left out of the list. */
  skills?: SkillInfo[]
  /** skills: the folder a skill for every project is written to, which the list names for a skill the user asks to have made. */
  skillsFolder?: string
  /** memory: the memory files a top-level conversation keeps; absent for a subagent. */
  memory?: { project: string; global: string; notes: string }
}

/*
 * memory: what the model is told about memory, in this app's words; MiMo's desktop build describes the same three files.
 * It names this conversation's own notes file, so a request carries it after the cached system prompt (runner systemFor).
 */
export function memorySection(files: { project: string; global: string; notes: string; readOnly?: boolean }): string {
  // memory: config's memory.disableWrite leaves the files to be read and searched, and says so.
  if (files.readOnly) {
    return `## Memory

Some notes outlast this conversation, as markdown files. Writing them is switched off in this app's settings, so do not write or edit any memory file; you can still search them with the memory tool and read them:

- Project memory: \`${files.project}\` - shared by every folder and worktree of this repository (outside a repository, by every such folder).
- Global memory: \`${files.global}\` - the user's preferences that hold in every project.
- This conversation's notes: \`${files.notes}\`.

Nothing from them is loaded for you: search or read them when you need what they may hold, and use the history tool for exact past wording.`
  }
  return `## Memory

Some notes outlast this conversation. They are markdown files you read and write with the ordinary tools, without asking:

- Project memory: \`${files.project}\` - what the project is, rules the user set for it, design decisions and facts later conversations in this project will need. Every folder and worktree of this repository shares it (outside a repository, every such folder shares one). Edit it when the user states a lasting rule or decision for the project, or when you learn something durable.
- Global memory: \`${files.global}\` - the user's preferences that hold in every project.
- This conversation's notes: \`${files.notes}\` - your one scratchpad. Add entries headed \`## [turn N · YYYY-MM-DDTHH:MM:SSZ]\` for open questions, quotes worth keeping or context that will matter later. Do not create other memory files.

Before asking the user something they may already have told you, search with the memory tool; use the history tool for exact past wording.`
}

/**
 * Builds the system prompt. Ordering matters for prompt caching: the static
 * base comes first, then the per-project material, which changes rarely.
 *
 * Nothing here describes the machine, the working tree or this model. MiMo's
 * engine can write such a block, but its desktop leaves the flag that produces
 * one switched off, so no MiMo user's model ever reads one; MCode sends none
 * either (the user's 2026-09-20 decision).
 */
export async function systemPrompt(context: PromptContext): Promise<string> {
  /*
   * The one agent prompt every model reads in every mode (session/prompts.ts).
   * It is the first section, so the cached prefix opens with the same bytes
   * whatever the model.
   */
  const sections = [agentPrompt(context.agent)]

  /*
   * Before the project's own files, and said to be the reader's rather than
   * the project's: a standing instruction is a preference, and a project that
   * disagrees with it - a repository with its own commit style, say - should
   * win inside that repository.
   */
  const standing = (context.instructions ?? "").trim()
  if (standing) {
    sections.push(
      `## Standing instructions\n\nThese are the user's own, and apply to every project they work in.\n\n${standing}`,
    )
  }

  const instructions = await projectInstructions(context.directory, context.instructionFiles ?? [], {
    home: context.home,
    fetch: context.fetchInstruction,
    globalAgentsFile: context.globalAgentsFile,
  })
  if (instructions) {
    sections.push(
      `## Instructions\n\nThese come from the project's instruction files, then the user's global one, then any the settings name. They take precedence over the general guidance above, and the project's own win where the global one disagrees.\n\n${instructions}`,
    )
  }

  if (context.skills) sections.push(skillsSection(context.skills, context.skillsFolder))

  // memory: names this conversation's own notes file, so last - where a request carries it, outside the cached prefix.
  if (context.memory) sections.push(memorySection(context.memory))
  return sections.join("\n\n")
}

/**
 * skills: the ones the model may load, by name, what each is for, and where it
 * lives, as MiMo's engine lists them; sorted so the list reads the same each turn.
 *
 * It ends on where a new skill goes. That used to ride on the first message of
 * every conversation; MiMo 26.920 moved it into the prompt, and here it sits
 * with the list it adds to, which is frozen for the conversation just as the
 * folder is fixed for the app.
 */
function skillsSection(skills: readonly SkillInfo[], folder?: string): string {
  const listed = modelInvocable(skills)
  const making = `A skill the user asks you to make goes in <project>/.mcode/skills/<name>/SKILL.md for one project${folder ? `, or ${folder}${path.sep}<name>${path.sep}SKILL.md for every project` : ""}. The folder name is the skill's id, its SKILL.md needs a name and a description in the frontmatter, and conversations started afterwards pick it up.`
  if (!listed.length) return `## Skills\n\nNo skills are available in this conversation.\n\n${making}`
  const entries = [...listed]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((skill) => [
      "  <skill>",
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>${pathToFileURL(skill.location).href}</location>`,
      "  </skill>",
    ])
  return [
    "## Skills",
    "",
    "A skill is a folder of instructions, and often scripts, for one kind of work. When the task matches a skill below, load it with the skill tool before you start, and follow it. When none clearly fits but one might, skill_search looks for it by what the work is.",
    "",
    "<skills>",
    ...entries,
    "</skills>",
    "",
    making,
  ].join("\n")
}

/**
 * MiMo's timeout for an instruction file fetched over the web (`Instruction.system`,
 * `HttpClientRequest.get(url).timeout(5000)`). Anything slower is left out.
 */
export const INSTRUCTION_FETCH_MS = 5000

/**
 * One web address named by the `instructions` setting.
 *
 * MiMo fetches these on the way into the system prompt; the user decided on
 * 2026-09-16 that MCode does too, so a turn may reach the network for them.
 * As MiMo does, anything that goes wrong - a refusal, a bad status, a timeout -
 * is the empty string rather than an error: an instruction file that cannot be
 * had must not stop the conversation.
 */
export async function fetchInstruction(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return ""
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INSTRUCTION_FETCH_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" })
    if (!response.ok) return ""
    return (await response.text()).trim()
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Where the instruction file that is not a project's own is looked for, in
 * MiMo's order: the app's global AGENTS.md (the one the settings open), then
 * `~/.claude/CLAUDE.md`. The first that exists is read and the search stops,
 * so a global AGENTS.md keeps CLAUDE.md out; switched off (renamed), it no
 * longer exists and CLAUDE.md is read in its place.
 */
export function globalInstructionFiles(home: string, globalAgentsFile?: string): string[] {
  return [...(globalAgentsFile ? [globalAgentsFile] : []), path.join(home, ".claude", "CLAUDE.md")]
}

/**
 * A project's instruction files, as MiMo gathers them (`Instruction.systemPaths`).
 *
 * Every AGENTS.md from the working folder up to the repository's top, nearest
 * first, so a package inside a monorepo reads its own and the root's. While
 * those say less than 500 characters, CLAUDE.md files on the same path join
 * them; with no AGENTS.md at all, the CLAUDE.md files stand in, and failing
 * those the CONTEXT.md files.
 *
 * Then the global instruction file - the first of `globalInstructionFiles`
 * that exists - as MiMo adds its own after the project's and before the
 * configured ones.
 *
 * Then the files the `instructions` setting names: each pattern looked for in
 * the same folders, and each web address fetched, both as MiMo does. MCode's
 * own `.mcode/rules.md` in the working folder is read last. Each file once,
 * labelled with where it came from.
 */
async function projectInstructions(
  directory: string,
  patterns: readonly string[],
  options: { home?: string; fetch?: (url: string) => Promise<string>; globalAgentsFile?: string } = {},
): Promise<string> {
  const home = options.home ?? os.homedir()
  const get = options.fetch ?? fetchInstruction
  const folders = await foldersUp(directory)
  const read = async (file: string) => ((await fs.readFile(file, "utf8").catch(() => "")) as string).trim()
  const named = async (name: string) => {
    const out: { file: string; content: string }[] = []
    for (const folder of folders) {
      const file = path.join(folder, name)
      const content = await read(file)
      if (content) out.push({ file, content })
    }
    return out
  }

  const agents = await named("AGENTS.md")
  let chosen = agents
  if (agents.length && agents.reduce((sum, entry) => sum + entry.content.length, 0) < AGENTS_SHORT) chosen = [...agents, ...(await named("CLAUDE.md"))]
  if (!agents.length) {
    const claude = await named("CLAUDE.md")
    chosen = claude.length ? claude : await named("CONTEXT.md")
  }

  // The first that exists ends the search, even when it says nothing - MiMo's rule.
  for (const file of globalInstructionFiles(home, options.globalAgentsFile)) {
    if (!(await exists(file))) continue
    const content = await read(file)
    if (content) chosen.push({ file, content })
    break
  }

  for (const pattern of patterns) {
    if (/^https?:\/\//i.test(pattern)) continue
    const expanded = pattern.startsWith("~/") ? path.join(home, pattern.slice(2)) : pattern
    const places = path.isAbsolute(expanded) ? [path.dirname(expanded)] : folders.map((folder) => path.join(folder, path.dirname(expanded)))
    const matcher = globToRegExp(path.basename(expanded))
    for (const place of places) {
      const entries = await fs.readdir(place, { withFileTypes: true }).catch(() => [])
      for (const entry of entries.filter((item) => item.isFile() && matcher.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(place, entry.name)
        const content = await read(file)
        if (content) chosen.push({ file, content })
      }
    }
  }

  const rules = path.join(directory, ".mcode", "rules.md")
  const ruleText = await read(rules)
  if (ruleText) chosen.push({ file: rules, content: ruleText })

  const seen = new Set<string>()
  const local = chosen
    .filter((entry) => {
      const key = path.resolve(entry.file).toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((entry) => `<instructions source="${entry.file}">\n${entry.content}\n</instructions>`)

  /* The web addresses last, each once, in the order they were configured. */
  const urls = [...new Set(patterns.filter((pattern) => /^https?:\/\//i.test(pattern)))]
  const fetched = await Promise.all(urls.map((url) => get(url).catch(() => "")))
  const remote = urls.flatMap((url, at) => (fetched[at] ? [`<instructions source="${url}">\n${fetched[at]}\n</instructions>`] : []))

  return [...local, ...remote].join("\n\n")
}

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}
