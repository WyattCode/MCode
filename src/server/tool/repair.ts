/**
 * Repairing a tool call a model got slightly wrong, the way MiMo's engine does
 * before giving up on it: a name matched exactly, then without case, then with
 * dashes, underscores and spaces ignored (an `mcp__server__tool` name counts
 * as `server_tool`); and argument names that differ from the schema's only in
 * that way - `filePath` for `file_path` - moved onto the schema's own names.
 */

const MCP_NAME = /^mcp__(.+?)__(.+)$/

export function canonicalName(name: string, ignoreCase = true): string {
  const mcp = MCP_NAME.exec(name)
  const collapsed = (mcp ? `${mcp[1]}_${mcp[2]}` : name).replace(/[-_\s]+/g, "")
  return ignoreCase ? collapsed.toLowerCase() : collapsed
}

/** The tool a model meant, among `candidates`, or undefined when none is close enough. */
export function resolveToolName(name: string, candidates: readonly string[]): string | undefined {
  const lower = name.toLowerCase()
  const key = canonicalName(name)
  let byCase: string | undefined
  let byShape: string | undefined
  for (const candidate of candidates) {
    if (candidate === name) return candidate
    if (!byCase && candidate.toLowerCase() === lower) byCase = candidate
    if (!byShape && canonicalName(candidate) === key) byShape = candidate
  }
  return byCase ?? byShape
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function normalizeValue(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value
  if (Array.isArray(value)) return isRecord(schema.items) ? value.map((item) => normalizeValue(item, schema.items)) : value
  return isRecord(value) ? normalizeToolInput(value, schema) : value
}

/** Arguments with their names put onto the schema's own spelling; an exact name always wins over a near one. */
export function normalizeToolInput(input: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const names = Object.keys(properties)
  const branches = ["allOf", "anyOf", "oneOf"].flatMap((key) => (Array.isArray(schema[key]) ? (schema[key] as unknown[]).filter(isRecord) : []))
  if (names.length === 0 && branches.length === 0) return input
  const byShape = new Map(names.map((name) => [canonicalName(name), name]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key in properties) out[key] = normalizeValue(value, properties[key])
  }
  for (const [key, value] of Object.entries(input)) {
    if (key in properties) continue
    const target = byShape.get(canonicalName(key))
    if (target) {
      if (!(target in out)) out[target] = normalizeValue(value, properties[target])
      continue
    }
    out[key] = value
  }
  return branches.reduce<Record<string, unknown>>((result, branch) => normalizeToolInput(result, branch), out)
}

/**
 * A JSON string whose `\u` escapes have been put back together.
 *
 * MiMo's `repairUnicodeEscapes`, which its `parseToolInput` runs after the
 * first `JSON.parse` fails. A model streaming arguments that contain Chinese
 * text, an emoji or an accented path is writing `\uXXXX` by hand, and where it
 * goes wrong is the four hex digits: whitespace lands in the middle of them, or
 * fewer than four arrive. Rewriting the escape from the digits that are there
 * recovers the call instead of refusing it with an `inputError`.
 *
 * A `\\` is left exactly as it was - the second backslash is data, not the
 * start of an escape - and anything else after a backslash is passed through
 * untouched, so `\n` and `\"` are unharmed.
 */
export function repairUnicodeEscapes(input: string): string {
  let out = ""
  let at = 0
  while (at < input.length) {
    const char = input[at]!
    if (char !== "\\") {
      out += char
      at += 1
      continue
    }
    const next = input[at + 1]
    if (next === "\\") {
      out += "\\\\"
      at += 2
      continue
    }
    if (next !== "u") {
      out += char
      at += 1
      continue
    }
    let scan = at + 2
    const hex: string[] = []
    while (scan < input.length && hex.length < 4) {
      const digit = input[scan]!
      if (/[0-9a-fA-F]/.test(digit)) {
        hex.push(digit)
        scan += 1
        continue
      }
      // Whitespace that drifted into the middle of an escape is not part of it.
      if (/\s/.test(digit)) {
        scan += 1
        continue
      }
      break
    }
    if (hex.length === 4) {
      out += `\\u${hex.join("")}`
      at = scan
      continue
    }
    out += char
    at += 1
  }
  return out
}

/**
 * A tool call's arguments, as MiMo's `parseToolInput` reads them: parsed, or
 * parsed again once the `\u` escapes have been repaired, or refused.
 *
 * Shared by the two adapters that assemble arguments out of a stream, which
 * each had their own copy that tried `JSON.parse` exactly once. A failure keeps
 * its sentence rather than quietly becoming `{}`, because the turn refuses the
 * call with it and the model is told what was wrong with what it wrote.
 */
export function parseToolArguments(raw: string | undefined): { input: Record<string, unknown>; inputError?: string } {
  if (!raw?.trim()) return { input: {} }
  const object = (parsed: unknown): { input: Record<string, unknown>; inputError?: string } =>
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { input: parsed as Record<string, unknown> }
      : { input: {}, inputError: "the arguments were not a JSON object" }
  try {
    return object(JSON.parse(raw))
  } catch (err) {
    const repaired = repairUnicodeEscapes(raw)
    if (repaired !== raw) {
      try {
        return object(JSON.parse(repaired))
      } catch {
        // The repair did not help, so the first failure is the one worth reporting.
      }
    }
    return { input: {}, inputError: `the arguments were not valid JSON (${(err as Error).message})` }
  }
}
