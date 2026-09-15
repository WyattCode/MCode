import type { HomeSuggestion, SuggestionIcon } from "@shared/protocol"

/**
 * The home screen's example tasks, remembered per project for this window.
 *
 * The server keeps its own answer too; this holds the pending request as well,
 * so switching the picker back and forth never asks twice. An empty answer is
 * not kept: the model may be connected by the next visit.
 */
const asked = new Map<string, Promise<HomeSuggestion[]>>()

export function rememberedSuggestions(
  directory: string,
  language: string,
  ask: () => Promise<HomeSuggestion[]>,
): Promise<HomeSuggestion[]> {
  const key = `${directory}|${language}`
  const held = asked.get(key)
  if (held) return held
  const pending = ask().catch(() => [] as HomeSuggestion[])
  asked.set(key, pending)
  void pending.then((rows) => {
    if (!rows.length) asked.delete(key)
  })
  return pending
}

/*
 * MCode's own starting points. MiMo's first render already has three cases, so
 * the area is never empty or loading while a project is chosen; these show at
 * once, and the model's rows for the project replace them when they come.
 */
export const STARTER_IDS = ["layout", "bugs", "tests"] as const

const STARTER_ICONS: Record<(typeof STARTER_IDS)[number], SuggestionIcon> = { layout: "code", bugs: "bug", tests: "test" }

export function builtinSuggestions(translate: (key: string) => string): HomeSuggestion[] {
  return STARTER_IDS.map((id) => ({
    title: translate(`home.starter.${id}.title`),
    query: translate(`home.starter.${id}.query`),
    icon: STARTER_ICONS[id],
  }))
}

/* MCode's own 16-unit marks for the rows, stroked in the row's muted colour. */
export const SUGGESTION_ICON_PATHS: Record<SuggestionIcon, string[]> = {
  code: ["M5.5 4.5 2 8l3.5 3.5", "M10.5 4.5 14 8l-3.5 3.5", "M9 3 7 13"],
  bug: [
    "M5.5 6.5a2.5 2.5 0 0 1 5 0V10a2.5 2.5 0 0 1-5 0z",
    "M8 7.5v4",
    "M2.5 8.5h3M10.5 8.5h3M3.5 5l2 1.5M12.5 5l-2 1.5M3.5 12.5l2-1.5M12.5 12.5l-2-1.5",
  ],
  test: ["M6 2.5h4", "M7 2.5v4l-3.5 5.8a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4", "M5 10.5h6"],
  doc: ["M9.5 2h-5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z", "M9.5 2v3h3", "M5.5 8.5h5M5.5 11h3.5"],
  chart: ["M2.5 13.5h11", "M4.5 11V8", "M8 11V4.5", "M11.5 11V6.5"],
  idea: ["M6 12.5h4M6.5 14h3", "M8 2a4 4 0 0 0-2.4 7.2c.5.4.9 1 .9 1.6v.2h3v-.2c0-.6.4-1.2.9-1.6A4 4 0 0 0 8 2z"],
}
