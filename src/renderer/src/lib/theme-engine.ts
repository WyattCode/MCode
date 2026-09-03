/**
 * Builds a full set of colour tokens from a theme's ten seed colours.
 *
 * A theme file names only a handful of colours - a background, an ink, and one
 * hue each for primary, accent, success, warning, error and info. Everything
 * the interface actually draws with is derived here: twelve-step ramps per hue
 * in OKLCH, then the semantic names mapped onto steps of those ramps.
 *
 * The arithmetic is the reference implementation's, kept step for step. The
 * check that it is faithful is that the built-in OC-2 theme regenerates the
 * app's own default tokens exactly, in both schemes - see theme.spec.
 */

export interface ThemePalette {
  neutral: string
  ink?: string
  primary: string
  accent?: string
  success: string
  warning: string
  error: string
  info: string
  interactive?: string
  diffAdd?: string
  diffDelete?: string
}

export interface ThemeVariant {
  palette: ThemePalette
  overrides?: Record<string, string>
  /*
   * Colours a theme pins outright, bypassing the generator. Two of the shipped
   * themes use it: OC-2, whose values the stylesheet was written from, and
   * Matrix, which wants a flat green ramp no seed would produce.
   */
  v2Overrides?: Record<string, string>
}

export interface Theme {
  id: string
  name: string
  light: ThemeVariant
  dark: ThemeVariant
}

interface Oklch {
  l: number
  c: number
  h: number
}

