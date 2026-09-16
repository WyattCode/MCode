import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { defaultBranch, gitUser, recentCommits, status } from "../git"
import { globToRegExp } from "../tool/ignore"
import { foldersUp } from "./worktree"
import { modelInvocable, type SkillInfo } from "../skill"
import { basePrompt } from "./prompts"

/** MiMo reads CLAUDE.md beside AGENTS.md only while the AGENTS.md files say less than this. */
const AGENTS_SHORT = 500

export interface PromptContext {
  directory: string
  agent: string
  /** The reader's standing instructions, if they have written any. */
  instructions?: string
  /** The global AGENTS.md, read into every conversation while it is there (switched off, it has been renamed). */
  globalAgentsFile?: string
  /** Whether the conversation works in stages. */
  staged?: boolean
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
  /** memory: the memory files a top-level conversation keeps; absent for a subagent. */
  memory?: { project: string; global: string; notes: string }
  /** Which model this is, so the environment block can say so (MiMo names it there). */
  model?: PromptModel
}

/** The model as the environment block names it. */
export interface PromptModel {
  /** Its display name, where the catalog knows one. */
  name?: string
  provider: string
  id: string
}

/*
 * memory: what the model is told about memory, in this app's words; MiMo's desktop build describes the same three files.
 * It names this conversation's own notes file, so a request carries it after the cached system prompt (runner systemFor).
 */
export function memorySection(files: { project: string; global: string; notes: string }): string {
  return `## Memory

Some notes outlast this conversation. They are markdown files you read and write with the ordinary tools, without asking:

- Project memory: \`${files.project}\` - what the project is, rules the user set for it, design decisions and facts later conversations in this project will need. Edit it when the user states a lasting rule or decision for the project, or when you learn something durable.
- Global memory: \`${files.global}\` - the user's preferences that hold in every project.
- This conversation's notes: \`${files.notes}\` - your one scratchpad. Add entries headed \`## [turn N · YYYY-MM-DDTHH:MM:SSZ]\` for open questions, quotes worth keeping or context that will matter later. Do not create other memory files.

Before asking the user something they may already have told you, search with the memory tool; use the history tool for exact past wording.`
}

/**
 * Builds the system prompt. Ordering matters for prompt caching: the static
 * base comes first, then per-project material that changes rarely, then the
 * volatile environment block last.
 */
/*
 * plan: what planning is, in the system prompt. The turn-by-turn rules - the
 * plan file's path, what is refused, how the turn ends - ride with each
 * message instead (session/plan.ts), because the path is per conversation and
 * this prompt is frozen for the whole of one.
 */
const PLAN = `## Planning only

You are in plan mode. You keep every tool, but writing is refused everywhere
except this conversation's plan file, whose path each of your turns is given.
Run a command only when you are certain it changes nothing; it is put to the
user like any other.

Work out what should be done and write it into the plan file as you go: what
would change, in which files, in what order, what you checked, and what you are
still unsure of. Say plainly when an answer depends on something you could not
settle by reading.

End each turn either by asking the user with the question tool, or - once the
plan is written and nothing is left to ask - by calling plan_exit, which puts
the plan to them for approval and switches this conversation to build mode if
they accept.`

/*
 * Staged mode. Four stages, named so the reader can see where the work is, and
 * each with the one thing that makes it a stage rather than a heading: what has
 * to be true before moving on. Plan mode already stops before building, so in
 * plan mode this section is left out rather than contradicted.
 */
const STAGED = `## Working in stages

The user has asked for this conversation to be worked in four stages. Name the
stage you are in when you move into it.

1. Clarify. Say back what you understand the task to be. If something the work
   depends on is genuinely unclear, ask before going further - with the question
   tool when it is available. Do not ask about things you can find out by reading.
2. Plan. Write down what will change, in which files, and how you will check it.
   Record the steps with the task tool.
3. Build. Make the changes the plan describes. If the plan turns out to be wrong,
   say so and revise it rather than quietly doing something else.
4. Review. Compare what you changed against the plan, run the project's checks,
   and report plainly what passed, what failed, and anything left undone.`

