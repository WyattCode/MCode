import { LANGUAGE_IDS } from "../tool/desktop-settings"

/**
 * The interface language as a locale code: the one chosen in Settings, or the
 * machine's own mapped onto the languages the interface has - Chinese by
 * region and script, a language the interface has by its first tag, English
 * otherwise. MiMo takes its reply language from the same place.
 */
export function interfaceLocale(language: string | undefined, system = Intl.DateTimeFormat().resolvedOptions().locale): string {
  if (language && language !== "system" && (LANGUAGE_IDS as readonly string[]).includes(language)) return language
  const lower = system.toLowerCase()
  const primary = lower.split(/[-_]/)[0] ?? ""
  if (primary === "zh") return /-(?:hk|tw|mo)\b|hant/.test(lower) ? "zh-TW" : "zh-CN"
  if (primary === "pt") return "pt-BR"
  if (primary === "no" || primary === "nn") return "nb"
  const found = LANGUAGE_IDS.find((id) => id.toLowerCase() === primary)
  return found ?? "en"
}

/** A locale's name in its own language and in English, as a model reads it best: "zh-CN (中文（中国） / Chinese (China))". */
export function localeName(locale: string): string {
  const named = (display: string) => {
    try {
      return new Intl.DisplayNames([display], { type: "language" }).of(locale) ?? locale
    } catch {
      return locale
    }
  }
  const own = named(locale)
  const english = named("en")
  return own === english ? `${locale} (${english})` : `${locale} (${own} / ${english})`
}
