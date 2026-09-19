/**
 * Round 14, lane L: locale formatting and right-to-left layout (L14-1
 * onwards). Kept apart from smoke.ts the way the earlier rounds are; smoke.ts
 * calls `roundFourteenLocaleChecks` with its own check and section.
 *
 * What can run without a window runs here; what needs one - the machine
 * locale reaching both sides, the mirrored arrows and spine - is read from the
 * source here and measured in the lane's Electron probe.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { LANGUAGE_IDS, resolveLanguage, systemLanguage } from "../src/shared/locale"
import { detectLanguage, LANGUAGES } from "../src/renderer/src/lib/i18n"
import { interfaceLocale } from "../src/server/session/locale"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundFourteenLocaleChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 14 (L): locale formatting and right-to-left")

  // ---------------------------------------------------------------- L14-3
  {
    const cases: [string, string][] = [
      ["zh-HK", "zh-TW"], ["zh-MO", "zh-TW"], ["zh-TW", "zh-TW"], ["zh-Hant", "zh-TW"], ["zh-Hant-SG", "zh-TW"], ["zh_hant_hk", "zh-TW"],
      ["zh-CN", "zh-CN"], ["zh-SG", "zh-CN"], ["zh", "zh-CN"],
      ["no", "nb"], ["nb-NO", "nb"], ["nn-NO", "nb"], ["pt-PT", "pt-BR"], ["de-AT", "de"], ["ar-EG", "ar"], ["sw-KE", "en"], ["", "en"],
    ]
    const wrong = cases.filter(([tag, want]) => systemLanguage(tag) !== want).map(([tag]) => `${tag} -> ${systemLanguage(tag)}`)
    check("L14-3: zh-HK / zh-MO / zh-Hant read Traditional, no / nb / nn read Norwegian", wrong.length === 0, wrong)
    const split = cases.filter(([tag]) => detectLanguage(tag) !== interfaceLocale("", tag)).map(([tag]) => tag)
    check("L14-3: the window and the reply language map every machine locale the same way", split.length === 0, split)
    check("L14-3: one list of languages for both sides", LANGUAGES.map((entry) => entry.id).join() === LANGUAGE_IDS.join())
    check("L14-3: a chosen language wins, an unknown one falls to the machine", resolveLanguage("ja", "de-DE") === "ja" && resolveLanguage("xx", "de-DE") === "de" && resolveLanguage("system", "zh-HK") === "zh-TW")
    const [i18n, locale] = await Promise.all([read("src/renderer/src/lib/i18n.ts"), read("src/server/session/locale.ts")])
    check(
      "L14-3: both sides call the shared mapping rather than keeping their own",
      /return systemLanguage\(/.test(i18n) && /resolveLanguage\(/.test(locale) && !/hant|\bnn\b/i.test(locale.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
    )
  }
}
