import type { Effort, ModelInfo, ModelRef, ProviderStatus } from "@shared/protocol"

/**
 * Reading the model record the server sends, and the reasoning steps on it.
 *
 * All of it is transcribed from the reference's own model store rather than
 * decided here, because every one of these rules is a rule about a specific
 * model and getting one wrong shows up as a control that does nothing.
 */

/** The record for a session's model, or nothing while the list is still loading. */
export function findModel(providers: readonly ProviderStatus[], ref?: ModelRef): ModelInfo | undefined {
  if (!ref) return undefined
  const provider = providers.find((entry) => entry.id === ref.provider)
  return provider?.models.find((entry) => entry.id === ref.model)
}

/**
 * The step a session is actually running at, given what its model accepts.
 *
 * `resolveModelVariant` (out/renderer/assets/main-8t-QUXax.js @2829318):
 *
 *     if (input.selected === null) return void 0;
 *     if (input.selected && input.variants.includes(input.selected)) return input.selected;
 *     if (input.configured && input.variants.includes(input.configured)) return input.configured;
 *     return void 0;
 *
 * The `configured` arm is not carried over: there, a configured default is a
 * named level that can be shown in place of the session's own; here the head of
 * the menu means "follow the app default" without naming it, and the app
 * default is applied server-side. What matters is the last line - a stored step
 * the model does not take resolves to nothing, and nothing is erased, so
 * leaving a model and coming back brings the step back with it.
 */
export function resolveVariant(variants: readonly Effort[], selected?: Effort): Effort | undefined {
  return selected && variants.includes(selected) ? selected : undefined
}

/**
 * The next step along, with "follow the default" between the last and the first.
 *
 * `cycleModelVariant` (@2829562), minus the same `configured` arm: an empty
 * list changes nothing at all, a step the model does not take starts again at
 * the first, and walking off the end returns to no setting rather than wrapping
 * - unset is not a sixth level, it is the session deferring to the app default,
 * and this is the only way back to it from the keyboard.
 */
export function cycleVariant(variants: readonly Effort[], selected?: Effort): Effort | undefined {
  if (!variants.length) return undefined
  const at = selected ? variants.indexOf(selected) : -1
  if (at === -1) return variants[0]
  return at + 1 >= variants.length ? undefined : variants[at + 1]
}

/**
 * The reference strips "(latest)" out of a model's name and shows it as a tag.
 *
 * `list()` in its model store (@2779029) is
 * `name: m.name.replace("(latest)", "").trim(), latest: m.name.includes("(latest)")`.
 * It is a property of the name the provider gives, not of anything on the wire,
 * so nothing had to be added to the protocol to show it.
 */
export function withoutLatest(name: string): string {
  return name.replace("(latest)", "").trim()
}

export function isLatest(name: string): boolean {
  return name.includes("(latest)")
}
