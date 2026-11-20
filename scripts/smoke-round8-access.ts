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

/* A file that is gone reads as empty, so its checks fail rather than stopping the run. */
function read(file: string): string {
  try {
    return fs.readFileSync(path.join(RENDERER, file), "utf8")
  } catch {
    return ""
  }
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
    check("a reply's copy says 复制失败 when the clipboard refuses", /async function copyToClipboard[\s\S]{0,400}catch \{\s*(?:if \(app\.currentID !== held\) return\s*)?notifyFailure\(t\("code\.copyFailed"\)\)/.test(stream))
  }

  section("round 8 access: a keyboard focus ring (A1)")
  {
    const base = read("styles/base.css")
    // R21-F1: the ring is MiMo's --color-ring - the ink, white in dark - not the interactive blue.
    const ring = /:where\(([^)]*\([^)]*\))*[^)]*\):focus-visible \{\s*outline: 2px solid var\(--ring\)/.exec(base)
    check("controls reached by keyboard draw MiMo's ring, which is the ink", Boolean(ring))
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
    check("a file in the review's list is a Tab stop that Enter and Space open", /class="db-list-line"\s+role="button"\s+tabindex="0"[\s\S]{0,220}@keydown\.enter\.space\.self\.prevent="reveal\(index, true\)"/.test(diff))
    check("Enter on a diff row inside a permission card does not also answer the card", /function onDockKey\(event: KeyboardEvent\) \{\s+\/\/[^\n]*\n\s+if \(event\.defaultPrevented\) return/.test(read("components/QuestionDock.vue")))
    check("a file header is a Tab stop that folds, and says whether it is open", /class="db-head"\s+role="button"\s+tabindex="0"\s+:aria-expanded="!collapsed\.has\(file\.name\)"[\s\S]{0,260}@keydown\.enter\.space\.self\.prevent="toggle/.test(diff))
    const panel = read("components/RightPanel.vue")
    check("the shown right-panel tab is the strip's Tab stop", /:tabindex="tab\.id === rp\.active \? 0 : -1"/.test(panel))
    const drawer = read("components/TerminalDrawer.vue")
    // The tab strip moved to a roving tabindex (one Tab stop for the strip, arrows move inside it),
    // so the static slot is `:tabindex="… ? 0 : -1"` rather than a literal 0. What A6 actually
    // guards is unchanged: the close control is a sibling button of the label, never nested in another button.
    check("a terminal tab's close is a button beside its label, not inside another button (A6)", /<div[^>]*class="tab"[^>]*role="tab"[^>]*(?:tabindex="0"|:tabindex="[^"]*\? 0 : -1")[\s\S]{0,600}<button type="button" class="tab-close"[\s\S]{0,120}<\/div>/.test(drawer) && !/<span class="tab-close"/.test(drawer))
    check("arrows, Home and End walk the tabs; Enter, Space and the Menu key act",
      /function onTabKey[\s\S]*"Enter"[\s\S]*"ContextMenu"[\s\S]*ArrowRight[\s\S]*"Home"[\s\S]*"End"/.test(panel) && /@keydown="onTabKey\(\$event, tab\.id\)"/.test(panel))
  }

  section("round 8 access: names that are not drawn (A7, A8, A10)")
  {
    // A7's folded rail went in round 18 (R18-U1): a folded column is not drawn, and its preview shows every row's own label.
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
    check("a sent file opens from the keyboard", operable(tagWith(read("components/MessageStream.vue"), "data-sent-file"), /@keydown\.enter\.space\.prevent="item\.path && openSentFile/))
    check("an annotation's note is edited from the keyboard", operable(tagWith(read("components/AnnotationChips.vue"), 'class="ann-note ann-note-edit"'), /@keydown\.enter\.space\.self\.stop\.prevent="startEdit/))
    const settings = read("components/SettingsDialog.vue")
    const archiveTitle = tagWith(settings, 'class="line-title archived-title"')
    const archiveSpace = settings.match(/^function onArchiveTitleSpace\(event: KeyboardEvent, id: string\) \{\n([^}]+)\n\}/m)?.[1]?.trim()
    check("an archived conversation is picked with Space only in selection mode",
      archiveTitle.includes(`:role="selecting ? 'checkbox' : undefined"`) &&
      archiveTitle.includes(':aria-label="selecting ? sessionTitle(session.title) : undefined"') &&
      archiveTitle.includes(':aria-checked="selecting ? pickedLive.includes(session.id) : undefined"') &&
      archiveTitle.includes(':tabindex="selecting ? 0 : undefined"') &&
      archiveTitle.includes('@keydown.space="onArchiveTitleSpace($event, session.id)"') &&
      archiveSpace === "if (!selecting.value) return\n  event.preventDefault()\n  if (!event.repeat) togglePick(id)")
    check("Ctrl+Enter on a step's head opens its path, as Ctrl+click on the path does", /data-step-head[\s\S]{0,60}@keydown\.enter="onTitleClick"/.test(read("components/parts/ToolPart.vue")))
    const media = read("components/parts/LocalMedia.vue")
    check("a voice clip seeks from the keyboard", /@keydown\.self="nudge"/.test(media) && /function nudge[\s\S]*ArrowLeft[\s\S]*Home/.test(media))
    const shell = read("App.vue")
    check("a turn that ends is announced, with the conversation's name when it is not on screen (A11)", /if \(app\.currentID === turn\.sessionID\) announce\(done\)\s+else if \(about\.title !== undefined\) announce\(`\$\{about\.title\} · \$\{done\}`\)/.test(shell))
    check("a background subagent of the conversation on screen is announced when it finishes (A11)", /!session\.subagent\?\.background \|\| !outcome\) continue\s+if \(app\.rootOf\(session\.id\) !== app\.currentID\) continue\s+announce\(/.test(shell))
    const side = read("components/Sidebar.vue")
    check("the side column and its navigation are named regions (A13)", /<aside class="side"[^>]*:aria-label="t\('a11y\.sidebar'\)"/.test(side) && /<nav class="nav" :aria-label="t\('key\.groupNavigation'\)"/.test(side))
    check("each turn has a heading that is never drawn, found or selected (A13)", /<h2 v-if="!latest" class="a11y-only" data-turn-heading data-find-skip data-selectable="none">\{\{ t\("a11y\.turnHeading"/.test(read("components/MessageStream.vue")))
    const toasts = read("components/Toasts.vue")
    // R21-F4-47: the ones past the third are kept but hidden, so the class and the Tab stop are bound rather than written out.
    check("each notice is an alert and a Tab stop, as MiMo's are (A14)", /class="notice"[\s\S]*?role="alert"\s+:tabindex="shownIds\.has\(toast\.id\) \? 0 : -1"\s+@mousedown="keepFocus"/.test(toasts))
    check("the column of notices stays a polite status region (A14)", /class="toasts"\s+role="status"\s+aria-live="polite"/.test(toasts))
    check("high contrast outlines the open conversation and the send button, and rings in Highlight (A12)",
      /@media \(forced-colors: active\) \{\s+\.row\.on \{\s+outline: 2px solid Highlight/.test(read("components/Sidebar.vue")) &&
        /@media \(forced-colors: active\) \{\s+\.send \{\s+outline: 1px solid ButtonText/.test(read("components/Composer.vue")) &&
        /@media \(forced-colors: active\) \{\s+:focus-visible \{\s+outline-color: Highlight/.test(read("styles/base.css")))
    const browser = read("components/right/RpBrowser.vue")
    check("the browser's zoom controls are named in the interface's language (A15)", !/aria-label="(Zoom|Zoom out|Zoom in|Reset zoom)"/.test(browser) && /:aria-label="t\('key\.zoomReset'\)"/.test(browser))
    const terminalPane = read("components/TerminalPane.vue")
    const mainIndex = read("../../main/index.ts")
    check(
      "the terminal's input, and round 9's too-much-output line, are named in the interface's language (A15)",
      /Terminal\.strings\.promptLabel = t\("term\.inputLabel"\)\s+Terminal\.strings\.tooMuchOutput = t\("term\.tooMuchOutput"\)\s+terminal = new Terminal\(/.test(terminalPane),
    )
    check(
      "round 9: the terminal's reading view is built only while assistive technology is there, and follows it live",
      /terminal = new Terminal\(\{[\s\S]*?screenReaderMode: screenReader\.value,/.test(terminalPane) &&
        /watch\(screenReader, \(enabled\) => \{\s+if \(terminal\) terminal\.options\.screenReaderMode = enabled/.test(terminalPane) &&
        /const screenReader = screenReaderActive\(\)/.test(terminalPane) &&
        /ipcMain\.handle\("mcode:screen-reader", \(\) => app\.accessibilitySupportEnabled\)/.test(mainIndex) &&
        /app\.on\("accessibility-support-changed"[\s\S]{0,200}webContents\.send\("mcode:screen-reader", enabled\)/.test(mainIndex),
    )
    check("the file viewer's picture opens its preview from the keyboard", operable(tagWith(read("components/right/RpFiles.vue"), 'class="fv-img"'), /@keydown\.enter\.space\.prevent="previewImage\(\$event\)"/))
  }
}
