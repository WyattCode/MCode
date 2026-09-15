import path from "node:path"
import { interfaceLocale, localeName } from "./locale"

/**
 * MiMo's attachment note: the paths of the files attached by path, what to
 * tell the user, and not to go looking through their folders for them.
 */
export function attachmentNote(files: readonly { path: string }[], directory: string): string | undefined {
  if (!files.length) return undefined
  return [
    "# Attached files",
    "The user attached these files to this message:",
    ...files.map((file) => `- ${path.isAbsolute(file.path) ? file.path : path.resolve(directory, file.path)}`),
    "Tell the user in one sentence what you received. When the message does not hold all of a file you need, read it with the read tool at the path above; do not search or list the user's folders to find it.",
  ].join("\n")
}

/**
 * What the model is told about where it is working, attached to the user's own
 * messages as they are sent - MiMo's runtime context, in MCode's words.
 *
 * Every prompt carries the reply language; the first prompt of a conversation
 * also carries the working directory and a note about what this app offers.
 * They are stored on the message, so what a message was sent with stays what
 * it was sent with, and the conversation's prefix does not shift under it.
 */

export interface RuntimeInput {
  /** The interface language setting; empty follows the machine. */
  language: string | undefined
  /** Given only on the conversation's first message. */
  directory?: string
  /** The date the message was sent, as YYYY-MM-DD. */
  today?: string
  /** The repository's state as the message was sent (prompt.ts `repositoryState`), kept out of the cached system prompt. */
  repository?: string
}

export function runtimeContext(input: RuntimeInput): string {
  const locale = interfaceLocale(input.language)
  const lines = ["# Runtime context"]
  if (input.directory) lines.push(`Working directory: ${input.directory}`)
  lines.push(
    `Response language: ${localeName(locale)}. Reply in this language unless the user's message or their custom instructions ask for another.`,
  )
  if (input.today) lines.push(`Today: ${input.today}`)
  const block = lines.join("\n")
  return input.repository ? `${block}\n\n${input.repository}` : block
}

export interface SessionNoteInput {
  /** The MCP servers this conversation has, by the name they are configured under. */
  mcpServers: string[]
  /** Where the user's global AGENTS.md lives. */
  globalAgentsFile: string
  platform?: NodeJS.Platform
}

/** The once-per-conversation note: tools, where things are configured, and how to ask. */
export function sessionNote(input: SessionNoteInput): string {
  const platform = input.platform ?? process.platform
  const servers = input.mcpServers.length
    ? `MCP servers configured in MCode for this conversation: ${input.mcpServers.join(", ")}. When one of them has a tool for the job, use it rather than a command-line equivalent, and never start a server's program yourself.`
    : "No MCP servers are configured in MCode for this conversation."
  const shell =
    platform === "win32"
      ? "Commands run in PowerShell on Windows: write PowerShell, not bash, and check that a program is installed before relying on it."
      : `Commands run in ${platform === "darwin" ? "a macOS" : "a Linux"} shell: check that a program is installed before relying on it.`
  return [
    "# About this app",
    `- ${servers}`,
    "- MCP servers are added and changed in MCode's Settings, on the MCP page; a change applies to conversations started after it.",
    "- A skill for this project is written as .mcode/skills/<name>/SKILL.md inside the project.",
    `- The user's global instructions are in ${input.globalAgentsFile}; a project's own instructions go in AGENTS.md at its root.`,
    "- When the user has to choose between options, ask with the question tool instead of listing the options in prose, and set multiple when more than one answer can apply.",
    `- ${shell}`,
  ].join("\n")
}