interface Rgb {
  r: number
  g: number
  b: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const wrapHue = (value: number) => ((value % 360) + 360) % 360

function srgbToLinear(channel: number) {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

function linearToSrgb(channel: number) {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055
}

function hexToRgb(hex: string): Rgb {
  const body = hex.replace("#", "")
  const full =
    body.length === 3 || body.length === 4
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body
  const rgb = full.length === 8 ? full.slice(0, 6) : full
  const value = parseInt(rgb, 16)
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 }
}

function rgbToHex(r: number, g: number, b: number) {
  const channel = (value: number) =>
    Math.round(clamp(value, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

function rgbToOklch(r: number, g: number, b: number): Oklch {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const long = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const medium = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const short = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const lightness = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short
  const bAxis = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short
  return {
    l: lightness,
    c: Math.sqrt(a * a + bAxis * bAxis),
    h: wrapHue(Math.atan2(bAxis, a) * (180 / Math.PI)),
  }
}

function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180)
  const bAxis = c * Math.sin((h * Math.PI) / 180)
  const long = (l + 0.3963377774 * a + 0.2158037573 * bAxis) ** 3
  const medium = (l - 0.1055613458 * a - 0.0638541728 * bAxis) ** 3
  const short = (l - 0.0894841775 * a - 1.291485548 * bAxis) ** 3
  return {
    r: linearToSrgb(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    g: linearToSrgb(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    b: linearToSrgb(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  }
}

/**
 * Pulls a colour back into sRGB by draining its chroma.
 *
 * OKLCH describes colours no monitor can show, and the ramps below reach for
 * them constantly - a saturated seed lightened towards white leaves the gamut
 * long before it gets there. Reducing chroma keeps the hue and the lightness,
 * which is what the eye reads first.
 */
function fitOklch(oklch: Oklch): Oklch {
  const base = { l: clamp(oklch.l, 0, 1), c: Math.max(0, oklch.c), h: wrapHue(oklch.h) }
  const inside = (rgb: Rgb) =>
    rgb.r >= 0 && rgb.r <= 1 && rgb.g >= 0 && rgb.g <= 1 && rgb.b >= 0 && rgb.b <= 1
  if (inside(oklchToRgb(base))) return base

  let chroma = base.c
  for (let step = 0; step < 24; step += 1) {
    chroma *= 0.9
    const next = { ...base, c: chroma }
    if (inside(oklchToRgb(next))) return next
  }
  return { ...base, c: 0 }
}

function hexToOklch(hex: string) {
  const { r, g, b } = hexToRgb(hex)
  return rgbToOklch(r, g, b)
}

function oklchToHex(oklch: Oklch) {
  const { r, g, b } = oklchToRgb(fitOklch(oklch))
  return rgbToHex(r, g, b)
}

/** Moves a colour by a lightness offset, a chroma factor and a hue rotation. */
function shift(hex: string, by: { l?: number; c?: number; h?: number }) {
  const base = hexToOklch(hex)
  return oklchToHex({
    l: base.l + (by.l ?? 0),
    c: base.c * (by.c ?? 1),
    h: base.h + (by.h ?? 0),
  })
}

/** Walks between two colours through OKLCH, taking the shorter way round the hue circle. */
function mixColors(from: string, to: string, amount: number) {
  const a = hexToOklch(from)
  const b = hexToOklch(to)
  const delta = ((((b.h - a.h) % 360) + 540) % 360) - 180
  return oklchToHex({
    l: a.l + (b.l - a.l) * amount,
    c: a.c + (b.c - a.c) * amount,
    h: a.h + delta * amount,
  })
}

/** Lays one colour over another at a given opacity, in plain sRGB. */
function blend(color: string, background: string, alpha: number) {
  const fg = hexToRgb(color)
  const bg = hexToRgb(background)
  return rgbToHex(
    fg.r * alpha + bg.r * (1 - alpha),
    fg.g * alpha + bg.g * (1 - alpha),
    fg.b * alpha + bg.b * (1 - alpha),
  )
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const { r, g, b } = hexToRgb(hex)
    const lift = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * lift(r) + 0.587 * lift(g) + 0.0722 * lift(b)
  }
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * The twelve greys, built from the background and the ink rather than picked.
 *
 * Mixing the two ends means the greys carry the theme's cast: a warm ink over a
 * warm background gives warm greys, which is what stops a themed window from
 * looking like a coloured skin laid over a neutral one.
 */
function neutralScale(seed: string, isDark: boolean, ink?: string) {
  if (ink) {
    const base = hexToOklch(seed)
    const lift = (tone: number) =>
      oklchToHex({
        l: base.l + (1 - base.l) * tone,
        c: base.c * Math.max(0, 1 - tone),
        h: base.h,
      })
    const sink = (tone: number) =>
      oklchToHex({
        l: base.l * (1 - tone),
        c: base.c * Math.max(0, 1 - tone * (isDark ? 0.12 : 0.3)),
        h: base.h,
      })
    const background = isDark
      ? sink(clamp(0.19 + Math.max(0, base.l - 0.12) * 0.33 + base.c * 1.95, 0.17, 0.27))
      : base.l < 0.82
        ? lift(0.86)
        : lift(clamp(0.1 + base.c * 3.2 + Math.max(0, 0.95 - base.l) * 0.35, 0.1, 0.28))
    const steps = isDark
      ? [0, 0.018, 0.039, 0.064, 0.097, 0.143, 0.212, 0.31, 0.46, 0.649, 0.845, 0.984]
      : [0, 0.022, 0.042, 0.068, 0.102, 0.146, 0.208, 0.296, 0.432, 0.61, 0.81, 0.965]
    return steps.map((step) => mixColors(background, ink, step))
  }

  const base = hexToOklch(seed)
  const chroma = Math.min(base.c, isDark ? 0.068 : 0.04)
  const lightness = isDark
    ? [
        0.138, 0.156, 0.178, 0.202, 0.232, 0.272, 0.326, 0.404, clamp(base.l * 0.83, 0.43, 0.55),
        0.596, 0.719, 0.956,
      ]
    : [0.991, 0.979, 0.964, 0.946, 0.931, 0.913, 0.891, 0.83, base.l, 0.617, 0.542, 0.205]
  return lightness.map((l) => oklchToHex({ l, c: chroma, h: base.h }))
}

/**
 * A hue's twelve steps.
 *
 * The top five are fixed light values so that every hue's pale end lands at the
 * same brightness - a row of tinted backgrounds has to read as one row. Below
 * those the seed's own lightness takes over, clamped so a very dark or very
 * pale seed still leaves a usable ramp.
 */
function hueScale(seed: string, isDark: boolean) {
  const base = hexToOklch(seed)
  const boost = isDark ? 1 : 1.05
  const lightness = [
    0.99,
    0.965,
    0.93,
    0.885,
    0.835,
    clamp(base.l, 0.48, 0.72),
    clamp(base.l - 0.07, 0.4, 0.64),
    clamp(base.l - 0.14, 0.32, 0.55),
    clamp(base.l - 0.21, 0.24, 0.46),
    clamp(base.l - 0.28, 0.17, 0.38),
    clamp(base.l - 0.34, 0.12, 0.3),
    clamp(base.l - 0.4, 0.08, 0.22),
  ]
  const chroma = [0.28, 0.48, 0.68, 0.86, 1.02, 1.28, 1.34, 1.28, 1.18, 1.08, 0.98, 0.88]
  return lightness.map((l, index) => oklchToHex({ l, c: base.c * chroma[index] * boost, h: base.h }))
}

const STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]

const HUES = ["grey", "blue", "green", "yellow", "red", "purple", "pink", "orange", "cyan"] as const
type Hue = (typeof HUES)[number]

/*
 * The fixed transparencies. These are the one part of a theme that does not
 * move with the palette: a hover state is a wash of the ink over whatever lies
 * beneath it, and it has to stay that whatever colour the surface is.
 */
const ALPHA: Record<string, string> = {
  "alpha-dark-4": "#0000000a",
  "alpha-dark-8": "#00000014",
  "alpha-dark-10": "#0000001a",
  "alpha-dark-20": "#00000033",
  "alpha-dark-25": "#00000040",
  "alpha-dark-40": "#00000066",
  "alpha-dark-60": "#00000099",
  "alpha-light-6": "#ffffff0f",
  "alpha-light-8": "#ffffff14",
  "alpha-light-10": "#ffffff1a",
  "alpha-light-20": "#ffffff33",
  "alpha-light-25": "#ffffff40",
}

const ref = (name: string) => `var(--v2-${name})`

/**
 * Which step of which ramp each name reads, per scheme.
 *
 * Dark reaches for the high grey numbers because the generated grey ramp is
 * reversed there, so that a step number keeps meaning the same distance from
 * the window fill in either scheme.
 */
function semantics(isDark: boolean): Record<string, string> {
  const grey = (step: number) => ref(`grey-${step}`)
  const hue = (name: Hue, step: number) => ref(`${name}-${step}`)

  return isDark
    ? {
        "background-bg-base": grey(1000),
        "background-bg-deep": grey(1100),
        "background-bg-layer-01": grey(800),
        "background-bg-layer-02": grey(600),
        "background-bg-layer-03": grey(500),
        "background-bg-layer-04": grey(400),
        "background-bg-contrast": grey(700),
        "text-text-accent": hue("blue", 400),
        "background-bg-accent": hue("blue", 600),
        "border-border-focus": hue("blue", 500),
        "border-border-selected": ref("alpha-light-25"),
        "border-border-muted": ref("alpha-light-8"),
        "border-border-base": ref("alpha-light-10"),
        "border-border-strong": ref("alpha-light-20"),
        "overlay-simple-overlay-hover": ref("alpha-light-6"),
        "overlay-simple-overlay-pressed": ref("alpha-light-10"),
        "overlay-simple-overlay-scrim": ref("alpha-dark-60"),
        "state-bg-success": hue("green", 1200),
        "state-fg-success": hue("green", 500),
        "state-bg-warning": hue("yellow", 1200),
        "state-fg-warning": hue("yellow", 500),
        "state-bg-danger": hue("red", 1200),
        "state-fg-danger": hue("red", 500),
        "state-bg-info": hue("blue", 1200),
        "state-fg-info": hue("blue", 500),
      }
    : {
        "background-bg-base": grey(100),
        "background-bg-deep": grey(200),
        "background-bg-layer-01": grey(300),
        "background-bg-layer-02": grey(400),
        "background-bg-layer-03": grey(500),
        "background-bg-layer-04": grey(600),
        "background-bg-contrast": grey(900),
        "text-text-accent": hue("blue", 600),
        "background-bg-accent": hue("blue", 600),
        "border-border-focus": hue("blue", 500),
        "border-border-selected": ref("alpha-dark-25"),
        "border-border-muted": ref("alpha-dark-8"),
        "border-border-base": ref("alpha-dark-10"),
        "border-border-strong": ref("alpha-dark-20"),
        "overlay-simple-overlay-hover": ref("alpha-dark-4"),
        "overlay-simple-overlay-pressed": ref("alpha-dark-8"),
        "overlay-simple-overlay-scrim": ref("alpha-dark-40"),
        "state-bg-success": hue("green", 100),
        "state-fg-success": hue("green", 800),
        "state-bg-warning": hue("yellow", 100),
        "state-fg-warning": hue("yellow", 800),
        "state-bg-danger": hue("red", 100),
        "state-fg-danger": hue("red", 800),
        "state-bg-info": hue("blue", 100),
        "state-fg-info": hue("blue", 800),
      }
}

function readPalette(variant: ThemeVariant) {
  const palette = variant.palette
  return {
    neutral: palette.neutral,
    ink: palette.ink,
    primary: palette.primary,
    accent: palette.accent ?? palette.info,
    success: palette.success,
    warning: palette.warning,
    error: palette.error,
    info: palette.info,
    interactive: palette.interactive ?? palette.primary,
    diffAdd: palette.diffAdd ?? shift(palette.success, { c: 0.55, l: 0.14 }),
    diffDelete: palette.diffDelete ?? palette.error,
  }
}

/** The nine twelve-step ramps a theme's seeds expand into. */
function ramps(variant: ThemeVariant, isDark: boolean): Record<Hue, string[]> {
  const colors = readPalette(variant)
  const grey = neutralScale(colors.neutral, isDark, colors.ink)
  return {
    grey: isDark ? [...grey].reverse() : grey,
    blue: hueScale(colors.interactive, isDark),
    green: hueScale(colors.success, isDark),
    yellow: hueScale(colors.warning, isDark),
    red: hueScale(colors.error, isDark),
    purple: hueScale(colors.accent, isDark),
    pink: hueScale(colors.info, isDark),
    orange: hueScale(shift(colors.warning, { h: -22, l: -0.082, c: 0.94 }), isDark),
    cyan: hueScale(shift(colors.info, { h: -12, l: 0.128, c: 1.12 }), isDark),
  }
}

/**
 * The grey nearest `target` that still clears `minContrast` against `background`.
 *
 * Icons are why this is a search rather than a fixed step: a theme whose
 * background sits near the middle of its own grey ramp would otherwise be given
 * an icon colour that disappears into it.
 */
function pickGrey(grey: string[], background: string, minContrast: number, target: number) {
  const matches = STEPS.filter((_, index) => contrastRatio(grey[index], background) >= minContrast)
  if (!matches.length) return grey[STEPS.indexOf(target)]
  const best = matches.reduce((carry, step) =>
    Math.abs(step - target) < Math.abs(carry - target) ? step : carry,
  )
  return grey[STEPS.indexOf(best)]
}

/**
 * Text and icon colours, taken from the ink rather than from the grey ramp.
 *
 * Body text is the one colour a reader looks at for minutes at a time, so it
 * follows the theme's own ink; the greys are for surfaces, where a slight cast
 * is what makes a theme read as one scheme rather than as a tint laid on top.
 */
function foreground(variant: ThemeVariant, isDark: boolean, grey: string[]) {
  const colors = readPalette(variant)
  const ink = colors.ink ?? colors.neutral
  const tint = hexToOklch(ink)
  const body = shift(ink, {
    l: isDark ? Math.max(0, 0.88 - tint.l) * 0.4 : -Math.max(0, tint.l - 0.18) * 0.24,
    c: isDark ? 1.04 : 1.02,
  })
  const overrides = variant.overrides ?? {}
  const background = grey[STEPS.indexOf(isDark ? 1000 : 100)]

  return {
    "text-text-base": isDark ? blend("#ffffff", body, 0.9) : shift(body, { l: -0.07, c: 1.04 }),
    "text-text-muted": overrides["text-weak"] ?? shift(body, { l: isDark ? -0.11 : 0.11, c: 0.9 }),
    "text-text-faint": shift(body, { l: isDark ? -0.2 : 0.21, c: isDark ? 0.78 : 0.72 }),
    "icon-icon-base": pickGrey(grey, background, 7, isDark ? 400 : 800),
    "icon-icon-muted": pickGrey(grey, background, 3, 600),
  }
}

/**
 * Every colour a theme defines, as flat values.
 *
 * The layers go on in the order the reference stacks them: ramps, then the
 * names that read from them, then the foreground taken from the ink, then
 * whatever the theme pins by hand. A theme that pins its own values - OC-2 and
 * Matrix both do - overrides everything the generator worked out, which is why
 * the pinned layer has to go on last.
 */
function v2Tokens(theme: Theme, isDark: boolean): Record<string, string> {
  const variant = isDark ? theme.dark : theme.light
  const scale = ramps(variant, isDark)

  const flat: Record<string, string> = { ...ALPHA }
  for (const hue of HUES) {
    STEPS.forEach((step, index) => {
      flat[`${hue}-${step}`] = scale[hue][index]
    })
  }
  // Not a step of any ramp: white is white in every theme, and it is what the
  // light scheme fills its own window with.
  flat["grey-50"] = "#ffffff"

  Object.assign(flat, semantics(isDark), foreground(variant, isDark, scale.grey))
  for (const [name, value] of Object.entries(variant.v2Overrides ?? {})) {
    flat[name.replace(/^v2-/, "")] = value
  }

  /*
   * The pinned layer names ramps rather than colours, so values only become
   * colours once every layer is in. Eight-digit hexes come from the theme files
   * themselves, whose alpha is always ff; trimming it keeps the values
   * comparable with what the stylesheet writes by hand.
   */
  const resolve = (value: string, depth = 0): string => {
    const match = /^var\(--v2-([a-z0-9-]+)\)$/.exec(value)
    if (match && depth < 8) return resolve(flat[match[1]] ?? value, depth + 1)
    return /^#[0-9a-f]{8}$/i.test(value) && value.slice(7).toLowerCase() === "ff"
      ? value.slice(0, 7)
      : value
  }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(flat)) out[name] = resolve(value)
  return out
}

/**
 * The app's own token names, filled in from a theme.
 *
 * Only the names this interface draws with: the reference emits a few hundred,
 * most of them for parts it has and this one does not.
 */
const TOKEN_MAP: Record<string, string> = {
  "--surface-raised": "background-bg-base",
  "--surface-base": "background-bg-deep",
  "--surface-raised-hover": "background-bg-layer-01",
  "--surface-menu": "background-bg-layer-01",
  "--surface-layer": "background-bg-layer-02",
  "--surface-layer-02": "background-bg-layer-02",
  "--surface-key": "background-bg-layer-03",
  "--avatar-gray": "background-bg-layer-04",
  "--surface-hover": "overlay-simple-overlay-hover",
  "--surface-selected": "overlay-simple-overlay-pressed",
  "--scrim": "overlay-simple-overlay-scrim",

  "--border-weaker": "border-border-muted",
  "--border-muted": "border-border-muted",
  "--border-weak": "border-border-base",
  "--border-strong": "border-border-strong",
  "--border-selected": "border-border-selected",

  "--text-strong": "text-text-base",
  "--text-base": "text-text-muted",
  "--text-weak": "text-text-faint",
  "--text-weaker": "background-bg-layer-04",
  "--text-accent": "text-text-accent",
  "--text-interactive": "text-text-accent",

  "--icon-base": "icon-icon-base",
  "--icon-weak": "icon-icon-muted",

  "--primary": "background-bg-accent",
  "--interactive": "border-border-focus",
  "--accent": "purple-400",
  "--success": "state-fg-success",
  "--warning": "state-fg-warning",
  "--error": "state-fg-danger",
  "--info": "state-fg-info",
  "--text-success": "state-fg-success",
  "--text-warning": "state-fg-warning",
  "--text-error": "state-fg-danger",
  "--surface-success": "state-bg-success",
  "--surface-critical": "state-bg-danger",
}

export function themeTokens(theme: Theme, isDark: boolean): Record<string, string> {
  const tokens = v2Tokens(theme, isDark)
  const out: Record<string, string> = {}
  for (const [name, source] of Object.entries(TOKEN_MAP)) {
    const value = tokens[source]
    if (value) out[name] = value
  }

  /*
   * The deepest fill, which the reference has no name for: its own window stops
   * at bg-deep, and this one puts a sunken surface below that.
   */
  out["--surface-sunken"] = isDark
    ? blend("#000000", tokens["background-bg-deep"], 0.35)
    : tokens["grey-200"]

  /*
   * Diff fills come from the theme's own diff seeds rather than from success
   * and error: several themes name one green for "passing" and another for an
   * added line, and mixing the two makes a review read like a test report.
   */
  const variant = isDark ? theme.dark : theme.light
  const colors = readPalette(variant)
  const add = hueScale(colors.diffAdd, isDark)
  const remove = hueScale(colors.diffDelete, isDark)
  out["--diff-add"] = add[STEPS.indexOf(isDark ? 500 : 700)]
  out["--diff-delete"] = remove[STEPS.indexOf(isDark ? 500 : 700)]
  const wash = isDark ? 0.18 : 0.14
  const behind = tokens["background-bg-base"]
  out["--surface-diff-add"] = blend(out["--diff-add"], behind, wash)
  out["--surface-diff-delete"] = blend(out["--diff-delete"], behind, wash)
  return out
}

/** Exposed for the check script, which compares whole ramps. */
export const internals = { ramps, v2Tokens, readPalette }
