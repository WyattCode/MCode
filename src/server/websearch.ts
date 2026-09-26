import type { WebSearchProviderID, WebSearchSelection } from "@shared/protocol"

/**
 * OpenCode v2's web search (packages/core/src/websearch.ts and
 * plugin/websearch/*, MIT): five search services, each usable without a key,
 * each taking one from its own environment variable when the user has set it.
 *
 * "auto" is v2's "random": a conversation keeps the service it was first given,
 * and a service that answers 429 is set aside for as long as it asked and the
 * next one tried. A named service is used alone, and its errors are reported
 * as they are.
 */
export interface WebSearchResult {
  url: string
  title?: string
  content?: string
  /** Milliseconds since the epoch, when the service said. */
  published?: number
}

interface Provider {
  id: WebSearchProviderID
  name: string
  /** The environment variable a key is read from; the service is used without one otherwise. */
  env: string
  search(query: string, key: string | undefined, signal: AbortSignal): Promise<WebSearchResult[]>
}

/** Where each service is reached. A check points them at a local stand-in. */
export const WEB_SEARCH_ENDPOINTS: Record<WebSearchProviderID, string> = {
  exa: "https://mcp.exa.ai/mcp",
  firecrawl: "https://mcp.firecrawl.dev/v2/mcp",
  parallel: "https://search.parallel.ai/mcp",
  tavily: "https://api.tavily.com/search",
  tinyfish: "https://agent.tinyfish.ai/mcp",
}

const USER_AGENT = "mcode"
const TIMEOUT_MS = 25_000
const MAX_RESPONSE_BYTES = 256 * 1024
const DEFAULT_COOLDOWN_MS = 60_000

/** A service's HTTP refusal, with what the tool tells the model about it. */
export class WebSearchHttpError extends Error {
  constructor(
    readonly provider: WebSearchProviderID,
    readonly status: number,
    readonly retryAfter: string | undefined,
  ) {
    super(`${provider} answered HTTP ${status}`)
  }
}

