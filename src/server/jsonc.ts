import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import path from "node:path"
import { CodedError } from "@shared/errors"

/**
 * config.json as a person edits it: comments and trailing commas are allowed,
 * and a save changes only the keys that changed, so the file keeps its
 * comments, its order and its layout - as MiMo treats its own config file.
 */

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
const OPTIONS = { allowTrailingComma: true, disallowComments: false }

/** Where a parse problem sits, counted from 1 the way an editor counts. */
export interface JsoncProblem {
  line: number
  column: number
  /** The parser's names for what went wrong, joined. */
  reason: string
}

function position(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let column = 1
  const end = Math.max(0, Math.min(offset, text.length))
  for (let index = 0; index < end; index++) {
    if (text[index] === "\n") {
      line++
      column = 1
    } else column++
  }
  return { line, column }
}

function withoutMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Reads JSONC; a blank text is no document at all. */
export function parseJsonc(raw: string): { value?: unknown; problem?: JsoncProblem } {
  const text = withoutMark(raw)
  if (!text.trim()) return {}
  const errors: ParseError[] = []
  const value = parse(text, errors, OPTIONS)
  if (!errors.length) return { value }
  const first = errors[0]
  return {
    problem: { ...position(text, first.offset), reason: errors.map((entry) => printParseErrorCode(entry.error)).join(", ") },
  }
}

/** The refusal a write meets when the file on disk no longer parses. */
export function unparseableError(file: string, problem: JsoncProblem): CodedError {
  return new CodedError(
    `${file} is not valid JSON near line ${problem.line}, column ${problem.column} (${problem.reason}); nothing was written`,
    "error.configUnparseable",
    { file: path.basename(file), line: problem.line, column: problem.column },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Edits `text` key by key until it says `next`; objects are walked, anything else is replaced whole. */
function editTo(text: string, next: unknown, before: unknown, path: (string | number)[]): string {
  if (isRecord(before) && isRecord(next)) {
    let out = text
    for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
      const wanted = Object.prototype.hasOwnProperty.call(next, key)
      const had = Object.prototype.hasOwnProperty.call(before, key)
      if (!wanted || next[key] === undefined) {
        if (had) out = applyEdits(out, modify(out, [...path, key], undefined, FORMAT))
        continue
      }
      if (!had) {
        out = applyEdits(out, modify(out, [...path, key], next[key], FORMAT))
        continue
      }
      out = editTo(out, next[key], before[key], [...path, key])
    }
    return out
  }
  if (JSON.stringify(before) === JSON.stringify(next)) return text
  return applyEdits(text, modify(text, path, next, FORMAT))
}

/**
 * The text a save writes: the current file edited to say `value`, or a fresh
 * document when there is none. A file that does not parse is never written
 * over - the refusal says where it broke.
 */
export function renderJsonc(file: string, current: string | undefined, value: unknown): string {
  const text = current === undefined ? "" : withoutMark(current)
  if (!text.trim()) return JSON.stringify(value, null, 2) + "\n"
  const read = parseJsonc(text)
  if (read.problem) throw unparseableError(file, read.problem)
  if (!isRecord(read.value) || !isRecord(value)) return JSON.stringify(value, null, 2) + "\n"
  return editTo(text, value, read.value, []).replace(/\s*$/, "\n")
}
