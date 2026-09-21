/**
 * Round 18, lane U: the small AI-generated marker MiMo 26.920 puts beside a
 * rendered score and an inline sound (R18-U14).
 *
 * MiMo's AbcBlock draws a line over the score whenever the score view shows,
 * and its inline audio card ends on a row as wide as the voice bubble: the
 * file's name, then the marker. The marker is live in both places - the ABC
 * block is what an ```abc fence and an .abc file in the files tab render, and
 * the audio card is what a sound's path in a reply and a delivered sound
 * render. The geometry is measured in the real window by the aigc probe;
 * what is read here is the structure and the strings.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { LANGUAGES, language, t } from "../src/renderer/src/lib/i18n"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** The body of the first rule whose selector is exactly `selector` in `css`, or "" when there is none. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? ""
}

export async function roundEighteenAigcMarkChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 18 (lane U): R18-U14 the （AI生成） marker beside a score and an inline sound")
  {
    const before = language.value
    const codes = LANGUAGES.map((entry) => entry.id)
    const seen = new Map<string, string>()
    for (const code of codes) {
      language.value = code as typeof language.value
      seen.set(code, t("markdown.aiGenerated"))
    }
    language.value = before
    check("R18-U14: in Chinese the marker reads （AI生成）, as MiMo writes it", seen.get("zh-CN") === "（AI生成）", seen.get("zh-CN"))
    const missing = [...seen].filter(([, text]) => !text || text === "markdown.aiGenerated")
    check("R18-U14: every language has the marker", codes.length === 18 && missing.length === 0, { count: codes.length, missing })
    const english = seen.get("en")
    const untranslated = [...seen].filter(([code, text]) => code !== "en" && !code.startsWith("zh") && code !== "ja" && text === english)
    check("R18-U14: and the others are their own words, not English left in", untranslated.length === 0, untranslated)
    check("R18-U14: every marker is one parenthesised phrase", [...seen.values()].every((text) => /^[（(].+[）)]$/.test(text)), [...seen.values()])
  }
  {
    const abc = await read("src/renderer/src/components/parts/AbcBlock.vue")
    const template = abc.slice(abc.indexOf("<template>"), abc.lastIndexOf("</template>"))
    const style = abc.slice(abc.indexOf("<style"))
    const view = template.slice(template.indexOf('<div v-show="showingScore" class="md-abc-view">'), template.indexOf("</template>", template.indexOf("md-abc-view")))
    const mark = view.indexOf('data-abc-aigc>{{ t("markdown.aiGenerated") }}</div>')
    check("R18-U14: the score view carries the marker", mark > 0, view.slice(0, 200))
    check("R18-U14: under the progress bar and the rendering note, over the score itself", mark > view.indexOf("data-abc-rendering") && mark > view.indexOf("data-abc-progress") && mark < view.indexOf('ref="score"'))
    check("R18-U14: whenever the score view shows, drawn or still drawing", /<div class="md-abc-aigc" data-abc-aigc>/.test(view))
    check("R18-U14: not in the code view", !template.slice(template.indexOf('<template v-if="!showingScore">')).includes("data-abc-aigc"))
    const line = rule(style, ".text .md-abc-aigc")
    check(
      "R18-U14: the score's marker is 12px in the muted colour, 6 above and 12 at the sides",
      /padding: 6px 12px 0;/.test(line) && /color: var\(--text-base\);/.test(line) && /font-size: calc\(12px \* var\(--ui-font-scale, 1\)\);/.test(line),
      line,
    )
  }
  {
    const media = await read("src/renderer/src/components/parts/LocalMedia.vue")
    const template = media.slice(media.indexOf("<template>"), media.lastIndexOf("</template>"))
    const style = media.slice(media.indexOf("<style"))
    const sound = template.slice(template.indexOf("<audio"))
    const foot = /<span class="md-voice-foot" :style="\{ width: bubbleWidth \}" data-voice-foot>\s*<span class="md-media-name md-voice-name">\{\{ name \}\}<\/span>\s*<span class="md-voice-aigc" data-voice-aigc>\{\{ t\("markdown\.aiGenerated"\) \}\}<\/span>\s*<\/span>/
    check("R18-U14: the sound card ends on the name, then the marker, in one row", foot.test(sound))
    check("R18-U14: the row is as wide as the bubble above it", sound.indexOf("data-voice-foot") > sound.indexOf("data-voice-bubble") && /:style="\{ width: bubbleWidth \}" data-voice-foot/.test(sound))
    const failedCard = template.slice(template.indexOf('v-if="state === \'error\'"'), template.indexOf("</button>", template.indexOf('v-if="state === \'error\'"')))
    check("R18-U14: the card for a sound that will not play has no marker", !failedCard.includes("aiGenerated") && (template.match(/markdown\.aiGenerated/g) ?? []).length === 1)
    const row = rule(style, ".text .md-voice-foot")
    check("R18-U14: the row is a line of its own with 8 between the two", /display: flex;/.test(row) && /align-items: center;/.test(row) && /gap: 8px;/.test(row) && /max-width: 100%;/.test(row), row)
    const name = rule(style, ".text .md-voice-name")
    check("R18-U14: the name takes the room and is cut short, not the marker", /flex: 1;/.test(name) && /min-width: 0;/.test(name) && /max-width: none;/.test(name), name)
    const marker = rule(style, ".text .md-voice-aigc")
    check(
      "R18-U14: the sound's marker is a fixed 10px on a 1.2 line in the dim colour, unshrunk and unselectable",
      /flex: none;/.test(marker) && /color: #151c1366;/.test(marker) && /font-size: 10px;/.test(marker) && /line-height: 1\.2;/.test(marker) && /user-select: none;/.test(marker),
      marker,
    )
    check(
      "R18-U14: and #777 in the dark, both ways the dark theme is chosen",
      /:root\[data-theme="dark"\] \.text \.md-voice-name,\n:root\[data-theme="dark"\] \.text \.md-voice-aigc \{\n  color: #777;/.test(style) &&
        /:root:not\(\[data-theme="light"\]\) \.text \.md-voice-name,\n  :root:not\(\[data-theme="light"\]\) \.text \.md-voice-aigc \{\n    color: #777;/.test(style),
    )
  }
  {
    const files = await read("src/renderer/src/components/right/RpFiles.vue")
    check("R18-U14: an .abc file in the files tab is the same block, so it carries the marker too", /<AbcBlock :code="opened\.content" \/>/.test(files))
    const delivered = await read("src/renderer/src/components/DeliveredFilesCard.vue")
    check("R18-U14: a delivered sound is the same card, so it carries the marker too", /<LocalMedia :kind="mediaPreview\(item\)!\.kind"/.test(delivered))
  }
}