async function textWithin(response: Response, limit: number): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new Error(`the search response exceeded ${limit} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function post(provider: WebSearchProviderID, url: string, body: unknown, headers: Record<string, string>, accept: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept, "User-Agent": USER_AGENT, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new WebSearchHttpError(provider, response.status, response.headers.get("retry-after") ?? undefined)
  }
  return textWithin(response, MAX_RESPONSE_BYTES)
}

/** The `result` of a JSON-RPC answer, sent as plain JSON or as server-sent events (v2 WebSearchMcp.parseResponse). */
export function mcpResult(body: string): Record<string, unknown> | undefined {
  const parse = (payload: string) => {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    try {
      const result = (JSON.parse(trimmed) as { result?: unknown }).result
      return result && typeof result === "object" ? (result as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  const direct = parse(body)
  if (direct) return direct
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = parse(line.slice(6))
    if (data) return data
  }
  return undefined
}

/** One MCP tool call over plain HTTP, the way v2 reaches the services that speak MCP. */
async function mcpCall(provider: WebSearchProviderID, url: string, tool: string, args: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal) {
  const body = await post(provider, url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, headers, "application/json, text/event-stream", signal)
  return mcpResult(body)
}

const firstText = (result: Record<string, unknown> | undefined): string | undefined =>
  Array.isArray(result?.content) ? (result.content as { text?: unknown }[]).find((item) => typeof item?.text === "string" && item.text)?.text as string | undefined : undefined

const parseJson = <T>(text: string | undefined): T | undefined => {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

const when = (text: string | null | undefined): number | undefined => {
  if (!text || text === "N/A") return undefined
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : undefined
}

const nonEmpty = (text: unknown): string | undefined => (typeof text === "string" && text.trim() ? text : undefined)

/** Exa's plain-text answer: blocks split by a rule, each with URL, Title, Published and its text (v2 exa.ts). */
export function exaResults(text: string): WebSearchResult[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    if (!url) return []
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const published = when(block.match(/^Published:\s*(.+)$/m)?.[1]?.trim())
    const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim()
    return [{ url, ...(title && title !== "N/A" ? { title } : {}), ...(content ? { content } : {}), ...(published !== undefined ? { published } : {}) }]
  })
}

export const WEB_SEARCH_PROVIDERS: readonly Provider[] = [
  {
    id: "exa",
    name: "Exa",
    env: "EXA_API_KEY",
    async search(query, key, signal) {
      const url = new URL(WEB_SEARCH_ENDPOINTS.exa)
      if (key) url.searchParams.set("exaApiKey", key)
      const text = firstText(await mcpCall("exa", url.toString(), "web_search_exa", { query, numResults: 8 }, {}, signal))
      return text ? exaResults(text) : []
    },
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    env: "FIRECRAWL_API_KEY",
    async search(query, key, signal) {
      const text = firstText(await mcpCall("firecrawl", WEB_SEARCH_ENDPOINTS.firecrawl, "firecrawl_search", { query, limit: 8 }, key ? { Authorization: `Bearer ${key}` } : {}, signal))
      const found = parseJson<{ data?: { web?: { url?: unknown; title?: unknown; description?: unknown }[] } }>(text)
      return (found?.data?.web ?? []).flatMap((item) =>
        typeof item.url === "string" ? [{ url: item.url, ...(nonEmpty(item.title) ? { title: item.title as string } : {}), ...(nonEmpty(item.description) ? { content: item.description as string } : {}) }] : [],
      )
    },
  },
  {
    id: "parallel",
    name: "Parallel",
    env: "PARALLEL_API_KEY",
    async search(query, key, signal) {
      const result = await mcpCall("parallel", WEB_SEARCH_ENDPOINTS.parallel, "web_search", { objective: query, search_queries: [query] }, key ? { Authorization: `Bearer ${key}` } : {}, signal)
      const found = result?.structuredContent as { results?: { url?: unknown; title?: unknown; publish_date?: unknown; excerpts?: unknown }[] } | undefined
      return (found?.results ?? []).flatMap((item) => {
        if (typeof item.url !== "string") return []
        const excerpts = Array.isArray(item.excerpts) ? item.excerpts.filter((entry): entry is string => typeof entry === "string") : []
        const published = when(typeof item.publish_date === "string" ? item.publish_date : undefined)
        return [{ url: item.url, ...(nonEmpty(item.title) ? { title: item.title as string } : {}), ...(excerpts.length ? { content: excerpts.join("\n\n") } : {}), ...(published !== undefined ? { published } : {}) }]
      })
    },
  },
  {
    id: "tavily",
    name: "Tavily",
    env: "TAVILY_API_KEY",
    async search(query, key, signal) {
      const body = await post(
        "tavily",
        WEB_SEARCH_ENDPOINTS.tavily,
        { query, search_depth: "basic", chunks_per_source: 3, max_results: 8 },
        key ? { Authorization: `Bearer ${key}` } : { "X-Tavily-Access-Mode": "keyless" },
        "application/json",
        signal,
      )
      const found = parseJson<{ results?: { url?: unknown; title?: unknown; content?: unknown }[] }>(body)
      return (found?.results ?? []).flatMap((item) =>
        typeof item.url === "string" ? [{ url: item.url, ...(nonEmpty(item.title) ? { title: item.title as string } : {}), ...(nonEmpty(item.content) ? { content: item.content as string } : {}) }] : [],
      )
    },
  },
  {
    id: "tinyfish",
    name: "TinyFish",
    env: "TINYFISH_API_KEY",
    async search(query, key, signal) {
      const text = firstText(await mcpCall("tinyfish", WEB_SEARCH_ENDPOINTS.tinyfish, "search", { query }, key ? { "X-API-Key": key } : { "X-TinyFish-Access-Mode": "keyless" }, signal))
      const found = parseJson<{ results?: { url?: unknown; title?: unknown; snippet?: unknown }[] }>(text)
      return (found?.results ?? []).flatMap((item) =>
        typeof item.url === "string" ? [{ url: item.url, ...(nonEmpty(item.title) ? { title: item.title as string } : {}), ...(nonEmpty(item.snippet) ? { content: item.snippet as string } : {}) }] : [],
      )
    },
  },
]

export function webSearchProvider(id: string): Provider | undefined {
  return WEB_SEARCH_PROVIDERS.find((provider) => provider.id === id)
}

/** How long a 429 sets a service aside: its retry-after, in seconds or as a date, else a minute (v2 cooldownMillis). */
export function cooldownMillis(value: string | undefined, now: number): number {
  if (!value?.trim()) return DEFAULT_COOLDOWN_MS
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : DEFAULT_COOLDOWN_MS
}

const cooldowns = new Map<WebSearchProviderID, { until: number; error: WebSearchHttpError }>()
const affinity = new Map<string, WebSearchProviderID>()

/** Forgets which service each conversation had and which were set aside; for the checks. */
export function resetWebSearch(): void {
  cooldowns.clear()
  affinity.clear()
}

/** The next service for an "auto" search: the conversation's own unless it is set aside or tried, else a random other. */
function nextAuto(sessionID: string, now: number, attempted: Set<WebSearchProviderID>, random: () => number): Provider | undefined {
  for (const [id, cooldown] of cooldowns) if (cooldown.until <= now) cooldowns.delete(id)
  const current = webSearchProvider(affinity.get(sessionID) ?? "")
  if (current && !cooldowns.has(current.id) && !attempted.has(current.id)) return current
  const available = WEB_SEARCH_PROVIDERS.filter((provider) => !cooldowns.has(provider.id) && !attempted.has(provider.id))
  const chosen = available[Math.floor(random() * available.length)]
  if (chosen) affinity.set(sessionID, chosen.id)
  return chosen
}

/**
 * Searches with the chosen service, or for "auto" with the conversation's own
 * and then the others while each answers 429. The environment is read at the
 * call, so a key set later is used without a restart.
 */
export async function searchWeb(
  query: string,
  options: {
    selection: Exclude<WebSearchSelection, false>
    sessionID: string
    signal: AbortSignal
    env?: Record<string, string | undefined>
    now?: () => number
    random?: () => number
    onProvider?: (provider: { id: WebSearchProviderID; name: string }) => void
  },
): Promise<{ provider: WebSearchProviderID; results: WebSearchResult[] }> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const keyOf = (provider: Provider) => env[provider.env]?.trim() || undefined
  if (options.selection !== "auto") {
    const provider = webSearchProvider(options.selection)
    if (!provider) throw new Error(`Unknown web search provider: ${options.selection}`)
    options.onProvider?.({ id: provider.id, name: provider.name })
    return { provider: provider.id, results: await provider.search(query, keyOf(provider), options.signal) }
  }
  const attempted = new Set<WebSearchProviderID>()
  let last: WebSearchHttpError | undefined
  for (;;) {
    const provider = nextAuto(options.sessionID, now(), attempted, options.random ?? Math.random)
    if (!provider) throw last ?? [...cooldowns.values()][0]?.error ?? new Error("Every web search provider is rate limited")
    attempted.add(provider.id)
    options.onProvider?.({ id: provider.id, name: provider.name })
    try {
      return { provider: provider.id, results: await provider.search(query, keyOf(provider), options.signal) }
    } catch (error) {
      if (!(error instanceof WebSearchHttpError) || error.status !== 429) throw error
      cooldowns.set(provider.id, { until: now() + cooldownMillis(error.retryAfter, now()), error })
      last = error
    }
  }
}

/** The results as the model reads them (v2 tool/plugin/websearch.ts). */
export function webSearchText(results: readonly WebSearchResult[]): string {
  if (results.length === 0) return NO_RESULTS
  return results
    .map((result) => {
      const published = result.published !== undefined ? `\nPublished: ${new Date(result.published).toISOString()}` : ""
      return `## [${result.title ?? result.url}](${result.url})${published}${result.content ? `\n\n${result.content}` : ""}`
    })
    .join("\n\n")
}

export const NO_RESULTS = "No search results found. Please try a different query."
