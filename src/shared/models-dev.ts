/**
 * The models.dev catalog as MCode keeps it: the fields it reads, and the rules
 * MiMo's engine applies to the catalog it downloads.
 *
 * Kept free of imports so scripts/models-snapshot.mjs can load it with Node's
 * own type stripping.
 */

export interface CatalogModel {
  id: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
  /** models.dev's `reasoning_options`: the effort values a model takes, when it says. */
  reasoning_options?: { type: string; values?: string[] }[]
  interleaved?: unknown
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

export interface CatalogProvider {
  id: string
  name?: string
  api?: string
  models: Record<string, CatalogModel>
}

export type Catalog = Record<string, CatalogProvider>

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const numberOr = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)

function pick<T extends object>(entries: [string, unknown][]): T {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as T
}

function trimModel(id: string, raw: Record<string, unknown>): CatalogModel {
  const limit = object(raw.limit) ? pick<NonNullable<CatalogModel["limit"]>>([["context", numberOr(raw.limit.context)], ["output", numberOr(raw.limit.output)]]) : undefined
  const cost = object(raw.cost)
    ? pick<NonNullable<CatalogModel["cost"]>>([
        ["input", numberOr(raw.cost.input)],
        ["output", numberOr(raw.cost.output)],
        ["cache_read", numberOr(raw.cost.cache_read)],
        ["cache_write", numberOr(raw.cost.cache_write)],
      ])
    : undefined
  const input = object(raw.modalities) && Array.isArray(raw.modalities.input) ? raw.modalities.input.filter((entry): entry is string => typeof entry === "string") : undefined
  const options = Array.isArray(raw.reasoning_options)
    ? raw.reasoning_options.filter(object).map((entry) =>
        pick<{ type: string; values?: string[] }>([
          ["type", String(entry.type ?? "")],
          ["values", Array.isArray(entry.values) ? entry.values.filter((value): value is string => typeof value === "string") : undefined],
        ]),
      )
    : undefined
  const flag = (value: unknown) => (typeof value === "boolean" ? value : undefined)
  return pick<CatalogModel>([
    ["id", id],
    ["name", typeof raw.name === "string" ? raw.name : undefined],
    ["attachment", flag(raw.attachment)],
    ["reasoning", flag(raw.reasoning)],
    ["tool_call", flag(raw.tool_call)],
    ["temperature", flag(raw.temperature)],
    ["reasoning_options", options],
    ["interleaved", raw.interleaved === undefined ? undefined : raw.interleaved],
    ["modalities", input ? { input } : undefined],
    ["limit", limit && Object.keys(limit).length ? limit : undefined],
    ["cost", cost && Object.keys(cost).length ? cost : undefined],
  ])
}

/**
 * The catalog with only what MCode reads, or an error when it is not one:
 * MiMo's own validation - every provider and model keyed by its own id, and at
 * least one model somewhere.
 */
export function trimCatalog(raw: unknown): Catalog {
  if (!object(raw)) throw new Error("models.dev catalog is not an object")
  const out: Catalog = {}
  for (const [pid, provider] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
    if (!object(provider) || provider.id !== pid || !object(provider.models)) throw new Error("models.dev provider identity mismatch")
    const models: Record<string, CatalogModel> = {}
    for (const [mid, model] of Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))) {
      if (!object(model) || model.id !== mid) throw new Error("models.dev model identity mismatch")
      models[mid] = trimModel(mid, model)
    }
    out[pid] = pick<CatalogProvider>([
      ["id", pid],
      ["name", typeof provider.name === "string" ? provider.name : undefined],
      ["api", typeof provider.api === "string" ? provider.api : undefined],
      ["models", models],
    ])
  }
  if (!Object.values(out).some((provider) => Object.keys(provider.models).length)) throw new Error("models.dev catalog contains no models")
  return out
}

function merge<T>(base: T, overlay: T): T {
  if (!object(base) || !object(overlay)) return overlay
  const keys = new Set([...Object.keys(base), ...Object.keys(overlay)])
  return Object.fromEntries([...keys].map((key) => [key, overlay[key] === undefined ? base[key] : merge(base[key], overlay[key])])) as T
}

/**
 * The downloaded catalog laid over the shipped one, as MiMo lays them: the
 * download decides which providers and models exist, and the shipped copy only
 * fills in fields the download leaves out.
 */
export function overlayCatalog(base: Catalog, overlay: Catalog): Catalog {
  const out: Catalog = {}
  for (const [pid, provider] of Object.entries(overlay)) {
    const shipped = base[pid]
    const models: Record<string, CatalogModel> = {}
    for (const [mid, model] of Object.entries(provider.models)) models[mid] = shipped?.models[mid] ? merge(shipped.models[mid], model) : model
    out[pid] = { ...(shipped ? merge({ ...shipped, models: {} }, { ...provider, models: {} }) : provider), models }
  }
  return out
}

/**
 * Whether a model id takes images, by MiMo's save-time rule: every catalog
 * entry of that id (compared in lower case, then without a `vendor/` prefix)
 * must agree. Undefined when the catalog does not know the id or disagrees.
 */
export function imageInputOf(catalog: Catalog, modelId: string): boolean | undefined {
  const id = modelId.trim().toLowerCase()
  const candidates = [id, id.split("/").pop() ?? ""].filter(Boolean)
  for (const candidate of candidates) {
    const found: boolean[] = []
    for (const provider of Object.values(catalog)) {
      for (const [mid, model] of Object.entries(provider.models)) {
        if (mid.toLowerCase() === candidate) found.push(Boolean(model.modalities?.input?.includes("image")))
      }
    }
    if (found.length) return found.every(Boolean) ? true : found.every((value) => !value) ? false : undefined
  }
  return undefined
}
