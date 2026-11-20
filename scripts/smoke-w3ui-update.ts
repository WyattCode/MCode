import assert from "node:assert/strict"
import { between, component, deferred, mount } from "./smoke-ui-races"

type Check = (label: string, ok: boolean, detail?: unknown) => void

export async function w3uiUpdateChecks(check: Check): Promise<void> {
  for (const [label, run] of [
    ["update row renders every main phase with real disabled and retry actions", updateRow],
    ["update feed input has an associated label", feedLabel],
    ["archive title exposes named checkbox state only while selectable", archiveCheckbox],
  ] as const) {
    try { await run(); check(label, true) } catch (err) { check(label, false, (err as Error).message) }
  }
}

async function updateRow() {
  const source = component("SettingsDialog")
  const reply = deferred<{ outcome: string }>()
  const retry = deferred<{ outcome: string }>()
  let sendPhase!: (state: { phase: string; ready: unknown }) => void
  let checks = 0
  let installs = 0
  const ui = await mount(`
    const props = {}
    const section = ref("updates")
    const updateState = reactive({ phase: "idle", version: "", error: "" })
    const installUpdate = fixture.install
    const app = { version: "1.0" }
    window.mcode = fixture.bridge
    ${between(source, "// Update status in settings", "// Local feedback history")}
  `, between(source, '<div class="line" data-update-row', '<div class="line">'), {
    install: () => { installs++ },
    bridge: {
      updateStatus: async () => ({ phase: "idle", ready: null }),
      onUpdateState: (listener: typeof sendPhase) => { sendPhase = listener; return () => {} },
      updateCheckNow: () => { return ++checks === 1 ? reply.promise : retry.promise },
    },
  })
  try {
    await ui.settle()
    const text = () => ui.get("[data-update-row]").textContent ?? ""
    const button = () => ui.get<HTMLButtonElement>("[data-update-row] button")
    assert.match(text(), /update.check/)
    assert.equal(button().disabled, false)
    sendPhase({ phase: "checking", ready: null })
    await ui.settle()
    assert.match(text(), /set.checking/)
    assert.equal(button().disabled, true)
    button().click()
    assert.equal(checks, 0)
    sendPhase({ phase: "idle", ready: null })
    await ui.settle()
    button().click()
    button().click()
    assert.equal(checks, 1)
    for (const [phase, label] of [["checking", "set.checking"], ["downloading", "update.downloading"]]) {
      sendPhase({ phase, ready: null })
      await ui.settle()
      assert(text().includes(label))
      assert.equal(button().disabled, true)
      button().click()
      assert.equal(checks, 1)
    }
    assert(ui.get("progress").getAttribute("value") === null)
    sendPhase({ phase: "idle", ready: null })
    reply.resolve({ outcome: "failed" })
    await ui.settle()
    assert.match(text(), /update.checkFailed/)
    assert.match(text(), /update.pillRetry/)
    assert.equal(button().disabled, false)
    button().click()
    assert.equal(checks, 2)
    await ui.settle()
    sendPhase({ phase: "ready", ready: { version: "2.0", notes: "" } })
    retry.resolve({ outcome: "ready" })
    await ui.settle()
    assert.match(text(), /update.readyVersion/)
    assert.equal(ui.get("[data-update-row]").getAttribute("data-update-version"), "2.0")
    assert.match(text(), /set.restartUpdate/)
    assert.equal(button().disabled, false)
    button().click()
    assert.equal(installs, 1)
  } finally { ui.close() }
}

async function feedLabel() {
  const ui = await mount('const app = { config: {} }', '<div class="line-text">' + between(component("SettingsDialog"),
    '<label for="settings-update-feed"', '<!-- MCode\'s own row').replace(/\s*<\/div>\s*$/, ""))
  try {
    const input = ui.get("input")
    assert(input.id)
    assert.equal(ui.get(`label[for="${input.id}"]`).textContent, "set.updateFeed")
  } finally { ui.close() }
}

async function archiveCheckbox() {
  const ui = await mount(`
    const selecting = ref(false), pickedLive = ref([])
    const session = { id: "one", title: "Archived conversation" }
    const sessionTitle = (title) => title
    const togglePick = (id) => { pickedLive.value = pickedLive.value.includes(id) ? [] : [id] }
    ${between(component("SettingsDialog"), "function onArchiveTitleSpace", "\n}")}
    }
    defineExpose({ selecting })
  `, between(component("SettingsDialog"), "<!-- In select mode", '<div class="line-sub">{{ archivedDescription'))
  try {
    const title = () => ui.get(".archived-title")
    assert.equal(title().getAttribute("role"), null)
    assert.equal(title().getAttribute("tabindex"), null)
    assert.equal(ui.event(title(), "keydown", { key: " " }).defaultPrevented, false)
    ui.exposed.selecting = true
    await ui.settle()
    assert.equal(title().getAttribute("role"), "checkbox")
    assert.equal(title().getAttribute("aria-label"), "Archived conversation")
    assert.equal(title().getAttribute("aria-checked"), "false")
    assert.equal(title().getAttribute("tabindex"), "0")
    assert(ui.event(title(), "keydown", { key: " " }).defaultPrevented)
    await ui.settle()
    assert.equal(title().getAttribute("aria-checked"), "true")
    ui.event(title(), "keydown", { key: " ", repeat: true })
    await ui.settle()
    assert.equal(title().getAttribute("aria-checked"), "true")
    title().click()
    await ui.settle()
    assert.equal(title().getAttribute("aria-checked"), "false")
  } finally { ui.close() }
}
