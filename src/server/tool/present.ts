import path from "node:path"
import fs from "node:fs/promises"
import type { Stats } from "node:fs"
import type { ToolDefinition } from "./types"
import { addressName, normalizedAddress } from "@shared/session-files"

/*
 * Two tools that act on the window rather than the project, as MiMo's baseline
 * extension offers them: one points the PDF preview at a quoted passage, one
 * names the files a turn is handing over. Neither reads or changes a file's
 * contents; the renderer does the showing once the call has completed.
 */

const baseName = (file: string) => file.split(/[\\/]/).pop() || file

/** MiMo's step title for a locate: the first 60 characters of the passage. */
export const LOCATE_TITLE_MAX = 60

export const PdfLocateTool: ToolDefinition = {
  name: "pdf_locate",
  description: [
    "Show a passage of a PDF in MCode's preview panel: the preview opens the PDF (or switches to it), scrolls to the passage and highlights it.",
    "Call it each time your reply quotes or points to specific text in a PDF, once per passage, right after you mention it, so the reader can see the original in place.",
    "It changes nothing and returns no content. A path that does not exist is ignored. Do not use it for files that are not PDFs.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "Absolute path of the PDF (a relative path is taken from the project folder)" },
      snippet: { type: "string", description: "The passage exactly as it appears in the PDF: a short verbatim fragment matches best; never paraphrase or translate it" },
      page: { type: "number", description: "1-based page the passage is on. Strongly recommended: when the text cannot be matched the preview still goes to this page" },
    },
    required: ["file", "snippet"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const file = String(input.file ?? "")
    const snippet = String(input.snippet ?? "")
    const page = typeof input.page === "number" && Number.isFinite(input.page) ? input.page : undefined
    const target = path.isAbsolute(file) ? path.resolve(file) : path.resolve(context.directory, file)
    const at = page ? ` at page ${page}` : ""
    return {
      output: `The preview was asked to show "${baseName(target)}"${at} and highlight the passage.`,
      title: snippet.slice(0, LOCATE_TITLE_MAX),
      metadata: { path: target, snippet, ...(page ? { page } : {}) },
    }
  },
}

/** One entry the model named, as the card draws it. */
export type PresentedFile = { path: string; name: string; size: number } | { url: string; name: string }

export type PresentSkip = { entry: string; reason: "missing" | "directory" }

/**
 * The folders a relative entry is looked for in, in MiMo's order: `cwd` (taken
 * from the project when it is itself relative), then the project.
 */
function bases(directory: string, cwd?: string): string[] {
  const root = path.resolve(directory)
  const first = cwd ? (path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(root, cwd)) : root
  return first === root ? [root] : [first, root]
}

/**
 * The entries a present_files call can show, in the order given.
 *
 * A web address is kept once, however it was written. A local path is taken as
 * it is when absolute - wherever it is, as MiMo hands over a file the user asked
 * to have written to the desktop - and otherwise from `cwd` and then from the
 * project, whichever holds it. It has to be an existing file; anything else is
 * skipped with its reason. The same file named twice is shown once.
 */
export async function presentable(
  files: readonly string[],
  directory: string,
  cwd?: string,
): Promise<{ files: PresentedFile[]; skipped: PresentSkip[] }> {
  const shown: PresentedFile[] = []
  const skipped: PresentSkip[] = []
  const seen = new Set<string>()
  for (const raw of files) {
    const entry = String(raw ?? "").trim()
    if (!entry) continue
    if (/^https?:\/\//i.test(entry)) {
      const address = normalizedAddress(entry)
      if (!address) {
        skipped.push({ entry, reason: "missing" })
        continue
      }
      if (seen.has(address)) continue
      seen.add(address)
      shown.push({ url: address, name: addressName(address) })
      continue
    }
    const candidates = path.isAbsolute(entry) ? [path.resolve(entry)] : bases(directory, cwd).map((base) => path.resolve(base, entry))
    let target: string | undefined
    let stat: Stats | undefined
    for (const candidate of candidates) {
      stat = await fs.stat(candidate).catch(() => undefined)
      if (stat) {
        target = candidate
        break
      }
    }
    if (!target || !stat) {
      skipped.push({ entry, reason: "missing" })
      continue
    }
    if (!stat.isFile()) {
      skipped.push({ entry, reason: "directory" })
      continue
    }
    const key = process.platform === "win32" ? target.toLowerCase() : target
    if (seen.has(key)) continue
    seen.add(key)
    shown.push({ path: target, name: baseName(target), size: stat.size })
  }
  return { files: shown, skipped }
}

const SKIP_WORDS: Record<PresentSkip["reason"], string> = {
  missing: "does not exist",
  directory: "is a folder, not a file",
}

export const PresentFilesTool: ToolDefinition = {
  name: "present_files",
  description: [
    "Hand the finished deliverables of this turn to the user in MCode: each file appears as a card under your reply, and the FIRST one opens in the preview panel by itself.",
    "Call it once, near the end of the turn, after the deliverables are done - a generated document, sheet, deck or PDF, a picture, a built web page, a report. Leave out scratch and intermediate files, dependencies, and files you only read.",
    "Only what the user will keep, open or pass on belongs here. When the user asks for an explanation, a demonstration or a walkthrough, answer in the reply itself instead of writing a file for it.",
    "Files must exist; an absolute path may be anywhere, a relative one is looked for in cwd and then in the project folder. Entries that are not found are skipped and named in the result.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "array",
        description: "The deliverables, most important first (the first opens automatically). Each is an absolute path, a path relative to cwd, or an http(s) address",
        items: { type: "string" },
      },
      cwd: { type: "string", description: "The folder relative entries in files are taken from" },
      explanation: { type: "string", description: "One short sentence saying what these files are" },
    },
    required: ["files", "cwd", "explanation"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const list = Array.isArray(input.files) ? input.files.map((entry) => String(entry)) : []
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined
    const { files, skipped } = await presentable(list, context.directory, cwd)
    const names = files.map((file) => file.name)
    const notes = skipped.map((skip) => `Skipped "${skip.entry}": it ${SKIP_WORDS[skip.reason]}.`)
    const head = files.length
      ? `Showed ${files.length} ${files.length === 1 ? "file" : "files"} to the user: ${names.join(", ")}. The first opens in the preview panel.`
      : "No files were shown to the user."
    return {
      output: [head, ...notes].join("\n"),
      title: names.join(", ").slice(0, 80),
      metadata: { files, skipped },
    }
  },
}
