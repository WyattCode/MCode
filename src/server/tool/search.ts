import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { IGNORED, relative, resolvePath } from "./fs-util"
import { globMatcher, walkFiles } from "./ignore"

/** MiMo lists at most 100 files for a glob and 100 matches for a grep. */
const LIMIT = 100
/** The list tool's own ceiling, which MiMo has no counterpart for. */
const MAX_LIST_ENTRIES = 200
const MAX_LINE_LENGTH = 2000

async function mtimeOf(file: string): Promise<number | undefined> {
  const stat = await fs.stat(file).catch(() => undefined)
  return stat && !stat.isDirectory() ? stat.mtimeMs : undefined
}

export const GlobTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by name pattern, e.g. *.ts, src/**/*.vue or *.{js,jsx}. A pattern without a slash matches file names at any depth. Hidden files are included and .gitignore is honoured. Lists absolute paths, newest first, at most 100.",
  permission: "glob",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob to match file names or paths against" },
      path: { type: "string", description: "Folder to search in, the project root when left out" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const root = input.path ? await resolvePath(context, String(input.path)) : path.resolve(context.directory)
    if ((await fs.stat(root).catch(() => undefined))?.isFile()) throw new ToolError(`glob's path has to be a folder: ${root}`)
    // Matched from the folder searched, as ripgrep's --glob is: `*.ts` at any depth, `src/*.ts` from there.
    const matches = globMatcher(String(input.pattern))
    const found: { path: string; mtime: number }[] = []

    // As MiMo's: the first 101 files the walk finds, so it can say there were more, then the newest first.
    await walkFiles(
      root,
      async (absolute) => {
        if (!matches(relative(root, absolute))) return false
        found.push({ path: absolute, mtime: (await mtimeOf(absolute)) ?? 0 })
        return found.length > LIMIT
      },
      context.signal,
    )
    const truncated = found.length > LIMIT
    if (truncated) found.length = LIMIT
    found.sort((a, b) => b.mtime - a.mtime)

    const output =
      found.length === 0
        ? "No files found"
        : found.map((entry) => entry.path).join("\n") +
          (truncated ? `\n\n(Only the first ${LIMIT} files found are listed. Narrow the path or the pattern to see the rest.)` : "")
    return {
      output,
      title: relative(context.directory, root),
      metadata: { count: found.length, truncated },
    }
  },
}

export const GrepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns the matching lines grouped under each file, newest files first, at most 100 matches. Narrow the search with path (a file or a folder) and include (a glob such as *.ts or *.{ts,tsx}).",
  permission: "grep",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "File or folder to search in, the project root when left out" },
      include: { type: "string", description: "Glob naming which files to search, e.g. *.js or *.{ts,tsx}" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const pattern = String(input.pattern ?? "")
    if (!pattern) throw new ToolError("pattern is required")
    const target = input.path ? await resolvePath(context, String(input.path)) : path.resolve(context.directory)

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${(err as Error).message}`)
    }
    const include = input.include ? globMatcher(String(input.include)) : undefined

    const rows: { path: string; line: number; text: string }[] = []
    const search = async (absolute: string) => {
      const bytes = await fs.readFile(absolute).catch(() => undefined)
      // A file with a NUL in it is binary, which ripgrep does not search.
      if (!bytes || bytes.includes(0)) return
      const lines = bytes.toString("utf8").split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) rows.push({ path: absolute, line: i + 1, text: lines[i] })
      }
    }

    if ((await fs.stat(target).catch(() => undefined))?.isFile()) await search(target)
    else {
      await walkFiles(
        target,
        async (absolute) => {
          if (include && !include(relative(target, absolute))) return
          await search(absolute)
        },
        context.signal,
      )
    }

    const empty = { output: "No files found", title: pattern, metadata: { matches: 0, truncated: false } }
    if (rows.length === 0) return empty
    const times = new Map<string, number>()
    for (const file of new Set(rows.map((row) => row.path))) {
      const mtime = await mtimeOf(file)
      if (mtime !== undefined) times.set(file, mtime)
    }
    const matches = rows.filter((row) => times.has(row.path)).sort((a, b) => times.get(b.path)! - times.get(a.path)!)
    if (matches.length === 0) return empty

    const total = matches.length
    const truncated = total > LIMIT
    const lines = [`Found ${total} matches${truncated ? ` (showing the first ${LIMIT})` : ""}`]
    let current = ""
    for (const match of matches.slice(0, LIMIT)) {
      if (current !== match.path) {
        if (current) lines.push("")
        current = match.path
        lines.push(`${match.path}:`)
      }
      const text = match.text.length > MAX_LINE_LENGTH ? `${match.text.slice(0, MAX_LINE_LENGTH)}...` : match.text
      lines.push(`  Line ${match.line}: ${text}`)
    }
    if (truncated) lines.push("", `(${LIMIT} of ${total} matches shown. Narrow the path or the pattern to see the rest.)`)
    return { output: lines.join("\n"), title: pattern, metadata: { matches: total, truncated } }
  },
}

export const ListTool: ToolDefinition = {
  name: "list",
  description:
    "List a directory as an indented tree. Use this to orient yourself in an unfamiliar part of the project; use glob when you already know what you are looking for.",
  permission: "list",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list, defaults to the project root" },
      depth: { type: "number", description: "How many levels to descend, default 2" },
    },
    additionalProperties: false,
  },
  async execute(input, context) {
    const root = input.path ? await resolvePath(context, String(input.path)) : path.resolve(context.directory)
    const maxDepth = Math.max(1, Math.min(5, Number(input.depth ?? 2)))
    const lines: string[] = []
    let count = 0

    async function descend(dir: string, depth: number, indent: string) {
      if (depth > maxDepth || count >= MAX_LIST_ENTRIES) return
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      const sorted = entries
        .filter((entry) => !entry.name.startsWith(".") && !IGNORED.has(entry.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of sorted) {
        if (count >= MAX_LIST_ENTRIES) return
        count++
        lines.push(`${indent}${entry.name}${entry.isDirectory() ? "/" : ""}`)
        if (entry.isDirectory()) await descend(path.join(dir, entry.name), depth + 1, indent + "  ")
      }
    }

    const stat = await fs.stat(root).catch(() => undefined)
    if (!stat?.isDirectory()) throw new ToolError(`Not a directory: ${relative(context.directory, root)}`)
    await descend(root, 1, "")

    const display = relative(context.directory, root) || "."
    return {
      output: `${display}/\n${lines.join("\n")}` + (count >= MAX_LIST_ENTRIES ? "\n\n(truncated)" : ""),
      title: display,
      metadata: { path: display, entries: count },
    }
  },
}
