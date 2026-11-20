import assert from "node:assert/strict"
import { between, component, deferred, dialog, mount } from "./smoke-ui-races"

/* Registered rather than handed to node:test: the battery counts a module through an exported
 * `(check)` runner, and a top-level node:test file reports nothing there. See smoke-ui-races. */
const registered: Array<{ name: string; run: () => Promise<unknown> }> = []
const test = (name: string, run: () => Promise<unknown>) => { registered.push({ name, run }) }
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 180)

export async function uiA11yChecks(check: (label: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  for (const { name, run } of registered) {
    try { await run(); check(name, true) } catch (err) { check(name, false, reason(err)) }
  }
}

for (const layout of ["grid", "list"] as const) {
  test(`artifact ${layout} actions own their Space and Enter keys`, async () => {
    const source = component("ArtifactsView")
    const cards = between(source, '<div v-else-if="visible.length && layout', '<!-- A search that found nothing')
      .replace("v-else-if=", "v-if=")
    const actions: string[] = []
    const ui = await mount(`
      const layout = fixture.layout
      const visible = [{ key: "file", name: "hello.txt", badge: { glyph: [] } }]
      const badgeStyle = () => ({})
      const when = () => ""
      const preview = () => fixture.actions.push("preview")
      const download = () => fixture.actions.push("download")
      const enter = () => fixture.actions.push("enter")
    `, cards, { layout, actions })
    try {
      const keyFor = { download: " ", enter: "Enter" }
      for (const [action, key] of Object.entries(keyFor)) {
        const button = ui.get(`button[data-act="${action}"]`)
        assert.equal(ui.event(button, "keydown", { key }).defaultPrevented, false)
        // Domino does not synthesize the native click from a keyboard event.
        button.click()
      }
      ui.get('button[data-act="preview"]').click()
      assert.deepEqual(actions, ["download", "enter", "preview"])
      assert(!ui.get('button[data-act="preview"]').closest('[role="button"]'))
    } finally { ui.close() }
  })
}

test("voice usage takes focus, traps Tab, and restores the opener", async () => {
  const ui = await mount(`
    import VoiceUsageDialog from "fixture:voice"
    const open = ref(false)
  `, `<div v-modal><button id="opener" @click="open = true">Voice</button>
    <button id="background">Background action</button>
    <Teleport to="body"><VoiceUsageDialog v-if="open" @close="open = false" /></Teleport>
  </div>`, { simulateFocus: true }, { voice: dialog("VoiceUsageDialog", "") }, true)
  try {
    await ui.settle()
    const opener = ui.get("#opener")
    opener.focus()
    opener.click()
    await ui.settle()
    const close = ui.get("[data-voice-usage-close]")
    assert(ui.document.activeElement === close)
    const background = ui.get("#background")
    assert(background.closest("[inert]"))
    background.focus()
    assert(ui.document.activeElement === close)
    assert(ui.event(background, "keydown", { key: " " }).defaultPrevented)
    assert.equal(ui.event(close, "keydown", { key: "Tab" }).defaultPrevented, true)
    assert(ui.document.activeElement === close)
    close.click()
    await ui.settle()
    assert(!ui.get("#background").closest("[inert]"))
    assert(ui.document.activeElement === opener)
  } finally { ui.close() }
})

test("shared modal preserves the alertdialog role", async () => {
  const ui = await mount('import ConfirmDialog from "fixture:confirm"',
    '<ConfirmDialog title="Confirm" body="Continue?" confirm-label="Yes" />',
    { simulateFocus: true }, { confirm: dialog("ConfirmDialog", "") }, true)
  try {
    assert.equal(ui.get("[data-confirm-dialog]").getAttribute("role"), "alertdialog")
  } finally { ui.close() }
})

test("file tree drag ends on pointercancel, lost capture, and unmount", async () => {
  const sfc = component("right/RpFiles")
  const fragment = between(sfc, 'const TREE_KEY =', "/* ---------------------------------------------------------------- the row menu")
  const ui = await mount(`${fragment}\ndefineExpose({ treeWidth })`,
    sfc.match(/<div class="fv-grip"[^>]*\/>/)![0])
  let unmounted = false
  try {
    const grip = ui.get(".fv-grip")
    Object.assign(grip, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => true })
    const pointer = (type: string, clientX: number) => ui.event(grip, type, { pointerId: 1, clientX })
    for (const cancel of ["pointercancel", "lostpointercapture"]) {
      const before = ui.exposed.treeWidth
      pointer("pointerdown", 0)
      pointer("pointermove", 20)
      assert.equal(ui.exposed.treeWidth, before + 20)
      pointer(cancel, 20)
      pointer("pointermove", 40)
      assert.equal(ui.exposed.treeWidth, before + 20)
    }
    const before = ui.exposed.treeWidth
    pointer("pointerdown", 0)
    ui.close()
    unmounted = true
    pointer("pointermove", 20)
    assert.equal(ui.exposed.treeWidth, before)
  } finally { if (!unmounted) ui.close() }
})

