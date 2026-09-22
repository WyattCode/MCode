/**
 * Round 13, lane K: keyboard and focus paths measured against MiMo 26.914
 * (K13-1 onwards, numbered as the audit numbers them). Kept apart from
 * smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundThirteenKeyboardChecks` with its own check and section.
 *
 * What can run without a window runs here against a stand-in document; the
 * rest is read from the source, and the real key presses are in the lane's
 * Electron probe.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { effectScope, nextTick, ref } from "vue"
import { dialogOpen, dismissMenus, escapeLayer, layerOpen, useEscapeLayerWhile } from "../src/renderer/src/lib/escape-layer"
import { composing } from "../src/renderer/src/lib/keys"
import { typeAheadBuffer, typeAheadMatch } from "../src/renderer/src/lib/type-ahead"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")
const component = (name: string) => read(`src/renderer/src/components/${name}.vue`)

/** A keydown as the page would get it, with only the fields the handlers read. */
function press(target: EventTarget, key: string, extra: Record<string, unknown> = {}): Event {
  const event = new Event("keydown", { cancelable: true, bubbles: true })
  Object.assign(event, { key, keyCode: key === "Escape" ? 27 : 0, isComposing: false, ...extra })
  target.dispatchEvent(event)
  return event
}

/** Just enough of a document for the escape helper: listeners and a selector query over tagged nodes. */
function standInDocument(nodes: { selector: string; exiting?: boolean }[]) {
  const doc = new EventTarget() as EventTarget & { querySelectorAll: (selector: string) => unknown[] }
  doc.querySelectorAll = (selector: string) =>
    nodes
      .filter((node) => selector.split(", ").includes(node.selector))
      .map((node) => ({ closest: (query: string) => (query === "[data-modal-exit]" && node.exiting ? node : null) }))
  return doc
}

