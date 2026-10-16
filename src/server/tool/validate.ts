/**
 * Checks a call's arguments against the schema its tool declares.
 *
 * A model sometimes writes arguments that do not fit - a field left out, a
 * number where a string belongs, JSON cut off mid-object. Handing those to the
 * tool made it fail from somewhere inside, with a message about its own
 * internals, and the transcript showed a red failure for what is really a
 * generation slip the model fixes on its next try. Checked here first, the
 * call is refused before it runs and the model is told exactly what was wrong.
 *
 * Only the parts of JSON Schema the tools actually use are understood: type,
 * required, properties, items and enum. Anything else - anyOf, $ref, formats -
 * is let through rather than guessed at, because refusing a call the schema
 * allows would be worse than missing one it does not. Extra keys are let
 * through for the same reason; the tools ignore them.
 */

type Schema = Record<string, unknown>

/** How many problems the note names before it stops listing. */
const MAX_PROBLEMS = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

function fits(expected: string, value: unknown): boolean {
  const actual = typeOf(value)
  if (expected === "number") return actual === "number" || actual === "integer"
  return actual === expected
}

function schemaTypes(schema: Schema): string[] {
  const declared = schema.type
  return typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared.filter((t): t is string => typeof t === "string") : []
}

function visit(schema: Schema, value: unknown, at: string, problems: string[]): void {
  if (problems.length >= MAX_PROBLEMS) return
  const name = at || "arguments"

  const types = schemaTypes(schema)
  if (types.length && !types.some((type) => fits(type, value))) {
    problems.push(`${name} should be ${types.join(" or ")}, got ${typeOf(value)}`)
    return
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    problems.push(`${name} should be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}, got ${JSON.stringify(value)}`)
    return
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []
    for (const key of required) {
      if (value[key] === undefined) problems.push(`${at ? `${at}.` : ""}${key} is required`)
      if (problems.length >= MAX_PROBLEMS) return
    }
    for (const [key, child] of Object.entries(value)) {
      const rule = properties[key]
      if (child === undefined || !isRecord(rule)) continue
      visit(rule, child, at ? `${at}.${key}` : key, problems)
    }
    return
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    const items = schema.items
    value.forEach((child, index) => visit(items, child, `${name}[${index}]`, problems))
  }
}

/** What is wrong with `input` for `schema`, in words the model can act on; empty when nothing is. */
export function argumentProblems(schema: Schema, input: unknown): string[] {
  const problems: string[] = []
  visit(schema, input, "", problems)
  return problems
}

/**
 * What the model reads back for a refused call.
 *
 * It has to say that nothing ran, so the model does not assume a half-done
 * change, and what to send instead, so the retry is not the same call again.
 */
function parameterSummary(schema?: Schema): string {
  if (!schema || !isRecord(schema)) return ""

  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []
  const entries = Object.entries(properties).slice(0, 12)
  if (!entries.length) return ""

  const parts = entries.map(([name, rule]) => {
    const flags: string[] = []

    if (isRecord(rule)) {
      const types = schemaTypes(rule)
      flags.push(types.length ? types.join(" or ") : "any")

      if (required.includes(name)) flags.push("required")

      if (Array.isArray(rule.enum)) {
        const options = rule.enum.slice(0, 8).map((option) => (typeof option === "string" ? option : JSON.stringify(option)))
        if (options.length) flags.push(`enum: ${options.join("|")}${rule.enum.length > 8 ? "..." : ""}`)
      }
    } else {
      flags.push("any")
    }

    return `${name} (${flags.join(", ")})`
  })

  return `Expected parameters: ${parts.join(", ")}.`
}

export function refusedArgumentsNote(tool: string, problems: string[], schema?: Schema): string {
  const base =
    `The ${tool} call was not run because its arguments did not match the tool's parameters: ` +
    `${problems.join("; ")}. Nothing was changed. Call ${tool} again with arguments that match its parameters.`

  const summary = parameterSummary(schema)
  return summary ? `${base} ${summary}` : base
}
