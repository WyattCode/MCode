import type { ModelEntry, ProviderKind } from "../provider/catalog"
import { modelVariants } from "../provider/variants"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

/**
 * The models a subagent can be given, with what a choice turns on.
 *
 * The actor tool's `models` action answers with names alone, because that is
 * what its own call needs. A model choosing between them needs more: what a
 * turn will cost, how much it can read, whether it takes a picture, and which
 * reasoning levels it honours. opencode makes that a tool of its own and tells
 * the subagent description to look a model up rather than guess; this is the
 * same surface over this app's catalog.
 *
 * Providers are the connected ones, since naming an unconnected model fails at
 * the subagent call itself. Prices are USD per million tokens, as the catalog
 * states them; zero is "unknown" and is printed as such rather than as free.
 */
export interface ModelsSource {
  providers(): readonly { id: string; name: string; kind: ProviderKind; configured: boolean }[]
  models(provider: string): ModelEntry[]
}

export interface ModelsOptions {
  query?: string
  provider?: string
  vision?: boolean
  limit?: number
}

/** How many models are listed when the call does not say. */
export const MODELS_DEFAULT_LIMIT = 50

/** The most a call may ask for, so one listing cannot flood the reply. */
export const MODELS_MAX_LIMIT = 100

const INPUT_NAMES = ["text", "image", "audio", "video", "pdf"] as const

function costOf(entry: ModelEntry): string {
  return entry.input > 0 || entry.output > 0 ? `$${entry.input}/$${entry.output} per Mtok` : "price unknown"
}

function inputsOf(entry: ModelEntry): string {
  const inputs = entry.inputs ?? {}
  const named = INPUT_NAMES.filter((name) => inputs[name])
  // Every chat model reads text, and a provider that states no modalities has
  // still told us that much, exactly as the composer's picker reads it.
  return named.length ? named.join(", ") : "text"
}

function describe(provider: { id: string; kind: ProviderKind }, entry: ModelEntry): string {
  const variants = modelVariants(provider.kind, entry, provider.id)
  const context = entry.contextWindow > 0 ? `${entry.contextWindow} context` : "context unknown"
  return `${provider.id}/${entry.id} - ${entry.name}; ${costOf(entry)}; ${context}; inputs: ${inputsOf(entry)}; variants: ${variants.length ? variants.join(", ") : "none"}`
}

/** The listing as the model reads it, and the counts the call reports back. */
export function listModels(source: ModelsSource, options: ModelsOptions = {}): { output: string; count: number; total: number } {
  const query = (options.query ?? "").trim().toLowerCase()
  const wanted = (options.provider ?? "").trim().toLowerCase()
  const limit = Math.min(MODELS_MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? MODELS_DEFAULT_LIMIT)))
  const groups: { provider: { id: string; name: string; kind: ProviderKind }; models: ModelEntry[] }[] = []
  let total = 0

  for (const provider of source.providers()) {
    if (!provider.configured) continue
    if (wanted && provider.id.toLowerCase() !== wanted && provider.name.toLowerCase() !== wanted) continue
    const models = source
      .models(provider.id)
      .filter((entry) => {
        if (options.vision === true && !(entry.inputs?.image ?? false)) return false
        if (!query) return true
        return `${provider.id} ${provider.name} ${entry.id} ${entry.name}`.toLowerCase().includes(query)
      })
      .sort((a, b) => a.id.localeCompare(b.id))
    if (!models.length) continue
    total += models.length
    groups.push({ provider, models })
  }

  const lines: string[] = []
  let count = 0
  for (const group of groups) {
    if (count >= limit) break
    const shown = group.models.slice(0, limit - count)
    if (!shown.length) continue
    lines.push(`${group.provider.name} (${group.provider.id})`)
    for (const entry of shown) lines.push(`  ${describe(group.provider, entry)}`)
    count += shown.length
  }

  if (!count) {
    const reason = wanted
      ? `No connected model matches provider "${String(options.provider).trim()}".`
      : options.vision === true
        ? "No connected model reads images."
        : "No models are connected."
    return { output: reason, count: 0, total }
  }

  lines.push("", `Showing ${count} of ${total} connected model(s). Pass one as provider/model in the actor tool's model field.`)
  if (count < total) lines.push(`Raise limit to list the rest (up to ${MODELS_MAX_LIMIT}).`)
  return { output: lines.join("\n"), count, total }
}

export const ModelsTool: ToolDefinition = {
  name: "models",
  description: [
    "List the models the connected providers offer, with what each choice means: price per million tokens, context window, the input types it reads, and the reasoning variants it accepts.",
    "",
    "- query: only models whose id or name contains this text.",
    "- provider: only this provider, by id or name.",
    "- vision: only models that read images.",
    "- limit: at most this many models (default 50, at most 100).",
    "",
    "Use it before naming a model for the actor tool's model field. Never guess a provider/model id: call this tool first and pass one it lists. It also answers which model to choose for a long context, a picture, or a cheaper subagent.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to find in a model's id or name" },
      provider: { type: "string", description: "Only this provider, by id or name" },
      vision: { type: "boolean", description: "Only models that read images" },
      limit: { type: "number", description: "At most this many models (default 50, at most 100)" },
    },
    additionalProperties: false,
  },
  async execute(input, context) {
    const source = context.models
    if (!source) throw new ToolError("The model catalog is not available here.")
    const listed = listModels(source, {
      query: typeof input.query === "string" ? input.query : undefined,
      provider: typeof input.provider === "string" ? input.provider : undefined,
      vision: input.vision === true,
      limit: typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined,
    })
    return {
      output: listed.output,
      title: listed.count === 0 ? "models" : `${listed.count} of ${listed.total} model(s)`,
      metadata: { count: listed.count, total: listed.total },
    }
  },
}
