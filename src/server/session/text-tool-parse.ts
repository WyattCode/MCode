/**
 * Recovering tool calls a local model wrote as plain text.
 *
 * Small and self-hosted models sometimes emit their tool calls as prose
 * instead of through the provider's structured channel. This parser recognises
 * the handful of shapes that actually appear in the wild and hands back the
 * name and arguments, so the runner can execute them rather than reminding the
 * model and burning another step.
 *
 * Conservative by design: only the shapes listed below are matched, everything
 * else is ignored. Never throws — returns [] when unsure. Does not execute
 * anything from the parsed content.
 */

export type ParsedCall = { name: string; input: Record<string, unknown> }

/** At most this many calls are recovered from one reply. */
const MAX_CALLS = 5

/**
 * Parse tool calls written as text.
 *
 * Supported shapes:
 * 1. Anthropic/MiMo-ish XML: `<function_calls>…<invoke name="edit">…<parameter name="file_path">…</parameter>…</invoke>`
 * 2. JSON tool-call blocks: fenced ```json or bare JSON objects/arrays with
 *    `{ "name": "edit", "arguments": { … } }`, `{ "tool": "edit", "parameters": { … } }`,
 *    or OpenAI-ish `{ "function": { "name": "…", "arguments": "{…}" } }`
 *    (arguments may be a stringified JSON object).
 * 3. Simple line form: `tool_call: edit` followed by a JSON object on the
 *    following lines, or `to=functions.edit` with JSON.
 */
