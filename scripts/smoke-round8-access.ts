/**
 * Round 8: the keyboard and assistive-technology barriers audited as A1-A15.
 *
 * Kept apart from smoke.ts the way rounds five to seven are, and called with
 * its check and section. These are read from the source: what they guard is
 * markup and wiring that only a window can exercise, and the window side is
 * measured by the round-eight probe. Each check names the one rule a later
 * edit could quietly undo.
 */
import fs from "node:fs"
import path from "node:path"
import type { Check } from "./smoke-round5"

const RENDERER = path.join("src", "renderer", "src")

function read(file: string): string {
  return fs.readFileSync(path.join(RENDERER, file), "utf8")
}

function sources(directory: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(vue|ts)$/.test(entry.name) && entry.name !== "i18n.ts") out.push(full)
  }
  return out
}

/**
 * Whether a clipboard write at `line` is answered when it is refused: a
 * `.catch(` on the same statement, or an open `try {` above it in the same
 * function. A refusal nobody catches reaches the window's fatal handler.
 */
function guarded(lines: string[], line: number): boolean {
  if (/\.catch\(|\.then\([^)]*,/.test(lines[line])) return true
  // Walk out through the enclosing blocks until a try or the function itself.
  let depth = 0
  for (let at = line - 1; at >= Math.max(0, line - 40); at--) {
    const text = lines[at]
    depth += (text.match(/\}/g) ?? []).length - (text.match(/\{/g) ?? []).length
    if (depth >= 0) continue
    if (/\btry\s*\{\s*$/.test(text)) return true
    if (/\bfunction\b|=>\s*\{\s*$/.test(text)) return false
    depth = 0
  }
  return false
}

export async function roundEightAccessChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("round 8 access: a refused clipboard is a notice")
  {
    const unguarded: string[] = []
    for (const file of sources(RENDERER)) {
      // The one helper that throws on purpose; its callers are checked through it.
      if (file.endsWith(path.join("lib", "diagram.ts"))) continue
      const lines = fs.readFileSync(file, "utf8").split("\n")
      lines.forEach((text, index) => {
        if (/navigator\.clipboard\??\.write(Text)?\(/.test(text) && !guarded(lines, index)) unguarded.push(`${path.relative(RENDERER, file)}:${index + 1}`)
      })
    }
    check("every clipboard write in the window catches a refusal", unguarded.length === 0, unguarded)
    const stream = read("components/MessageStream.vue")
    check("a reply's copy says 复制失败 when the clipboard refuses", /async function copyToClipboard[\s\S]{0,200}catch \{\s*notifyFailure\(t\("code\.copyFailed"\)\)/.test(stream))
  }

  section("round 8 access: a keyboard focus ring (A1)")
  {
    const base = read("styles/base.css")
    const ring = /:where\(([^)]*\([^)]*\))*[^)]*\):focus-visible \{\s*outline: 2px solid var\(--interactive\)/.exec(base)
    check("controls reached by keyboard draw the accent ring", Boolean(ring))
    check("the ring covers buttons, tabs, switches and anything tabbable", Boolean(ring && ["button", '[role="tab"]', '[role="switch"]', "[tabindex]:not"].every((part) => ring[0].includes(part))))
    check("a text field is ringed only after a Tab press", /:root\[data-focus-key\] :is\([^{]*textarea[^{]*\):focus \{\s*outline: 2px/.test(base))
    const tracker = read("lib/focus-ring.ts")
    check("Tab sets the mark and a pointer press clears it", /"Tab"\) root\.dataset\.focusKey = ""/.test(tracker) && /"pointerdown", \(\) => delete root\.dataset\.focusKey/.test(tracker))
    check("the mark is installed at start", /installFocusRing\(\)/.test(read("main.ts")))
  }

  section("round 8 access: a permission request is announced (A2)")
  {
    const dock = read("components/QuestionDock.vue")
    check("the dock is an alertdialog named by its card's title", /role="alertdialog"/.test(dock) && /:aria-labelledby="LABELLED_BY\.join/.test(dock) && /:aria-describedby="DESCRIBED_BY\.join/.test(dock))
    check("a new request is spoken assertively", /announce\(textOf\(\[\.\.\.LABELLED_BY, \.\.\.DESCRIBED_BY\]\), "assertive"\)/.test(dock))
    const perm = read("components/PermissionDialog.vue")
    const form = read("components/parts/QuestionForm.vue")
    check("the permission card and the question name the title and subject the dock points at", ['id="confirm-dock-title"', 'id="confirm-dock-desc"'].every((id) => perm.includes(id) && form.includes(id) && dock.includes(id)))
    const announcer = read("lib/announce.ts")
    check("the live regions exist before anything is said", /installAnnouncer\(\)/.test(read("main.ts")) && /aria-live", urgency\)/.test(announcer))
  }

  section("round 8 access: the review and the right panel from the keyboard (A4, A5)")
  {
    const diff = read("components/parts/DiffBody.vue")
    check("a file in the review's list is a Tab stop that Enter and Space open", /class="db-list-line"\s+role="button"\s+tabindex="0"[\s\S]{0,80}@keydown\.enter\.space\.self\.prevent="reveal\(index, true\)"/.test(diff))
    check("a file header is a Tab stop that folds, and says whether it is open", /class="db-head"\s+role="button"\s+tabindex="0"\s+:aria-expanded="!collapsed\.has\(file\.name\)"[\s\S]{0,80}@keydown\.enter\.space\.self\.prevent="toggle/.test(diff))
    const panel = read("components/RightPanel.vue")
    check("the shown right-panel tab is the strip's Tab stop", /:tabindex="tab\.id === rp\.active \? 0 : -1"/.test(panel))
    const drawer = read("components/TerminalDrawer.vue")
    check("a terminal tab's close is a button beside its label, not inside another button (A6)", /<div[^>]*class="tab"[^>]*role="tab"[^>]*tabindex="0"[\s\S]{0,300}<button type="button" class="tab-close"[\s\S]{0,120}<\/div>/.test(drawer) && !/<span class="tab-close"/.test(drawer))
    check("arrows, Home and End walk the tabs; Enter, Space and the Menu key act", /function onTabKey[\s\S]*"Enter"[\s\S]*"ContextMenu"[\s\S]*ArrowRight[\s\S]*"Home"[\s\S]*"End"/.test(panel) && /@keydown="onTabKey\(\$event, tab\.id\)"/.test(panel))
  }
}
