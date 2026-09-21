/**
 * Round 15, fix lane U1: the conversation UI's bugs (R15-U1-1 onwards). Kept
 * apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundFifteenUiChatChecks` with its own check and section.
 *
 * What can run without a window runs here against the real code: the path
 * split the document views hand the Office channel, checked against the
 * channel's own guard, the turn rule the conversation navigator now shares
 * with the transcript, and the reduced-motion rule the home wordmark now
 * obeys. The rest is layout and event order, which only a window can show:
 * those are read from the source here and measured in the lane's Electron
 * probe (r15u1-probe.cjs / r15u1-find.cjs), whose numbers are in the report.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import type { Message } from "../src/shared/protocol"
import { turnOpeners } from "../src/shared/steer"
import { officeRefusal } from "../src/main/office-guard"
import { splitFilePath } from "../src/renderer/src/lib/file-path"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** A stylesheet's selectors scored the way the cascade scores them: ids, classes, elements. */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g) ?? []).length
  const elements = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length
  return ids * 10_000 + classes * 100 + elements
}

/** Every rule in a `<style>` block whose declarations set `property`, in source order. Comments are dropped: they sit in the selector's place. */
function rulesSetting(styleBlock: string, property: string): { selector: string; value: string; at: number }[] {
  const css = styleBlock.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: { selector: string; value: string; at: number }[] = []
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let match = rule.exec(css); match; match = rule.exec(css)) {
    const found = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(match[2]!)
    if (found) out.push({ selector: match[1]!.trim().replace(/\s+/g, " "), value: found[1]!.trim(), at: match.index })
  }
  return out
}

const userMessage = (id: string, extra: Partial<Message> = {}): Message =>
  ({ id, sessionID: "s", role: "user", text: `text ${id}`, attachments: [], time: { created: 1 }, ...extra }) as Message
const assistantMessage = (id: string): Message =>
  ({ id, sessionID: "s", role: "assistant", parts: [], time: { created: 1 }, model: { provider: "p", model: "m" } }) as unknown as Message

