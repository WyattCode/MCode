/**
 * Regenerates the provider marks. Run `npm run icons` after adding a provider.
 *
 * Source is @lobehub/icons-static-svg (MIT), an icon set maintained for exactly
 * this purpose - model vendors - so it carries the ones a general logo set does
 * not, including OpenAI, whose mark Simple Icons was asked to remove.
 * Trademarks remain their owners'; the marks identify the service being
 * connected and nothing more.
 *
 * The output is committed so the app does not ship a 900-icon dependency to
 * show twenty-eight of them. Every mapping below is written out by hand: fuzzy
 * matching offered QQ for Tencent Hunyuan and OpenAI Gym for OpenAI, and a
 * wrong logo is worse than none.
 */
import fs from "node:fs"
import path from "node:path"
import * as simpleIcons from "simple-icons"

const simple = Object.values(simpleIcons as Record<string, unknown>).filter(
  (value): value is { slug: string; svg: string } =>
    typeof value === "object" && value !== null && "slug" in value && "svg" in value,
)

/**
 * Provider id -> mark, and the brand colour to paint it in.
 *
 * `icon` names a file in the Lobe set; `simple` names a Simple Icons slug.
 * Both are used because neither is complete: Simple Icons was asked to drop
 * OpenAI and never carried most Chinese vendors, while the Lobe set ships a
 * two-line wordmark for Xiaomi MiMo that is a smudge at seventeen pixels.
 */
const PROVIDERS: Record<string, { icon?: string; simple?: string; color: string }> = {
  anthropic: { icon: "anthropic", color: "#d4a27f" },
  openai: { icon: "openai", color: "#10a37f" },
  chatgpt: { icon: "openai", color: "#10a37f" },
  // The MI symbol, not the stacked "Xiaomi MiMo" wordmark.
  xiaomi: { simple: "xiaomi", color: "#ff6900" },
  "xiaomi-plan": { simple: "xiaomi", color: "#ff8f3f" },
  google: { icon: "gemini", color: "#8e75b2" },
  openrouter: { icon: "openrouter", color: "#94a3b8" },
  deepseek: { icon: "deepseek", color: "#5786fe" },
  // Kimi is Moonshot's product and the mark it ships under.
  moonshot: { icon: "moonshot", color: "#a78bfa" },
  zhipu: { icon: "zhipu", color: "#3859ff" },
  // DashScope serves Qwen; the platform's own mark is Alibaba Cloud's.
  dashscope: { icon: "qwen", color: "#615ced" },
  xai: { icon: "xai", color: "#c9ced6" },
  groq: { icon: "groq", color: "#f55036" },
  // SiliconFlow ships internationally as SiliconCloud.
  siliconflow: { icon: "siliconcloud", color: "#7c5cff" },
  volcengine: { icon: "volcengine", color: "#3c8cff" },
  minimax: { icon: "minimax", color: "#e73562" },
  stepfun: { icon: "stepfun", color: "#3d7bff" },
  hunyuan: { icon: "hunyuan", color: "#2e6be6" },
  // Qianfan serves ERNIE, which carries the Wenxin mark.
  qianfan: { icon: "wenxin", color: "#2932e1" },
  mistral: { icon: "mistral", color: "#fa520f" },
  together: { icon: "together", color: "#2f7bff" },
  fireworks: { icon: "fireworks", color: "#ff5a1f" },
  cerebras: { icon: "cerebras", color: "#f26522" },
  perplexity: { icon: "perplexity", color: "#1fb8cd" },
  nvidia: { icon: "nvidia", color: "#76b900" },
  lmstudio: { icon: "lmstudio", color: "#8b8bf5" },
  vllm: { icon: "vllm", color: "#30a2ff" },
  ollama: { icon: "ollama", color: "#c9ced6" },
}

const LOBE = path.join("node_modules", "@lobehub", "icons-static-svg", "icons")

type Rule = "evenodd" | "nonzero"

