/**
 * The Code Mode catalog: which tools a script can call, as the model is told
 * of them, and the `search` a script uses for the ones not listed.
 *
 * Ported from OpenCode v2 (core/src/codemode/catalog.ts and instructions.ts,
 * codemode/src/tool-runtime.ts, MIT): every server stays named, and full
 * listings are taken one per server per round, shortest first, until about
 * 2,000 tokens are spent; past that, `search` finds the rest.
 */
import { toolExpression, toolSignature } from "./schema-ts"

export interface CatalogTool {
  /** The server, then the tool's own name: `tools[server][tool]`. */
  segments: [string, string]
  description: string
  inputSchema: unknown
}

export interface Listing {
  path: string
  line: string
}

export interface NamespaceSummary {
  name: string
  count: number
  entries: Listing[]
}

export interface CatalogSummary {
  total: number
  shown: number
  namespaces: NamespaceSummary[]
}

const DESCRIPTION_LIMIT = 120
const CHARACTERS_PER_TOKEN = 4
const INLINE_BUDGET = 2_000

const pathOf = (tool: CatalogTool) => tool.segments.join(".")
const cost = (text: string) => Math.round(text.length / CHARACTERS_PER_TOKEN)
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

function firstLine(description: string): string {
  const line = description.split("\n", 1)[0]?.trim() ?? ""
  return line.length > DESCRIPTION_LIMIT ? line.slice(0, DESCRIPTION_LIMIT - 3) + "..." : line
}

export function namespaceLine(namespace: NamespaceSummary): string {
  const count = namespace.count === 1 ? "1 tool" : `${namespace.count} tools`
  const label = namespace.entries.length === namespace.count ? count : namespace.entries.length === 0 ? `${count}, none shown` : `${count}, ${namespace.entries.length} shown`
  return `- ${namespace.name} (${label})`
}

export function summarize(tools: readonly CatalogTool[], budget = INLINE_BUDGET): CatalogSummary {
  const groups = new Map<string, CatalogTool[]>()
  for (const tool of tools) groups.set(tool.segments[0], [...(groups.get(tool.segments[0]) ?? []), tool])
  const namespaces = [...groups]
    .sort(([left], [right]) => compare(left, right))
    .map(([name, entries]) => {
      const listings = entries
        .map((tool) => {
          const description = firstLine(tool.description)
          return { path: pathOf(tool), line: `  - ${toolSignature(tool.segments, tool.inputSchema, true)}${description ? ` // ${description}` : ""}` }
        })
        .sort((left, right) => compare(left.path, right.path))
      const order = listings.map((listing) => ({ listing, cost: cost(listing.line) })).sort((left, right) => left.cost - right.cost || compare(left.listing.path, right.listing.path))
      return { name, listings, order, selected: new Set<Listing>(), at: 0 }
    })
  let remaining = budget - namespaces.reduce((total, namespace) => total + cost(namespaceLine({ name: namespace.name, count: namespace.listings.length, entries: [] })), 0)
  const active = new Set(namespaces)
  while (active.size > 0) {
    for (const namespace of active) {
      const candidate = namespace.order[namespace.at]
      if (!candidate || candidate.cost > remaining) {
        active.delete(namespace)
        continue
      }
      namespace.selected.add(candidate.listing)
      namespace.at += 1
      remaining -= candidate.cost
      if (namespace.at === namespace.order.length) active.delete(namespace)
    }
  }
  const summaries = namespaces.map((namespace) => ({
    name: namespace.name,
    count: namespace.listings.length,
    entries: namespace.listings.filter((listing) => namespace.selected.has(listing)),
  }))
  return { total: tools.length, shown: summaries.reduce((total, namespace) => total + namespace.entries.length, 0), namespaces: summaries }
}

export const SEARCH_SIGNATURE = "search(input?: { query?: string; namespace?: string; limit?: number; offset?: number }): { items: Array<{ path: string; description: string; signature: string }>; remaining: number; next: { offset: number } | null }"

/** v2's `# Code Mode` instructions and the catalog, carried on the execute tool's description. */
export function renderCatalog(summary: CatalogSummary): string {
  const more = summary.shown < summary.total
  const head = [
    "# Code Mode",
    "",
    `Use the \`execute\` tool to call the tools listed below. They cannot be called directly${more ? ", and neither can `search`. Both" : ". They"} only work inside code you pass to \`execute\`.`,
    "",
    more
      ? `The catalog is partial. Inside \`execute\`, use \`search(...)\` to find a tool, then call it by the \`path\` in the result. \`search\` is synchronous. Call it without \`await\`; it does not return a Promise. Do not guess tool names.\n\n- ${SEARCH_SIGNATURE}`
      : "The catalog is complete. Do not guess tool names.",
    "",
    "## Available tools",
    "",
  ].join("\n")
  const lines = summary.namespaces.flatMap((namespace) => [namespaceLine(namespace), ...namespace.entries.map((entry) => entry.line)])
  return head + lines.join("\n")
}

const tokenize = (query: string): string[] =>
  query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*")

const termForms = (term: string): string[] => {
  const forms = [term]
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2))
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1))
  return forms
}

