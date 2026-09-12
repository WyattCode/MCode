/**
 * The app's own mark, in six colourways.
 *
 * One geometry, written once: the settings gallery draws it live and the PNGs
 * the window and the taskbar are given are rasterised from the same string, so
 * the icon a reader picks in the gallery is the icon they get. A second copy
 * of these paths would drift the first time either was touched.
 *
 * The mark is the ribbon M this app has always used. Only the tile under it and
 * the ink of the ribbon change between colourways; the names are proper names
 * and are not translated, the way the theme palettes already are.
 */
export interface AppIconSpec {
  id: string
  /** Shown as-is in every language, like a palette's name. */
  name: string
  /** The tile, top-left to bottom-right. */
  tile: [string, string]
  /** The ribbon, along the same diagonal. */
  ink: [string, string]
}

export const APP_ICONS: AppIconSpec[] = [
  { id: "graphite", name: "Graphite", tile: ["#1e1e22", "#0b0b0d"], ink: ["#e4e9f2", "#8ea4c6"] },
  { id: "paper", name: "Paper", tile: ["#fbfbfc", "#e6e7ea"], ink: ["#3f4654", "#1b1d22"] },
  { id: "indigo", name: "Indigo", tile: ["#2b3570", "#141a3c"], ink: ["#eef1ff", "#a7b4ee"] },
  { id: "moss", name: "Moss", tile: ["#25402f", "#0f1e17"], ink: ["#e8f3ea", "#9cc9a8"] },
  { id: "clay", name: "Clay", tile: ["#7a3a2c", "#3d1b14"], ink: ["#fdece4", "#f0b39a"] },
  { id: "brass", name: "Brass", tile: ["#1e1b14", "#0c0a07"], ink: ["#f6e3b0", "#c69a48"] },
]

export const DEFAULT_APP_ICON = "graphite"

export function appIconByID(id: string): AppIconSpec {
  return APP_ICONS.find((entry) => entry.id === id) ?? APP_ICONS[0]
}

/*
 * The ribbon, in a 120 box: up the left leg, over the first shoulder, down into
 * the middle fold, over the second shoulder and down the right leg. Round caps
 * give it the ends the mark has always had.
 *
 * The fold goes almost as deep as the feet. A shallow one - the first attempt
 * stopped a third of the way down - turns the mark into a lowercase m: it is
 * the depth of the middle, not the arches, that makes an M read as an M.
 */
const RIBBON = "M24 88V56C24 34 33 30 44 30C56 30 60 48 60 80C60 48 64 30 76 30C87 30 96 34 96 56V88"

/**
 * The mark as standalone SVG markup.
 *
 * `size` only sets the box the caller lays out with - the artwork itself is
 * drawn in the 120 grid and scales, so a 34px gallery tile and a 512px icon
 * file are the same drawing rather than two that happen to look alike.
 */
export function appIconSvg(spec: AppIconSpec, size: number): string {
  const id = spec.id
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 120 120">`,
    `<defs>`,
    `<linearGradient id="tile-${id}" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${spec.tile[0]}"/><stop offset="1" stop-color="${spec.tile[1]}"/>`,
    `</linearGradient>`,
    `<linearGradient id="ink-${id}" x1="0.1" y1="0" x2="0.9" y2="1">`,
    `<stop offset="0" stop-color="${spec.ink[0]}"/><stop offset="1" stop-color="${spec.ink[1]}"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="120" height="120" rx="27" fill="url(#tile-${id})"/>`,
    /* The fold: the same ribbon, a shade down and a hair below, so the M has a
       lit edge instead of reading as a flat wire. */
    `<path d="${RIBBON}" transform="translate(0 2.5)" fill="none" stroke="${spec.ink[1]}"`,
    ` stroke-width="15" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>`,
    `<path d="${RIBBON}" fill="none" stroke="url(#ink-${id})"`,
    ` stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>`,
    `</svg>`,
  ].join("")
}
