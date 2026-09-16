import path from "node:path"
import { interfaceLocale, localeName } from "./locale"

/** Office documents a model cannot read as text, and what opens each of them. */
const OFFICE_TOOLS: Record<string, string> = {
  xlsx: "Python with openpyxl, or pandas when the sheet is a table",
  xlsm: "Python with openpyxl, or pandas when the sheet is a table",
  xls: "Python with pandas (its xlrd reader), or LibreOffice to convert it first",
  csv: "the read tool, or pandas for anything past a quick look",
  docx: "Python with python-docx",
  doc: "LibreOffice to convert it to .docx first, then python-docx",
  pptx: "Python with python-pptx",
  ppt: "LibreOffice to convert it to .pptx first, then python-pptx",
  odt: "LibreOffice to convert it, or a reader for OpenDocument",
  ods: "Python with pandas, or LibreOffice to convert it",
  odp: "LibreOffice to convert it to .pptx first",
  rtf: "Pandoc or LibreOffice to convert it to plain text",
  epub: "Python with ebooklib, or Pandoc to convert it",
}

function extensionOf(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()
}

/** Which of the three attachment blocks a file belongs in, by its name. */
function group(file: string): "office" | "media" | "other" {
  const extension = extensionOf(file)
  if (OFFICE_TOOLS[extension]) return "office"
  if (/^(png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|mp3|wav|ogg|oga|m4a|aac|flac|opus|mp4|mov|avi|wmv|webm|mkv)$/.test(extension)) return "media"
  return "other"
}

/**
 * MiMo's attachment blocks: the paths of the files attached by path, what to
 * tell the user about them, and what to open each kind with.
 *
 * MiMo writes three of these into the message's system text - text and code
 * files, Office documents, everything else binary - because what to do with an
 * attachment depends entirely on which of the three it is: the first has
 * already been read into the message, the second needs a library named per
 * type, and the third is a path to operate on rather than a document to read.
 * A single list said none of that, so a spreadsheet read as text came back as
 * mojibake and the model reported the file as damaged.
 */
export function attachmentNote(files: readonly { path: string }[], directory: string): string | undefined {
  if (!files.length) return undefined
  const absolute = (file: { path: string }) => (path.isAbsolute(file.path) ? file.path : path.resolve(directory, file.path))
  const office: string[] = []
  const media: string[] = []
  const other: string[] = []
  for (const file of files) {
    const target = absolute(file)
    const where = group(file.path)
    if (where === "office") office.push(target)
    else if (where === "media") media.push(target)
    else other.push(target)
  }

  const lines = ["# Attached files", "The user attached these files to this message. Tell them in one sentence what you received before you do anything else."]
  const listed = (paths: readonly string[]) => paths.map((target) => `- ${target}`)
  if (other.length) {
    lines.push(
      "",
      "Text and code files, already read into this message:",
      ...listed(other),
      "What is here is what the read tool returned. Read one again at the path above only when the message does not hold all of it, or when something may have changed it since.",
    )
  }
  if (office.length) {
    lines.push("", "Office documents. They are not text: reading one with the read tool gives you the compressed container, not the content. Open each with what fits it:", ...office.map((target) => `- ${target} - ${OFFICE_TOOLS[extensionOf(target)]}`))
    lines.push("Check that the library is installed before relying on it, and say so plainly if it is not rather than guessing at the contents.")
  }
  if (media.length) {
    lines.push("", "Pictures, audio, video and PDFs. They travel in this message where this model reads that kind of file, and a line says so where it does not:", ...listed(media))
  }
  lines.push("", "Every path above is absolute and exact. Do not search or list the user's folders to find these files, and do not ask them to type a path again.")
  return lines.join("\n")
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
  /** This app's own config file, which holds the MCP servers among everything else. */
  configFile: string
  /** Where this app keeps its data, which is where a global skill goes. */
  dataRoot: string
  platform?: NodeJS.Platform
}

/**
 * The once-per-conversation note: which tools this app adds, where things are
 * configured, and how to ask.
 *
 * The MCP paragraph is the long one on purpose, and it is the one MiMo spends
 * its own length on. Without it a model that has a configured MCP server still
 * reaches for a platform's command-line tool, spends a turn on a login this app
 * cannot service, and then tells the user it cannot see any MCP servers at all.
 */
export function sessionNote(input: SessionNoteInput): string {
  const platform = input.platform ?? process.platform
  const lines = ["# About this app"]

  if (input.mcpServers.length) {
    lines.push(
      `- MCP servers configured here: ${input.mcpServers.join(", ")}. This is the user's real configuration, so when they ask which servers they have, answer from this list rather than saying you cannot tell.`,
      "- Whether a server can be used this turn is a different question: it can when its tools are in the tool list you were given. Where they are, use them. Where a configured server's tools are missing, say it is configured but not loaded in this conversation - a server added or switched on applies to conversations started afterwards - instead of denying the server exists.",
      "- Prefer an MCP tool to a command-line program that does the same job. When a server covers the work, do not reach for that platform's CLI, do not check whether the CLI is installed, and never try to sign into one: this app cannot hand a terminal over to an interactive login, so the attempt only costs a turn.",
      "- A server's own executable is not a shell fallback either. If the tool you need is missing, say which server it belongs to and that it needs connecting, rather than running the server yourself or substituting a different server's tool.",
    )
  } else {
    lines.push("- No MCP servers are configured here. Say so plainly if the user asks, and do not invent one.")
  }

  lines.push(
    `- MCP servers are edited on the MCP page of MCode's Settings, or directly in ${input.configFile}, whose \`mcpServers\` object holds one entry per server: a local one is {"type":"local","command":["program","arg"],"environment":{"KEY":"value"},"enabled":true} and a remote one {"type":"remote","url":"https://...","headers":{"KEY":"value"},"enabled":true}. Edit that file only when the user asks for servers to be added or changed - it is how several go in at once - keep the rest of it exactly as it is, and tell them a change applies to conversations started afterwards.`,
    `- A skill goes in <project>/.mcode/skills/<name>/SKILL.md for one project, or ${path.join(input.dataRoot, "skills")}/<name>/SKILL.md for every project. The folder name is the skill's id; its SKILL.md needs name and description in the frontmatter. A new skill is picked up by conversations started after it.`,
    `- Instructions: a project's own go in AGENTS.md at its root, and one in a nested folder is read as well for work under it. The user's global instructions are in ${input.globalAgentsFile}. Write to those paths when asked to record a rule; do not invent a folder for another tool's convention.`,
    "- When the user has to choose between options, ask with the question tool instead of listing the options in prose, and set multiple when more than one answer can apply - the flag, not the wording, is what lets them pick more than one.",
  )

  lines.push(
    platform === "win32"
      ? "- Commands run in PowerShell on Windows: write PowerShell rather than bash, quote paths with spaces, and check that a program is on PATH before building a plan around it. Do not assume the GNU tools are here."
      : `- Commands run in ${platform === "darwin" ? "a macOS" : "a Linux"} shell: check that a program is installed before building a plan around it, and do not assume a tool from another platform is present.`,
  )
  return lines.join("\n")
}
