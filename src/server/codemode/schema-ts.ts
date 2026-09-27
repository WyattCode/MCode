/**
 * A tool's JSON Schema as the TypeScript type the model reads in Code Mode.
 *
 * Ported from OpenCode v2 (packages/codemode/src/tool-schema.ts, MIT): the
 * same rendering of objects, unions, references and documentation comments,
 * over plain JSON Schema rather than Effect's.
 */
export type JsonSchema = {
  readonly type?: string | readonly string[]
  readonly description?: string
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly items?: JsonSchema
  readonly additionalProperties?: boolean | JsonSchema
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly anyOf?: readonly JsonSchema[]
  readonly oneOf?: readonly JsonSchema[]
  readonly allOf?: readonly JsonSchema[]
  readonly $ref?: string
  readonly $defs?: Readonly<Record<string, JsonSchema>>
  readonly definitions?: Readonly<Record<string, JsonSchema>>
  readonly default?: unknown
  readonly deprecated?: boolean
  readonly format?: string
  readonly minimum?: number
  readonly maximum?: number
  readonly exclusiveMinimum?: number
  readonly exclusiveMaximum?: number
  readonly multipleOf?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly minItems?: number
  readonly maxItems?: number
  readonly uniqueItems?: boolean
}

export const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const renderLiteral = (value: unknown): string => JSON.stringify(value) ?? "unknown"
const renderKey = (name: string): string => (identifierSegment.test(name) ? name : JSON.stringify(name))
const unescapeToken = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~")

const intersection = (members: readonly string[]): string => {
  const concrete = members.filter((member) => member !== "unknown")
  if (concrete.length === 0) return "unknown"
  if (concrete.length === 1) return concrete[0]!
  return concrete.map((member) => (member.includes(" | ") ? `(${member})` : member)).join(" & ")
}

const MAX_RENDER_DEPTH = 8

type RenderContext = { readonly definitions: Readonly<Record<string, JsonSchema>>; readonly pretty: boolean }

const refName = (ref: string): string | undefined => {
  const segment = ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1]
  return segment === undefined ? undefined : unescapeToken(segment)
}

function hasUnresolvedRef(schema: JsonSchema, definitions: Readonly<Record<string, JsonSchema>>, seen: ReadonlySet<string> = new Set(), visited: ReadonlySet<JsonSchema> = new Set()): boolean {
  if (visited.has(schema)) return false
  const nextVisited = new Set([...visited, schema])
  if (schema.$ref !== undefined) {
    const name = refName(schema.$ref)
    if (name === undefined || definitions[name] === undefined || seen.has(name)) return true
    if (hasUnresolvedRef(definitions[name]!, definitions, new Set([...seen, name]), nextVisited)) return true
  }
  return [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items === undefined ? [] : [schema.items]),
    ...(typeof schema.additionalProperties === "object" ? [schema.additionalProperties] : []),
  ].some((item) => hasUnresolvedRef(item, definitions, seen, nextVisited))
}

function docTags(schema: JsonSchema): string[] {
  const tags: string[] = []
  if (schema.deprecated === true) tags.push("@deprecated")
  if (schema.default !== undefined) {
    try {
      const rendered = JSON.stringify(schema.default)
      if (rendered !== undefined) tags.push(`@default ${rendered}`)
    } catch {
      // A default that cannot be written out is left unsaid.
    }
  }
  if (typeof schema.format === "string") tags.push(`@format ${schema.format}`)
  if (schema.type === "integer") tags.push("@integer")
  const numbers = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems"] as const
  for (const key of numbers) if (typeof schema[key] === "number") tags.push(`@${key} ${schema[key]}`)
  if (typeof schema.pattern === "string") tags.push(`@pattern ${schema.pattern}`)
  if (schema.uniqueItems === true) tags.push("@uniqueItems true")
  return tags
}

function docLines(schema: JsonSchema, width: number): string[] {
  const summary = docTags(schema).join(" ")
  const lines = (schema.description ?? "").split("\n").map((line) => line.replace(/\s+$/, ""))
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
  const inline = lines.length === 1 ? `${lines[0]}${lines[0]!.endsWith(".") ? "" : "."} ${summary}` : summary
  return summary && lines.length === 1 && width + inline.length + 7 <= 120 ? [inline] : [...lines, ...(summary ? [summary] : [])]
}

