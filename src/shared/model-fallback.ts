import type { ModelRef, ProviderStatus } from "./protocol"

/**
 * Which model to fall back to when the one in use has gone - its provider
 * removed or disconnected, or the model dropped from the provider's list - as
 * MiMo's desktop picks one: a MiMo Pro model first (an id whose `-`/`/`
 * separated words include both `mimo` and `pro`), otherwise the first model
 * there is. MiMo's next choice, its Smart model, is a mode in MCode rather than
 * a model, so it is not a candidate here.
 *
 * `prefer` names a provider that was just connected: its own models come
 * before everyone else's, since connecting it was a request to use it.
 */
export function fallbackModel(candidates: readonly ModelRef[], prefer?: string): ModelRef | undefined {
  const pro = (ref: ModelRef) => {
    const words = `${ref.provider}/${ref.model}`.split(/[-/]/)
    return words.includes("mimo") && words.includes("pro")
  }
  const preferred = prefer ? candidates.filter((ref) => ref.provider === prefer) : []
  return preferred.find(pro) ?? preferred[0] ?? candidates.find(pro) ?? candidates[0]
}

/**
 * Whether a turn can run on a model: the provider is connected and still lists
 * it. A connected provider that lists nothing at all - a config file that
 * names no models, a list not fetched yet - has nothing to check against, so
 * its models are taken at their word.
 */
export function modelAvailable(providers: readonly ProviderStatus[], ref: ModelRef | undefined): boolean {
  if (!ref?.provider || !ref.model) return false
  const provider = providers.find((entry) => entry.id === ref.provider)
  if (!provider?.configured) return false
  return !provider.models.length || provider.models.some((model) => model.id === ref.model)
}

/** Every model a turn could run on, provider by provider in the order they are listed. */
export function availableModels(providers: readonly ProviderStatus[]): ModelRef[] {
  return providers.filter((entry) => entry.configured).flatMap((entry) => entry.models.map((model) => ({ provider: entry.id, model: model.id })))
}
