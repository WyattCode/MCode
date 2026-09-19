import { resolveLanguage } from "@shared/locale"

/**
 * The interface language as a locale code: the one chosen in Settings, or the
 * machine's own mapped onto the languages the interface has by the rule the
 * window uses (`systemLanguage`). MiMo takes its reply language from the same
 * place.
 */
export function interfaceLocale(language: string | undefined, system = Intl.DateTimeFormat().resolvedOptions().locale): string {
  return resolveLanguage(language, system)
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