// `*/` is neutralised so a server's schema text cannot close the comment early.
function jsdoc(schema: JsonSchema, pad: string): string {
  const content = docLines(schema, pad.length)
  const types = typeof schema.type === "string" ? [schema.type] : (schema.type ?? [])
  const append = (label: string, child: JsonSchema) => {
    docLines(child, pad.length + label.length + 2).forEach((line, index) => content.push(index === 0 ? `${label}: ${line}` : line ? `  ${line}` : ""))
  }
  if (types.includes("array") && schema.items) append("Each item", schema.items)
  if ((types.includes("object") || schema.properties) && typeof schema.additionalProperties === "object") {
    append(Object.keys(schema.properties ?? {}).length > 0 ? "Each additional value" : "Each value", schema.additionalProperties)
  }
  if (content.length === 0) return ""
  const escaped = content.map((line) => line.replaceAll("*/", "* /"))
  if (escaped.length === 1 && pad.length + escaped[0]!.length + 7 <= 120) return `${pad}/** ${escaped[0]} */\n`
  return `${pad}/**\n${escaped.map((line) => `${pad} *${line === "" ? "" : ` ${line}`}`).join("\n")}\n${pad} */\n`
}

function renderSchema(schema: JsonSchema, ctx: RenderContext, depth = 0, seen: ReadonlySet<string> = new Set()): string {
  if (depth > MAX_RENDER_DEPTH) return "unknown"
  const nested = schema.definitions === undefined && schema.$defs === undefined ? ctx : { ...ctx, definitions: { ...ctx.definitions, ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) } }
  if (schema.$ref) {
    const name = refName(schema.$ref)
    if (!name || !nested.definitions[name] || seen.has(name)) return "unknown"
    return intersection([renderSchema(nested.definitions[name]!, nested, depth, new Set([...seen, name])), renderSchema({ ...schema, $ref: undefined }, nested, depth + 1, seen)])
  }
  if (schema.const !== undefined) return renderLiteral(schema.const)
  if (schema.enum) return schema.enum.map(renderLiteral).join(" | ")
  const alternatives = schema.anyOf ?? schema.oneOf
  if (alternatives) {
    const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen))
    if (members.some((member) => member === "unknown")) return "unknown"
    return intersection([members.join(" | "), renderSchema({ ...schema, anyOf: undefined, oneOf: undefined }, nested, depth + 1, seen)])
  }
  if (schema.allOf) {
    if (schema.allOf.some((item) => hasUnresolvedRef(item, nested.definitions))) return "unknown"
    return intersection([renderSchema({ ...schema, allOf: undefined }, nested, depth + 1, seen), ...schema.allOf.map((item) => renderSchema(item, nested, depth + 1, seen))])
  }
  if (Array.isArray(schema.type)) return schema.type.map((item) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen)).join(" | ")
  if (schema.type === "string") return "string"
  if (schema.type === "number" || schema.type === "integer") return "number"
  if (schema.type === "boolean") return "boolean"
  if (schema.type === "null") return "null"
  if (schema.type === "array") return `Array<${renderSchema(schema.items ?? {}, nested, depth + 1, seen)}>`
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required ?? [])
    const properties = Object.entries(schema.properties ?? {})
    const additional = schema.additionalProperties
    const indexType = additional && typeof additional === "object" ? renderSchema(additional, nested, depth + 1, seen) : undefined
    const field = ([name, value]: readonly [string, JsonSchema]) => `${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}`
    if (!ctx.pretty) {
      const fields = properties.map(field)
      if (indexType !== undefined) fields.push(`[key: string]: ${indexType}`)
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`
    }
    if (properties.length === 0 && indexType === undefined) return "{}"
    const pad = "  ".repeat(depth + 1)
    const lines = properties.map((entry) => `${jsdoc(entry[1], pad)}${pad}${field(entry)},`)
    if (indexType !== undefined) lines.push(`${pad}[key: string]: ${indexType},`)
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`
  }
  return "unknown"
}

export function jsonSchemaToTypeScript(schema: unknown, pretty = false): string {
  try {
    return renderSchema((schema && typeof schema === "object" ? schema : {}) as JsonSchema, { definitions: {}, pretty })
  } catch {
    return "unknown"
  }
}

/** How a tool is called from a script: `tools.server.tool`, or bracketed where a name is not an identifier. */
export function toolExpression(segments: readonly string[]): string {
  return "tools" + segments.map((segment) => (identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`)).join("")
}

/** A tool's one-line signature for the catalog: its call, its input type, and what it resolves to. */
export function toolSignature(segments: readonly string[], inputSchema: unknown, pretty = false): string {
  const input = jsonSchemaToTypeScript(inputSchema, pretty)
  return `${toolExpression(segments)}${input === "{}" ? "()" : `(${input})`}: Promise<string>`
}
