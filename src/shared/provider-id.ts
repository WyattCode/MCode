/**
 * MiMo 26.920's rule for a custom provider's id, used by the models page form,
 * the clone dialog and the backend alike.
 *
 * Trimmed, it must not be empty and must not hold `/` - a model is named
 * `provider/model`, and the first slash splits the two. Anything else goes,
 * uppercase included; what is refused is an id another provider already has,
 * compared without case, so `OpenAI` cannot sit beside `openai`. The names an
 * object's prototype answers to are refused as taken too, because stored
 * credentials and catalogs are keyed by the id.
 */
export type ProviderIdProblem = "empty" | "slash" | "exists"

const RESERVED = new Set(["__proto__", "constructor", "prototype"])

export function providerIdProblem(raw: string, taken: Iterable<string>, allow?: string): ProviderIdProblem | undefined {
  const id = raw.trim()
  if (!id) return "empty"
  if (id.includes("/")) return "slash"
  const lower = id.toLowerCase()
  if (RESERVED.has(lower)) return "exists"
  if (allow !== undefined && allow.toLowerCase() === lower) return undefined
  for (const other of taken) if (other.toLowerCase() === lower) return "exists"
  return undefined
}

/** The i18n key each problem is said with, which is also the backend's error code for it. */
export function providerIdMessageKey(problem: ProviderIdProblem): string {
  if (problem === "empty") return "provider.custom.error.providerID.required"
  if (problem === "slash") return "set.models.providerIdSlash"
  return "provider.custom.error.providerID.exists"
}
