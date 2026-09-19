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
import { ago, detectLanguage, language, LANGUAGES } from "../src/renderer/src/lib/i18n"
import { subagentTime } from "../src/renderer/src/lib/subagents"
import { interfaceLocale, setMachineLocale } from "../src/server/session/locale"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundFourteenLocaleChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 14 (L): locale formatting and right-to-left")

  // ---------------------------------------------------------------- L14-1
  {
    /*
     * A machine whose display language (app.getLocale) is French and whose
     * region format - this process's Intl default - is something else: both
     * sides must follow the display language main hands them.
     */
    const g = globalThis as { window?: unknown }
    const savedWindow = g.window
    const region = Intl.DateTimeFormat().resolvedOptions().locale
    const display = systemLanguage(region) === "fr" ? "de-DE" : "fr-FR"
    g.window = { mcode: { systemLocale: () => display } }
    setMachineLocale(display)
    const reply = interfaceLocale(undefined)
    const ui = detectLanguage()
    check("L14-1: with no choice, the reply language is the display language main reads, not the region format", reply === systemLanguage(display), { reply, region })
    check("L14-1: and the window starts in that same language", ui === reply, { ui, reply })
    setMachineLocale("")
    g.window = savedWindow
    check("L14-1: without Electron the backend still has a locale", interfaceLocale(undefined) === systemLanguage(region))
    const [main, preload] = await Promise.all([read("src/main/index.ts"), read("src/preload/index.ts")])
    check(
      "L14-1: main hands app.getLocale() to the backend and answers the window's ask with it",
      /setMachineLocale\(app\.getLocale\(\)\)/.test(main) &&
        /ipcMain\.on\("mcode:system-locale"[\s\S]{0,80}returnValue = app\.getLocale\(\)/.test(main) &&
        /systemLocale: \(\): string => ipcRenderer\.sendSync\("mcode:system-locale"\)/.test(preload),
    )
  }

  // ---------------------------------------------------------------- L14-2
  {
    const [app, html, i18n] = await Promise.all([read("src/renderer/src/App.vue"), read("src/renderer/index.html"), read("src/renderer/src/lib/i18n.ts")])
    const watcher = app.slice(app.indexOf("() => app.config?.language"), app.indexOf("publishMenuLabels()", app.indexOf("() => app.config?.language")))
    check("L14-2: <html lang> is set from the interface language wherever the language is set", /document\.documentElement\.lang = language\.value/.test(watcher))
    check("L14-2: and starts as the language the window starts in", html.match(/<html lang="([^"]+)"/)?.[1] === i18n.match(/export const language = ref<Language>\("([^"]+)"\)/)?.[1])
    const invalid = LANGUAGES.map((entry) => entry.id).filter((id) => {
      try {
        return Intl.getCanonicalLocales(id)[0] !== id
      } catch {
        return true
      }
    })
    check("L14-2: every table's id is already a canonical BCP-47 tag", invalid.length === 0, invalid)
  }

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

  // ---------------------------------------------------------------- L14-5
  {
    const saved = language.value
    language.value = "ar"
    const minute = 60_000
    const said = {
      m1: ago(Date.now() - 1 * minute), m2: ago(Date.now() - 2 * minute), m3: ago(Date.now() - 3 * minute), m11: ago(Date.now() - 11 * minute),
      h2: ago(Date.now() - 2 * 60 * minute), h5: ago(Date.now() - 5 * 60 * minute),
      d1: ago(Date.now() - 24 * 60 * minute), d2: ago(Date.now() - 48 * 60 * minute), d7: ago(Date.now() - 7 * 24 * 60 * minute), d20: ago(Date.now() - 20 * 24 * 60 * minute),
    }
    check(
      "L14-5: Arabic says one, two, a few and many minutes each in its own form",
      said.m1 === "قبل دقيقة" && said.m2 === "قبل دقيقتين" && said.m3 === "قبل 3 دقائق" && said.m11 === "قبل 11 دقيقة",
      said,
    )
    check("L14-5: and hours and days likewise", said.h2 === "قبل ساعتين" && said.h5 === "قبل 5 ساعات" && said.d1 === "قبل يوم" && said.d2 === "قبل يومين" && said.d7 === "قبل 7 أيام" && said.d20 === "قبل 20 يومًا", said)
    const subagent = subagentTime({ id: "x", name: "", status: "completed", endedAt: 0 } as unknown as Parameters<typeof subagentTime>[0], 3 * minute)
    check("L14-5: the subagent column's ended time is a counted key", subagent.key === "time.minutesAgo" && subagent.counted === true, subagent)
    language.value = "en"
    check("L14-5: English is untouched", ago(Date.now() - 1 * minute) === "1 min ago" && ago(Date.now() - 5 * 60 * minute) === "5 h ago")
    language.value = saved
    const sites = await Promise.all(
      ["src/renderer/src/components/ArtifactsView.vue", "src/renderer/src/components/right/VersionHistory.vue", "src/renderer/src/components/right/RpSubagents.vue", "src/renderer/src/lib/i18n.ts"].map(read),
    )
    const plain = sites.filter((text) => /\bt\(\s*(["'`])time\.(minutes|hours|days)Ago\1/.test(text) || /\bt\(age\.unit/.test(text))
    check("L14-5: every relative-time call site goes through the plural lookup", plain.length === 0 && sites.every((text) => /\btn\(/.test(text)))
  }

  // ---------------------------------------------------------------- L14-4
  {
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    const button = settings.match(/<button[^>]*data-reset-all-shortcuts[^>]*>/)?.[0] ?? ""
    check("L14-4: the reset-all button carries its label as a tooltip", /:title="t\('set\.keys\.resetAll'\)"/.test(button), button)
    const rule = settings.match(/\n\.keys-foot \.ctl-btn \{([^}]*)\}/)?.[1] ?? ""
    check(
      "L14-4: and is not held to the 320px row-button cap, wrapping instead of cutting",
      /max-width: (none|100%)/.test(rule) && /white-space: normal/.test(rule) && /height: auto/.test(rule),
      rule,
    )
  }

  // ---------------------------------------------------------------- L14-6
  {
    const [sidebar, spine] = await Promise.all([read("src/renderer/src/components/Sidebar.vue"), read("src/renderer/src/components/SessionSpine.vue")])
    const arrows = [...sidebar.matchAll(/<button[^>]*@click="emit\('(back|forward)'\)"[^>]*>\s*<svg([^>]*)>/g)]
    check(
      "L14-6: both back / forward pairs (open and folded column) draw arrows that can turn",
      arrows.length === 4 && arrows.every((match) => /class="way"/.test(match[2])),
      arrows.map((match) => match[1] + (/class="way"/.test(match[2]) ? "+" : "-")),
    )
    check("L14-6: and turn under dir=rtl", /\.way:dir\(rtl\) \{\s*transform: scaleX\(-1\);/.test(sidebar))
    const css = spine.slice(spine.indexOf("<style"))
    const physical = [...css.matchAll(/^\s*(left|right|padding: 0 \d+px 0 \d+px)[:;]/gm)].map((match) => match[1])
    check("L14-6: the spine's strip, ticks, fades and card bridge are placed by logical sides", physical.length === 0 && /\.spine \{[^}]*inset-inline-start: 0/.test(css), physical)
    check(
      "L14-6: right to left the card opens on the rail's left, and the room is measured at the right",
      /rtl\(rail\.value\) \? railRect\.left - 14 - /.test(spine) && /rtl\(view\) \? viewRect\.right - innerRect\.right/.test(spine),
    )
  }
}
