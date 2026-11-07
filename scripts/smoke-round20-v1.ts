/**
 * Round 20, visual lane 1: the conversation stream against MiMo 26.920 - the
 * turn head, the harness column's spacing, the working indicator, the question
 * row, the step greys, and the reply's type and action row. Each check fails
 * on the code before its fix.
 *
 * These live in markup and CSS, so they are read from the source; the lane's
 * Electron probe measured the result in a real window. smoke.ts calls
 * `roundTwentyVisualOneChecks` with its own check and section. `root` is the
 * checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

/** The bodies of every top-level CSS rule whose selector (or last selector of a list) is exactly `selector`, in order. */
function rule(css: string, selector: string): string {
  const bodies: string[] = []
  for (let at = css.indexOf(`\n${selector} {`); at >= 0; at = css.indexOf(`\n${selector} {`, at + 1)) {
    const open = css.indexOf("{", at)
    bodies.push(css.slice(open + 1, css.indexOf("}", open)))
  }
  return bodies.join("\n")
}

export async function roundTwentyVisualOneChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")
  const stream = await read("src/renderer/src/components/MessageStream.vue")
  const steps = await read("src/renderer/src/components/parts/steps.css")
  const body = await read("src/renderer/src/components/parts/MarkdownBody.vue")
  const markdown = await read("src/renderer/src/lib/markdown.ts")
  const template = stream.slice(stream.indexOf("<template>"), stream.indexOf("<style"))

  section("Round 20 V1: the turn head")
  {
    const head = rule(stream, ".run")
    check("V1-1: the head keeps 2px above and below whether running or done", /padding: 2px 0;/.test(head), head)
    check("V1-1: five below it, so the first line is ten clear", /margin-bottom: 5px;/.test(head), head)
    check("V1-1: the label stands on MiMo's 1.6 line", /line-height: calc\(22\.4px \* var\(--ui-font-scale, 1\)\);/.test(rule(stream, ".run-label")))
    check("V1-9a: past an hour the time reads 1h 2m 3s", /`\$\{Math\.floor\(minutes \/ 60\)\}h \$\{minutes % 60\}m \$\{seconds % 60\}s`/.test(stream))
    check("V1-9b: the running head's sweep covers its label and its time", /<span class="run-body" :class="\{ 'running-shimmer': liveTurn\(at\) \}">\s*<span class="run-label">[^\n]*\n\s*<span v-if="headTime\(turn, at\)" class="run-time"/.test(template))
  }

  section("Round 20 V1: the harness column")
  {
    check("V1-2: every row two apart", /\n\.part \+ \.part \{\s*margin-top: 2px;\s*\}/.test(stream))
    check("V1-2: a run of words carries 5px above and below, as a step row does", /padding: 5px 0;/.test(rule(stream, ".part.words")))
    check("V1-2: no row keeps the old 24 / 12 breaks", !/margin-top: 24px;/.test(stream) && !/\.part \+ \.part\.step/.test(stream))
    check("V1-3: a step row's line is 22.4", /line-height: calc\(22\.4px/.test(rule(steps, ".hstep")) && /line-height: calc\(22\.4px/.test(rule(steps, ".hs-h")))
    check("V1-4: a group's open body sits 2 under its summary", /margin-top: 2px;/.test(rule(steps, ".hs-group > .hs-collapse")))
    // A long title is cut inside its code, so the pill keeps its corners; the colour is the title's and the code inherits it, so the dots match.
    const title = rule(steps, ".hs-title")
    const code = rule(steps, ".hs-title code")
    const toolPart = await read("src/renderer/src/components/parts/ToolPart.vue")
    check("V1-4b: the title is a flex row holding the colour, and does not cut the text itself", /display: flex;/.test(title) && /color: #3a3a38;/.test(title) && !/text-overflow/.test(title), title)
    check("V1-4b: the code shrinks, keeps its padding, and sets no colour of its own", /display: flex;/.test(code) && /min-width: 0;/.test(code) && /padding: 1\.5px 5px;/.test(code) && !/\bcolor:/.test(code), code)
    check("V1-4b: its line leaves the pill the height it had inline, so no row grows", /line-height: 1\.25;/.test(code), code)
    check("V1-4b: the head is cut with a dot, the tail keeps the file name", /text-overflow: ellipsis;/.test(rule(steps, ".hs-head")) && /flex: none;/.test(rule(steps, ".hs-tail")))
    check("V1-4b: a failed step reddens its verb, not its title", /'hs-err': state === 'error'[^}]*\}" data-step-verb/.test(toolPart) && !/class="hs-title"\s*:class="\{[^}]*hs-err/.test(toolPart))
  }

  section("Round 20 V1: the working indicator")
  {
    const assistant = template.slice(template.indexOf('class="msg assistant"'), template.indexOf("<EditedFilesCard"))
    check("V1-5: it is drawn inside the running turn's block, after its rows", /<div v-for="row in shown\(turn, at\)"[\s\S]*class="work-indicator"[\s\S]*data-work-loading/.test(assistant), assistant.slice(-600))
    check("V1-5: 14 under a step row", /margin-top: 14px;/.test(rule(stream, ".work-indicator")))
    check("V1-5: 10 under the words being written", /margin-top: 5px;/.test(rule(stream, ".part.words + .work-indicator")))
    check("V1-5: outside the block only while the turn has nothing of its own", /v-if="thinking\(turn, at\) && !answers\(turn, at\)"/.test(template))
  }

  section("Round 20 V1: the question row")
  {
    check("V1-6: the bubble and its time row are 6 + 2 apart", /gap: 6px;/.test(rule(stream, ".msg.user")) && /margin-top: 2px;/.test(rule(stream, ".user-meta")))
    check("V1-7: the question's time is MiMo's muted colour", /color: var\(--text-base\);/.test(rule(stream, ".user-time")))
    check("V1-8: the bubble is MiMo's #f8f7f5 in light", /background: #f8f7f5;/.test(stream.slice(stream.lastIndexOf("\n.user-bubble {"))))
    check("V1-8: and #2e2e2e in dark", /:root\[data-theme="dark"\] \.user-bubble,\s*:root\[data-theme="dark"\] \.asked-edit \{\s*background: #2e2e2e;/.test(stream))
  }

  section("Round 20 V1: step greys and the group head")
  {
    check("V1-8: no automations-page grey left in the step sheet", !/#909091|#919191/.test(steps))
    check("V1-8: a row's words are the thread's muted colour in both themes", /color: var\(--text-base\);/.test(rule(steps, ".hs-h")) && !/:is\(\.hs-h,/.test(steps))
    check("V1-9c: a group head hovers to MiMo's txt", /color: var\(--text-body\);/.test(rule(steps, '.hs-summary:not([aria-disabled="true"]):hover')))
    // The dark half is --text-body's own, so no rule restates it any more.
    const live = /if \(live\) \{([\s\S]*?)return \{ rows: all, foldAt: 0 \}/.exec(stream)?.[1] ?? ""
    check("V1-9d: while running every group of the unfinished stage opens, bar one of edits only; anything said ends the stage", /if \(speaks\(row\)\) break\s*if \(row\.kind === "group" && !editsOnly\(row\.items\)\) row\.open = true/.test(live), live)
    check("V1-9d: a finished turn's last stage that said nothing opens its groups the same way", /row\.kind === "group" && !row\.actor && !editsOnly\(row\.items\)\) row\.open = true/.test(stream))
  }

  section("Round 20 V1: the reply's type")
  {
    check("R-1: the code block's copy is muted", /color: var\(--text-base\);/.test(rule(body, ".text .md-code-copy")))
    check("R-2: line numbers are muted at .6", /color: var\(--text-base\);[\s\S]*opacity: 0\.6;/.test(rule(body, ".text .md-code.md-lined .line::before")))
    check("R-3: code in a block keeps 1.5px 5px", /padding: 1\.5px 5px;/.test(rule(body, ".text .md-code code")))
    const chip = body.slice(body.lastIndexOf("\n.text code {"))
    check("R-4: the chip is #f0f0f2 / #3a3a38 in light, 13px on the text scale, at the weight around it", /color: #3a3a38;\s*background: #f0f0f2;[\s\S]*?font-size: calc\(13px \* var\(--ui-font-scale, 1\)\);\s*\}/.test(chip) && !/font-weight/.test(rule(body, ".text code")))
    check("R-4: and #2e2e2e / #e6e6e6 in dark", /:root\[data-theme="dark"\] \.text code \{\s*color: #e6e6e6;\s*background: #2e2e2e;/.test(body))
    check("R-5: bold is semibold", /font-weight: 600;/.test(rule(body, ".text strong")))
    check("R-6: nested lists keep 22px, 14 below and discs", !/\.md-list \.md-list/.test(body) && /list-style-type: disc;/.test(rule(body, ".text ul.md-list")))
    check("R-7: h6 and quotes are muted", /color: var\(--text-base\);/.test(rule(body, '.text .md-h[data-level="6"]')) && /color: var\(--text-base\);/.test(rule(body, ".text .md-quote")))
    check("R-8: the answer is #151c13 in light and #f4f4f5 in dark; headings inherit it", /color: var\(--text-strong\);/.test(body.slice(body.indexOf("\n.text {\n  /*"))) && /:root\[data-theme="dark"\] \.text \{\s*color: #f4f4f5;/.test(body) && !/\n\.text \.md-h \{[^}]*color/.test(body))
    check("R-9: a reply that opens on a heading keeps its top margin", !/\.md-h:first-child/.test(body))
    check("R-16: cells stop at 30rem and break at words", /max-width: 30rem;\s*overflow-wrap: break-word;/.test(rule(body, ".text .md-table :is(th, td)")))
    check("R-16: only the last body cell drops its end padding", !/\.md-table th:last-child/.test(body) && /padding-inline-end: 0;/.test(rule(body, ".text .md-table td:last-child")))
    check("R-16: rows part on MiMo's line-soft", /border-bottom-color: #0000000d;/.test(rule(body, ".text .md-table td")) && /border-bottom-color: #ffffff12;/.test(body))
    check("R-16: a narrow column keeps a four-column table at its own width", /@container \(max-width: 640px\) \{\s*\.text \.md-table:has\(> thead > tr > th:nth-child\(4\)\) \{\s*width: max-content;/.test(body))
    check("R-17: struck text keeps its colour", !/\.text del \{/.test(body))
    check("R-19: a block fades in over MiMo's .32s ease-out both", /animation: stream-block-in 0\.32s ease-out both;/.test(body))
    check("R-15: the copy glyphs are 14px on a 24 grid with a 2 stroke", /const CODE_GLYPH = 'width="14" height="14" viewBox="0 0 24 24"[^']*stroke-width="2"/.test(markdown) && /\$\{CODE_GLYPH\}/.test(markdown))
    check("R-15: its fade is 150ms", /transition: opacity 0\.15s/.test(rule(body, ".text .md-code-copy")))
  }

  section("Round 20 V1: the action row")
  {
    check("R-11: icons are muted", /color: var\(--text-base\);/.test(rule(stream, ".msg-act")))
    check("R-11: hover is MiMo's txt, which --text-body now carries in both schemes", /color: var\(--text-body\);/.test(rule(stream, ".msg-act:hover")))
    const time = rule(stream, ".msg-time")
    check("R-12: the time is muted and appears without a fade", /color: var\(--text-base\);/.test(time) && !/transition/.test(time), time)
    check("R-12: behind MiMo's line, #f0ebe5 light and #2e2e2e dark", /background: #f0ebe5;/.test(rule(stream, ".msg-time::before")) && /:root\[data-theme="dark"\] \.msg-time::before \{\s*background: #2e2e2e;/.test(stream))
    const copies = template.match(/<svg width="12" height="12" viewBox="0 0 17 20"[^>]*>\s*<path d="M1 11V5a4 4 0 0 1 4-4h6" \/>\s*<rect x="4\.75" y="4\.75" width="11\.25" height="14\.25" rx="2\.25" \/>/g) ?? []
    check("R-13: both copy buttons draw MiMo's portrait sheet with its corner", copies.length === 2, copies.length)
    check("R-13: branch is a stem with a branch and a foot, ringed on the right", /<path d="M2 1\.5v11\.25a3\.5 3\.5 0 0 0 3\.5 3\.5h4\.75M2 6\.75h8\.25" \/>\s*<circle cx="12\.5" cy="6\.75" r="2\.25" \/>\s*<circle cx="12\.5" cy="16\.25" r="2\.25" \/>/.test(template))
    check("R-14: 10 under a media strip", /\.media-strip ~ \.msg-actions\) \{\s*margin-top: 10px;/.test(stream))
  }
}
