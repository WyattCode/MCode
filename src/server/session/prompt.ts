import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { recentCommits, status } from "../git"

/**
 * Instruction files a project can drop in its root to teach the agent its
 * conventions. Read in order; every one that exists is appended.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".mcode/rules.md"]

const BASE = `You are MCode, an AI coding agent working inside a user's project on their machine.

## How to work

Do what the user asked, no more. Read before you write: quote a file exactly as the read tool showed it to you. When a task takes several steps, record the plan with todowrite and keep it current so the user can follow along; skip it for single-step work.

Prefer the dedicated tools over shelling out. read, glob, and grep are faster than cat, find, and their shell equivalents, and their output is easier for you to use. Reach for bash for builds, tests, package managers, and version control.

Match the code around you. Read a neighbouring file before adding a new one, and follow its naming, comment density, and idiom rather than importing conventions from elsewhere. Do not add a comment explaining a change you just made - comments explain code, not edits.

## Verifying

When you change code, try to check it: run the project's tests, its type checker, or its linter if one exists. Report what you actually ran and what it said. If something fails and you cannot fix it, say so plainly with the output - do not describe unfinished work as done.

## Talking to the user

Be concise. The user is reading your output in a terminal-style pane next to their editor, not a document. Answer the question that was asked; skip preamble, skip summarizing what you are about to do, and skip restating the code you just wrote unless the user needs to read it to answer you. Reference files as paths so they are clickable.

Never fabricate a file path, a command's output, or an API you have not verified exists in this project.`

export interface PromptContext {
  directory: string
  agent: string
  /** The reader's standing instructions, if they have written any. */
  instructions?: string
  /** The global AGENTS.md, read into every conversation while it is there (switched off, it has been renamed). */
  globalAgentsFile?: string
  /** Whether the conversation works in stages. */
  staged?: boolean
}

/**
 * Builds the system prompt. Ordering matters for prompt caching: the static
 * base comes first, then per-project material that changes rarely, then the
 * volatile environment block last.
 */
const PLAN = `## Planning only

You are in plan mode. The tools that change files are not available to you in
this mode, and you must not ask the user to run a command that would change
anything either.

Read whatever you need, then answer with a plan: what you would change, in
which files, in what order, and what you are unsure of. Say plainly when the
answer depends on something you could not determine by reading.`

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
   Record the steps with todowrite.
3. Build. Make the changes the plan describes. If the plan turns out to be wrong,
   say so and revise it rather than quietly doing something else.
4. Review. Compare what you changed against the plan, run the project's checks,
   and report plainly what passed, what failed, and anything left undone.`

export async function systemPrompt(context: PromptContext): Promise<string> {
  const sections = [BASE]
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

  const instructions = await projectInstructions(context.directory)
  if (instructions) {
    sections.push(`## Project instructions\n\nThese come from the project itself and take precedence over the general guidance above.\n\n${instructions}`)
  }

  const commands = await projectCommands(context.directory)
  if (commands) sections.push(commands)

  /*
   * Last, and in this order: the environment changes per project, the
   * repository changes per turn. Anything after them would be re-sent with a
   * new prefix every time the working tree moved.
   */
  sections.push(await environment(context.directory))
  const repository = await repositoryState(context.directory)
  if (repository) sections.push(repository)
  return sections.join("\n\n")
}

async function projectInstructions(directory: string): Promise<string> {
  const found: string[] = []
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(directory, name)
    const content = await fs.readFile(file, "utf8").catch(() => undefined)
    if (content?.trim()) found.push(`<instructions source="${name}">\n${content.trim()}\n</instructions>`)
  }
  return found.join("\n\n")
}

async function environment(directory: string): Promise<string> {
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

  return `## Environment

Project directory: ${directory}
Platform: ${process.platform} (${os.release()})
Shell: ${process.platform === "win32" ? "PowerShell" : process.env.SHELL || "/bin/bash"}
Today: ${new Date().toISOString().slice(0, 10)}

Top level of the project: ${entries}`
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
async function repositoryState(directory: string): Promise<string | undefined> {
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
