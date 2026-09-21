import path from "node:path"
import { attachmentKind, extensionOf } from "@shared/attachment-kind"
import { interfaceLocale, localeName } from "./locale"

/** Office documents a model cannot read as text, and what opens each of them. */
const OFFICE_TOOLS: Record<string, string> = {
  xlsx: "Python with openpyxl, or pandas when the sheet is a table",
  xlsm: "Python with openpyxl, or pandas when the sheet is a table",
  xlsb: "Python with pandas (its pyxlsb reader), or LibreOffice to convert it first",
  xls: "Python with pandas (its xlrd reader), or LibreOffice to convert it first",
  docx: "Python with python-docx",
  doc: "LibreOffice to convert it to .docx first, then python-docx",
  pptx: "Python with python-pptx",
  ppt: "LibreOffice to convert it to .pptx first, then python-pptx",
  pdf: "Python with pypdf for the text, or a page renderer when the layout matters",
  odt: "LibreOffice to convert it, or a reader for OpenDocument",
  ods: "Python with pandas, or LibreOffice to convert it",
  odp: "LibreOffice to convert it to .pptx first",
  rtf: "Pandoc or LibreOffice to convert it to plain text",
  epub: "Python with ebooklib, or Pandoc to convert it",
}

/** The one line every block ends on: the paths are exact, so nothing is to be searched for. */
const BY_PATH = "Work on the absolute paths exactly as written. Do not search the user's folders, do not glob, do not list directories to find these files, and do not ask for a path again."

/**
 * MiMo's attachment blocks: what the user attached this turn, sorted into the
 * three kinds that need different handling, each with the paths to work on.
 *
 * Only a picture travels inside the message. A text file, an Office document
 * and anything else are named here and nowhere else, so the model reads what it
 * needs, when it needs it, at the size it really is - an attached 300 KB log
 * used to arrive cut off at 50 KB under a line claiming the read had already
 * been made for it, and the rest was never fetched.
 *
 * Three blocks rather than one list because what to do differs entirely by
 * kind: the first is read with the read tool, the second needs a library named
 * per type, and the third is a path to operate on rather than a document to
 * read. A single list said none of that, so a spreadsheet read as text came
 * back as mojibake and the model reported the file as damaged.
 */
export function attachmentNote(files: readonly { path: string }[], directory: string): string | undefined {
  if (!files.length) return undefined
  const absolute = (file: { path: string }) => (path.isAbsolute(file.path) ? file.path : path.resolve(directory, file.path))
  const text: string[] = []
  const office: string[] = []
  const binary: string[] = []
  for (const file of files) {
    const target = absolute(file)
    const kind = attachmentKind(file.path)
    // A picture is in the message already; it needs no instructions.
    if (kind === "image") continue
    if (kind === "office") office.push(target)
    else if (kind === "text") text.push(target)
    else binary.push(target)
  }
  if (!text.length && !office.length && !binary.length) return undefined

  const lines = ["# Attached files", "The user attached these files to this message. Tell them in one sentence what you received before you do anything else."]
  const listed = (paths: readonly string[]) => paths.map((target) => `- ${target}`)
  if (text.length) {
    lines.push(
      "",
      "Text and code files. They are not in this message: read each one with the read tool before working on it.",
      ...listed(text),
      BY_PATH,
    )
  }
  if (office.length) {
    lines.push(
      "",
      "Office documents. They are binary: reading one with the read tool gives you the compressed container, not the content. Open each with what fits it:",
      ...office.map((target) => `- ${target} - ${OFFICE_TOOLS[extensionOf(target)] ?? "a reader that understands this format"}`),
    )
    // MiMo's bundled runtime: its Python already has these libraries (src/main/runtimes.ts names it).
    if (process.env.MCODE_PYTHON) lines.push("MCode's bundled Python (the MCODE_PYTHON environment variable) has openpyxl, pandas, python-docx, python-pptx and pypdf installed; run these with it.")
    else lines.push("Check that the library is installed before relying on it, and say so plainly if it is not rather than guessing at the contents.")
    lines.push(BY_PATH)
  }
  if (binary.length) {
    lines.push(
      "",
      "Files of a binary or unknown kind - audio, video, archives, images this model cannot read, anything else. Nothing of them is in this message: operate on each one directly, at its path, with whatever tool suits it.",
      ...listed(binary),
      BY_PATH,
    )
  }
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
}

