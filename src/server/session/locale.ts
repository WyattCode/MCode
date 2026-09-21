import { resolveLanguage } from "@shared/locale"

/*
 * The machine's locale, handed over by the main process from `app.getLocale()`
 * - the window reads the same value - so the reply language and the interface
 * come from one source, as MiMo's do. The process's own Intl default is the
 * region format rather than the display language, and is only the fallback for
 * a backend running without Electron.
 */
let machine: string | undefined

export function setMachineLocale(tag: string): void {
  machine = tag || undefined
}

export function machineLocale(): string {
  return machine ?? Intl.DateTimeFormat().resolvedOptions().locale
}

/**
 * The interface language as a locale code: the one chosen in Settings, or the
 * machine's own mapped onto the languages the interface has by the rule the
 * window uses (`systemLanguage`). MiMo takes its reply language from the same
 * place.
 */
export function interfaceLocale(language: string | undefined, system = machineLocale()): string {
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
