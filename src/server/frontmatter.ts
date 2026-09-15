/**
 * A markdown file's frontmatter, read without a YAML dependency.
 *
 * Skills and commands only ever write a handful of shapes, and this reads all
 * of them: plain, single- and double-quoted scalars, booleans, numbers and
 * null; a plain value that carries on over more-indented lines; `|` and `>`
 * block scalars with their `-` and `+` chomping; inline `[a, b]` lists and
 * block `- a` lists; and one level of `key:` maps (a skill's `metadata`).
 * Anything past that is reported as an error rather than half-read, so a file
 * written in richer YAML is skipped with a reason instead of loading with a
 * value that is quietly wrong.
 */

export interface Frontmatter {
  data: Record<string, unknown>
  body: string
  /** Why the block could not be read; `data` is then empty. */
  error?: string
}

const OPENING = /^---[ \t]*\r?\n/
const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/

export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^﻿/, "")
  if (!OPENING.test(text)) return { data: {}, body: text }
  const lines = text.split(/\r?\n/)
  let close = -1
  for (let at = 1; at < lines.length; at++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[at]!)) {
      close = at
      break
    }
  }
  if (close < 0) return { data: {}, body: text }
  const body = lines.slice(close + 1).join("\n")
  try {
    return { data: readMap(lines.slice(1, close)), body }
  } catch (err) {
    return { data: {}, body, error: err instanceof Error ? err.message : String(err) }
  }
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].length
}

function blank(line: string): boolean {
  return !line.trim() || /^[ \t]*#/.test(line)
}

/** A block of `key: value` lines at one indent. */
function readMap(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let at = 0
  const base = lines.find((line) => !blank(line))
  const indent = base === undefined ? 0 : indentOf(base)
  while (at < lines.length) {
    const line = lines[at]!
    if (blank(line)) {
      at++
      continue
    }
    if (indentOf(line) !== indent) throw new Error(`unexpected indentation at "${line.trim()}"`)
    const pair = KEY.exec(line.slice(indent))
    if (!pair) throw new Error(`not a key: "${line.trim()}"`)
    const key = pair[1]!
    const rest = (pair[2] ?? "").trim()
    // Everything indented deeper than this key belongs to its value.
    let end = at + 1
    while (end < lines.length && (blank(lines[end]!) ? true : indentOf(lines[end]!) > indent)) end++
    // Trailing blank lines are not part of the value.
    let last = end
    while (last > at + 1 && !lines[last - 1]!.trim()) last--
    out[key] = readValue(rest, lines.slice(at + 1, last), indent)
    at = end
  }
  return out
}

function readValue(first: string, more: string[], indent: number): unknown {
  const block = /^([|>])([+-]?)[ \t]*(?:#.*)?$/.exec(first)
  if (block) return blockScalar(block[1] as "|" | ">", block[2]!, more)
  const content = more.filter((line) => !blank(line))
  if (!first) {
    if (!content.length) return null
    const inner = Math.min(...content.map(indentOf))
    if (inner <= indent) return null
    if (content[0]!.slice(inner).startsWith("- ") || content[0]!.slice(inner) === "-") return readList(more, inner)
    if (KEY.test(content[0]!.slice(inner))) return readMap(more)
    return fold(content.map((line) => line.trim()))
  }
  if (first.startsWith('"') || first.startsWith("'")) {
    const joined = [first, ...more.map((line) => line.trim())].join(" ")
    const quoted = readQuoted(joined)
    if (quoted.rest.replace(/#.*$/, "").trim()) throw new Error(`text after a quoted value: "${quoted.rest.trim()}"`)
    return quoted.value
  }
  if (first.startsWith("[")) return readInlineList([first, ...more.map((line) => line.trim())].join(" "))
  if (content.length) return fold([stripComment(first), ...content.map((line) => line.trim())])
  return scalar(stripComment(first))
}

function blockScalar(style: "|" | ">", chomp: string, more: string[]): string {
  const content = more.filter((line) => line.trim())
  const inner = content.length ? Math.min(...content.map(indentOf)) : 0
  const rows = more.map((line) => (line.trim() ? line.slice(inner) : ""))
  let text: string
  if (style === "|") text = rows.join("\n")
  else {
    // Folded: lines of one paragraph join with a space, a blank line stays a break.
    text = ""
    for (const row of rows) {
      if (!row) text += "\n"
      else text += text && !text.endsWith("\n") ? ` ${row}` : row
    }
  }
  if (chomp === "-") return text.replace(/\n+$/, "")
  if (chomp === "+") return `${text}\n`
  return `${text.replace(/\n+$/, "")}\n`
}

function readList(lines: string[], indent: number): unknown[] {
  const out: unknown[] = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at]!
    if (blank(line)) {
      at++
      continue
    }
    if (indentOf(line) !== indent || !/^-(\s|$)/.test(line.slice(indent))) throw new Error(`not a list item: "${line.trim()}"`)
    const first = line.slice(indent + 1).trim()
    let end = at + 1
    while (end < lines.length && (blank(lines[end]!) || indentOf(lines[end]!) > indent)) end++
    out.push(readValue(first, lines.slice(at + 1, end), indent))
    at = end
  }
  return out
}

function readInlineList(text: string): unknown[] {
  const trimmed = stripComment(text)
  if (!trimmed.endsWith("]")) throw new Error(`unclosed list: "${text}"`)
  const inside = trimmed.slice(1, -1).trim()
  if (!inside) return []
  const out: unknown[] = []
  let rest = inside
  while (rest) {
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quoted = readQuoted(rest)
      out.push(quoted.value)
      rest = quoted.rest.trim().replace(/^,/, "").trim()
      continue
    }
    const comma = rest.indexOf(",")
    const item = (comma < 0 ? rest : rest.slice(0, comma)).trim()
    if (item.startsWith("[") || item.startsWith("{")) throw new Error(`nested collection in a list: "${text}"`)
    out.push(scalar(item))
    rest = comma < 0 ? "" : rest.slice(comma + 1).trim()
  }
  return out
}

function readQuoted(text: string): { value: string; rest: string } {
  const mark = text[0]!
  let value = ""
  for (let at = 1; at < text.length; at++) {
    const char = text[at]!
    if (mark === "'" && char === "'") {
      if (text[at + 1] === "'") {
        value += "'"
        at++
        continue
      }
      return { value, rest: text.slice(at + 1) }
    }
    if (mark === '"' && char === "\\") {
      const next = text[at + 1] ?? ""
      const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0" }
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
        value += String.fromCharCode(parseInt(text.slice(at + 2, at + 6), 16))
        at += 5
        continue
      }
      value += escapes[next] ?? next
      at++
      continue
    }
    if (mark === '"' && char === '"') return { value, rest: text.slice(at + 1) }
    value += char
  }
  throw new Error(`unclosed quote: ${text.slice(0, 40)}`)
}

function stripComment(text: string): string {
  return text.replace(/\s+#.*$/, "").trim()
}

function fold(parts: string[]): string {
  return parts.filter(Boolean).join(" ")
}

function scalar(text: string): unknown {
  if (text === "" || text === "~" || text === "null") return text === "" ? "" : null
  if (text === "true") return true
  if (text === "false") return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith("{")) throw new Error(`inline maps are not read: "${text}"`)
  return text
}