/**
 * MiMo's runtime context holds the working directory and the reply language
 * and nothing else - no branch, no working tree, no model name. MCode adds the
 * date, which no model can work out for itself; the repository block that used
 * to follow this one is gone (the user's 2026-09-20 decision).
 */
export function runtimeContext(input: RuntimeInput): string {
  const locale = interfaceLocale(input.language)
  const lines = ["# Runtime context"]
  if (input.directory) lines.push(`Working directory: ${input.directory}`)
  lines.push(
    `Response language: ${localeName(locale)}. Reply in this language unless the user's message or their custom instructions ask for another.`,
  )
  if (input.today) lines.push(`Today: ${input.today}`)
  return lines.join("\n")
}

export interface SessionNoteInput {
  /** The MCP servers this conversation has, by the name they are configured under. */
  mcpServers: string[]
  /** This app's own config file, which holds the MCP servers among everything else. */
  configFile: string
}

/**
 * The once-per-conversation note: the MCP servers this app has, and where
 * they are configured.
 *
 * MiMo 26.920 cut its note to these two blocks, both English, and so does
 * MCode: where a skill or an instruction file goes, how to ask the user, and
 * the environment check went with it. The first of those now sits in the
 * Skills section of the prompt, the question tool's own description covers the
 * third, and the base prompt's "Tools on this machine" says in one sentence
 * what the environment check said in eight.
 *
 * The MCP paragraph is the long one on purpose, and it is the one MiMo spends
 * its own length on. Without it a model that has a configured MCP server still
 * reaches for a platform's command-line tool, spends a turn on a login this app
 * cannot service, and then tells the user it cannot see any MCP servers at all.
 * With no server configured MiMo's server block is empty and only the file
 * block remains, and so it is here.
 */
export function sessionNote(input: SessionNoteInput): string {
  const lines = ["# About this app"]

  if (input.mcpServers.length) {
    lines.push(
      `- MCP servers configured here: ${input.mcpServers.join(", ")}. This is the user's real configuration, so when they ask which servers they have, answer from this list rather than saying you cannot tell.`,
      "- Whether a server can be used this turn is a different question: it can when its tools are in the tool list you were given. Where they are, use them. Where a configured server's tools are missing, say it is configured but not loaded in this conversation - a server added or switched on applies to conversations started afterwards - instead of denying the server exists.",
      "- Prefer an MCP tool to a command-line program that does the same job. When a server covers the work, do not reach for that platform's CLI, do not check whether the CLI is installed, and never try to sign into one: this app cannot hand a terminal over to an interactive login, so the attempt only costs a turn.",
      "- A server's own executable is not a shell fallback either. If the tool you need is missing, say which server it belongs to and that it needs connecting, rather than running the server yourself or substituting a different server's tool.",
    )
  }

  lines.push(
    `- The MCP servers live in the \`mcpServers\` section of ${input.configFile}. That file exists and you may edit it: when the user wants several servers added at once, write them into that section with the file tools rather than sending them to the settings one by one. One entry per server - a local one as {"type":"local","command":["program","argument"],"environment":{"KEY":"value"},"enabled":true}, a remote one as {"type":"remote","url":"https://...","headers":{"KEY":"value"},"enabled":true}. Change nothing else in the file, and tell the user that the change reaches conversations started afterwards; the MCP page in the settings can add and remove servers too.`,
  )
  return lines.join("\n")
}
