/**
 * Round 17, lane X: the mermaid diagram block, and the motion rule that was
 * flattening it.
 *
 * A diagram is laid out from measurements taken while it is being drawn:
 * mermaid gives a label's foreignObject a scratch size, reads back the size the
 * text took, shrinks the foreignObject to it and asks the node group for its
 * box. With 弱化动效 on, `html[data-motion="on"] *` put a transition on every
 * property, so the shrink was still on its way when the box was read - every
 * node came back about two thousand units wide and the diagram landed in a
 * viewport of almost nothing. The cascade is worked out here for the element
 * that is measured; the drawn geometry is in the lane's Electron probes
 * (x17-probe.cjs and its passes), whose numbers are in the report.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { svgSize } from "../src/renderer/src/lib/svg-safe"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** One element on the path down to the thing being measured. */
type Step = { tag: string; attrs?: Record<string, string> }

/** A rule as the cascade needs it: where it can land, and what it sets. */
type Rule = { selectors: string[]; declarations: string; media?: string }

/** The rules of a stylesheet, with `@media` blocks kept whole under their query. */
function rulesOf(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: Rule[] = []
  const collect = (body: string, media?: string) => {
    let at = 0
    while (at < body.length) {
      const open = body.indexOf("{", at)
      if (open < 0) return
      const head = body.slice(at, open).trim()
      let depth = 1
      let close = open + 1
      while (close < body.length && depth > 0) {
        if (body[close] === "{") depth += 1
        else if (body[close] === "}") depth -= 1
        close += 1
      }
      const inner = body.slice(open + 1, close - 1)
      if (head.startsWith("@media")) collect(inner, head.slice(6).trim())
      else if (!head.startsWith("@")) out.push({ selectors: head.split(",").map((one) => one.trim()).filter(Boolean), declarations: inner, media })
      at = close
    }
  }
  collect(text)
  return out
}

/** Does one compound - `*`, `svg`, `html[data-motion="on"]` - describe this step? */
function hits(compound: string, step: Step): boolean {
  if (compound.includes("::")) return false
  const tag = /^[*a-zA-Z][\w-]*/.exec(compound)?.[0] ?? ""
  if (tag !== "*" && tag.toLowerCase() !== step.tag.toLowerCase()) return false
  for (const [, name, value] of compound.matchAll(/\[([\w-]+)="([^"]*)"\]/g)) {
    if ((step.attrs ?? {})[name] !== value) return false
  }
  return !/[.#:]/.test(compound.slice(tag.length).replace(/\[[^\]]*\]/g, ""))
}

/** A descendant-only selector against a path, matched from the key compound up. */
function matches(selector: string, path: Step[]): boolean {
  const compounds = selector.trim().split(/\s+/)
  if (compounds.some((one) => /[>+~]/.test(one))) return false
  let at = path.length - 1
  for (let which = compounds.length - 1; which >= 0; which -= 1) {
    if (which === compounds.length - 1) {
      if (!hits(compounds[which], path[at])) return false
      at -= 1
      continue
    }
    while (at >= 0 && !hits(compounds[which], path[at])) at -= 1
    if (at < 0) return false
    at -= 1
  }
  return true
}

/** A selector's weight, enough for the shapes a stylesheet's motion rules use. */
function weight(selector: string): number {
  const compounds = selector.trim().split(/\s+/)
  let attributes = 0
  let tags = 0
  for (const one of compounds) {
    attributes += [...one.matchAll(/\[[^\]]*\]/g)].length
    const tag = /^[*a-zA-Z][\w-]*/.exec(one)?.[0] ?? ""
    if (tag && tag !== "*") tags += 1
  }
  return attributes * 100 + tags
}