export async function roundThirteenKeyboardChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 13 (K): keyboard and focus")

  const saved = (globalThis as { document?: unknown }).document
  // ---------------------------------------------------------------- K13-7
  {
    const nodes: { selector: string; exiting?: boolean }[] = []
    const doc = standInDocument(nodes)
    ;(globalThis as { document?: unknown }).document = doc
    const closed: string[] = []
    const releaseMenu = escapeLayer(() => closed.push("menu"))
    const releaseConfirm = escapeLayer(() => closed.push("confirm"))
    let underneath: boolean | undefined
    doc.addEventListener("keydown", (event) => (underneath = event.defaultPrevented))
    const first = press(doc, "Escape")
    check("K13-7: one Escape closes only the layer opened last", closed.join() === "confirm", closed)
    check("K13-7: and is marked taken, so a viewer listening underneath skips it", first.defaultPrevented && underneath === true)
    releaseConfirm()
    press(doc, "Escape")
    check("K13-7: the next Escape reaches the layer under it", closed.join() === "confirm,menu", closed)
    press(doc, "Escape", { isComposing: true })
    press(doc, "Escape", { keyCode: 229 })
    check("K13-7: an Escape that belongs to an input method closes nothing (K13-16)", closed.length === 2, closed)
    const taken = new Event("keydown", { cancelable: true })
    Object.assign(taken, { key: "Escape", keyCode: 27, isComposing: false })
    taken.preventDefault()
    doc.dispatchEvent(taken)
    check("K13-7: an Escape a list on top already took is left alone", closed.length === 2, closed)
    releaseMenu()
    const after = press(doc, "Escape")
    check("K13-7: with no layer up, Escape is not taken", !after.defaultPrevented)

    nodes.push({ selector: '[aria-modal="true"]', exiting: true })
    check("K13-7: the copy a closing dialog leaves behind is not a layer", !dialogOpen() && !layerOpen())
    nodes.push({ selector: '[role="menu"]' })
    check("K13-7: an open menu is a layer but not a dialog", layerOpen() && !dialogOpen())
    nodes.push({ selector: '[aria-modal="true"]' })
    check("K13-7: an open dialog is both", layerOpen() && dialogOpen())
  }
  ;(globalThis as { document?: unknown }).document = saved

  {
    const helper = await read("src/renderer/src/lib/escape-layer.ts")
    check(
      "K13-7: the helper listens on the document's capture phase, after the window's lists and before every bubble listener",
      /document\.addEventListener\("keydown", onKeydown, true\)/.test(helper) && !/window\.addEventListener/.test(helper),
    )
    const users = ["ContextMenu", "AppMenu", "ConfirmDialog", "RenameDialog", "NewProjectDialog", "ProjectDialog", "SkillDetailDialog", "FullAccessDialog", "ThirdPartyDialog", "VoiceUsageDialog", "ProviderCloneDialog", "ConnectDialog"]
    const own: string[] = []
    for (const name of users) {
      const source = await component(name)
      if (!/useEscapeLayer\(/.test(source) || /"Escape"/.test(source.slice(0, source.indexOf("</script>")))) own.push(name)
    }
    check("K13-7: menus and the older dialogs take Escape through the helper, with no Escape handler of their own", own.length === 0, own)
    const viewers: string[] = []
    for (const name of ["PdfView", "DocxView", "XlsxView", "PptxView"]) {
      const source = await component(`right/${name}`)
      const body = source.slice(source.indexOf("function onEscape("), source.indexOf("\n}\n", source.indexOf("function onEscape(")))
      if (!/event\.defaultPrevented/.test(body) || !/dialogOpen\(\)/.test(body)) viewers.push(name)
    }
    check("K13-7: the document viewers keep what was sent when a layer took Escape or a dialog covers them", viewers.length === 0, viewers)
    const info = await component("InfoPanel")
    const shell = await read("src/renderer/src/App.vue")
    check("K13-7: the info card reads the page instead of a hand-made escapeBlocked list", !/escapeBlocked|escape-blocked/.test(info + shell) && /dialogOpen\(\)/.test(info))
  }

  const settings = await component("SettingsDialog")
  // ---------------------------------------------------------------- K13-1
  {
    const onKeydown = settings.slice(settings.indexOf("function onKeydown(event: KeyboardEvent) {\n  if (event.key !== \"Escape\")"))
    const body = onKeydown.slice(0, onKeydown.indexOf("\n}\n"))
    check(
      "K13-1: Settings records on the capture phase whether any other layer was up when Escape went down, as MiMo's overlay does",
      /function notePress\(event: KeyboardEvent\) \{\n\s+if \(event\.key === "Escape"\) layerAtPress = layerOpen\(dialogEl\.value\)/.test(settings) &&
        /window\.addEventListener\("keydown", notePress, true\)/.test(settings),
    )
    check(
      "K13-1: and closes only when no layer was up and none took the key, with no hand-kept list (the models page's confirmation was missing from it)",
      /if \(event\.defaultPrevented\) return/.test(body) && /if \(layerAtPress\) return\s+requestClose\(\)/.test(body) && !/removingProject\.value \|\|/.test(body) && !/connectOpen/.test(body),
      body,
    )
  }

  // ---------------------------------------------------------------- K13-2
  {
    const doc = standInDocument([])
    ;(globalThis as { document?: unknown }).document = doc
    const open = ref(false)
    const scope = effectScope()
    scope.run(() => useEscapeLayerWhile(() => open.value, () => (open.value = false)))
    const shut = press(doc, "Escape")
    open.value = true
    await nextTick()
    const taken = press(doc, "Escape")
    await nextTick()
    const closedByEscape = !open.value
    open.value = true
    await nextTick()
    scope.stop()
    const afterStop = press(doc, "Escape")
    ;(globalThis as { document?: unknown }).document = saved
    check("K13-2: a menu held by useEscapeLayerWhile takes Escape only while it is open, and lets go when its owner goes", !shut.defaultPrevented && taken.defaultPrevented && closedByEscape && !afterStop.defaultPrevented)

    const picker = await component("BranchPicker")
    check(
      "K13-2: the branch menu closes on Escape wherever focus is in it, its search included; the switch confirmation is its own layer",
      /useEscapeLayerWhile\(\s*\(\) => open\.value,/.test(picker) && /useEscapeLayerWhile\(\s*\(\) => pending\.value,/.test(picker) && !/addEventListener\("keydown"/.test(picker),
    )
  }

  const composer = await component("Composer")
  // ---------------------------------------------------------------- K13-3
  {
    const plus = /<div v-if="menu === 'plus'"[^>]*>/.exec(composer)?.[0] ?? ""
    check("K13-3: the plus menu is a menu with its own keys", /role="menu"/.test(plus) && /@keydown="onPlusKeys"/.test(plus), plus)
    check(
      "K13-3: opening it puts focus on its first row, as MiMo's menu primitive does",
      /watch\(menu, async \(value\) => \{\n\s+if \(value !== "plus"\) return\n\s+await nextTick\(\)\n\s+plusMenu\.value\?\.querySelector<HTMLElement>\(":scope > \.item"\)\?\.focus\(/.test(composer),
    )
    const keys = composer.slice(composer.indexOf("function onPlusKeys("), composer.indexOf("\n}\n", composer.indexOf("function onPlusKeys(")))
    check(
      "K13-3: Up, Down, Home and End walk its rows; Right on 技能 opens the skills with focus in the search; Down leaves the search for the list and Left comes back out",
      /isRovingKey\(event\.key\)/.test(keys) && /focusRow\(\[\.\.\.\(plusMenu\.value\?\.querySelectorAll<HTMLElement>\(":scope > \.item"\)/.test(keys) &&
        /event\.key === "ArrowRight" && event\.target === skillRow/.test(keys) && /openSkillFrom\(skillRow\)/.test(keys) &&
        /field && event\.key !== "ArrowDown"/.test(keys) && /event\.key === "ArrowLeft"/.test(keys),
    )
    const layer = composer.slice(composer.indexOf('useEscapeLayerWhile(\n  () => menu.value === "plus"'))
    check(
      "K13-3: Escape closes the skills panel back to its row, then the menu back to the box, and the search no longer closes the whole menu itself",
      layer.length > 0 && /if \(skillSubOpen\.value\) \{[\s\S]*?\[data-plus-skills\][\s\S]*?menu\.value = undefined\n\s+focus\(\)/.test(layer.slice(0, 500)) && !/@keydown\.escape\.stop\.prevent="menu = undefined"/.test(composer),
    )
    check("K13-3: every row of the menu and the skills panel is a menuitem", (composer.match(/role="menuitem"/g) ?? []).length >= 4)
  }

  // ---------------------------------------------------------------- K13-4
  {
    const overlay = await component("SearchOverlay")
    check(
      "K13-4: the search overlay closes on Escape wherever focus is, a result row included, not only from its field",
      /useEscapeLayer\(close\)/.test(overlay) && !/@keydown="onKeydown"/.test(overlay),
    )
  }

  const shell = await read("src/renderer/src/App.vue")
  // ---------------------------------------------------------------- K13-5
  {
    const covered = shell.slice(shell.indexOf("function conversationCovered("), shell.indexOf("\n}\n", shell.indexOf("function conversationCovered(")))
    check(
      // The palette went in round 21 (R21-F4-24), MiMo having none; the search is what Ctrl+K opens.
      "K13-5: a conversation is covered while a modal, the search or any dialog on the page is up",
      /modalOpen\.value/.test(covered) && /searchOpen\.value/.test(covered) && /dialogOpen\(\)/.test(covered),
      covered,
    )
    const unguarded = ["p", "r", "a", "s", "u", "c", "l"].filter((letter) => {
      const at = shell.indexOf(`if (mod && event.altKey && letter === "${letter}") {`)
      return at < 0 || !/^\s+if \(conversationCovered\(\)/.test(shell.slice(shell.indexOf("\n", at) + 1, shell.indexOf("\n", shell.indexOf("\n", at) + 1)))
    })
    check("K13-5: pin, rename, archive, side chat, priority filter, copy id and copy link do nothing behind a layer", unguarded.length === 0, unguarded)
    check(
      "K13-5: and neither do they when re-bound to another chord",
      /if \(CONVERSATION_COMMANDS\.has\(command\.id\) && conversationCovered\(\)\) return/.test(shell) &&
        ["session.pin", "session.archive", "session.rename", "session.side", "session.copyID", "session.copyLink", "view.priority"].every((id) => new RegExp(`CONVERSATION_COMMANDS = new Set\\(\\[[^\\]]*"${id.replace(".", "\\.")}"`).test(shell)),
    )
  }

  // ---------------------------------------------------------------- K13-6
  {
    ;(globalThis as { document?: unknown }).document = standInDocument([])
    const gone: string[] = []
    const releaseDialog = escapeLayer(() => gone.push("dialog escaped"))
    const releaseMenu = escapeLayer(() => gone.push("menu escaped"), () => gone.push("menu"))
    const releaseSub = escapeLayer(() => gone.push("sub escaped"), () => gone.push("sub"))
    dismissMenus()
    releaseSub()
    releaseMenu()
    releaseDialog()
    ;(globalThis as { document?: unknown }).document = saved
    check("K13-6: dismissing closes every open menu, innermost first, and leaves a dialog alone", gone.join() === "sub,menu", gone)

    const run = shell.slice(shell.indexOf("function newTaskOverLayers("), shell.indexOf("\n}\n", shell.indexOf("function newTaskOverLayers(")))
    check(
      "K13-6: new task closes the menus, the search, the previews and Settings (asking first about unsaved edits), then runs",
      /dismissMenus\(\)/.test(run) && /searchOpen\.value = false/.test(run) && /closeImagePreview\(\)/.test(run) && /closeVideoPreview\(\)/.test(run) &&
        /settingsDialog\.value\.leaveThen\(\(\) => \{\s+settingsOpen\.value = false\s+newSession\(\)/.test(run) && /\n  newSession\(\)\n  return true$/.test(run),
      run,
    )
    check("K13-6: a dialog that asks something keeps the key", /!node\.closest\("\[data-new-task-clears\]"\)/.test(run) && /if \(asking \|\| editingProject\.value/.test(run))
    check(
      "K13-6: its chord is tried before the modal block, wherever it is bound, and the application menu's New goes the same way",
      /if \(isNewTaskChord\(chordOf\(event, platform\)\) && !commandDisabled\("session\.new"\) && newTaskOverLayers\(\)\) \{/.test(shell) &&
        shell.indexOf("if (isNewTaskChord(") < shell.indexOf("if (!modalOpen.value) {\n    const chord = chordOf(") && /"new-session": \(\) => void newTaskOverLayers\(\)/.test(shell),
    )
    const cleared = await Promise.all(["SettingsDialog", "SearchOverlay", "ImagePreview", "VideoPreview"].map(async (name) => /data-new-task-clears/.test(await component(name))))
    check("K13-6: Settings, the search and both previews are marked as what a new task clears", cleared.every(Boolean), cleared)
    check("K13-6: Settings leaves for it through its own unsaved-edits guard", /function leaveThen\(action: \(\) => void\) \{\n\s+requestLeave\(/.test(settings) && /defineExpose\(\{ leaveThen \}\)/.test(settings))
  }

  // ---------------------------------------------------------------- K13-8
  {
    const image = await component("ImagePreview")
    const video = await component("VideoPreview")
    // R17-V1: the table preview moved with the rest of the reply body into the shared markdown component.
    const text = await component("parts/MarkdownBody")
    const imageRoot = /<div\s+v-if="imagePreview"[\s\S]*?>/.exec(image)?.[0] ?? ""
    check("K13-8: the image preview keeps Tab inside and gives focus back on close, still focusing its own root as MiMo's does", /v-modal/.test(imageRoot) && /data-modal-keep-focus/.test(imageRoot), imageRoot)
    check("K13-8: the video preview takes focus, keeps Tab inside and gives it back", /<div id="video-preview" v-modal /.test(video) && !/id="video-preview"[^>]*data-modal-keep-focus/.test(video))
    check(
      "K13-8: so does the table preview, which now closes on Escape as a layer",
      /<div v-modal class="md-table-preview-dialog"/.test(text) && /useEscapeLayerWhile\(\(\) => previewing\.value, closePreview\)/.test(text) && !/addEventListener\("keydown", onEscape\)/.test(text),
    )
  }

  // ---------------------------------------------------------------- K13-9
  {
    check(
      "K13-9: composing() is MiMo's test: isComposing, or the 229 an input method reports",
      composing({ isComposing: true, keyCode: 13 }) && composing({ isComposing: false, keyCode: 229 }) && !composing({ isComposing: false, keyCode: 13 }),
    )
    const unguarded = await enterFieldsWithoutImeGuard()
    check("K13-9: every Enter handler on a text field steps aside while an input method is composing", unguarded.length === 0, unguarded)
  }

  // ---------------------------------------------------------------- K13-10
  {
    const source = await component("Composer")
    const row = await component("ModelMenuRow")
    const menuOf = (marker: string) => {
      const at = source.indexOf(marker)
      const open = source.lastIndexOf("<div", at)
      return source.slice(open, source.indexOf(">", at) + 1)
    }
    const roots = ['ref="accessMenu"', 'ref="modelMenu"', 'ref="plusMenu"'].map(menuOf)
    check("K13-10: the access, model and plus menus close when focus moves outside them and their chip", roots.every((tag) => /@focusout="onMenuFocusOut"/.test(tag)), roots)
    const out = source.slice(source.indexOf("function onMenuFocusOut("), source.indexOf("\n}\n", source.indexOf("function onMenuFocusOut(")))
    check(
      "K13-10: focus going nowhere (the window losing focus) leaves them open; focus inside or on the chip keeps them",
      /next instanceof Node && !\(event\.currentTarget as HTMLElement\)\.parentElement\?\.contains\(next\)/.test(out),
    )
    // Each button tag inside the three menus, and in the model rows, is not a Tab stop.
    const menuRegions = [
      source.slice(source.indexOf('ref="accessMenu"'), source.indexOf("MiMo's one mode chip")),
      source.slice(source.indexOf('ref="modelMenu"'), source.indexOf("MiMo's voice capsule")),
      source.slice(source.indexOf('ref="plusMenu"'), source.indexOf("The permission map in one control")),
      row.slice(row.indexOf("<template>")),
    ]
    const tabStops = menuRegions.flatMap((region) => [...region.matchAll(/<button\b[^>]*?>/gs)].map((tag) => tag[0]).filter((tag) => !/tabindex="-1"/.test(tag)))
    check("K13-10: their rows are walked by the arrows and are not Tab stops, so Tab leaves in one step with no second cursor", tabStops.length === 0, tabStops)
    const pickers = await Promise.all(["ProjectPicker", "BranchPicker"].map(component))
    check(
      "K13-10: the home project and branch pickers close when focus leaves them",
      pickers.every((picker) => /ref="root"[^>]*@focusout="onFocusOut"/.test(picker) && /if \(open\.value && next instanceof Node && !root\.value\?\.contains\(next\)\) open\.value = false/.test(picker)),
    )
  }

  // ---------------------------------------------------------------- K13-11
  {
    const picker = await component("ProjectPicker")
    const layer = picker.slice(picker.indexOf("useEscapeLayerWhile(\n  () => open.value,"))
    check(
      "K13-11: Escape in the project picker's \"add a project\" submenu closes the submenu alone and gives focus back to its row",
      /if \(!sub\.value\) \{\s+open\.value = false\s+return\s+\}\s+sub\.value = false\s+trigger\.value\?\.focus\(\)/.test(layer.slice(0, 300)) && !/addEventListener\("keydown"/.test(picker),
    )
  }

  // ---------------------------------------------------------------- K13-12
  {
    const labels = ["Light", "Dark", "Dim", "System", "Deep"]
    check("K13-12: a letter lands on the next label starting with it, after the current row", typeAheadMatch(labels, 0, "d") === 1 && typeAheadMatch(labels, 1, "d") === 2)
    check("K13-12: the same letter again steps on and wraps round", typeAheadMatch(labels, 4, "dd") === 1 && typeAheadMatch(labels, 2, "ddd") === 4)
    check("K13-12: a longer search narrows, and may stay on the row it already matches", typeAheadMatch(labels, 1, "de") === 4 && typeAheadMatch(labels, 3, "sy") === -1 && typeAheadMatch(labels, 0, "sy") === 3)
    check("K13-12: nothing matching moves nothing, and case does not matter", typeAheadMatch(labels, 0, "x") === -1 && typeAheadMatch(labels, -1, "S") === 3)
    const buffer = typeAheadBuffer()
    const first = buffer.push("d")
    const second = buffer.push("i")
    check("K13-12: keys typed together build one search", first === "d" && second === "di" && buffer.searching())

    const select = await component("SelectMenu")
    check(
      "K13-12: the settings dropdown opens on Space as well as the arrows and Enter, as MiMo's does",
      /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp" \|\| event\.key === "Enter" \|\| event\.key === " "\) \{\s+event\.preventDefault\(\)\s+toggle\(\)/.test(select),
    )
    check(
      "K13-12: and types ahead both closed (picking the value) and open (moving the highlighted row)",
      /if \(typeAhead\(event\)\) return\n\s+\/\/ MiMo's trigger opens on Space/.test(select) && /\n  if \(typeAhead\(event\)\) return\n/.test(select) &&
        /if \(open\.value\) active\.value = hit\n\s+else choose\(props\.options\[hit\]\.value\)/.test(select) && /if \(event\.key === " " && !typed\.searching\(\)\) return false/.test(select),
    )
  }

  // ---------------------------------------------------------------- K13-14
  {
    const app = await read("src/renderer/src/App.vue")
    const click = app.slice(app.indexOf("function onThreadClick("), app.indexOf("\n}\n", app.indexOf("function onThreadClick(")))
    const controls = /const THREAD_CONTROLS =\s+"([^"]+)"/.exec(app)?.[1] ?? ""
    const wanted = ["button", "a", "input", "textarea", "select", "label", "[contenteditable]", "[role=button]", "[role=textbox]", "[role=link]", "[role=menuitem]", "[role=checkbox]", "[role=tab]"]
    check("K13-14: a click in the thread leaves MiMo's list of controls alone", wanted.every((entry) => controls.split(", ").includes(entry)), controls)
    check(
      "K13-14: anywhere else, with nothing selected, it puts the caret at the end of the box",
      /<MessageStream v-else ref="stream" @click="onThreadClick" \/>/.test(app) && /if \(window\.getSelection\(\)\?\.toString\(\)\) return/.test(click) && /closest\?\.\(THREAD_CONTROLS\)\) return\n\s+composer\.value\?\.focus\(\)/.test(click),
    )
  }

  // ---------------------------------------------------------------- K13-17
  {
    // A new task lands in the home screen's own box: the conversation's box is not drawn there.
    const app = await read("src/renderer/src/App.vue")
    const hero = await component("HomeHero")
    const focusing = app.slice(app.indexOf("async function focusComposer("), app.indexOf("\n}\n", app.indexOf("async function focusComposer(")))
    const side = app.slice(app.indexOf("function newTaskFromSide("), app.indexOf("\n}\n", app.indexOf("function newTaskFromSide(")))
    check(
      "K13-17: a new task focuses the home screen's box, as MiMo's newChatGlobal does",
      /if \(isHome\.value\) homeHero\.value\?\.focus\(\)/.test(focusing) && /ref="homeHero"/.test(app) && /defineExpose\(\{ focus: \(\) => box\.value\?\.focus\(\) \}\)/.test(hero),
    )
    check("K13-17: and the side column's new task does too", /goHome\(\)\n\s+void focusComposer\(\)/.test(side))
  }
}

/*
 * Every <input> and <textarea> in the renderer whose Enter does something: the
 * handler, or the function it names, has to test composing() or isComposing.
 * A generic @keydown handler counts when its body looks at Enter.
 */
/** Each <input> and <textarea> opening tag, read to its closing bracket outside quotes (an arrow in a handler is not one). */
function fieldTags(source: string): string[] {
  const tags: string[] = []
  for (const start of source.matchAll(/<(input|textarea)\b/g)) {
    let quote = ""
    let at = start.index ?? 0
    for (; at < source.length; at++) {
      const char = source[at]
      if (quote) {
        if (char === quote) quote = ""
      } else if (char === '"' || char === "'") quote = char
      else if (char === ">") break
    }
    tags.push(source.slice(start.index, at + 1))
  }
  return tags
}

async function enterFieldsWithoutImeGuard(): Promise<string[]> {
  const root = path.join(process.cwd(), "src/renderer/src/components")
  const files: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith(".vue")) files.push(full)
    }
  }
  await walk(root)
  const guarded = (text: string) => /composing\(|isComposing/.test(text)
  const bad: string[] = []
  for (const file of files) {
    const source = await fs.readFile(file, "utf8")
    const script = source.slice(0, source.indexOf("<template>"))
    const bodyOf = (name: string) => {
      const at = script.search(new RegExp(`function ${name}\\(`))
      return at < 0 ? "" : script.slice(at, script.indexOf("\n}\n", at))
    }
    for (const tag of fieldTags(source)) {
      for (const handler of tag.matchAll(/@keydown(\.[\w.]+)?="([^"]*)"/g)) {
        const modifiers = handler[1] ?? ""
        const expr = handler[2]
        const named = /^(\w+)(\(.*\))?$/.exec(expr.trim())?.[1]
        const body = named ? bodyOf(named) : ""
        if (modifiers.includes(".enter")) {
          if (!guarded(expr) && !guarded(body)) bad.push(`${path.basename(file)}: ${handler[0]}`)
        } else if (!modifiers && body && /"Enter"/.test(body) && !guarded(body)) {
          bad.push(`${path.basename(file)}: ${handler[0]}`)
        }
      }
    }
  }
  return bad
}
