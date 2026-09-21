/**
 * T3 (round 7's open item): switching back to a long conversation.
 *
 * Measured in the real window (scratchpad perf/perf-switch.cjs, 160 turns /
 * 480 messages with code, tables and tool steps): 438ms from the switch to a
 * painted, stable stream before, of which 300ms was laying out 33,000 nodes
 * out of sight, 23ms building a date formatter per stamp and 22ms of the
 * navigator scanning the transcript once per turn. These are the source
 * guarantees behind that number; the timing itself needs a window and stays
 * in the probe.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { dateIn, language } from "../src/renderer/src/lib/i18n"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** A scoped rule's body, whitespace folded, or "" when the selector is not there. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  if (at === -1) return ""
  return css.slice(at, css.indexOf("}", at)).replace(/\s+/g, " ")
}

export async function perfThreadChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("T3: switching back to a long conversation")

  const stream = await read("src/renderer/src/components/MessageStream.vue")
  const style = stream.slice(stream.indexOf("<style"))

  // MiMo 26.920's `#thread>.row`: a turn out of sight is not laid out or painted.
  const turn = rule(style, ".inner > .turn")
  check("T3-1: a turn out of sight skips layout and paint (content-visibility: auto)", /content-visibility: auto;/.test(turn), turn)
  check("T3-2: and keeps a remembered size, 240px before it has been drawn", /contain-intrinsic-size: auto 240px;/.test(turn), turn)

  // The last turn - the one being written and read - is always drawn, and the template marks it.
  check(
    "T3-3: the last turn is always drawn in full",
    /content-visibility: visible;/.test(rule(style, ".inner > .turn[data-turn-last]")) &&
      /class="turn" :data-turn="turn\.id" :data-turn-last="at === turns\.length - 1 \? '' : undefined"/.test(stream),
  )

  // While a selection is made or held every turn is drawn, containment kept so nothing moves.
  check(
    "T3-4: a selection in the conversation draws every turn, with the containment kept",
    /content-visibility: visible;/.test(rule(style, ".stream.selecting .inner > .turn")) &&
      /contain: layout paint style;/.test(rule(style, ".stream.selecting .inner > .turn:not([data-turn-last])")) &&
      /document\.addEventListener\("selectionchange", onSelectionChange\)/.test(stream) &&
      /document\.addEventListener\("mousedown", onPressDown\)/.test(stream) &&
      /classList\.toggle\("selecting"/.test(stream),
  )

  // A contained turn is the containing block of a fixed box inside it: every menu a turn opens is on the body.
  const edited = await read("src/renderer/src/components/EditedFilesCard.vue")
  check("T3-5: the edited-files card's menu is on the body, not inside the contained turn", /<Teleport to="body">\s*<ContextMenu v-if="menu"/.test(edited))
  const inTurn = ["DeliveredFilesCard.vue", "parts/MarkdownBody.vue", "parts/DiagramBlock.vue", "parts/SvgFileCard.vue"]
  const unported: string[] = []
  for (const file of inTurn) {
    const source = await read(`src/renderer/src/components/${file}`)
    const template = source.slice(source.indexOf("<template>"), source.lastIndexOf("</template>"))
    const menu = template.indexOf("<ContextMenu")
    if (menu !== -1 && template.lastIndexOf("<Teleport", menu) === -1) unported.push(file)
  }
  check("T3-6: so is every other context menu a reply draws", unported.length === 0, unported)

  // One formatter per language and options, not one per stamp.
  const i18n = await read("src/renderer/src/lib/i18n.ts")
  const dateBody = i18n.slice(i18n.indexOf("export function dateIn("), i18n.indexOf("export function calendarDate("))
  check("T3-7: dates are written with a kept formatter", /formatterFor\(language\.value, options\)/.test(dateBody) && !/new Intl\.DateTimeFormat/.test(dateBody))
  const was = language.value
  const moment = new Date(2026, 8, 21, 20, 49)
  const same = (["en", "zh-CN", "th", "ar", "de"] as const).every((tag) => {
    language.value = tag
    const options = { month: "short", day: "numeric" } as const
    return dateIn(moment, options) === new Intl.DateTimeFormat(tag, options).format(moment) && dateIn(moment) === new Intl.DateTimeFormat(tag).format(moment)
  })
  language.value = was
  check("T3-8: and write exactly what a fresh one would, in every language asked", same)

  // The navigator finds every turn in one pass rather than a selector per turn.
  const spine = await read("src/renderer/src/components/SessionSpine.vue")
  const active = spine.slice(spine.indexOf("function markActive()"), spine.indexOf("let frame = 0"))
  check("T3-9: the navigator's on-screen marks come from one scan of the transcript", /querySelectorAll<HTMLElement>\("\[data-turn\]"\)/.test(active) && !/turnElement\(/.test(active), active.slice(0, 200))
}
