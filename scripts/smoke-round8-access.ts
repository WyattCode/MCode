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
    check("arrows, Home and End walk the tabs; Enter, Space and the Menu key act",
      /function onTabKey[\s\S]*"Enter"[\s\S]*"ContextMenu"[\s\S]*ArrowRight[\s\S]*"Home"[\s\S]*"End"/.test(panel) && /@keydown="onTabKey\(\$event, tab\.id\)"/.test(panel))
  }

  section("round 8 access: names that are not drawn (A7, A8, A10)")
  {
    const side = read("components/Sidebar.vue")
    check("the folded rail names 产物中心 and 设置 itself, not through a tip bound before it folded", /:aria-label="collapsed \? t\('side\.railArtifacts'\) : undefined"/.test(side) && /:aria-label="collapsed \? t\('rail\.settings'\) : undefined"/.test(side))
    const unnamed: string[] = []
    for (const file of sources(path.join(RENDERER, "components"))) {
      if (!file.endsWith(".vue")) continue
      const text = fs.readFileSync(file, "utf8")
      for (const match of text.matchAll(/<(button|div|span)\b[^>]*>/g)) {
        const tag = match[0]
        if (!/role="switch"|class="switch"/.test(tag) || /aria-hidden="true"/.test(tag)) continue
        // A switch that is a whole row is named by the row's own text.
        const texty = /class="item |class="row /.test(tag)
        if (!/role="switch"/.test(tag) || !/aria-checked/.test(tag) || (!texty && !/aria-label/.test(tag))) unnamed.push(`${path.basename(file)}:${text.slice(0, match.index).split("\n").length}`)
      }
    }
    check("every drawn switch is a named role=switch with its state", unnamed.length === 0, unnamed)
    for (const file of ["components/parts/DiagramBlock.vue", "components/parts/SvgFileCard.vue"]) {
      check(`${path.basename(file)}'s more button is named`, /class="md-diagram-more"[^>]*:aria-label="t\('svgMenu\.actions'\)"/.test(read(file)))
    }
  }

  section("round 8 access: click targets that the keyboard reaches too (A9)")
  {
    /** The opening tag that carries `marker`, so a check reads one element's attributes. */
    const tagWith = (source: string, marker: string) => {
      const at = source.indexOf(marker)
      if (at < 0) return ""
      return source.slice(source.lastIndexOf("<", at), source.indexOf(">", at) + 1)
    }
    const operable = (tag: string, keys: RegExp) => /role="button"|:role="[^"]*'button'/.test(tag) && /tabindex/.test(tag) && keys.test(tag)
    const composer = read("components/Composer.vue")
    const tiles = [...composer.matchAll(/<(img|video)\b[^>]*class="att-thumb"[^>]*>/g)].map((match) => match[0])
    check("a picture or video waiting to be sent opens its preview from the keyboard, as MiMo's does", tiles.length === 2 && tiles.every((tag) => operable(tag, /@keydown\.enter\.space\.prevent="onTileClick/)))
    check("a file waiting to be sent opens from the keyboard", operable(tagWith(composer, 'class="att-file"'), /@keydown\.enter\.space\.self\.prevent="onTileClick/))
    const servers = read("components/ServersDialog.vue")
    check("the local server is chosen from the keyboard", operable(tagWith(servers, `@click="choose('')"`), /@keydown\.enter\.space\.self\.prevent="choose\(''\)"/))
    check("a saved server is chosen from the keyboard through its name", operable(tagWith(servers, `@keydown.enter.space.prevent="choose(entry.url)"`), /choose\(entry\.url\)/))
    check("a sent file opens from the keyboard", operable(tagWith(read("components/MessageStream.vue"), "data-sent-file"), /@keydown\.enter\.space\.prevent="item\.path && openSentFile/))
    check("an annotation's note is edited from the keyboard", operable(tagWith(read("components/AnnotationChips.vue"), 'class="ann-note ann-note-edit"'), /@keydown\.enter\.space\.self\.stop\.prevent="startEdit/))
    check("an archived conversation is picked with Space", /:role="selecting \? 'checkbox' : undefined"[\s\S]{0,160}:tabindex="selecting \? 0 : undefined"[\s\S]{0,120}@keydown\.space\.prevent="selecting && togglePick/.test(read("components/SettingsDialog.vue")))
    check("Ctrl+Enter on a step's head opens its path, as Ctrl+click on the path does", /data-step-head[\s\S]{0,60}@keydown\.enter="onTitleClick"/.test(read("components/parts/ToolPart.vue")))
    const media = read("components/parts/LocalMedia.vue")
    check("a voice clip seeks from the keyboard", /@keydown\.self="nudge"/.test(media) && /function nudge[\s\S]*ArrowLeft[\s\S]*Home/.test(media))
    const shell = read("App.vue")
    check("a turn that ends is announced, with the conversation's name when it is not on screen (A11)", /if \(app\.currentID === turn\.sessionID\) announce\(done\)\s+else if \(about\.title !== undefined\) announce\(`\$\{about\.title\} · \$\{done\}`\)/.test(shell))
    check("a background subagent of the conversation on screen is announced when it finishes (A11)", /!session\.subagent\?\.background \|\| !outcome\) continue\s+if \(app\.rootOf\(session\.id\) !== app\.currentID\) continue\s+announce\(/.test(shell))
    check("the file viewer's picture opens its preview from the keyboard", operable(tagWith(read("components/right/RpFiles.vue"), 'class="fv-img"'), /@keydown\.enter\.space\.prevent="openImagePreview/))
  }
}
