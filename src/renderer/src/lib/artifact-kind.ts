/*
 * What the artifacts page knows about a file from its name alone: MiMo's three
 * tabs, its per-kind badge colour and glyph, and its short relative time. Kept
 * free of Vue and i18n so the smoke test can run it.
 */

import { extensionOf } from "@shared/artifact-category"

export { artifactCategory, extensionOf, type ArtifactCategory } from "@shared/artifact-category"

/** MiMo's badge kinds, less its mini-app kind, which has no counterpart here. */
export type BadgeKind = "docx" | "pptx" | "xlsx" | "pdf" | "txt" | "web" | "image" | "file"

export interface BadgeStyle {
  kind: BadgeKind
  /** The i18n key of its label. */
  key: string
  /** MiMo's colour, the same in both themes; the tint is it at 12%. */
  fg: string
  /** Lucide glyph paths (ISC licence) on the 24 grid. */
  glyph: string[]
}

const PAGE = "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"
const FOLD = "M14 2v4a2 2 0 0 0 2 2h4"
/*
 * The same page with its bottom-left corner cut away, which is what MiMo's PDF
 * mark is drawn on: a letter sits in the notch rather than beside the lines.
 */
const CORNER_PAGE = "M12 22h6a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v6"

const STYLES: Record<BadgeKind, Omit<BadgeStyle, "kind">> = {
  docx: { key: "art.badge.word", fg: "#2b6cb0", glyph: [PAGE, FOLD, "M10 9H8", "M16 13H8", "M16 17H8"] },
  pptx: { key: "art.badge.ppt", fg: "#c43e1c", glyph: ["M2 3h20", "M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3", "m7 21 5-5 5 5"] },
  xlsx: { key: "art.badge.excel", fg: "#21a366", glyph: [PAGE, FOLD, "M8 13h2", "M14 13h2", "M8 17h2", "M14 17h2"] },
  /* MiMo's PDF mark is the corner-cut page with a serif T standing in the notch, not the lined page. */
  pdf: { key: "art.badge.pdf", fg: "#d93831", glyph: [CORNER_PAGE, FOLD, "M3 16v-2h8v2", "M7 14v8", "M6 22h2"] },
  txt: { key: "art.badge.text", fg: "#4b5563", glyph: [PAGE, FOLD, "M10 9H8", "M16 13H8", "M16 17H8"] },
  web: { key: "art.badge.web", fg: "#2f6fed", glyph: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"] },
  image: { key: "art.badge.image", fg: "#0e9488", glyph: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M11 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0z", "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"] },
  file: { key: "art.badge.file", fg: "#8c8c86", glyph: [PAGE, FOLD] },
}

const KINDS: Record<string, BadgeKind> = {
  doc: "docx",
  docx: "docx",
  ppt: "pptx",
  pptx: "pptx",
  xls: "xlsx",
  xlsx: "xlsx",
  csv: "xlsx",
  pdf: "pdf",
  md: "txt",
  markdown: "txt",
  txt: "txt",
  rtf: "txt",
  html: "web",
  htm: "web",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  avif: "image",
  ico: "image",
}

export function badgeOf(file: string): BadgeStyle {
  const kind = KINDS[extensionOf(file)] ?? "file"
  return { kind, ...STYLES[kind] }
}

export type ArtifactAge =
  | { unit: "just" }
  | { unit: "m" | "h" | "d"; n: number }
  | { unit: "date" }

/** MiMo's tile time, floored: just now, minutes, hours, days under a week, then the date (calendarDate's unpadded Y/M/D). */
export function artifactAge(at: number, now: number): ArtifactAge {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return { unit: "just" }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { unit: "m", n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: "h", n: hours }
  const days = Math.floor(hours / 24)
  if (days < 7) return { unit: "d", n: days }
  return { unit: "date" }
}

/** MiMo's page size for 加载更多. */
export const ARTIFACT_PAGE = 50

/** An artifact's path on disk: the server gives project-relative paths inside the project, absolute ones outside. */
export function artifactAbsolute(directory: string, file: string): string {
  if (/^([A-Za-z]:)?[\\/]/.test(file)) return file
  return `${directory.replace(/[\\/]+$/, "")}/${file}`
}
