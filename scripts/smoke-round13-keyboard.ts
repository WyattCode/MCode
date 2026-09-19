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
import { dialogOpen, escapeLayer, layerOpen, useEscapeLayerWhile } from "../src/renderer/src/lib/escape-layer"

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
    const users = ["ContextMenu", "AppMenu", "ConfirmDialog", "RenameDialog", "NewProjectDialog", "ProjectDialog", "SkillDetailDialog", "FullAccessDialog", "ThirdPartyDialog", "VoiceUsageDialog", "CustomModelDialog", "ConnectDialog"]
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
      "K13-5: a conversation is covered while a modal, the search, the palette or any dialog on the page is up",
      /modalOpen\.value/.test(covered) && /searchOpen\.value/.test(covered) && /paletteOpen\.value/.test(covered) && /dialogOpen\(\)/.test(covered),
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
}