export async function roundFifteenUiChatChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ---------------------------------------------------------------- R15-U1-1
  section("Round 15 (U1-1): a document at a drive root opens, because the folder keeps its separator")
  {
    const sep = String.fromCharCode(92)
    const [driveDir, driveBase] = splitFilePath(`D:${sep}book.xlsx`)
    check("a drive root splits into the root itself and the name", driveDir === `D:${sep}` && driveBase === "book.xlsx", { driveDir, driveBase })
    const [deepDir, deepBase] = splitFilePath(`C:${sep}work${sep}notes${sep}a.docx`)
    check("a folder deeper down keeps its separator too", deepDir === `C:${sep}work${sep}notes${sep}` && deepBase === "a.docx", { deepDir, deepBase })
    const [posixDir, posixBase] = splitFilePath("/deck.pptx")
    check("and a posix root splits the same way", posixDir === "/" && posixBase === "deck.pptx", { posixDir, posixBase })
    const [bareDir, bareBase] = splitFilePath("page.html")
    check("a bare name has no folder at all", bareDir === "" && bareBase === "page.html", { bareDir, bareBase })

    /*
     * The bug's own shape: "D:" is not an absolute path, so the Office
     * channel's guard turned the read away before it reached the file and the
     * tab only ever said the file was not there.
     */
    const roots = async () => []
    const kept = await officeRefusal("mcode:read-file-bytes", [driveDir, driveBase], roots)
    const cut = await officeRefusal("mcode:read-file-bytes", [`D:`, driveBase], roots)
    check("the channel accepts the folder the views now send", kept === undefined, kept)
    check("and refused the one three of them used to send", cut === "shape", cut)

    const views = ["XlsxView", "PptxView", "HtmlTab", "PdfView", "DocxView"]
    const sources = await Promise.all(views.map((name) => read(`src/renderer/src/components/right/${name}.vue`)))
    check(
      "every document view splits its path with the one shared helper",
      sources.every((source) => /splitFilePath/.test(source)) && !sources.some((source) => /lastIndexOf\("\\\\"\)/.test(source)),
      views.filter((_name, at) => !/splitFilePath/.test(sources[at]!)),
    )
  }

  // ---------------------------------------------------------------- R15-U1-2
  section("Round 15 (U1-2): the files tab's find bar stays inside the viewer it floats over")
  {
    const source = await read("src/renderer/src/components/right/RpFiles.vue")
    const bar = /\.fv-find \{([^}]*)\}/.exec(source)?.[1] ?? ""
    const input = /\.fv-find-input \{([^}]*)\}/.exec(source)?.[1] ?? ""
    check("the bar is capped at the viewer's width", /max-width:\s*calc\(100% - 28px\)/.test(bar), bar)
    check("and floored at what its own controls need, so it never spills off the panel", /min-width:\s*calc\(/.test(bar), bar)
    // R17-V2: the input was the only part with no floor under it, so it was the only part that gave - to 17px, and to 1px at the panel's minimum.
    check("its input holds MiMo's fixed 150px and is not what gives", /flex:\s*none/.test(input) && /width:\s*150px/.test(input) && !/min-width:\s*0/.test(input), input)
  }

  // ---------------------------------------------------------------- R15-U1-3
  section("Round 15 (U1-3): the history button closes the list it opened")
  {
    const pop = await read("src/renderer/src/components/right/VersionHistory.vue")
    const down = /function onDown\([\s\S]*?\n\}/.exec(pop)?.[0] ?? ""
    check(
      "the outside-press listener leaves the history button alone, so the button's own click is not undone",
      /data-office-history/.test(down) && /return/.test(down),
      down,
    )
    for (const name of ["OfficeTab", "HtmlTab"]) {
      const tab = await read(`src/renderer/src/components/right/${name}.vue`)
      check(`${name}'s history button carries the mark the listener looks for`, /data-office-history/.test(tab))
    }
  }

  // ---------------------------------------------------------------- R15-U1-4
  section("Round 15 (U1-4): the conversation navigator marks the turns the transcript drew")
  {
    /* The shared rule the navigator now reads, on the two messages it used to make dead ticks for. */
    const messages: Message[] = [
      userMessage("u1"),
      assistantMessage("a1"),
      userMessage("u2", { synthetic: true } as Partial<Message>),
      assistantMessage("a2"),
      userMessage("u3", { steered: true, notices: [{ subagentID: "explore-1", sessionID: "kid", description: "d", status: "completed" }] } as Partial<Message>),
      assistantMessage("a3"),
      userMessage("u4", { steered: true } as Partial<Message>),
      assistantMessage("a4"),
    ]
    const openers = turnOpeners(messages, true)
    check("news of a subagent never opens a turn", !openers.has("u3"), [...openers])
    check("a steer the model has taken does", openers.has("u4") && openers.has("u1"), [...openers])

    const spine = await read("src/renderer/src/components/SessionSpine.vue")
    const stops = /const stops = computed<Stop\[\]>\(\(\) => \{[\s\S]*?\n\}\)/.exec(spine)?.[0] ?? ""
    check("the navigator asks the same rule the transcript asks", /turnOpeners\(app\.visible, !app\.busy\)/.test(stops), stops.slice(0, 200))
    check("it skips the app's own synthetic message", /message\.synthetic/.test(stops) && /continue/.test(stops), stops.slice(0, 400))
    check("and shows no question for a message that only carries notices", /message\.notices\?\.length \? "" :/.test(stops), stops.slice(0, 600))
  }

  // ---------------------------------------------------------------- R15-U1-6
  section("Round 15 (U1-6): the docx revision rail never asks for a top CSS throws away")
  {
    const docx = await read("src/renderer/src/components/right/DocxView.vue")
    const layout = (/function layoutRail\(\)[\s\S]*?\n\}/.exec(docx)?.[0] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    check(
      "the rail starts one gap above its top rather than at -Infinity, so a card with no anchor still lands on the page",
      /let bottom = -CARD_GAP/.test(layout) && !/-Infinity/.test(layout),
      layout.slice(0, 400),
    )
  }

  // ---------------------------------------------------------------- R15-U1-7
  section("Round 15 (U1-7): a subagent row's focus ring is drawn where the group cannot clip it")
  {
    const source = await read("src/renderer/src/components/right/RpSubagents.vue")
    const row = /\.rp-subagent-row:focus-visible \{([^}]*)\}/.exec(source)?.[1] ?? ""
    check("the row's ring is inset, as every scroller-bound ring in the app is", /outline-offset:\s*-2px/.test(row), row)
    check("the group still clips, which is what the inset is for", /\.rp-subagent-group \{[^}]*overflow:\s*hidden/.test(source))
  }

  // ---------------------------------------------------------------- R15-U1-8
  section("Round 15 (U1-8): the home wordmark's hop follows the app's own reduced-motion setting")
  {
    const { reducedMotion } = await import("../src/renderer/src/lib/modal")
    const globals = globalThis as { window?: unknown; document?: unknown }
    const saved = { window: globals.window, document: globals.document }
    const stand = (motion: string | null, system: boolean) => {
      globals.document = { documentElement: { getAttribute: (name: string) => (name === "data-motion" ? motion : null) } }
      globals.window = { matchMedia: (query: string) => ({ matches: system && /reduce/.test(query) }) }
    }
    try {
      stand("on", false)
      check("turned on in the app, motion is reduced even where the system asks for none", reducedMotion() === true)
      stand("off", true)
      check("turned off in the app, motion runs even where the system asks to reduce it", reducedMotion() === false)
      stand(null, true)
      check("left to the system, the system decides", reducedMotion() === true)
      stand(null, false)
      check("and decides the other way too", reducedMotion() === false)
    } finally {
      globals.window = saved.window
      globals.document = saved.document
    }

    const hero = await read("src/renderer/src/components/HomeHero.vue")
    const hop = /async function hop\(\)[\s\S]*?\n\}/.exec(hero)?.[0] ?? ""
    check("the hop asks that rule rather than the system alone", /reducedMotion\(\)/.test(hop) && !/matchMedia/.test(hop), hop.slice(0, 300))
    const row = await read("src/renderer/src/components/RowTitle.vue")
    check("the sliding row title reads the same one helper instead of its own copy", /reducedMotion/.test(row) && !/function reduced\(\)/.test(row))
  }

  // ---------------------------------------------------------------- R15-U1-9
  section("Round 15 (U1-9): a skill row is as tall as the search box above it")
  {
    const source = await read("src/renderer/src/components/Composer.vue")
    const css = /<style scoped>([\s\S]*)<\/style>/.exec(source)?.[1] ?? ""
    const heights = rulesSetting(css, "height")
    const skill = heights.find((rule) => /skill-item/.test(rule.selector))
    const base = heights.find((rule) => rule.selector === ".item")
    check("both rules are still there", Boolean(skill) && Boolean(base), { skill, base })
    /* Read through lane U3's scaling: both are written `calc(Npx * var(--ui-font-scale, 1))`, which is Npx at the default size. */
    const resting = (value: string | undefined) => /^(?:calc\()?([\d.]+)px/.exec(value ?? "")?.[1]
    check("the skill row asks for 30, the menu row for 28", resting(skill?.value) === "30" && resting(base?.value) === "28", { skill, base })
    /* The cascade, not the reading of it: the modifier has to outscore the base rule, because it is written first. */
    const wins = skill && base && (specificity(skill.selector) > specificity(base.selector) || skill.at > base.at)
    check("and the skill row's rule wins the cascade over it", Boolean(wins), { skill: skill && specificity(skill.selector), base: base && specificity(base.selector), order: [skill?.at, base?.at] })
    const search = heights.find((rule) => rule.selector === ".skill-search")
    check("which is the height the search box beside it uses", search?.value === skill?.value, { search, skill })
  }

  // --------------------------------------------------------------- R15-U1-10
  section("Round 15 (U1-10): the review tab drops a read that is no longer the newest")
  {
    const source = await read("src/renderer/src/components/right/RpReview.vue")
    const load = /async function load\(\)[\s\S]*?\n\}/.exec(source)?.[0] ?? ""
    const patch = /async function loadPatch\([\s\S]*?\n\}/.exec(source)?.[0] ?? ""
    const guards = (body: string, expression: RegExp) => (body.match(new RegExp(expression, "g")) ?? []).length
    check(
      "the status read carries a number, and both the answer and the failure check it and the project they were asked for",
      /const mine = \+\+readSeq/.test(load) && guards(load, /mine !== readSeq \|\| props\.root !== root/) >= 2,
      load.slice(0, 500),
    )
    check("the diff read does the same", /const mine = \+\+patchSeq/.test(patch) && guards(patch, /mine === patchSeq && props\.root === root/) >= 2, patch.slice(0, 500))
    check("and changing the project retires whatever git is still working on", /readSeq\+\+/.test(source) && /patchSeq\+\+/.test(source))
  }
}
