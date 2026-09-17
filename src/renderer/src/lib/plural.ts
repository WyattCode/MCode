import { language, t } from "./i18n"

/*
 * A counted string in the reader's language.
 *
 * `t` has no plural selection, so a counted key is stored once per form -
 * `_one`, `_few`, `_many`, `_other`, the forms MiMo's own tables carry, and
 * `_two`, `_zero` for Arabic's dual and zero (every table carries them; the
 * others repeat their `_other`) - and this picks the one the language's rules
 * ask for.
 */
const KEPT = new Set(["zero", "one", "two", "few", "many"])

export function tn(key: string, count: number): string {
  let form = "other"
  try {
    const picked = new Intl.PluralRules(language.value).select(count)
    if (KEPT.has(picked)) form = picked
  } catch {
    // A language tag the runtime does not know keeps `_other`.
  }
  const said = t(`${key}_${form}`, { count })
  // A table without that form says `_other`, rather than the key itself.
  return said === `${key}_${form}` ? t(`${key}_other`, { count }) : said
}