/** What a property ends up as for an element, `!important` declarations only. */
function important(rules: Rule[], property: string, path: Step[], media?: (query: string) => boolean): string | undefined {
  let best: { at: number; weight: number; value: string } | undefined
  rules.forEach((rule, at) => {
    if (rule.media && !(media?.(rule.media) ?? false)) return
    const found = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]*?)\\s*!important\\s*(?:;|$)`).exec(rule.declarations)
    if (!found) return
    for (const selector of rule.selectors) {
      if (!matches(selector, path)) continue
      const rank = weight(selector)
      if (best && (rank < best.weight || (rank === best.weight && at < best.at))) continue
      best = { at, weight: rank, value: found[1] }
    }
  })
  return best?.value
}

export async function roundSeventeenDiagramChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ---------------------------------------------------------------- R17-X1
  section("Round 17 (X1): a diagram is measured while it is drawn, so 弱化动效 must not transition its geometry")
  {
    const base = await read("src/renderer/src/styles/base.css")
    const rules = rulesOf(base)
    // mermaid's scratch element, down to the foreignObject whose size is read back.
    const scratch = (motion: string): Step[] => [
      { tag: "html", attrs: { "data-motion": motion } },
      { tag: "body" },
      { tag: "div" },
      { tag: "svg" },
      { tag: "g" },
      { tag: "foreignObject" },
    ]
    // A button in the interface, which the damping is for.
    const control = (motion: string): Step[] => [{ tag: "html", attrs: { "data-motion": motion } }, { tag: "body" }, { tag: "div" }, { tag: "button" }]
    const reduced = (query: string) => /prefers-reduced-motion:\s*reduce/.test(query)

    check("R17-X1: 弱化动效 still damps the interface's transitions", important(rules, "transition-duration", control("on")) === "0.01ms")
    check("R17-X1: and its animations, which must run rather than freeze", important(rules, "animation-duration", control("on")) === "0.01ms")
    check("R17-X1: inside a drawing a size change lands at once", important(rules, "transition-duration", scratch("on")) === "0s")
    check("R17-X1: a drawing's own animations are damped like the rest", important(rules, "animation-duration", scratch("on")) === "0.01ms")

    check("R17-X1: following the machine damps the interface the same way", important(rules, "transition-duration", control("system"), reduced) === "0.01ms")
    check("R17-X1: and leaves a drawing's geometry alone the same way", important(rules, "transition-duration", scratch("system"), reduced) === "0s")
    check("R17-X1: with motion off nothing is forced on either", important(rules, "transition-duration", scratch("off")) === undefined && important(rules, "transition-duration", control("off")) === undefined)
  }

  // ---------------------------------------------------------------- R17-X2
  section("Round 17 (X2): the drawn size a diagram is laid out and zoomed by")
  {
    // What mermaid hands back with useMaxWidth left on: a width of 100%, its size in the viewBox.
    const drawn = '<svg id="mmd-1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 255.73px;" viewBox="0 0 255.734375 458.09375">'
    check("R17-X2: a per-cent width is not a size", svgSize(drawn).w === 255.734375 && svgSize(drawn).h === 458.09375)
    check("R17-X2: pixels win when the drawing carries them", svgSize('<svg width="120" height="40" viewBox="0 0 12 4">').w === 120)
    check("R17-X2: a drawing with neither falls back", svgSize("<svg>").w === 800 && svgSize("<svg>").h === 600)

    const block = await read("src/renderer/src/components/parts/DiagramBlock.vue")
    check("R17-X2: the canvas is that size times the zoom", /width: `\$\{size\.value\.w \* zoom\.value\}px`, height: `\$\{size\.value\.h \* zoom\.value\}px`/.test(block))
    check("R17-X2: and the drawing fills the canvas", /\.md-diagram-canvas svg \{[^}]*width: 100%;[^}]*height: 100%;[^}]*max-width: none !important;/.test(block))
    check("R17-X2: the pill runs a quarter to three, in quarters", /ZOOM_MIN = 0\.25/.test(block) && /ZOOM_MAX = 3\b/.test(block) && /ZOOM_STEP = 0\.25/.test(block))

    const diagram = await read("src/renderer/src/lib/diagram.ts")
    check("R17-X2: mermaid is set up as MiMo sets it up", /startOnLoad: false/.test(diagram) && /securityLevel: "strict"/.test(diagram) && /suppressErrorRendering: true/.test(diagram) && /fontFamily: "inherit"/.test(diagram))
    check("R17-X2: with mermaid's own wrapping left alone", !/useMaxWidth/.test(diagram) && !/wrappingWidth/.test(diagram))
  }
}