export async function systemPrompt(context: PromptContext): Promise<string> {
  /*
   * The agent prompt of this model's family (session/prompts.ts), as MiMo picks
   * one of its ten by model id. It is the first section, so the whole of the
   * cached prefix below it stays in one order for every family.
   */
  const sections = [basePrompt(context.model ? { id: context.model.id } : undefined)]
  if (context.agent === "plan") sections.push(PLAN)
  else if (context.staged) sections.push(STAGED)

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

  const global = context.globalAgentsFile
    ? (await fs.readFile(context.globalAgentsFile, "utf8").catch(() => "")).trim()
    : ""
  if (global) {
    sections.push(
      `## Global instructions\n\nThese come from the user's global AGENTS.md and apply to every project; the project's own instructions below take precedence.\n\n${global}`,
    )
  }

  const instructions = await projectInstructions(context.directory, context.instructionFiles ?? [], {
    home: context.home,
    fetch: context.fetchInstruction,
  })
  if (instructions) {
    sections.push(`## Project instructions\n\nThese come from the project itself and take precedence over the general guidance above.\n\n${instructions}`)
  }

  const commands = await projectCommands(context.directory)
  if (commands) sections.push(commands)

  // skills: rarely changes, so before the environment and the repository.
  if (context.skills) sections.push(skillsSection(context.skills))

  /*
   * Then the environment, which changes per project. The repository's state
   * and the date change per turn, so they travel with each prompt instead
   * (session/context.ts) and this prompt stays the same for the conversation,
   * as MiMo freezes its own.
   */
  sections.push(await environment(context.directory, context.model))

  // memory: names this conversation's own notes file, so last - where a request carries it, outside the cached prefix.
  if (context.memory) sections.push(memorySection(context.memory))
  return sections.join("\n\n")
}

/**
 * skills: the ones the model may load, by name, what each is for, and where it
 * lives, as MiMo's engine lists them; sorted so the list reads the same each turn.
 */
