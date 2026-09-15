import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { IGNORED, relative, resolvePath } from "./fs-util"
import { globMatcher, walkFiles } from "./ignore"

const MAX_RESULTS = 200
const MAX_FILE_BYTES = 2_000_000

export const GlobTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by name pattern, e.g. **/*.ts or src/**/{a,b}.vue. Results are sorted by modification time, newest first, so recently touched files surface at the top.",
  permission: "glob",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern matched against project-relative paths" },
      directory: { type: "string", description: "Subdirectory to search within" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const root = input.directory
      ? await resolvePath(context, String(input.directory))
      : path.resolve(context.directory)
    // Matched from the folder searched, as ripgrep's --glob is: `*.ts` at any depth, `src/*.ts` from there.
    const matches = globMatcher(String(input.pattern))
    const found: { path: string; mtime: number }[] = []

    await walkFiles(
      root,
      async (absolute) => {
        if (!matches(relative(root, absolute))) return
        const stat = await fs.stat(absolute).catch(() => undefined)
        found.push({ path: relative(context.directory, absolute), mtime: stat?.mtimeMs ?? 0 })
      },
      context.signal,
    )

    found.sort((a, b) => b.mtime - a.mtime)
    const shown = found.slice(0, MAX_RESULTS)
    if (shown.length === 0) return { output: "No files matched.", title: String(input.pattern) }

    const footer = found.length > shown.length ? `\n\n(${found.length - shown.length} more matches not shown)` : ""
    return {
      output: shown.map((entry) => entry.path).join("\n") + footer,
      title: `${String(input.pattern)} - ${found.length} files`,
      metadata: { count: found.length, files: shown.map((entry) => entry.path) },
    }
  },
}

export const GrepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns matching lines with their file and line number. Narrow the search with include to keep results focused.",
  permission: "grep",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression" },
      include: { type: "string", description: "Glob limiting which files are searched, e.g. **/*.ts" },
      directory: { type: "string", description: "Subdirectory to search within" },
      ignoreCase: { type: "boolean", description: "Case-insensitive match" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const root = input.directory
      ? await resolvePath(context, String(input.directory))
      : path.resolve(context.directory)

    let regex: RegExp
    try {
      regex = new RegExp(String(input.pattern), input.ignoreCase ? "i" : "")
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${(err as Error).message}`)
    }
    const include = input.include ? globMatcher(String(input.include)) : undefined

    const matches: { path: string; line: number; text: string }[] = []
    let files = 0

    await walkFiles(
      root,
      async (absolute) => {
        if (matches.length >= MAX_RESULTS) return
        const rel = relative(context.directory, absolute)
        if (include && !include(relative(root, absolute))) return
        const stat = await fs.stat(absolute).catch(() => undefined)
        if (!stat || stat.size > MAX_FILE_BYTES) return
        const content = await fs.readFile(absolute, "utf8").catch(() => undefined)
        if (content === undefined || content.includes("\0")) return
        files++
        const lines = content.split("\n")
        for (let i = 0; i < lines.length && matches.length < MAX_RESULTS; i++) {
          if (regex.test(lines[i])) {
            matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 400) })
          }
        }
      },
      context.signal,
    )

    if (matches.length === 0) return { output: `No matches in ${files} files.`, title: String(input.pattern) }

    const output = matches.map((match) => `${match.path}:${match.line}: ${match.text.trim()}`).join("\n")
    const footer = matches.length >= MAX_RESULTS ? `\n\n(stopped at ${MAX_RESULTS} matches)` : ""
    return {
      output: output + footer,
      title: `${String(input.pattern)} - ${matches.length} matches`,
      metadata: { count: matches.length, matches },
    }
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
      if (depth > maxDepth || count >= MAX_RESULTS) return
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      const sorted = entries
        .filter((entry) => !entry.name.startsWith(".") && !IGNORED.has(entry.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of sorted) {
        if (count >= MAX_RESULTS) return
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
      output: `${display}/\n${lines.join("\n")}` + (count >= MAX_RESULTS ? "\n\n(truncated)" : ""),
      title: display,
      metadata: { path: display, entries: count },
    }
  },
}
