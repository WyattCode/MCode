/*
 * MiMo's fidelity pass over docx-preview's output: symbol-font characters
 * (Symbol, Wingdings, Webdings) turned into the Unicode they stand for, Office
 * fonts given metric-compatible or platform substitutes (Carlito for Calibri,
 * Caladea for Cambria, CJK system fonts), the web fonts loaded, and unitless
 * line heights scaled by each font's own "normal" line height, which is what
 * Word's single spacing means.
 */

type Platform = "darwin" | "win32" | "linux"

const SYMBOL_FONTS = new Set(["symbol", "wingdings", "wingdings 2", "wingdings 3", "webdings"])

function table(entries: [number, string][]): Map<number, string> {
  return new Map(entries)
}

const SYMBOL = (() => {
  const upper = "ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ"
  const lower = "αβχδεφγηιϕκλμνοπθρστυϖωξψζ"
  const entries: [number, string][] = []
  ;[...upper].forEach((char, at) => entries.push([65 + at, char]))
  ;[...lower].forEach((char, at) => entries.push([97 + at, char]))
  entries.push([34, "∀"], [36, "∃"], [39, "∍"], [64, "≅"], [94, "⊥"], [126, "∼"])
  ;[..."′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…"].forEach((char, at) => entries.push([162 + at, char]))
  entries.push([191, "↵"])
  ;[..."⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇"].forEach((char, at) => entries.push([196 + at, char]))
  entries.push([212, "™"], [213, "∏"], [214, "√"], [215, "⋅"], [216, "¬"], [217, "∧"], [218, "∨"])
  ;[..."⇔⇐⇑⇒⇓"].forEach((char, at) => entries.push([219 + at, char]))
  entries.push([229, "∑"], [242, "∫"])
  return table(entries)
})()

const TABLES: Record<string, Map<number, string>> = {
  symbol: SYMBOL,
  wingdings: table([
    [74, "☺"], [76, "☹"], [108, "●"], [109, "○"], [110, "■"], [111, "□"], [112, "❑"], [113, "❒"], [115, "▲"], [116, "▼"],
    [117, "◆"], [118, "❖"], [119, "⬥"], [120, "⌧"], [161, "○"], [167, "▪"], [168, "◻"], [216, "➢"], [222, "➾"],
    [224, "⇦"], [240, "⇦"], [225, "⇨"], [241, "⇨"], [226, "⇧"], [242, "⇧"], [227, "⇩"], [243, "⇩"],
    [251, "✗"], [252, "✔"], [253, "☒"], [254, "☑"],
  ]),
  "wingdings 2": table([[80, "✓"], [81, "✔"], [82, "✗"], [83, "✘"], [84, "☑"], [86, "☒"], [151, "●"], [152, "■"], [153, "▲"], [163, "▪"], [181, "◆"]]),
  "wingdings 3": table([[103, "▲"], [104, "▼"], [116, "◀"], [117, "▶"], [125, "➤"], [164, "▲"], [165, "▼"], [169, "◄"], [170, "►"]]),
  webdings: table([[61, "🌍"], [64, "🚹"], [97, "✅"], [105, "ℹ"], [114, "★"], [142, "▶"], [52, "■"]]),
}

