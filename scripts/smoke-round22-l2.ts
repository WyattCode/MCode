/**
 * Round 22, lane L2: the findings round 21's right-panel lane reported outside
 * its own brief and left undone, each re-read against MiMo 26.920 before it was
 * acted on. Every check here fails on the code as lane F3 left it.
 *
 * Two of the seven turned out to be false once MiMo was read rather than
 * summarised, so what they guard is that MCode is *not* "fixed" back:
 *   - the launcher glyph is 16px, because every tool MCode launches carries
 *     MiMo's `figma-830-tool` class, whose rule overrides the 20px `.i.big`;
 *   - the docx revision colours stay literal, because they already are MiMo's
 *     --color-revision-* / --color-danger-* values and this round may not add
 *     token names to carry them.
 *
 * smoke.ts calls `roundTwentyTwoLaneTwoChecks` with its own check and section.
 * `root` is the checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { LAUNCH_ORDER } from "../src/renderer/src/lib/right-tools"

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** The bodies of every rule whose selector (or last selector of a list) is exactly `selector`, in order. */
function rule(css: string, selector: string): string {
  const bodies: string[] = []
  for (let at = css.indexOf(`\n${selector} {`); at >= 0; at = css.indexOf(`\n${selector} {`, at + 1)) {
    const open = css.indexOf("{", at)
    bodies.push(css.slice(open + 1, css.indexOf("}", open)))
  }
  return bodies.join("\n")
}

export async function roundTwentyTwoLaneTwoChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")
  const panel = code(await read("src/renderer/src/components/RightPanel.vue"))
  const office = code(await read("src/renderer/src/components/right/OfficeTab.vue"))
  const html = code(await read("src/renderer/src/components/right/HtmlTab.vue"))
  const files = code(await read("src/renderer/src/components/right/RpFiles.vue"))
  const versions = code(await read("src/renderer/src/components/right/VersionHistory.vue"))
  const diffTab = code(await read("src/renderer/src/components/right/RpDiffTab.vue"))
  const review = code(await read("src/renderer/src/components/right/RpReview.vue"))
  const docx = code(await read("src/renderer/src/components/right/DocxView.vue"))
  const subagents = code(await read("src/renderer/src/components/right/RpSubagents.vue"))
  const chips = code(await read("src/renderer/src/components/AnnotationChips.vue"))
  const errors = code(await read("src/renderer/src/components/ErrorBoundary.vue"))
  const paneBoundary = code(await read("src/renderer/src/components/right/PaneBoundary.vue"))

  // ------------------------------------------------------------------ R22-L2-1
  section("Round 22 (L2-1): the selected panel tab stands on --color-bg, not on white")
  {
    check("the active tab takes the page colour", /background: var\(--surface-page\);/.test(rule(panel, ".rp-tab.active")), rule(panel, ".rp-tab.active"))
    check("and no longer the raised white", !/--surface-raised/.test(rule(panel, ".rp-tab.active")))
    check("its line is still MiMo's --color-line", /border-color: var\(--border-weak\);/.test(rule(panel, ".rp-tab.active")))
    check("nowhere does it fall back to --surface-raised", !/\.rp-tab\.active \{\s*background: var\(--surface-raised\);/.test(panel))
    check(
      "and both dark overrides keep it, because `:root[…] .rp-tab` outweighs `.rp-tab.active` and would otherwise paint it unselected",
      (panel.match(/\.rp-tab\.active \{\s*background: var\(--surface-page\);/g) ?? []).length === 2,
      panel.match(/\.rp-tab\.active \{[^}]*\}/g) ?? [],
    )
    check("while the inactive tab keeps MiMo's --color-side-active", /background: #f1f0ec;/.test(rule(panel, ".rp-tab")) && /background: var\(--surface-selected\);/.test(panel))
  }

  // ------------------------------------------------------------------ R22-L2-2
  section("Round 22 (L2-2): every fill MiMo paints with --color-bg leaves --surface-base, which is #141414 in dark where MiMo is #181818")
  {
    for (const [name, source] of [["the office head", office], ["the HTML head", html], ["the files head", files]] as const) {
      check(`${name}'s .fc-btn stands on the page colour`, /background: var\(--surface-page\);/.test(rule(source, ".fc-btn")), rule(source, ".fc-btn"))
      check(`and ${name}'s .fc-btn no longer on the app ground`, !/--surface-base/.test(rule(source, ".fc-btn")))
    }
    check("the version popup's restore button too", /background: var\(--surface-page\);/.test(rule(versions, ".vp-restore")) && !/--surface-base/.test(rule(versions, ".vp-restore")), rule(versions, ".vp-restore"))
    check("and the diff tab's chosen layout, which MiMo writes bg-bg", /background: var\(--surface-page\);/.test(rule(diffTab, ".dt-seg-btn.on")), rule(diffTab, ".dt-seg-btn.on"))
    check(
      "the two MiMo paints with --color-side keep --surface-base, whose dark half is that token's own #141414",
      /background: var\(--surface-base\);/.test(rule(docx, ".docx-rail")) && /background: var\(--surface-base\);/.test(rule(code(await read("src/renderer/src/components/right/OfficeFallback.vue")), ".of-note")),
    )
  }

  // ------------------------------------------------------------------ R22-L2-3
  section("Round 22 (L2-3): MiMo's txt ink where MCode reached for the strong one")
  {
    check("the review's refresh darkens to the body ink under the pointer", /color: var\(--text-body\);/.test(rule(review, ".rv-refresh:hover:not(:disabled)")), rule(review, ".rv-refresh:hover:not(:disabled)"))
    check("and keeps MiMo's --color-menu-hover behind it", /background: var\(--surface-hover\);/.test(rule(review, ".rv-refresh:hover:not(:disabled)")))
    check("the layout buttons hover to the body ink", /color: var\(--text-body\);/.test(rule(diffTab, ".dt-seg-btn:hover")), rule(diffTab, ".dt-seg-btn:hover"))
    check("the chosen one is written in it as well", /color: var\(--text-body\);/.test(rule(diffTab, ".dt-seg-btn.on")))
    check("neither reaches for --text-strong any more", !/--text-strong/.test(rule(diffTab, ".dt-seg-btn:hover") + rule(diffTab, ".dt-seg-btn.on") + rule(review, ".rv-refresh:hover:not(:disabled)")))
    check("the revision rail's head is MiMo's --color-txt", /color: var\(--text-body\);/.test(rule(docx, ".rail-head")), rule(docx, ".rail-head"))
    check("the rail's own rows keep the strong ink, which is what MiMo writes them in", /color: var\(--text-strong\);/.test(rule(docx, ".card-text")))
  }

  // ------------------------------------------------------------------ R22-L2-4
  section("Round 22 (L2-4): the launcher glyph is 16px because MiMo's own override says so")
  {
    check("the glyph is 16 square", /width: 16px;/.test(rule(panel, ".lc-icon")) && /height: 16px;/.test(rule(panel, ".lc-icon")), rule(panel, ".lc-icon"))
    check("with MiMo's 2px of side air, which only the same override carries", /margin: 0 2px;/.test(rule(panel, ".lc-icon")))
    check(
      "and the launcher ships none of the two types MiMo draws at 20 (automation, simulator), so the 20px rule never applies",
      !LAUNCH_ORDER.includes("automation" as (typeof LAUNCH_ORDER)[number]) && !LAUNCH_ORDER.includes("simulator" as (typeof LAUNCH_ORDER)[number]),
      LAUNCH_ORDER,
    )
  }

  // ------------------------------------------------------------------ R22-L2-5
  section("Round 22 (L2-5): a literal size is copied where it cannot clip, and only there")
  {
    check("the subagent subtitle is MiMo's literal 11px", /font-size: 11px;/.test(rule(subagents, ".rp-subagent-detail-subtitle")), rule(subagents, ".rp-subagent-detail-subtitle"))
    check("and no longer scales", !/--ui-font-scale/.test(rule(subagents, ".rp-subagent-detail-subtitle")))
    check("the model pill pins the same 11px, as MiMo pins it", /font-size: 11px;/.test(rule(subagents, ".rp-subagent-model")), rule(subagents, ".rp-subagent-model"))
    check("the head that holds them is a min-height, so a larger UI font pushes it open rather than cutting it", /min-height: 58px;/.test(rule(subagents, ".rp-subagent-detail-head")) && !/[^-]height: 58px;/.test(rule(subagents, ".rp-subagent-detail-head")))
    check("the annotation chip keeps its scaling height", /height: calc\(24px \* var\(--ui-font-scale, 1\)\);/.test(rule(chips, ".cchip")), rule(chips, ".cchip"))
    check("because its label scales in MiMo too, and a literal 24 would cut it", /font-size: calc\(13px \* var\(--ui-font-scale, 1\)\);/.test(rule(chips, ".cchip")) && /overflow: hidden;/.test(rule(chips, ".cchip")))
  }

  // ------------------------------------------------------------------ R22-L2-6
  section("Round 22 (L2-6): the docx revision colours are MiMo's token values, written out")
  {
    const pairs: [string, string, string][] = [
      [".card-badge.del", "#d93025", "#fdecea"],
      [".card-badge.cmt", "#6b46c1", "#f3ecff"],
    ]
    for (const [selector, fg, bg] of pairs) {
      check(`${selector} is MiMo's light pair`, rule(docx, selector).includes(`color: ${fg};`) && rule(docx, selector).includes(`background: ${bg};`), rule(docx, selector))
    }
    check("the rail's bar and elbow are --color-revision-bar", /stroke: #7c3aed;/.test(rule(docx, ".rail-bar")) && /stroke: #7c3aed;/.test(rule(docx, ".rail-elbow")))
    check("the revisions pill is the --color-revision-ins pair, edge included", /color: #2b6cb0;/.test(rule(docx, ".rail-pill")) && /background: #e6f0fa;/.test(rule(docx, ".rail-pill")) && /border: 1px solid #2b6cb0;/.test(rule(docx, ".rail-pill")))
    check("and dark turns all four over, which MiMo's tokens do for it", /#ff9b7f/.test(docx) && /#3a2320/.test(docx) && /#c4b5fd/.test(docx) && /#2a2140/.test(docx) && /#a78bfa/.test(docx) && /#7ab5e8/.test(docx) && /#1c2b3d/.test(docx))
    check("no token name was invented to hold them", !/--(revision|danger)[a-z-]*/.test(docx), docx.match(/--(revision|danger)[a-z-]*/g) ?? [])
  }

  // ------------------------------------------------------------------ R22-L2-7
  section("Round 22 (L2-7): both error strips sit where MiMo's sits, flush in the region that failed")
  {
    check("the conversation's boundary carries no margin", !/margin/.test(rule(errors, ".render-error")), rule(errors, ".render-error"))
    check("the pane boundary carries none either", !/margin/.test(rule(paneBoundary, ".pane-error")), rule(paneBoundary, ".pane-error"))
    check("and both keep MiMo's 8 by 12 on an 8px corner over red-50", /padding: 8px 12px;/.test(rule(errors, ".render-error")) && /padding: 8px 12px;/.test(rule(paneBoundary, ".pane-error")) && /background: #fef2f2;/.test(rule(errors, ".render-error")) && /background: #fef2f2;/.test(rule(paneBoundary, ".pane-error")))
    check("the retry still holds the strip's end", /margin-inline-start: auto;/.test(rule(errors, ".retry")), rule(errors, ".retry"))
  }
}