test("search holds the loading row until transcript results settle", async () => {
  const sfc = component("SearchOverlay")
  const messages = deferred<{ hits: unknown[] }>()
  let search: (() => void) | undefined
  const ui = await mount(`
    const app = fixture.app
    const setTimeout = fixture.schedule
    const flat = ref([])
    const RECENT = 50
    ${between(sfc, 'const query =', '/* MiMo keeps the overlay')}
    ${between(sfc, 'let timer:', '/** Plays MiMo')}
  `, sfc.match(/<input\s+id="search-overlay-query"[\s\S]*?\/>/)![0] +
    between(sfc, '<div v-if="messageFailed"', '<div v-for="group in groups"'),
  { app: { client: { request: ({ type }: { type: string }) =>
    type === "search.messages" ? messages.promise : Promise.resolve({ artifacts: [] }) } },
  schedule: (callback: () => void) => { search = callback } })
  try {
    ui.input("input", "query")
    await ui.settle()
    search?.()
    await ui.settle()
    assert(ui.document.querySelector("[data-search-loading]"))
    messages.resolve({ hits: [] })
    await ui.settle()
    assert.equal(ui.get(".sr-empty").textContent, "searchOverlay.empty")
  } finally { ui.close() }
})

test("lab polling recovery clears its own error", async () => {
  let poll: (() => Promise<void>) | undefined
  let attempts = 0
  const ui = await mount('import LabEvolve from "fixture:lab"', '<LabEvolve />', {
    schedule: (callback: () => Promise<void>) => { poll = callback },
    app: { platform: "linux", client: { request: async () => {
      if (++attempts === 1) throw new Error("offline")
      return { history: [] }
    } } },
  }, { lab: dialog("LabEvolve", 'const LAB_TASK_SET = "builtin"; const setTimeout = fixture.schedule; const useApp = () => fixture.app') })
  try {
    await ui.settle()
    assert.match(ui.get('[role="alert"]').textContent!, /offline/)
    assert(poll)
    await poll()
    await ui.settle()
    assert(!ui.document.querySelector('[role="alert"]'))
  } finally { ui.close() }
})

test("queue textarea gets its accessible label from one translation", async () => {
  const label = between(component("QueueBar"), '<label class="queue-editor-label">', '<div class="queue-editor-actions">')
  const ui = await mount('const draft = ref(""); const editKeys = () => {}', label)
  try {
    assert.equal(ui.get("label span").textContent, "composer.queue.editingDraft")
  } finally { ui.close() }
})