const SUBSTITUTES: Record<string, Partial<Record<Platform | "all", string[]>>> = {
  calibri: { all: ["Carlito"] },
  "calibri light": { all: ["Carlito"] },
  cambria: { all: ["Caladea"] },
  "cambria math": { all: ["Caladea"] },
  arial: { linux: ["Liberation Sans", "DejaVu Sans"] },
  "times new roman": { linux: ["Liberation Serif", "DejaVu Serif"] },
  "courier new": { linux: ["Liberation Mono", "DejaVu Sans Mono"] },
  宋体: { darwin: ["Songti SC", "STSong"], linux: ["Noto Serif CJK SC", "WenQuanYi Micro Hei"] },
  simsun: { darwin: ["Songti SC", "STSong"], linux: ["Noto Serif CJK SC", "WenQuanYi Micro Hei"] },
  新宋体: { darwin: ["Songti SC"], linux: ["Noto Serif CJK SC"] },
  nsimsun: { darwin: ["Songti SC"], linux: ["Noto Serif CJK SC"] },
  黑体: { darwin: ["Heiti SC", "PingFang SC"], linux: ["Noto Sans CJK SC"] },
  simhei: { darwin: ["Heiti SC", "PingFang SC"], linux: ["Noto Sans CJK SC"] },
  微软雅黑: { darwin: ["PingFang SC"], linux: ["Noto Sans CJK SC"] },
  "microsoft yahei": { darwin: ["PingFang SC"], linux: ["Noto Sans CJK SC"] },
  "microsoft yahei ui": { darwin: ["PingFang SC"], linux: ["Noto Sans CJK SC"] },
  楷体: { darwin: ["Kaiti SC", "STKaiti"], linux: ["Noto Serif CJK SC"] },
  kaiti: { darwin: ["Kaiti SC", "STKaiti"], linux: ["Noto Serif CJK SC"] },
  仿宋: { darwin: ["STFangsong"], linux: ["Noto Serif CJK SC"] },
  fangsong: { darwin: ["STFangsong"], linux: ["Noto Serif CJK SC"] },
  等线: { darwin: ["PingFang SC"], linux: ["Noto Sans CJK SC"] },
  dengxian: { darwin: ["PingFang SC"], linux: ["Noto Sans CJK SC"] },
  "ms mincho": { darwin: ["Hiragino Mincho ProN"], linux: ["Noto Serif CJK JP"] },
  "ms gothic": { darwin: ["Hiragino Kaku Gothic ProN"], linux: ["Noto Sans CJK JP"] },
  "yu gothic": { darwin: ["Hiragino Kaku Gothic ProN"], linux: ["Noto Sans CJK JP"] },
  "malgun gothic": { darwin: ["Apple SD Gothic Neo"], linux: ["Noto Sans CJK KR"] },
}

const TAIL: Record<Platform, string[]> = {
  darwin: ["PingFang SC", "sans-serif"],
  win32: ["Microsoft YaHei", "sans-serif"],
  linux: ["Noto Sans CJK SC", "sans-serif"],
}

const firstFamily = (value: string) => (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "")
const isSymbolFont = (value: string) => SYMBOL_FONTS.has(firstFamily(value).toLowerCase())

function remapText(text: string, font: string): string {
  const map = TABLES[font]
  if (!map) return text
  let out = ""
  for (const char of text) {
    let code = char.codePointAt(0) ?? 0
    if (code >= 0xf000 && code <= 0xf0ff) code -= 0xf000
    const mapped = map.get(code)
    if (mapped) out += mapped
    else if (char === " " || char === "\t" || char === "\n") out += char
    else if (font === "symbol" && code < 128) out += String.fromCharCode(code)
    else out += "●"
  }
  return out
}

function quoteFamily(name: string) {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : JSON.stringify(name)
}

