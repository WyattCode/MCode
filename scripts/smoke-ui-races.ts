import fs from "node:fs"
import { createRequire } from "node:module"
import assert from "node:assert/strict"
import { compileScript, parse } from "@vue/compiler-sfc"
import { build } from "esbuild"

/*
 * The battery only counts a module through an `export function x(check)`; a file that registers its
 * cases with node:test behind an argv gate contributes zero checks and stays green forever. So the
 * registration here is unconditional, and one exported runner reports every case by name.
 */
const registered: Array<{ name: string; run: () => Promise<unknown> }> = []
const test = (name: string, run: () => Promise<unknown>) => { registered.push({ name, run }) }
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 180)

export async function uiRaceChecks(check: (label: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  for (const { name, run } of registered) {
    try { await run(); check(name, true) } catch (err) { check(name, false, reason(err)) }
  }
}

export const component = (name: string) => fs.readFileSync(`src/renderer/src/components/${name}.vue`, "utf8")
export function between(source: string, start: string, end: string) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert(from >= 0 && to >= 0, `Missing fragment: ${start}`)
  return source.slice(from, to)
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function mount(
  setup: string, template: string, fixture: Record<string, any> = {},
  children: Record<string, string> = {}, realModal = false,
) {
  const compile = (source: string, id: string) =>
    compileScript(parse(source).descriptor, { id, inlineTemplate: true }).content
  const source = `<script setup lang="ts">
    import { reactive, ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue"
    declare const fixture: any
    const t = (key: string) => key
    const notify = fixture.notify ?? (() => {})
    const notifyFailure = notify
    ${setup}
    </script><template>${template}</template>`
  const { outputFiles } = await build({
    stdin: {
      contents: compile(source, "smoke") + '\nexport { createApp, nextTick } from "vue";' +
        (realModal ? '\nexport { installModal } from "./src/renderer/src/lib/modal";' : ""),
      loader: "ts", resolveDir: process.cwd(),
    },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{
      name: "fixtures",
      setup(build) {
        build.onResolve({ filter: /^fixture:/ }, ({ path }) => ({ path: path.slice(8), namespace: "fixture" }))
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: compile(children[path], path), loader: "ts", resolveDir: process.cwd(),
        }))
      },
    }],
  })
  const require = createRequire(import.meta.url)
  const window = require("@mixmark-io/domino").createWindow()
  const document: Document = window.document
  window.Node.prototype.getRootNode ??= function (this: Node) { return this.ownerDocument }
  window.HTMLInputElement.prototype.select ??= () => {}
  window.HTMLInputElement.prototype.setSelectionRange ??= () => {}
  if (fixture.simulateFocus) {
    let active: Element = document.body
    Object.defineProperty(document, "activeElement", { get: () => active })
    const create = document.createElement.bind(document)
    document.createElement = ((name: string, options?: ElementCreationOptions) => {
      const el = create(name, options)
      Object.defineProperty(el, "offsetParent", { get: () => el.parentElement })
      Object.defineProperty(el, "focus", { value() {
        active = el
        el.dispatchEvent(new window.Event("focusin", { bubbles: true }))
      } })
      return el
    }) as typeof document.createElement
  }
  const frames = new Map<number, FrameRequestCallback>()
  let frame = 0
  const environment = {
    fixture, document, window, SVGElement: window.SVGElement ?? class {}, Element: window.Element,
    Document: window.Document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, FileReader: fixture.FileReader,
    getComputedStyle: () => ({ direction: "ltr" }), localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }
  const module = { exports: {} }
  new Function("module", "exports", "require", ...Object.keys(environment), outputFiles[0].text)(
    module, module.exports, require, ...Object.values(environment),
  )
  const { default: View, createApp, nextTick, installModal } = module.exports as any
  const host = document.createElement("div")
  document.body.appendChild(host)
  const view = createApp(View)
  if (installModal) installModal(view)
  else view.directive("modal", {})
  view.directive("tip", {})
  const exposed = view.mount(host)
  const settle = async () => {
    await Promise.resolve()
    await nextTick()
    await Promise.resolve()
    await nextTick()
    for (const [id, callback] of frames) { frames.delete(id); callback(0) }
  }
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const node = document.querySelector<T>(selector)
    assert(node, selector)
    return node
  }
  const event = (node: Element, type: string, fields = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, "stopImmediatePropagation", { value: event.stopImmediatePropagation, writable: true })
    Object.assign(event, fields)
    node.dispatchEvent(event)
    return event as Event
  }
  const input = (selector: string, value: string) => {
    const node = get<HTMLInputElement>(selector)
    node.value = value
    event(node, "input")
  }
  return { document, exposed, get, input, event, settle, close() { view.unmount(); host.remove() } }
}

