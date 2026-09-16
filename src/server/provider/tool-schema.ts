import type { ModelRef } from "@shared/protocol"

/**
 * A tool's parameter schema as one model family will take it - MiMo's
 * `transform.schema`, the two family arms of it.
 *
 * The schemas MCode writes itself are plain, but an MCP server's are whatever
 * that server wrote, and two families refuse shapes the rest accept:
 *
 * - Gemini (Google's provider, or an id containing `gemini`) wants enum values
 *   as strings, a `required` list that names only declared properties, an
 *   `items` on every array, and no `properties` on a schema that is not an
 *   object. A server that sends `enum: [1, 2]` would otherwise fail the whole
 *   request, not only that tool.
 * - Moonshot's Kimi (a provider or id naming moonshot or kimi) rejects a
 *   `type` beside `anyOf` / `oneOf`; the type is pushed down into each branch
 *   that lacks one instead.
 *
 * Only the request is changed; the tool keeps its schema for validation.
 */

type Node = Record<string, unknown>

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const COMBINERS = ["anyOf", "oneOf", "allOf"] as const

function combines(node: Node): boolean {
  return COMBINERS.some((key) => Array.isArray(node[key]))
}

/** Keys that say a schema describes something, rather than being an empty `{}`. */
const DESCRIBING = [
  "type",
  "properties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "$ref",
  "additionalProperties",
  "patternProperties",
  "required",
  "not",
  "if",
  "then",
  "else",
]

function describes(node: Node): boolean {
  return combines(node) || DESCRIBING.some((key) => key in node)
}

function isGemini(model: ModelRef): boolean {
  return model.provider === "google" || model.model.includes("gemini")
}

function isMoonshot(model: ModelRef): boolean {
  const provider = model.provider.toLowerCase()
  const id = model.model.toLowerCase()
  return ["moonshot", "kimi"].some((mark) => provider.includes(mark) || id.includes(mark))
}

function forGemini(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(forGemini)
  if (!isNode(value)) return value
  const out: Node = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = key === "enum" && Array.isArray(child) ? child.map((entry) => String(entry)) : forGemini(child)
  }
  if (Array.isArray(value.enum) && (out.type === "integer" || out.type === "number")) out.type = "string"
  if (out.type === "object" && isNode(out.properties) && Array.isArray(out.required)) {
    const declared = out.properties
    out.required = out.required.filter((name) => typeof name === "string" && name in declared)
  }
  if (out.type === "array" && !combines(out)) {
    if (out.items == null) out.items = {}
    if (isNode(out.items) && !describes(out.items)) out.items = { ...out.items, type: "string" }
  }
  if (out.type !== undefined && out.type !== "object" && !combines(out)) {
    delete out.properties
    delete out.required
  }
  return out
}

function forMoonshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(forMoonshot)
  if (!isNode(value)) return value
  const out: Node = {}
  for (const [key, child] of Object.entries(value)) out[key] = forMoonshot(child)
  const combiner = (["anyOf", "oneOf"] as const).find((key) => Array.isArray(out[key]))
  if (combiner && "type" in out) {
    const type = out.type
    out[combiner] = (out[combiner] as unknown[]).map((branch) => (isNode(branch) && !("type" in branch) ? { type, ...branch } : branch))
    delete out.type
  }
  return out
}

/** The schema to send for this model; the same object when its family needs nothing. */
export function schemaFor(model: ModelRef, schema: Record<string, unknown>): Record<string, unknown> {
  let out: unknown = schema
  if (isGemini(model)) out = forGemini(out)
  if (isMoonshot(model)) out = forMoonshot(out)
  return out as Record<string, unknown>
}
