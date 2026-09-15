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