interface Segment {
  d: string
  fillOpacity?: string
  clipRule?: Rule
  fillRule?: Rule
}

/**
 * The drawing instructions out of one file.
 *
 * Several marks are more than one path, and some of those carry a fill-opacity
 * or clip-rule that the shape needs - dropping them turns a shaded logo into a
 * solid blob, so they come along.
 */
function segments(entry: { icon?: string; simple?: string }): Segment[] {
  const icon = entry.icon ?? entry.simple ?? ""
  let source: string
  if (entry.icon) {
    const file = path.join(LOBE, `${entry.icon}.svg`)
    if (!fs.existsSync(file)) throw new Error(`no icon file for "${entry.icon}"`)
    source = fs.readFileSync(file, "utf8")
  } else {
    const match = simple.find((candidate) => candidate.slug === entry.simple)
    if (!match) throw new Error(`no Simple Icons entry for "${entry.simple}"`)
    source = match.svg
  }

  const box = source.match(/viewBox="([^"]*)"/)?.[1]
  if (box !== "0 0 24 24") throw new Error(`${icon}: unexpected viewBox "${box}"`)

  const shapes = source.match(/<(circle|rect|polygon|ellipse|line|polyline)\b/g)
  if (shapes) throw new Error(`${icon}: carries ${shapes.join(", ")}, which this renderer cannot draw`)

  const out: Segment[] = []
  for (const tag of source.match(/<path[^>]*\/?>/g) ?? []) {
    const d = tag.match(/\sd="([^"]*)"/)?.[1]
    if (!d) throw new Error(`${icon}: a path has no d`)
    const segment: Segment = { d }
    const opacity = tag.match(/fill-opacity="([^"]*)"/)?.[1]
    const clip = tag.match(/clip-rule="([^"]*)"/)?.[1]
    const fill = tag.match(/fill-rule="([^"]*)"/)?.[1]
    if (opacity) segment.fillOpacity = opacity
    // Anything outside the enumeration would be a silent rendering change.
    if (clip) {
      if (clip !== "evenodd" && clip !== "nonzero") throw new Error(icon + ': clip-rule "' + clip + '"')
      segment.clipRule = clip
    }
    if (fill) {
      if (fill !== "evenodd" && fill !== "nonzero") throw new Error(icon + ': fill-rule "' + fill + '"')
      segment.fillRule = fill
    }
    out.push(segment)
  }
  if (!out.length) throw new Error(`${icon}: no paths`)
  return out
}

const lines: string[] = []
let multi = 0

for (const [id, entry] of Object.entries(PROVIDERS)) {
  const parts = segments(entry)
  if (parts.length > 1) multi++
  lines.push(`  ${JSON.stringify(id)}: { color: ${JSON.stringify(entry.color)}, paths: ${JSON.stringify(parts)} },`)
}

const output = `/**
 * A mark per provider. GENERATED - edit scripts/gen-provider-icons.ts instead.
 *
 * Marks come from @lobehub/icons-static-svg (MIT). Trademarks remain their
 * owners'; they identify the service being connected and nothing more.
 */

export interface MarkPath {
  d: string
  fillOpacity?: string
  /** The SVG attribute is an enumeration, and Vue types it as one. */
  clipRule?: "evenodd" | "nonzero"
  fillRule?: "evenodd" | "nonzero"
}

export interface ProviderMark {
  /** Brand colour. */
  color: string
  /** Drawing instructions on a 24x24 grid. */
  paths: MarkPath[]
}

export const PROVIDER_MARKS: Record<string, ProviderMark> = {
${lines.join("\n")}
}
`

const target = path.join("src", "renderer", "src", "lib", "provider-marks.ts")
fs.writeFileSync(target, output, "utf8")
console.log(
  `${target}: ${Object.keys(PROVIDERS).length} marks (${multi} multi-path), ${(output.length / 1024).toFixed(1)} KB`,
)
