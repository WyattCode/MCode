/*
 * The home screen's example tasks.
 *
 * MiMo shows three of its own built-in cases once a project is chosen and asks
 * nothing of anyone to do so. MCode used to ask the default model for three
 * that fit the project, which sent the project's folder listing and recent
 * conversation titles off the machine every time the home screen opened; the
 * user chose MiMo's way (2026-09-16), so these three are all there is.
 */

export type SuggestionIcon = "code" | "bug" | "test"

/* An example task on the home screen: its row title, and the request that goes into the box. */
export interface HomeSuggestion {
  title: string
  query: string
  icon: SuggestionIcon
}

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
}