function instructions() {
  const sfc = component("SettingsDialog")
  const setup = between(sfc, "const draft =", "/* This app's own files")
  const fields = between(sfc, '<textarea\n            v-model="draft"', "        </template>")
  const guard = between(sfc, "const pendingLeave =", "/*\n * MiMo focuses")
    .replace("defineExpose({ leaveThen })", "")
  return { sfc, setup, fields, guard }
}

export function dialog(name: string, setup: string) {
  return component(name).replace(/^import (?!.*from "vue")[^\n]+\n/gm, "")
    .replace('<script setup lang="ts">', `<script setup lang="ts">
      declare const fixture: any
      const t = (key: string) => key
      const useEscapeLayer = () => {}
      ${setup}
    `)
}

async function models(app: Record<string, any>) {
  const source = component("ModelsPage")
    .replace(/^import (?!.*from "vue")[^\n]+\n/gm, "")
    .replace('<script setup lang="ts">', `<script setup lang="ts">
      import { reactive } from "vue"
      import ConfirmDialog from "fixture:confirm"
      import ProviderCloneDialog from "fixture:clone"
      import CustomProviderForm from "fixture:form"
      declare const fixture: any
      const useApp = () => reactive(fixture.app)
      const t = (key: string) => key
      const notify = () => {}
      const notifyFailure = notify
      const providerLabel = (provider) => provider.name
      const ProviderIcon = { render: () => null }
      const ConnectDialog = ProviderIcon
      const PROVIDER_PRESETS = { custom: { label: "Custom" } }
      const cloneId = (id) => id + "-copy"
    `)
  const providers = [
    { id: "vendor", name: "Vendor", configured: true, kind: "openai-compatible", models: [], baseURL: "old" },
    ...["first", "second"].map(id => ({ id, name: id, custom: true, models: [] })),
  ]
  const ui = await mount('import ModelsPage from "fixture:models"',
    '<div data-settings-overlay><div class="dialog"><ModelsPage /></div></div>',
    { app: { providers, config: { customProviders: providers.slice(1) }, ...app } },
    {
      models: source,
      confirm: dialog("ConfirmDialog", ""),
      clone: dialog("ProviderCloneDialog", 'const composing = () => false; const providerIdProblem = () => undefined; const providerIdError = () => ""'),
      form: `<script setup>
        import { ref, computed } from "vue"
        const form = ref({ name: "" })
        ${between(component("CustomProviderForm"), "const snapshot =", "const protocolOptions =")}
        defineExpose({ dirty })
        </script><template><input data-form-draft v-model="form.name"></template>`,
    })
  await ui.settle()
  return ui
}

