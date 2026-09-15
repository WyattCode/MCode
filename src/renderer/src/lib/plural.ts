import { language, t } from "./i18n"

/*
 * A counted string in the reader's language.
 *
 * `t` has no plural selection, so a counted key is stored once per form -
 * `_one`, `_few`, `_many`, `_other`, the forms MiMo's own tables carry - and
 * this picks the one the language's rules ask for. A form no table keeps
 * (zero, two) reads as `_other`.
 */
const KEPT = new Set(["one", "few", "many"])

export function tn(key: string, count: number): string {
  let form = "other"
  try {
    const picked = new Intl.PluralRules(language.value).select(count)
    if (KEPT.has(picked)) form = picked
  } catch {
    // A language tag the runtime does not know keeps `_other`.
  }
  return t(`${key}_${form}`, { count })
}
