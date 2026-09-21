/** MCode's interface languages, as the settings page lists them; `system` (no choice) follows the machine. */
export const LANGUAGE_IDS = [
  "zh-CN", "zh-TW", "en", "ar", "bs", "da", "de", "es", "fr", "ja", "ko", "nb", "pl", "pt-BR", "ru", "th", "tr", "uk",
] as const

export type LanguageId = (typeof LANGUAGE_IDS)[number]

/** Subtags that make a Chinese locale Traditional: Hong Kong, Taiwan, Macau, or the script itself (MiMo's `WC`). */
const TRADITIONAL = new Set(["hk", "tw", "mo", "hant"])

/** Primary tags that name a language by another code than the table's. */
const ALIASES: Record<string, LanguageId> = { pt: "pt-BR", no: "nb", nn: "nb", nb: "nb" }

/**
 * The machine's locale mapped onto the languages the interface has.
 *
 * MiMo's rule: Chinese by region and script, the rest by the first subtag,
 * English otherwise. MCode has one Traditional table where MiMo has two, so Hong
 * Kong lands on zh-TW with Taiwan and Macau; and Norwegian is `nb` whether the
 * machine says no, nb or nn. The window and the backend both call this, so the
 * interface and the reply language cannot disagree about the same machine.
 */
export function systemLanguage(tag: string | undefined): LanguageId {
  const parts = (tag ?? "").trim().toLowerCase().replace(/_/g, "-").split("-")
  const primary = parts[0] ?? ""
  if (primary === "zh") return parts.slice(1).some((part) => TRADITIONAL.has(part)) ? "zh-TW" : "zh-CN"
  const alias = ALIASES[primary]
  if (alias) return alias
  return LANGUAGE_IDS.find((id) => id === primary) ?? "en"
}

/** A choice from Settings when it names a table, the machine's language when it does not. */
export function resolveLanguage(choice: string | undefined, system: string | undefined): LanguageId {
  if (choice && (LANGUAGE_IDS as readonly string[]).includes(choice)) return choice as LanguageId
  return systemLanguage(system)
}
