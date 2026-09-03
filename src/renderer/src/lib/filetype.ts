/**
 * File-type badges for the file tree.
 *
 * Colours are grouped by what a file *is* rather than by extension, so related
 * types read as a family at a glance: config is amber, markup is orange, styles
 * are blue, docs are grey-blue, and so on. The label is the shortest thing that
 * still identifies the type, which at 13px is more legible than a glyph.
 */
export interface FileBadge {
  label: string
  hue: number
  /** Rendered grey rather than tinted - for types with no natural colour. */
  neutral?: boolean
}

const TYPES: Record<string, FileBadge> = {
  // Scripts and languages
  ts: { label: "TS", hue: 210 },
  tsx: { label: "TS", hue: 210 },
  mts: { label: "TS", hue: 210 },
  cts: { label: "TS", hue: 210 },
  js: { label: "JS", hue: 48 },
  jsx: { label: "JS", hue: 48 },
  mjs: { label: "JS", hue: 48 },
  cjs: { label: "JS", hue: 48 },
  vue: { label: "V", hue: 150 },
  svelte: { label: "S", hue: 14 },
  py: { label: "PY", hue: 205 },
  rb: { label: "RB", hue: 0 },
  go: { label: "GO", hue: 190 },
  rs: { label: "RS", hue: 20 },
  java: { label: "JV", hue: 12 },
  kt: { label: "KT", hue: 275 },
  swift: { label: "SW", hue: 18 },
  c: { label: "C", hue: 215 },
  h: { label: "H", hue: 215 },
  cpp: { label: "C+", hue: 215 },
  hpp: { label: "H+", hue: 215 },
  cs: { label: "C#", hue: 270 },
  php: { label: "PHP", hue: 250 },
  lua: { label: "LU", hue: 230 },

  // Shell
  sh: { label: ">_", hue: 120 },
  bash: { label: ">_", hue: 120 },
  zsh: { label: ">_", hue: 120 },
  ps1: { label: ">_", hue: 205 },
  bat: { label: ">_", hue: 205 },
  cmd: { label: ">_", hue: 205 },

  // Config and data
  json: { label: "{}", hue: 45 },
  jsonc: { label: "{}", hue: 45 },
  yml: { label: "YM", hue: 40 },
  yaml: { label: "YM", hue: 40 },
  toml: { label: "TO", hue: 35 },
  ini: { label: "IN", hue: 35 },
  env: { label: "EN", hue: 55 },
  xml: { label: "<>", hue: 25 },
  sql: { label: "SQ", hue: 195 },

  // Markup and style
  html: { label: "<>", hue: 20 },
  htm: { label: "<>", hue: 20 },
  css: { label: "CS", hue: 210 },
  scss: { label: "SC", hue: 330 },
  sass: { label: "SC", hue: 330 },
  less: { label: "LE", hue: 225 },

  // Docs
  md: { label: "MD", hue: 200 },
  mdx: { label: "MD", hue: 200 },
  txt: { label: "TX", hue: 0, neutral: true },
  pdf: { label: "PD", hue: 5 },

  // Assets
  png: { label: "IM", hue: 290 },
  jpg: { label: "IM", hue: 290 },
  jpeg: { label: "IM", hue: 290 },
  gif: { label: "IM", hue: 290 },
  webp: { label: "IM", hue: 290 },
  svg: { label: "SV", hue: 300 },
  ico: { label: "IC", hue: 300 },
  icns: { label: "IC", hue: 300 },
  woff: { label: "FN", hue: 265 },
  woff2: { label: "FN", hue: 265 },
  ttf: { label: "FN", hue: 265 },

  // Archives
  zip: { label: "ZP", hue: 50 },
  gz: { label: "ZP", hue: 50 },
  tar: { label: "ZP", hue: 50 },
  "7z": { label: "ZP", hue: 50 },
  rar: { label: "ZP", hue: 50 },

  // Binaries
  exe: { label: "EX", hue: 0 },
  dll: { label: "DL", hue: 0 },
  lock: { label: "LK", hue: 0, neutral: true },
}

/** Files whose whole name identifies them, extension or not. */
const BY_NAME: Record<string, FileBadge> = {
  dockerfile: { label: "DK", hue: 205 },
  makefile: { label: "MK", hue: 30 },
  license: { label: "LI", hue: 45 },
  "readme.md": { label: "RM", hue: 200 },
  ".gitignore": { label: "GI", hue: 15 },
  ".editorconfig": { label: "EC", hue: 35 },
}

const FALLBACK: FileBadge = { label: "•", hue: 0, neutral: true }

export function fileBadge(name: string): FileBadge {
  const lower = name.toLowerCase()
  const named = BY_NAME[lower]
  if (named) return named

  const dot = lower.lastIndexOf(".")
  if (dot <= 0) return FALLBACK
  return TYPES[lower.slice(dot + 1)] ?? FALLBACK
}

/**
 * Unknown and colourless types stay grey on purpose - tinting everything would
 * make the tree read as a wall of status colours rather than a file list.
 */
export function badgeStyle(badge: FileBadge): Record<string, string> {
  if (badge.neutral) {
    return { color: "var(--text-weaker)", background: "var(--surface-raised-hover)" }
  }
  return {
    color: `hsl(${badge.hue} 62% 68%)`,
    background: `hsl(${badge.hue} 46% 22%)`,
  }
}