export function parseTextToolCalls(text: string): ParsedCall[] {
  if (!text) return []
  const results: ParsedCall[] = []

  // 1) XML
  try { results.push(...parseXml(text)) } catch { /* ignore */ }

  // 2) JSON
  try { results.push(...parseJson(text)) } catch { /* ignore */ }

  // 3) Line form
  try { results.push(...parseLineForm(text)) } catch { /* ignore */ }

  // Deduplicate by name + canonicalised input, cap at MAX_CALLS. The canonical
  // form is order-insensitive and type-loose (5 and "5" collapse), because the
  // XML parser keeps values as strings where the JSON parser produces numbers -
  // the same logical call must not survive twice and run twice.
  const seen = new Set<string>()
  const unique: ParsedCall[] = []
  for (const call of results) {
    if (!call.name) continue
    const key = `${call.name}\0${canonical(call.input)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(call)
    if (unique.length >= MAX_CALLS) break
  }
  return unique
}

/** A stable textual form of a value: keys sorted, primitives by their string. */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null"
  if (typeof value === "object") {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${key}:${canonical(item)}`).join(",")}}`
  }
  return String(value)
}

/* ------------------------------------------------------------------ XML */

/**
 * `<invoke name="edit"> … <parameter name="file_path">src/a.ts</parameter> … </invoke>`
 *
 * The `<function_calls>` wrapper is optional; bare `<invoke>` tags are matched
 * too. Parameter values are kept as strings unless they parse as JSON.
 */
function parseXml(text: string): ParsedCall[] {
  const calls: ParsedCall[] = []
  const invokeRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi
  let match: RegExpExecArray | null
  while ((match = invokeRe.exec(text))) {
    const name = match[1]
    const body = match[2]
    if (!name) continue
    const input: Record<string, unknown> = {}
    const paramRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi
    let pm: RegExpExecArray | null
    while ((pm = paramRe.exec(body))) {
      const key = pm[1]
      if (!key) continue
      const raw = pm[2].trim()
      // Try JSON first (arrays, objects, numbers, booleans); fall back to string.
      try { input[key] = JSON.parse(raw) } catch { input[key] = raw }
    }
    calls.push({ name, input })
  }
  return calls
}

/* ----------------------------------------------------------------- JSON */

/** Extract candidate JSON values from fenced blocks and bare objects/arrays. */
function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = []
  const seen = new Set<string>()

  // Fenced ```json … ``` blocks.
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(text))) {
    const raw = match[1].trim()
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    try { values.push(JSON.parse(raw)) } catch { /* not valid JSON */ }
  }

  // Bare JSON: scan for `{` or `[` that could start a tool-call object.
  // Only attempt a parse when the first 80 characters hint at a known key,
  // so random braces in prose or code are skipped cheaply.
  const HINT = /"(?:name|tool|function|arguments|parameters|calls|tool_calls|input)"\s*:/
  for (let i = 0; i < text.length && values.length < 20; i++) {
    const ch = text[i]
    if (ch !== "{" && ch !== "[") continue
    const preview = text.slice(i, i + 80)
    if (!HINT.test(preview)) continue
    const end = findMatchingBrace(text, i)
    if (end <= i) continue
    const raw = text.slice(i, end + 1)
    if (seen.has(raw)) continue
    seen.add(raw)
    try { values.push(JSON.parse(raw)) } catch { /* malformed */ }
  }

  return values
}

/** Find the index of the brace/bracket that closes the one at `start`. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (inString) {
      if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === "{" || ch === "[") depth++
    else if (ch === "}" || ch === "]") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function parseJson(text: string): ParsedCall[] {
  const calls: ParsedCall[] = []
  for (const value of extractJsonValues(text)) {
    calls.push(...jsonToCalls(value))
  }
  return calls
}

/** Turn a parsed JSON value into tool calls, recognising the known shapes. */
function jsonToCalls(value: unknown): ParsedCall[] {
  if (Array.isArray(value)) {
    const calls: ParsedCall[] = []
    for (const item of value) calls.push(...jsonToCalls(item))
    return calls
  }
  if (!value || typeof value !== "object") return []
  const obj = value as Record<string, unknown>

  // { "name": "edit", "arguments": { … } }  or  { "name": "edit", "input": { … } }
  if (typeof obj.name === "string" && obj.name) {
    const input = asRecord(obj.arguments ?? obj.input ?? obj.parameters ?? {})
    return [{ name: obj.name, input }]
  }

  // { "tool": "edit", "parameters": { … } }
  if (typeof obj.tool === "string" && obj.tool) {
    const input = asRecord(obj.parameters ?? obj.arguments ?? obj.input ?? {})
    return [{ name: obj.tool, input }]
  }

  // OpenAI-ish: { "function": { "name": "…", "arguments": "{…}" } }
  if (obj.function && typeof obj.function === "object" && !Array.isArray(obj.function)) {
    const fn = obj.function as Record<string, unknown>
    if (typeof fn.name === "string" && fn.name) {
      const input = asRecord(fn.arguments ?? fn.parameters ?? {})
      return [{ name: fn.name, input }]
    }
  }

  // { "tool_calls": [ … ] } wrapper
  if (Array.isArray(obj.tool_calls)) {
    const calls: ParsedCall[] = []
    for (const item of obj.tool_calls) calls.push(...jsonToCalls(item))
    return calls
  }

  return []
}

/** Coerce a value to a plain object; a string is tried as JSON. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* not JSON */ }
    return {}
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

/* ----------------------------------------------------------- Line form */

/**
 * `tool_call: edit` or `to=functions.edit` followed by a JSON object on the
 * next lines (until a blank line or the next such header).
 */
function parseLineForm(text: string): ParsedCall[] {
  const calls: ParsedCall[] = []
  const lines = text.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let name: string | undefined

    const tcMatch = /^tool_call:\s*(\S+)/i.exec(line)
    if (tcMatch) name = tcMatch[1]

    if (!name) {
      const fnMatch = /^to=functions\.(\S+)/i.exec(line)
      if (fnMatch) name = fnMatch[1]
    }

    if (!name) continue

    // Collect following lines until a blank line or the next header.
    const jsonLines: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim()
      if (!next || /^tool_call:/i.test(next) || /^to=functions\./i.test(next)) break
      jsonLines.push(lines[j])
    }

    if (!jsonLines.length) continue
    try {
      const parsed = JSON.parse(jsonLines.join("\n").trim())
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        calls.push({ name, input: parsed as Record<string, unknown> })
      }
    } catch { /* not valid JSON */ }
  }

  return calls
}