test("clone ID names its input and associates validation feedback", async () => {
  const ui = await mount('import ProviderCloneDialog from "fixture:clone"',
    '<ProviderCloneDialog initial="available" :taken="new Set()" />', {},
    { clone: dialog("ProviderCloneDialog", `
      const composing = () => false
      const providerIdProblem = (value) => value ? undefined : "required"
      const providerIdError = () => "Required"
    `) })
  try {
    const input = ui.get("[data-clone-provider-id]")
    assert(input.getAttribute("aria-label"))
    ui.input("[data-clone-provider-id]", "")
    await ui.settle()
    assert.equal(input.getAttribute("aria-invalid"), "true")
    assert(ui.document.getElementById(input.getAttribute("aria-describedby")!) === ui.get("[data-clone-provider-error]"))
  } finally { ui.close() }
})

test("terminal tabs rove with arrows, Home, and End", async () => {
  const sfc = component("TerminalDrawer")
  const ui = await mount(`
    const terms = ref([{ id: 1, num: 1 }, { id: 2, num: 2 }, { id: 3, num: 3 }])
    const activeID = ref(1)
    const terminalLabel = (num) => num
    const paneOf = () => undefined
    const requestClose = () => {}
    ${between(sfc, 'function select(', 'function add(')}
  `, '<div class="head" role="tablist">' +
    between(sfc, '        <div\n          v-for="term in terms"', "        <!-- MiMo's: a bare plus") +
    '</div>', { simulateFocus: true })
  try {
    const tabs = [...ui.document.querySelectorAll<HTMLElement>("[role=tab]")]
    assert.deepEqual(tabs.map(tab => tab.getAttribute("tabindex")), ["0", "-1", "-1"])
    tabs[0].focus()
    for (const [key, from, to] of [["ArrowRight", 0, 1], ["End", 1, 2], ["Home", 2, 0], ["ArrowLeft", 0, 2]] as const) {
      assert(ui.event(tabs[from], "keydown", { key }).defaultPrevented)
      await ui.settle()
      assert(ui.document.activeElement === tabs[to])
      assert.equal(tabs[to].getAttribute("aria-selected"), "true")
      assert.equal(tabs[to].getAttribute("tabindex"), "0")
    }
  } finally { ui.close() }
})

test("sidebar separator is focusable and emits keyboard width changes", async () => {
  const sfc = component("Sidebar")
  const resizes: unknown[][] = []
  const ui = await mount(`
    const props = { width: 200, maxWidth: 420 }
    const { width, maxWidth } = props
    const SIDE_WIDTH_MIN = 160
    const left = ref(true)
    const collapsed = false
    const emit = (...args) => fixture.resizes.push(args)
    ${between(sfc, 'const dragging = ref(false)\nfunction beginResize', '/*\n * MiMo 26.920\'s folded column')}
  `, sfc.match(/<div\s+v-if="!collapsed"\s+class="resizer"[\s\S]*?\/>/)![0], { resizes, simulateFocus: true })
  try {
    const bar = ui.get("[data-side-resizer]")
    assert.equal(bar.getAttribute("role"), "separator")
    assert.equal(bar.getAttribute("tabindex"), "0")
    bar.focus()
    assert(ui.document.activeElement === bar)
    assert(ui.event(bar, "keydown", { key: "ArrowRight" }).defaultPrevented)
    assert(ui.event(bar, "keydown", { key: "ArrowLeft" }).defaultPrevented)
    assert.deepEqual(resizes, [["resize", 212, true], ["resize", 188, true]])
  } finally { ui.close() }
})

/* Standalone entry: runs what this file registered, in file order. The battery ignores this and
 * drives `uiA11yChecks` instead, so the case count is never left to an argv match. The basename is
 * compared exactly because the battery builds this file as `rounds-smoke-ui-a11y.mjs`. */
const entry = process.argv[1]?.split("/").pop()
if (entry === "smoke-ui-a11y.ts" || entry === "smoke-ui-a11y.mjs") {
  void (async () => {
    let failed = 0
    for (const { name, run } of registered) {
      try { await run() } catch (err) { failed++; console.log("FAIL " + name + " -> " + reason(err)) }
    }
    console.log(`${registered.length - failed}/${registered.length} checks passed`)
    if (failed) process.exitCode = 1
  })()
}
