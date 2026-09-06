import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

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

export async function systemPrompt(context: PromptContext): Promise<string> {
  const sections = [BASE]
  if (context.agent === "plan") sections.push(PLAN)

  const instructions = await projectInstructions(context.directory)
  if (instructions) {
    sections.push(`## Project instructions\n\nThese come from the project itself and take precedence over the general guidance above.\n\n${instructions}`)
  }

  sections.push(await environment(context.directory))
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
Shell: ${process.platform === "win32" ? "PowerShell" : process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash")}
Today: ${new Date().toISOString().slice(0, 10)}

Top level of the project: ${entries}`
}

/** First line of the user's opening message, trimmed into a sidebar title. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ")
  if (line.length <= 60) return line || "New session"
  return line.slice(0, 57) + "..."
}