function searchText(tool: CatalogTool): string {
  const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {}
  return [pathOf(tool), tool.description, ...Object.entries(properties).flatMap(([name, value]) => (value?.description ? [name, value.description] : [name]))].join("\n").toLowerCase()
}

function rank(tools: readonly CatalogTool[], query: string): CatalogTool[] {
  const terms = tokenize(query).map(termForms)
  return tools
    .map((tool) => {
      const path = pathOf(tool).toLowerCase()
      const words = tokenize(pathOf(tool))
      const description = tool.description.toLowerCase()
      const text = searchText(tool)
      const score = terms.reduce(
        (total, forms) =>
          total +
          (forms.some((form) => path === form || path.endsWith(`.${form}`)) ? 20 : 0) +
          (forms.some((form) => words.includes(form)) ? 12 : 0) +
          (forms.some((form) => path.includes(form)) ? 8 : 0) +
          (forms.some((form) => description.includes(form)) ? 4 : 0) +
          (forms.some((form) => text.includes(form)) ? 2 : 0),
        0,
      )
      return { tool, score }
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || compare(pathOf(left.tool), pathOf(right.tool)))
    .map(({ tool }) => tool)
}

/** v2's `search`: an exact path or call expression first, then ranked matches, a page at a time. */
export function searchCatalog(tools: readonly CatalogTool[], input: { query?: unknown; namespace?: unknown; limit?: unknown; offset?: unknown } = {}) {
  const query = typeof input.query === "string" ? input.query : ""
  const offset = typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0
  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 10
  let namespace = typeof input.namespace === "string" ? input.namespace : undefined
  if (namespace === "tools") namespace = undefined
  else if (namespace?.startsWith("tools.")) namespace = namespace.slice("tools.".length)
  const scoped = namespace === undefined ? tools : tools.filter((tool) => pathOf(tool) === namespace || pathOf(tool).startsWith(`${namespace}.`))
  const trimmed = query.trim()
  const pathQuery = trimmed.startsWith("tools.") ? trimmed.slice("tools.".length) : trimmed
  const exact = pathQuery === "" ? undefined : scoped.find((tool) => pathOf(tool) === pathQuery || toolExpression(tool.segments) === trimmed)
  const ranked = exact ? [exact] : rank(scoped, query)
  const items = ranked.slice(offset, offset + limit).map((tool) => ({
    path: toolExpression(tool.segments),
    description: tool.description,
    signature: toolSignature(tool.segments, tool.inputSchema, true),
  }))
  const remaining = Math.max(0, ranked.length - offset - items.length)
  return { items, remaining, next: remaining > 0 ? { offset: offset + items.length } : null }
}