function buildChain(first: string, platform: Platform, eastAsia?: string): string {
  const names: string[] = [first]
  const push = (family: string) => {
    const substitutes = SUBSTITUTES[family.toLowerCase()]
    if (!substitutes) return
    names.push(...(substitutes[platform] ?? []), ...(substitutes.all ?? []))
  }
  push(first)
  if (eastAsia && eastAsia.toLowerCase() !== first.toLowerCase()) {
    names.push(eastAsia)
    push(eastAsia)
  }
  names.push(...TAIL[platform])
  const seen = new Set<string>()
  return names
    .filter((name) => {
      const key = name.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((name) => (name === "sans-serif" ? name : quoteFamily(name)))
    .join(", ")
}

function rewriteFamily(value: string, platform: Platform, eastAsia?: string): string | null {
  if (!value || value.includes("var(")) return null
  const first = firstFamily(value)
  if (!first || SYMBOL_FONTS.has(first.toLowerCase())) return null
  return buildChain(first, platform, eastAsia)
}

/* Characters inside quoted strings of a CSS `content` value, remapped (list bullets use them). */
function remapContent(content: string, font: string): string {
  return content.replace(/(["'])((?:\\.|(?!\1).)*)\1/g, (_match, quote: string, body: string) => {
    const decoded = body.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_escape, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    return `${quote}${remapText(decoded, font)}${quote}`
  })
}

const ratios = new Map<string, number>()
const RATIOS_KEPT = 512
function normalLineHeight(family: string, sample: string): number {
  const key = `${family}\u0000${sample}`
  const known = ratios.get(key)
  if (known) return known
  const probe = document.createElement("span")
  probe.textContent = sample
  probe.style.cssText = `position:absolute;visibility:hidden;display:inline-block;white-space:nowrap;font-size:100px;line-height:normal;font-family:${family}`
  document.body.append(probe)
  const measured = probe.getBoundingClientRect().height / 100
  probe.remove()
  const ratio = measured >= 1 && measured <= 1.8 ? measured : 1.2
  // Oldest out first, so a long session of document previews cannot grow this for ever (N11-37).
  if (ratios.size >= RATIOS_KEPT) ratios.delete(ratios.keys().next().value!)
  ratios.set(key, ratio)
  return ratio
}

export async function patchDocxFidelity(host: HTMLElement, platform: Platform, eastAsia: { major?: string; minor?: string }) {
  // 1. Symbol-font characters in the text.
  for (const element of host.querySelectorAll<HTMLElement>("span, s, b, i, em, strong")) {
    const family = getComputedStyle(element).fontFamily
    if (!isSymbolFont(family)) continue
    const font = firstFamily(family).toLowerCase()
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) node.nodeValue = remapText(node.nodeValue ?? "", font)
    }
    element.style.fontFamily = ""
  }

  // 2. The stylesheets docx-preview generated.
  for (const style of host.querySelectorAll("style")) {
    let rules: CSSRuleList
    try {
      rules = (style.sheet as CSSStyleSheet).cssRules
    } catch {
      continue
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue
      const family = rule.style.getPropertyValue("font-family")
      if (family) {
        if (isSymbolFont(family)) {
          const content = rule.style.getPropertyValue("content")
          if (content) rule.style.setProperty("content", remapContent(content, firstFamily(family).toLowerCase()))
          rule.style.removeProperty("font-family")
        } else {
          const rewritten = rewriteFamily(family, platform, eastAsia.minor)
          if (rewritten) rule.style.setProperty("font-family", rewritten)
        }
      }
      for (const name of Array.from(rule.style)) {
        if (!/^--docx-.*-font$/.test(name)) continue
        const fallback = name.includes("major") ? (eastAsia.major ?? eastAsia.minor) : eastAsia.minor
        const rewritten = rewriteFamily(rule.style.getPropertyValue(name), platform, fallback)
        if (rewritten) rule.style.setProperty(name, rewritten)
      }
    }
  }

  // 3. Inline font families.
  for (const element of host.querySelectorAll<HTMLElement>("[style*='font-family']")) {
    const family = element.style.fontFamily
    if (!family) continue
    if (isSymbolFont(family)) element.style.fontFamily = ""
    else {
      const rewritten = rewriteFamily(family, platform, eastAsia.minor)
      if (rewritten) element.style.fontFamily = rewritten
    }
  }

  // 4. The web fonts.
  try {
    await Promise.all([document.fonts.load("12px Carlito"), document.fonts.load("12px Caladea")])
    await document.fonts.ready
  } catch {
    // Missing fonts only cost fidelity.
  }

  // 5. Unitless line heights, scaled by each font's normal line height.
  const sample = /[⺀-鿿぀-ヿ가-힯]/.test(host.textContent ?? "") ? "Mg汉字" : "Mgj"
  const scale = (value: string, family: string) => {
    if (!/^\d*\.?\d+$/.test(value.trim())) return null
    const number = Number(value)
    if (!(number > 0 && number < 10)) return null
    return String(Math.round(number * normalLineHeight(family, sample) * 1000) / 1000)
  }
  const paragraph = host.querySelector("p")
  const defaultFamily = paragraph ? getComputedStyle(paragraph).fontFamily : getComputedStyle(host).fontFamily
  for (const style of host.querySelectorAll("style")) {
    let rules: CSSRuleList
    try {
      rules = (style.sheet as CSSStyleSheet).cssRules
    } catch {
      continue
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue
      const value = rule.style.getPropertyValue("line-height")
      if (!value) continue
      const scaled = scale(value, rule.style.getPropertyValue("font-family") || defaultFamily)
      if (scaled) rule.style.setProperty("line-height", scaled)
    }
  }
  for (const element of host.querySelectorAll<HTMLElement>("[style*='line-height']")) {
    const scaled = scale(element.style.lineHeight, getComputedStyle(element).fontFamily)
    if (scaled) element.style.lineHeight = scaled
  }
}
