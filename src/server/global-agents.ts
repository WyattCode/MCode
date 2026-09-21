import fs from "node:fs/promises"
import path from "node:path"
import type { AgentsFileState } from "@shared/protocol"

/**
 * The global AGENTS.md: instructions kept next to MCode's own config that reach
 * every conversation, as MiMo's engine reads its global instructions file.
 *
 * Switching it off renames it to AGENTS.md.disabled, so the words are kept but
 * the prompt no longer finds them; switching it on renames it back.
 */
export function globalAgentsPath(storageDirectory: string): string {
  return path.join(storageDirectory, "AGENTS.md")
}

const disabledPath = (file: string) => `${file}.disabled`

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

export async function agentsState(file: string): Promise<AgentsFileState> {
  if (await exists(file)) return "loaded"
  return (await exists(disabledPath(file))) ? "disabled" : "none"
}

/** Writes a starting file when there is none, so there is something to open. A switched-off one is left alone. */
export async function ensureAgents(file: string): Promise<AgentsFileState> {
  const state = await agentsState(file)
  if (state !== "none") return state
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, TEMPLATE, "utf8")
  return "loaded"
}

export async function setAgentsEnabled(file: string, enabled: boolean): Promise<AgentsFileState> {
  const off = disabledPath(file)
  if (enabled) {
    if (await exists(file)) return "loaded"
    if (!(await exists(off))) return "none"
    await fs.rename(off, file)
    return "loaded"
  }
  if (!(await exists(file))) return (await exists(off)) ? "disabled" : "none"
  await fs.rm(off, { force: true })
  await fs.rename(file, off)
  return "disabled"
}

/** Removes the file whether it is on or off. */
export async function deleteAgents(file: string): Promise<void> {
  await fs.rm(file, { force: true })
  await fs.rm(disabledPath(file), { force: true })
}

const TEMPLATE = `# Global instructions

Write here what MCode should keep in mind in every project: how you like answers
written, tools you prefer, conventions you always follow. A project's own
AGENTS.md is read before this file and wins where the two disagree. While this
file exists, ~/.claude/CLAUDE.md is not read.
`