function skillsSection(skills: readonly SkillInfo[]): string {
  const listed = modelInvocable(skills)
  if (!listed.length) return "## Skills\n\nNo skills are available in this conversation."
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

/** Where the instruction files that are not a project's own are looked for, in MiMo's order: the first that exists wins. */
export function globalInstructionFiles(home: string): string[] {
  return [path.join(home, ".claude", "CLAUDE.md")]
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
 * Then the global instruction file - `~/.claude/CLAUDE.md`, the first of the
 * global candidates that exists - as MiMo adds its own after the project's and
 * before the configured ones (the user's 2026-09-16 decision; MCode's own
 * global AGENTS.md is a separate section of the prompt).
 *
 * Then the files the `instructions` setting names: each pattern looked for in
 * the same folders, and each web address fetched, both as MiMo does. MCode's
 * own `.mcode/rules.md` in the working folder is read last. Each file once,
 * labelled with where it came from.
 */
async function projectInstructions(
  directory: string,
  patterns: readonly string[],
  options: { home?: string; fetch?: (url: string) => Promise<string> } = {},
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

  for (const file of globalInstructionFiles(home)) {
    const content = await read(file)
    if (content) {
      chosen.push({ file, content })
      break
    }
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

/**
 * The environment block, memoised for the day.
 *
 * MiMo caches its own per (directory, date, provider, model id) and this does
 * the same: everything here is a fact that holds for a day at a time - which
 * model this is, whether the folder is a repository, which branch a pull
 * request should target, who git will credit - so rebuilding it per turn would
 * only spend a `git` call to print the same words.
 *
 * What genuinely moves while the conversation runs - the current branch, what
 * is dirty, the recent commits, the date - is deliberately NOT here. It travels
 * with each prompt instead (`repositoryState`, session/context.ts), so the
 * cached prefix stays byte-identical across a turn while the model still reads
 * a current working tree. MiMo folds the volatile half in here too and lets it
 * go stale, telling the model in so many words that it is "a snapshot in time";
 * MCode keeps the fresher answer.
 */
const environments = new Map<string, string>()

async function environment(directory: string, model?: PromptModel, today = new Date().toISOString().slice(0, 10)): Promise<string> {
  const key = [path.resolve(directory), today, model?.provider ?? "", model?.id ?? ""].join("|")
  const cached = environments.get(key)
  if (cached !== undefined) return cached

  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .then((list) =>
      list
        .filter((entry) => !entry.name.startsWith("."))
        .slice(0, 40)
        .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
        .join(", "),
    )
    .catch(() => "(unreadable)")

  const repo = (await status(directory).catch(() => undefined))?.repo === true
  const [trunk, who] = repo
    ? await Promise.all([defaultBranch(directory).catch(() => undefined), gitUser(directory).catch(() => undefined)])
    : [undefined, undefined]

  const lines = [
    "## Environment",
    "",
    `Project directory: ${directory}`,
    `Is a git repository: ${repo}`,
    `Platform: ${process.platform} (${os.release()})`,
    `Shell: ${process.platform === "win32" ? "PowerShell" : process.env.SHELL || "/bin/bash"}`,
  ]
  // Which model this is: without it a model cannot answer "which model am I".
  if (model) lines.push(`Model: ${model.name ? `${model.name}, ` : ""}${model.provider}/${model.id}`)
  if (trunk) lines.push(`Default branch: ${trunk}. Target a pull request at this branch unless the user asks for another.`)
  if (who) lines.push(`Git user: ${who}`)
  lines.push("", `Top level of the project: ${entries}`)

  const block = lines.join("\n")
  environments.set(key, block)
  return block
}

/**
 * How this project is built and tested, read off the files that say so.
 *
 * The agent is told to check its work, which is no help if finding the check
 * costs it a turn of grepping. Only names that are actually declared appear
 * here - a script this lists can be run, and one this omits may simply not
 * exist rather than being hidden.
 */
async function projectCommands(directory: string): Promise<string | undefined> {
  const lines: string[] = []

  const manifest = await readJSON(path.join(directory, "package.json"))
  if (manifest && typeof manifest.scripts === "object" && manifest.scripts) {
    const names = Object.keys(manifest.scripts as Record<string, string>)
    if (names.length) {
      /* The runner is whichever lockfile is on disk; npm is the fallback,
         because running pnpm's scripts through npm mostly works and guessing
         pnpm where there is none does not. */
      const runner = (await exists(path.join(directory, "pnpm-lock.yaml")))
        ? "pnpm"
        : (await exists(path.join(directory, "yarn.lock")))
          ? "yarn"
          : (await exists(path.join(directory, "bun.lockb")))
            ? "bun"
            : "npm"
      const shown = names.slice(0, 24).join(", ")
      lines.push(`package.json scripts (\`${runner} run <name>\`): ${shown}`)
    }
  }

  if (await exists(path.join(directory, "Cargo.toml"))) lines.push("Cargo project: `cargo build`, `cargo test`")
  if (await exists(path.join(directory, "go.mod"))) lines.push("Go module: `go build ./...`, `go test ./...`")
  if (await exists(path.join(directory, "pyproject.toml"))) lines.push("pyproject.toml is present")
  if (await exists(path.join(directory, "Makefile"))) lines.push("Makefile is present")

  if (!lines.length) return undefined
  return `## Building and testing\n\n${lines.join("\n")}`
}

/**
 * The repository, as it stands this turn.
 *
 * Which branch, what is already dirty, and what the last few commits were. The
 * first two keep the agent from committing to the wrong place or claiming
 * credit for changes that were there before it started; the third is the
 * cheapest look at how this project writes its history.
 */
export async function repositoryState(directory: string): Promise<string | undefined> {
  const state = await status(directory).catch(() => undefined)
  if (!state?.repo) return undefined

  const lines: string[] = []
  lines.push(`Branch: ${state.branch || "(no commits yet)"}`)

  if (!state.changed.length) lines.push("Working tree: clean")
  else {
    const shown = state.entries.slice(0, 12).map((entry) => `  ${entry.kind}: ${entry.path}`)
    const rest = state.entries.length - shown.length
    lines.push(`Already modified before this turn (${state.entries.length}):`)
    lines.push(...shown)
    if (rest > 0) lines.push(`  ...and ${rest} more`)
  }

  const commits = await recentCommits(directory, 5).catch(() => [])
  if (commits.length) lines.push("Recent commits:", ...commits.map((line) => `  ${line}`))

  return `## Repository\n\n${lines.join("\n")}`
}

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

async function readJSON(file: string): Promise<Record<string, unknown> | undefined> {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