export function raceTests() {
  test("file write commits its submitted snapshot and keeps subsequent typing", async () => {
    const sfc = component("right/RpFiles")
    const write = deferred()
    const requests: any[] = []
    const ui = await mount(`
      const app = fixture.app
      const props = { viewFile: "file.txt" }
      const root = ref("/project")
      const opened = ref({ content: "old" })
      const draft = ref("")
      const editing = ref(false)
      const saving = ref(false)
      const isText = ref(true)
      const saveFailureKey = (message: string) => message
      ${between(sfc, "function startEdit()", "/* ---------------------------------------------------------------- actions")}
      defineExpose({ opened, editing })
    `, `<button id="edit" @click="startEdit">Edit</button>
      ${sfc.match(/<textarea v-model="draft"[^>]+\/>/)?.[0]}
      ${sfc.match(/<button[^>]*data-ft-save[^>]*>[\s\S]*?<\/button>/)?.[0]}`,
    { app: { client: { request(value: any) { requests.push(value); return write.promise } } } })
    try {
      ui.get("#edit").click()
      await ui.settle()
      ui.input("textarea", "A")
      ui.get("[data-ft-save]").click()
      ui.input("textarea", "B")
      write.resolve()
      await ui.settle()
      assert.equal(requests[0].content, "A")
      assert.equal(ui.exposed.opened.content, "A")
      assert.equal(ui.exposed.editing, true)
      assert.equal(ui.get<HTMLTextAreaElement>("textarea").value, "B")
    } finally { ui.close() }
  })

  for (const newer of ["B", "old"]) test(`instructions save preserves typing during the request (${newer})`, async () => {
    const { setup, fields } = instructions()
    const write = deferred()
    const ui = await mount(`
      const app = reactive({ config: { instructions: "old" }, patchConfig: fixture.patchConfig })
      ${setup}
      defineExpose({ app })
    `, fields, { patchConfig: () => write.promise })
    try {
      ui.input("textarea", " A ")
      await ui.settle()
      ui.get("[data-ci-save]").click()
      ui.input("textarea", newer)
      ui.exposed.app.config.instructions = "A"
      write.resolve()
      await ui.settle()
      assert.equal(ui.get<HTMLTextAreaElement>("textarea").value, newer)
    } finally { ui.close() }
  })

  test("external instructions follow the saved baseline only when pristine", async () => {
    const { setup, fields } = instructions()
    const ui = await mount(`
      const app = reactive({ config: { instructions: "old" } })
      ${setup}
      defineExpose({ app })
    `, fields)
    try {
      ui.exposed.app.config.instructions = "external"
      await ui.settle()
      assert.equal(ui.get<HTMLTextAreaElement>("textarea").value, "external")
      ui.input("textarea", "local")
      ui.exposed.app.config.instructions = "later"
      await ui.settle()
      assert.equal(ui.get<HTMLTextAreaElement>("textarea").value, "local")
    } finally { ui.close() }
  })

  test("closing settings offers keeping or discarding unsaved instructions", async () => {
    const { sfc, setup, fields, guard } = instructions()
    const confirmation = sfc.match(/<Teleport to="body">\s*<ConfirmDialog\s+v-if="pendingLeave"[\s\S]*?<\/Teleport>/)?.[0]
    assert(confirmation)
    const ui = await mount(`
      import ConfirmDialog from "fixture:confirm"
      const app = reactive({ config: { instructions: "old" } })
      const configuring = ref()
      const envDirty = ref(false)
      const envName = ref("")
      const emit = fixture.emit
      ${setup}
      ${guard}
    `, fields + confirmation + sfc.match(/<button class="close"[^>]*data-settings-close[\s\S]*?<\/button>/)?.[0],
    { emit: () => { closed++ } }, { confirm: dialog("ConfirmDialog", "") })
    let closed = 0
    try {
      ui.document.documentElement.setAttribute("data-motion", "on")
      ui.input("textarea", "local")
      ui.get("[data-settings-close]").click()
      await ui.settle()
      assert.equal(closed, 0)
      assert.equal(ui.get("[data-confirm-dialog] .ghost").textContent, "set.unsavedKeepEditing")
      assert.equal(ui.get("[data-confirm]").textContent, "set.unsavedDiscard")
      ui.get("[data-confirm-dialog] .ghost").click()
      await ui.settle()
      assert.equal(ui.get<HTMLTextAreaElement>("textarea").value, "local")
      ui.get("[data-settings-close]").click()
      await ui.settle()
      ui.get("[data-confirm]").click()
      await ui.settle()
      assert.equal(closed, 1)
    } finally { ui.close() }
  })

  test("endpoint reply keeps newer edits for the same provider", async () => {
    const write = deferred()
    const ui = await models({ patchConfig: () => write.promise })
    try {
      ui.input("[data-provider-endpoint]", "A")
      await ui.settle()
      ui.get(".endpoint button").click()
      ui.input("[data-provider-endpoint]", "B")
      write.resolve()
      await ui.settle()
      assert.equal(ui.get<HTMLInputElement>("[data-provider-endpoint]").value, "B")
    } finally { ui.close() }
  })

  test("provider tab asks before discarding a dirty custom form", async () => {
    const ui = await models({})
    try {
      ui.get('[data-provider-tab="first"]').click()
      await ui.settle()
      ui.input("[data-form-draft]", "local")
      ui.get('[data-provider-tab="second"]').click()
      await ui.settle()
      assert.equal(ui.get('[data-provider-tab="first"]').getAttribute("aria-pressed"), "true")
      ui.get("[data-confirm-dialog] .ghost").click()
      await ui.settle()
      assert.equal(ui.get<HTMLInputElement>("[data-form-draft]").value, "local")
      ui.get('[data-provider-tab="second"]').click()
      await ui.settle()
      ui.get("[data-confirm]").click()
      await ui.settle()
      assert.equal(ui.get('[data-provider-tab="second"]').getAttribute("aria-pressed"), "true")
    } finally { ui.close() }
  })

  test("clone submits once and its reply leaves the replacement dialog intact", async () => {
    const write = deferred<string>()
    let calls = 0
    const ui = await models({ copyCustomProvider: () => { calls++; return write.promise } })
    try {
      ui.get('[data-provider-tab="first"]').click()
      await ui.settle()
      ui.get("[data-provider-clone]").click()
      await ui.settle()
      ui.get("[data-clone-confirm]").click()
      ui.event(ui.get("[data-clone-provider-id]"), "keydown", { key: "Enter" })
      await ui.settle()
      assert.equal(calls, 1)
      ui.get("[data-clone-cancel]").click()
      await ui.settle()
      ui.get('[data-provider-tab="second"]').click()
      await ui.settle()
      ui.get("[data-provider-clone]").click()
      await ui.settle()
      write.resolve("first-copy")
      await ui.settle()
      assert.equal(ui.get<HTMLInputElement>("[data-clone-provider-id]").value, "second-copy")
      assert.equal(ui.get('[data-provider-tab="second"]').getAttribute("aria-pressed"), "true")
    } finally { ui.close() }
  })

  test("delete pending prevents resubmission and its reply keeps the new confirmation", async () => {
    const write = deferred()
    let calls = 0
    const ui = await models({ removeCustomProvider: () => { calls++; return write.promise }, ensureUsableModel: async () => {} })
    try {
      ui.get('[data-provider-tab="first"]').click()
      await ui.settle()
      ui.get("[data-provider-remove]").click()
      await ui.settle()
      ui.get("[data-confirm]").click()
      await ui.settle()
      assert.equal(ui.get<HTMLButtonElement>("[data-confirm]").disabled, true)
      ui.get("[data-confirm]").click()
      ui.event(ui.get("[data-confirm-dialog]").parentElement!, "mousedown")
      await ui.settle()
      ui.get('[data-provider-tab="second"]').click()
      await ui.settle()
      ui.get("[data-provider-remove]").click()
      await ui.settle()
      write.resolve()
      await ui.settle()
      assert.equal(ui.get<HTMLButtonElement>("[data-confirm]").disabled, false)
      assert.equal(calls, 1)
    } finally { ui.close() }
  })

  test("project save waits for the selected icon and handles read failure", async () => {
    const patches: any[] = []
    const readers: Reader[] = []
    class Reader {
      result = "data:image/png;base64,new"
      onload?: () => void
      onerror?: () => void
      readAsDataURL() { readers.push(this) }
    }
    const ui = await mount('import ProjectDialog from "fixture:project"', '<ProjectDialog directory="/project" />',
      { FileReader: Reader, app: { config: {}, patchConfig: (patch: any) => patches.push(patch) } },
      { project: dialog("ProjectDialog", 'const useApp = () => fixture.app; const projectHue = () => 20; const composing = () => false') })
    try {
      const pick = ui.get('input[type="file"]')
      Object.defineProperty(pick, "files", { value: [{ type: "image/png", size: 1 }] })
      ui.event(pick, "change")
      ui.event(ui.get("#proj-name"), "keydown", { key: "Enter" })
      await ui.settle()
      assert.equal(patches.length, 0)
      readers[0].onload?.()
      await ui.settle()
      ui.event(ui.get("#proj-name"), "keydown", { key: "Enter" })
      await ui.settle()
      assert.equal(patches[0].projectIcons["/project"], readers[0].result)
      ui.event(pick, "change")
      readers[1].onerror?.()
      await ui.settle()
      assert(ui.document.querySelector(".error"))
    } finally { ui.close() }
  })
}
raceTests()
if (process.argv[1]?.endsWith("smoke-ui-races.mjs")) {
  void (async () => {
    let failed = 0
    for (const { name, run } of registered) {
      try { await run() } catch (err) { failed++; console.log("FAIL " + name + " -> " + reason(err)) }
    }
    console.log(`${registered.length - failed}/${registered.length} checks passed`)
    if (failed) process.exitCode = 1
  })()
}
