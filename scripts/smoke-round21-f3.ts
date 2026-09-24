/**
 * Round 21, lane F3: the right panel, its viewers and the terminal dock, read
 * against MiMo 26.920. Each check fails on the code before its fix.
 *
 * Most of what the lane settled lives in markup and CSS, so it is read from
 * the source here; the lane's Electron probe measured the result in a real
 * window, in both schemes, and its numbers are in the report. smoke.ts calls
 * `roundTwentyOneF3Checks` with its own check and section. `root` is the
 * checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { barMode } from "../src/shared/browser-page"
import { ADD_MENU_ORDER } from "../src/renderer/src/lib/right-tools"

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

/** MiMo's --color-txt, which --text-body carries: 80% ink on light, #f4f4f5 in dark. */
const TXT = "var(--text-body)"
/** The same, safe to drop into a pattern - the token's brackets are not a group. */
const TXT_RE = TXT.replace(/[()]/g, "\\$&")

export async function roundTwentyOneF3Checks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")
  const panel = code(await read("src/renderer/src/components/RightPanel.vue"))
  const files = code(await read("src/renderer/src/components/right/RpFiles.vue"))
  const review = code(await read("src/renderer/src/components/right/RpReview.vue"))
  const subagents = code(await read("src/renderer/src/components/right/RpSubagents.vue"))
  const versions = code(await read("src/renderer/src/components/right/VersionHistory.vue"))
  const browser = code(await read("src/renderer/src/components/right/RpBrowser.vue"))
  const drawer = code(await read("src/renderer/src/components/TerminalDrawer.vue"))
  const image = code(await read("src/renderer/src/components/ImagePreview.vue"))
  const boundary = code(await read("src/renderer/src/components/right/PaneBoundary.vue"))
  const office = code(await read("src/renderer/src/components/right/OfficeTab.vue"))
  const html = code(await read("src/renderer/src/components/right/HtmlTab.vue"))
  const chips = code(await read("src/renderer/src/components/AnnotationChips.vue"))

  // ------------------------------------------------------------------ R21-F3-1
  section("Round 21 (F3-1): the panel's secondary labels are MiMo's --color-mut, not its dimmest grey")
  {
    check("an inactive tab's label is muted", /\.rp-tab \{[^}]*color: var\(--text-base\);/.test(panel), rule(panel, ".rp-tab").slice(0, 200))
    check("and its fill is MiMo's --color-side-active", /\.rp-tab \{[^}]*background: #f1f0ec;/.test(panel))
    check("its glyph takes no colour of its own, so it follows the label", !/\.rpt-ic \{[^}]*color:/.test(panel), rule(panel, ".rpt-ic"))
    check("the review's count pill and its refresh are muted", /color: var\(--text-base\);/.test(rule(review, ".rv-pill")) && /color: var\(--text-base\);/.test(rule(review, ".rv-refresh")))
    check("and the pill stands on the code fill, which lifts in dark", /background: var\(--surface-layer\);/.test(rule(review, ".rv-pill")))
    check("the files head, its tree glyph and its notes are muted", /color: var\(--text-base\);/.test(rule(files, ".fv-head")) && /color: var\(--text-base\);/.test(rule(files, ".fv-ic")) && /color: var\(--text-base\);/.test(rule(files, ".fv-note")))
    check("so are the find bar's magnifier and its buttons", /color: var\(--text-base\);/.test(rule(files, ".fv-find-ic")) && /color: var\(--text-base\);/.test(rule(files, ".fv-find-btn")))
    check("no viewer note is left on --text-weak", !/color: var\(--text-weak\);/.test(rule(code(await read("src/renderer/src/components/right/PdfView.vue")), ".pdf-note")))
    check("the subagents tab spells mut, dim and txt as tokens rather than mixes of the strong ink", !/color: color-mix\(in srgb, var\(--text-strong\) \d+%/.test(subagents), (subagents.match(/color: color-mix\(in srgb, var\(--text-strong\) \d+%/g) ?? []).join(" "))
  }

  // ------------------------------------------------------------------ R21-F3-2
  section("Round 21 (F3-2): MiMo cancels the subagent transcript's box inside the tab")
  {
    const box = rule(subagents, ".rp-subagent-transcript")
    check("the transcript is the tab's own scroller, 14 / 16 / 28 in", /flex: 1;/.test(box) && /padding: 14px 16px 28px;/.test(box) && /overflow: auto;/.test(box), box)
    check("with no border, corner, ceiling or margin left of the cancelled box", !/border(?!-box)|max-height|margin-top/.test(box), box)
    check("and the stream inside it is not padded a second time", /padding: 0;/.test(rule(subagents, ".rp-subagent-stream :deep(.inner)")))
    check("its note is MiMo's 2px, not a 16px inset", /padding: 2px 0;/.test(rule(subagents, ".rp-subagent-note")))
  }

  // ------------------------------------------------------------------ R21-F3-3
  section("Round 21 (F3-3): the launcher card is a name and a key cap, as MiMo draws it")
  {
    check("the description element is gone, as its only MiMo rule is display:none", !/lc-desc/.test(panel))
    const strings = await read("src/renderer/src/lib/i18n.ts")
    check("and no language table still carries a launch description", !/"launch\.\w+Desc":/.test(strings))
    check("MiMo's .launch-card .i.big ink is --color-txt", new RegExp(`\\.lc-icon \\{[^}]*color: ${TXT_RE};`).test(panel), rule(panel, ".lc-icon"))
    check("and the name beside it takes the same ink", rule(panel, ".lc-name").includes(`color: ${TXT};`))
  }

  // ------------------------------------------------------------------ R21-F3-4
  section("Round 21 (F3-4): the plus menu names 子智能体, as MiMo's dNe does")
  {
    check("it lists review, terminal, browser, files, chat and subagents in that order", ADD_MENU_ORDER.join(",") === "review,terminal,browser,files,chat,subagents", ADD_MENU_ORDER.join(","))
    check("and picking it opens the one subagents tab", /if \(key === "subagents"\) rp\.openSubagents\(\)/.test(panel))
    check("its label and glyph come from the tab's own, not from TOOL_INFO", /tool === "subagents" \? "launch\.subagents"/.test(panel) && /icon: iconOf\(tool\)/.test(panel))
  }

  // ------------------------------------------------------------------ R21-F3-5
  section("Round 21 (F3-5): the version popup is MiMo's, down to its teal pill")
  {
    const pop = rule(versions, ".version-pop")
    check("340 wide, 320 tall, 8 all round on a 10px corner", /width: 340px;/.test(pop) && /max-height: 320px;/.test(pop) && /padding: 8px;/.test(pop) && /border-radius: 10px;/.test(pop), pop)
    check("under MiMo's softer shadow, above everything at 10000", /box-shadow: 0 8px 28px rgba\(0, 0, 0, 0\.12\);/.test(pop) && /z-index: 10000;/.test(pop))
    check("the head carries no rule under it", !/border-bottom/.test(rule(versions, ".vp-head")), rule(versions, ".vp-head"))
    check("rows are 8 apart at 6 by 4 on an 8px corner, over a 44px column", /gap: 8px;/.test(rule(versions, ".vp-row")) && /padding: 6px 4px;/.test(rule(versions, ".vp-row")) && /width: 44px;/.test(rule(versions, ".vp-left")))
    check("the current mark is MiMo's filled teal pill", /background: #e8f5f3;/.test(rule(versions, ".vp-current")) && /color: #0f766e;/.test(rule(versions, ".vp-current")) && /border-radius: 999px;/.test(rule(versions, ".vp-current")))
    check("restore is filled on the page colour at 4 by 8 on a 6px corner", /background: var\(--surface-page\);/.test(rule(versions, ".vp-restore")) && /padding: 4px 8px;/.test(rule(versions, ".vp-restore")) && /border-radius: 6px;/.test(rule(versions, ".vp-restore")))
    check("and the tip is MiMo's dark slate box", /background: rgba\(15, 23, 42, 0\.92\);/.test(rule(versions, ".vp-tip")) && /color: #fff;/.test(rule(versions, ".vp-tip")) && /z-index: 10001;/.test(rule(versions, ".vp-tip")))
  }

  // ------------------------------------------------------------------ R21-F3-6
  section("Round 21 (F3-6): the files tab reads as MiMo's")
  {
    check("the head's spacer never closes past 8", /min-width: 8px;/.test(rule(files, ".fv-spacer")))
    check("the folder chevron is 1.7, like its neighbours", !/class="fv-chev"[^>]*stroke-width="2"/.test(files))
    check("the tree's grip is MiMo's 7px resizer", /width: 7px;/.test(rule(files, ".fv-grip")))
    check("a code line has no end padding, as MiMo's pre has none", !/padding-inline-end/.test(rule(files, ".fv-text")), rule(files, ".fv-text"))
    check("the head button does not fade when disabled, as MiMo's does not", !/\.fv-icon:disabled/.test(files))
    check("and .fc-btn shows the default cursor when it is", /cursor: default;/.test(rule(files, ".fc-btn:disabled")))
    check("a search hit's folder is a flat 11px, as MiMo writes it", /font-size: 11px;/.test(rule(files, ".fv-search-dir")))
    check("rows, the filter, code, the editor and .fc-btn take --color-txt", [".fv-row", ".fv-filter input", ".fv-text", ".fv-editor", ".fc-btn"].every((selector) => rule(files, selector).includes(`color: ${TXT};`)))
    check("a markdown file is plain body type, not a reply", /font-weight: 400;/.test(rule(files, ".fv-doc :deep(.text)")) && /margin: 8px 0;/.test(rule(files, ".fv-doc :deep(.md-p)")))
    check("and the row menu's glyphs are untinted: MiMo's .menu-item .i outranks .ft-ic", !/iconColor/.test(files))
  }

  // ------------------------------------------------------------------ R21-F3-7
  section("Round 21 (F3-7): the browser bar follows MiMo's own measurements")
  {
    check("the address placeholder is the preflight half-ink", /\.rb-url::placeholder \{\s*opacity: 1;\s*color: color-mix\(in oklab, currentcolor 50%, transparent\);/.test(browser))
    check("the empty tab has no inset of its own", !/margin-inline/.test(rule(browser, ".rb-local")), rule(browser, ".rb-local"))
    check("no hairline is a fixed #f1f1f1 any more", !/#f1f1f1/.test(browser), (browser.match(/#f1f1f1/g) ?? []).length)
    check("the Ctrl+. cap and the annotate hint are platform-formatted", !/\{\{ ANNOTATE_COMBO \}\}/.test(browser) && !/combo: ANNOTATE_COMBO/.test(browser))
    check("the annotate button is MiMo's plain 34 high", /\.rb-annotate \{[^}]*height: 34px;/.test(browser))
    check("the address, the failed page's address and the cap follow the interface font", !/font-size: calc\(1[12]px \* var\(--code-font-scale, 1\)\)/.test(browser), (browser.match(/calc\(\d+px \* var\(--code-font-scale, 1\)\)/g) ?? []).join(" "))
    // MiMo writes the zoom stepper 24 square under a var(--text-14) glyph, and the cap an 18px line under a var(--text-11)
    // one; both cut into their own text at the top of the interface-size slider, so round 15's U3 rule keeps them scaling.
    check("the stepper and the cap's line still scale, where MiMo's plain px would clip", /width: calc\(24px \* var\(--ui-font-scale, 1\)\)/.test(browser) && /line-height: calc\(18px \* var\(--ui-font-scale, 1\)\);/.test(rule(browser, ".rb-annotate-kbd")))
    check("each menu label is a span that never wraps", (browser.match(/class="rb-item-name"/g) ?? []).length === 4 && /white-space: nowrap;/.test(rule(browser, ".rb-item-name")))
    check("a disabled back button still lights under the pointer", /\.rb-round:hover \{/.test(browser) && !/\.rb-round:hover:not\(:disabled\)/.test(browser))
  }

  // ------------------------------------------------------------------ R21-F3-8
  section("Round 21 (F3-8): a bar measured before it is shown is the full bar")
  {
    check("a zero width is full, not mini", barMode(0) === "full", barMode(0))
    check("so is a negative one", barMode(-1) === "full", barMode(-1))
    check("and a width that is no number at all", barMode(Number.NaN) === "full", barMode(Number.NaN))
    check("the three widths themselves are unchanged", barMode(299) === "mini" && barMode(300) === "compact" && barMode(380) === "full")
  }

  // ------------------------------------------------------------------ R21-F3-9
  section("Round 21 (F3-9): the terminal dock is MiMo's bar")
  {
    check("the bar's 38 is a floor, so it grows with the interface font", /min-height: 38px;/.test(rule(drawer, ".head")) && !/[^-]height: 38px;/.test(rule(drawer, ".head")), rule(drawer, ".head"))
    check("the resizer sits at 30, over the panel it divides", /z-index: 30;/.test(rule(drawer, ".resize")))
    check("the active tab stands on the page colour", /background: #fffefd;/.test(rule(drawer, ".tab.on")))
    check("the tab's label and the notice take --color-txt", rule(drawer, ".tab").includes(`color: ${TXT};`) && rule(drawer, ".mismatch").includes(`color: ${TXT};`))
    check("the close mark's hover is MiMo's #00000014, which --overlay-hover now holds", /background: var\(--overlay-hover\);/.test(rule(drawer, ".tab-close:hover")))
    check("and the primary pill is the txt ink filled, its label the page colour", /background: #151c13cc;/.test(rule(drawer, ".mismatch-btn.primary")) && /color: #fffefd;/.test(rule(drawer, ".mismatch-btn.primary")))
    const terminal = code(await read("src/renderer/src/components/right/RpTerminal.vue"))
    check("the tab's fill is on the terminal host, where MiMo puts it", !/background/.test(rule(terminal, ".rp-term")) && /background: var\(--surface-raised\);/.test(rule(terminal, ".rp-term :deep(.term),\n.rp-term :deep(.term-host)")))
  }

  // ------------------------------------------------------------------ R21-F3-10
  section("Round 21 (F3-10): the image preview's glyphs and lift are MiMo's")
  {
    check("the zoom circles are r7 at 11,11", (image.match(/<circle cx="11" cy="11" r="7" \/>/g) ?? []).length === 2)
    check("the rotate arc has radius 9", /d="M21 12a9 9 0 1 1-3-6\.7L21 8"/.test(image))
    check("reset is four rounded corners, not four brackets", /d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/.test(image))
    check("and download starts at 3 over a 21 floor", /d="M12 3v12M7 10l5 5 5-5M5 21h14"/.test(image))
    check("the close button blurs at --blur-sm", /backdrop-filter: blur\(8px\);/.test(rule(image, ".ip-close")))
    check("and the picture carries MiMo's shadow-pop literal, not the ringed --shadow-lg", /box-shadow: 0 12px 40px #00000024;/.test(rule(image, ".ip-transform img")))
  }

  // ------------------------------------------------------------------ R21-F3-11
  section("Round 21 (F3-11): the pane's error strip is red throughout, as MiMo's is")
  {
    check("its title is red-600 and its message red-500/70", /color: #dc2626;/.test(rule(boundary, ".pe-title")) && /color: rgb\(239 68 68 \/ 0\.7\);/.test(rule(boundary, ".pe-message")))
    check("retry is red-bordered on white, hovering to red-100", /color: #dc2626;/.test(rule(boundary, ".pe-retry")) && /background: #ffffff;/.test(rule(boundary, ".pe-retry")) && /background: #fee2e2;/.test(rule(boundary, ".pe-retry:hover")))
    check("dark takes red-400 and red-400/50", /:root\[data-theme="dark"\] \.pe-title \{\s*color: #f87171;/.test(boundary) && /:root\[data-theme="dark"\] \.pe-message \{\s*color: rgb\(248 113 113 \/ 0\.5\);/.test(boundary))
    check("and the strip carries no margin of its own", !/margin/.test(rule(boundary, ".pane-error")), rule(boundary, ".pane-error"))
    const errors = code(await read("src/renderer/src/components/ErrorBoundary.vue"))
    check("the conversation's own boundary gains the dark half its message was missing", /:root\[data-theme="dark"\] \.detail \{\s*color: rgb\(248 113 113 \/ 0\.5\);/.test(errors))
  }

  // ------------------------------------------------------------------ R21-F3-12
  section("Round 21 (F3-12): the office and HTML heads, and the annotation overlays")
  {
    check("the office meta lets its two spaces collapse, as MiMo's markup does", !/white-space: pre;/.test(rule(office, ".office-meta")), rule(office, ".office-meta"))
    check("the HTML tab's open-in-browser is never disabled", !/data-html-open-browser[^>]*:disabled/.test(html))
    check("and its .fc-btn is the office tab's rule: gap 6, no centring", /gap: 6px;/.test(rule(html, ".fc-btn")) && !/justify-content: center;/.test(rule(html, ".fc-btn")))
    check("both heads' buttons stand on the page colour in the txt ink", rule(html, ".fc-btn").includes(`color: ${TXT};`) && rule(office, ".fc-btn").includes(`color: ${TXT};`))
    check("the composer chip takes MiMo's chip tokens", /background: #0000000d;/.test(rule(chips, ".cchip")) && /color: #137a3f;/.test(rule(chips, ".cchip-name")) && /color: #8a8a82;/.test(rule(chips, ".cchip-rm,\n.ann-rm")))
    check("and the annotation list hangs on the page colour under --shadow-menu", /background: #fffefd;/.test(rule(chips, ".ann-pop")) && /box-shadow: var\(--shadow-menu\);/.test(rule(chips, ".ann-pop")))
  }

  // ------------------------------------------------------------------ R21-F3-13
  section("Round 21 (F3-13): macOS keeps MiMo's own arithmetic (unverified - there is no Mac here)")
  {
    check("the head row is centred on the traffic lights at 10 down", /\.app\[data-platform="darwin"\] \.rp-head \{\s*padding-block: 10px 0;/.test(panel))
    check("and the folded fullscreen head starts at 160", /\.right-panel\.fullscreen\.side-collapsed \.rp-head \{\s*padding-inline-start: 160px;/.test(panel))
    check("while off macOS the user's left-aligned 82 still wins", /\.app:not\(\[data-platform="darwin"\]\) \.right-panel\.fullscreen\.side-collapsed \.rp-head \{\s*padding-inline-start: 82px;/.test(panel))
  }
}
