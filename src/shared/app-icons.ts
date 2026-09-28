/**
 * The app's mark, in seven colourways.
 *
 * Every colourway is generated from the one painted source by
 * scripts/icons.mjs - its ground and the inks the mark's shading is remapped
 * to live there, beside the rest of the drawing - and shipped as files:
 * resources/app-icons/<id>.png for the window, the taskbar and the gallery,
 * resources/app-icons-mac/<id>.png for the Dock. The gallery shows those
 * files, so the tile a reader presses is the icon they get. The names are
 * proper names and are not translated, the way the theme palettes are.
 */
export interface AppIconSpec {
  id: string
  /** Shown as-is in every language, like a palette's name. */
  name: string
}

export const APP_ICONS: AppIconSpec[] = [
  /* First and default: the painted mark as it was drawn. */
  { id: "classic", name: "Classic" },
  { id: "graphite", name: "Graphite" },
  { id: "paper", name: "Paper" },
  { id: "indigo", name: "Indigo" },
  { id: "moss", name: "Moss" },
  { id: "clay", name: "Clay" },
  { id: "brass", name: "Brass" },
]

export const DEFAULT_APP_ICON = "classic"

export function appIconByID(id: string): AppIconSpec {
  return APP_ICONS.find((entry) => entry.id === id) ?? APP_ICONS[0]
}
