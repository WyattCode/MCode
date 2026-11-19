import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { compileScript, parse } from "@vue/compiler-sfc"
import { probeModels } from "../src/server/provider/discover"
import type { CustomProvider } from "../src/shared/protocol"
import type { Check } from "./smoke-round5"

export async function modelParityChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Model editor dialog")
  const probe = (body: unknown) => probeModels({
    baseURL: "https://example.test",
    apiKey: "",
    fetcher: async () => Response.json(body),
  })
  const metadata = { id: "m-x", name: "X 模型", contextWindow: 200000, maxOutput: 32000, inputs: { image: true } }
  const probed = await probe({ data: ["m-x", metadata, { id: "invalid", contextWindow: -1, maxOutput: 2.5 }] })
  check("probe preserves metadata and discards invalid limits", probed.ok &&
    JSON.stringify(probed.models) === JSON.stringify([metadata, "invalid"]), probed)
  const require = createRequire(import.meta.url)
  const window = require("@mixmark-io/domino").createWindow()
  // The fixture uses one document, with no shadow roots.
  window.Node.prototype.getRootNode ??= function (this: Node) { return this.ownerDocument }
  const { outputFiles } = await build({
    stdin: {
      contents: `export { default as Form } from "./src/renderer/src/components/CustomProviderForm.vue"
        export { createApp, nextTick } from "vue"
        export { fixture } from "./src/renderer/src/stores/app"`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { "@shared": "./src/shared" },
    plugins: [{
      name: "model-editor-smoke",
      setup(builder) {
        builder.onResolve({ filter: /\/(stores\/app|lib\/toast)$/ }, (args) => ({ path: args.path.split("/").slice(-2).join("/"), namespace: "fixture" }))
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: path.endsWith("/app")
            ? `export const fixture = { saved: [], providers: [{ id: "catalog", models: [
                  { id: "alpha", name: "Catalog name", contextWindow: 512000, maxOutput: 64000,
                    inputs: { image: true }, variants: ["medium", "high"], defaultEffort: "medium" },
                  { id: "catalog-only", name: "Catalog only", variants: [] },
                  { id: "m-x", name: "X 模型目录", contextWindow: 100000, maxOutput: 16000, inputs: { audio: true }, variants: [] }
                ] }],
                probeProvider: async () => ({ ok: true, modelIds: [
                  { id: "alpha", name: "Catalog name", contextWindow: 512000, maxOutput: 64000, inputs: { image: true } },
                  "beta"
                ] }),
                addCustomProvider: async (entry) => fixture.saved.push(entry),
                updated: [], removed: [],
                updateCustomProvider: async (entry) => fixture.updated.push(entry),
                removeCustomModel: async (...args) => fixture.removed.push(args) }
              export const useApp = () => fixture`
            : "export const notice = { warning() {}, danger() {}, success() {} }; export const notifyFailure = () => {}",
        }))
        builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => ({
          contents: compileScript(parse(await readFile(path, "utf8"), { filename: path }).descriptor, {
            id: path,
            inlineTemplate: true,
          }).content,
          loader: "ts",
        }))
      },
    }],
  })
  const module = { exports: {} }
  new Function("module", "exports", "require", "document", "window", "SVGElement", "Element", "Document", outputFiles[0].text)(
    module, module.exports, require, window.document, window, window.SVGElement ?? class {}, window.Element, window.Document,
  )
  const { createApp, nextTick, Form, fixture } = module.exports as {
    createApp: typeof import("vue").createApp
    nextTick: typeof import("vue").nextTick
    Form: typeof import("../src/renderer/src/components/CustomProviderForm.vue").default
    fixture: {
      saved: CustomProvider[]
      updated: CustomProvider[]
      removed: string[][]
      probeProvider: () => Promise<unknown>
    }
  }
  const document = window.document as Document
  const host = document.createElement("div")
  document.body.appendChild(host)
  const app = createApp(Form)
  app.directive("modal", {})

  const form = app.mount(host) as unknown as { submit: () => Promise<boolean> }
  const find = (selector: string) => document.querySelector<HTMLInputElement>(selector)
  const event = (selector: string, type: string, properties: object = {}) => {
    const element = find(selector)
    if (!element) throw new Error(`Missing editor control ${selector}`)
    const dispatched = new window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(dispatched, properties)
    element.dispatchEvent(dispatched)
    return nextTick()
  }
  const click = (selector: string) => event(selector, "click")
  const input = (selector: string, value: string) => {
    const element = find(selector)
    if (!element) throw new Error(`Missing input ${selector}`)
    element.value = value
    return event(selector, "input")
  }
  const combo = "[data-model-combo]"
  const save = "[data-model-editor-save]"
  const context = '[data-model-limit="context"]'
  const output = '[data-model-limit="output"]'
  const name = "[data-model-name-editor]"
  const comboMenu = "[data-model-combo-menu]"
  const pressed = () => Array.from(document.querySelectorAll("[data-model-reasoning-preset][aria-pressed=true]"))
    .map((button) => button.getAttribute("data-model-reasoning-preset")).join()
  try {
    check("shows the model list empty state", find("[data-model-list-empty]")?.textContent?.trim() === "暂无模型，添加模型后可在聊天中使用。")
    await click("[data-model-add]")
    const opened = Boolean(find("[data-model-editor-dialog][role=dialog]"))
    check("add opens a model dialog", opened)
    if (!opened) return

    await input("[data-provider-id]", "smoke-models")
    await input("[data-custom-endpoint]", "https://example.test")
    await input("input[type=password]", "fixture-key")
    await click("[data-provider-probe]")
    await nextTick()
    await input(combo, "")
    check("only models returned by the connection test appear as candidates", Boolean(find('[data-model-combo-option="beta"]')) &&
      !find('[data-model-combo-option="catalog-only"]') && !find('[data-model-combo-option="beta"] [data-model-combo-name]'))
    await input(combo, "ALP")
    check("probe ids filter case-insensitively", Boolean(find('[data-model-combo-option="alpha"]')) && !find('[data-model-combo-option="beta"]'))
    await input(combo, "CATALOG NAME")
    check("candidate names filter case-insensitively and render separately", find("[data-model-combo-name]")?.textContent === "Catalog name")
    await event(combo, "compositionstart")
    await event(combo, "keydown", { key: "ArrowDown" })
    await event(combo, "keydown", { key: "Enter" })
    check("arrows and Enter are inactive during IME composition", find(combo)?.value === "CATALOG NAME" &&
      Boolean(find(comboMenu)) && !find(combo)?.hasAttribute("aria-activedescendant"))
    await event(combo, "compositionend")
    await event(combo, "keydown", { key: "ArrowDown" })
    await event(combo, "keydown", { key: "Enter" })
    check("Enter applies the highlighted candidate and its metadata", find(combo)?.value === "alpha" && find(name)?.value === "Catalog name" &&
      find(context)?.value === "512000" && find(output)?.value === "64000" && find('[data-model-modality="image"]')?.checked === true)
    check("the catalogue recommendation initializes the reasoning settings", find("[data-model-reasoning-state]")?.textContent === "已采用推荐配置")
    await click('[data-model-reasoning-preset="low-max"]')
    check("a customized recommendation can be restored", find("[data-model-reasoning-state]")?.textContent === "已自定义")
    await click("[data-model-reasoning-reset]")
    check("restoring the recommendation applies its set of levels", find("[data-model-reasoning-state]")?.textContent === "已采用推荐配置" &&
      document.querySelectorAll("[data-model-reasoning-level][aria-pressed=true]").length === 2)
    await input(name, "Manual display name")
    await input(combo, "beta")
    await click('[data-model-combo-option="beta"]')
    check("an id-only candidate leaves manually set fields alone", find(name)?.value === "Manual display name")
    await input(combo, "manual-id")
    check("manual ids clear automatic fields and preserve edited ones", find(name)?.value === "Manual display name" &&
      find(context)?.value === "" && find(output)?.value === "" && find('[data-model-modality="image"]')?.checked === false)
    check("unmatched input shows the manual-entry hint", find("[data-model-combo-empty]")?.textContent?.trim() === "未找到模型，请手动输入 model-id")
    await event(combo, "keydown", { key: "Enter" })
    check("Enter preserves the manual id", find(combo)?.value === "manual-id" && !find("[data-model-combo-menu]"))
    await input(context, "-1")
    await click(save)
    check("invalid limit is reported near its field", find('[data-model-field-error="context"][role=alert]')?.textContent?.trim() === "请输入正整数，或留空使用默认值")
    await click('[data-model-limit-option="context-256000"]')
    check("context preset writes the numeric input", find(context)?.value === "256000")
    const chip = '[data-model-limit-option="context-256000"]'
    for (const [value, expected] of [["0256000", "true"], ["256000", "true"], ["256000.5", "false"], ["abc", "false"], ["", "false"]]) {
      await input(context, value)
      check(`256K chip state for ${JSON.stringify(value)}`, find(chip)?.getAttribute("aria-pressed") === expected)
    }
    await input(context, "0256000")
    await click(save)
    check("an unpaired limit is reported near the empty field", find('[data-model-field-error="output"][role=alert]')?.textContent?.trim() === "请同时填写上下文和输出上限，或将两项都留空")
    await click('[data-model-limit-option="output-32000"]')
    const text = find('[data-model-modality="text"]')
    check("text is always checked and locked", text?.checked === true && text.disabled)
    for (const key of ["image", "audio"]) {
      const selector = `[data-model-modality="${key}"]`
      find(selector)!.checked = true
      await event(selector, "change")
    }
    await click('[data-model-reasoning-preset="none"]')
    check("no tuning is the only pressed preset when selected", pressed() === "none")
    await click('[data-model-reasoning-preset="low-high"]')
    check("low–high is the only pressed preset", pressed() === "low-high")
    await click('[data-model-reasoning-preset="low-max"]')
    check("low–max is the only pressed preset", pressed() === "low-max")
    await click(save)
    const card = find('[data-model-card="manual-id"]')
    check("add writes one row with formatted limit and modality chips", Boolean(find("[data-model-list]")) &&
      ["256K", "输出 32K", "图像 · 音频"].every((label) => card?.textContent?.includes(label)))
    await click("[data-model-add]")
    await click(save)
    check("empty ids get an inline error", find('[data-model-field-error="modelId"]')?.textContent?.trim() === "请输入模型 ID")
    await input(combo, "beta")
    await event(combo, "keydown", { key: "Escape" })
    check("Escape closes the combo alone", !find(comboMenu) && Boolean(find("[data-model-editor-dialog]")))
    if (!find(combo)) await click("[data-model-add]")
    await input(combo, "manual-id")
    await click(save)
    check("duplicate id stays in the dialog with an inline error", find('[data-model-field-error="modelId"]')?.textContent?.trim() === "模型已存在")
    await click("[data-model-editor-cancel]")
    await click('[data-model-edit="manual-id"]')
    await input(name, "Discarded")
    await click("[data-model-editor-cancel]")
    check("cancelling edits preserves the original row", card?.textContent?.includes("Manual display name") === true)
    await click('[data-model-edit="manual-id"]')
    check("editing reopens the saved preset", pressed() === "low-max")
    await input("[data-model-name-editor]", "Renamed model")
    await click('[data-model-reasoning-preset="none"]')
    await click(save)
    const submitted = await form.submit()
    check("edit replaces the row and saves through the provider channel with thinking off", submitted && fixture.saved[0]?.models.length === 1 &&
      fixture.saved[0].models[0]?.name === "Renamed model" && fixture.saved[0].models[0]?.thinking === undefined, fixture.saved.map(({ models }) => models))
    const savedModel = fixture.saved[0]?.models[0]
    check("provider save retains the model limits and input types",
      savedModel?.limit?.context === 256000 && savedModel.limit.output === 32000 &&
      savedModel.attachment === true && savedModel.inputs?.audio === true)
    for (const [index, rows] of [
      ["m-x"],
      [metadata],
    ].entries()) {
      const shape = index ? "metadata" : "id-only"
      const result = await probe(rows)
      fixture.probeProvider = async () => ({ ok: result.ok, modelIds: result.ok ? result.models : [] })
      await click("[data-provider-probe]")
      await click("[data-model-add]")
      const label = index ? "X 模型" : "X 模型目录"
      await input(combo, label)
      const option = '[data-model-combo-option="m-x"]'
      check(`real ${shape} response supports display-name search`, find(option)?.querySelector("[data-model-combo-name]")?.textContent === label)
      if (find(option)) await click(option)
      check(`real ${shape} candidate fills name, limits and inputs`, find(name)?.value === label &&
        find(context)?.value === (index ? "200000" : "100000") && find(output)?.value === (index ? "32000" : "16000") &&
        find(`[data-model-modality="${index ? "image" : "audio"}"]`)?.checked === true)
      await click(save)
      check(`real ${shape} candidate saves without field errors`, Boolean(find('[data-model-card="m-x"]')) &&
        !find("[data-model-editor-dialog]") && !find("[data-model-field-error]"))
      if (find("[data-model-editor-dialog]")) await click("[data-model-editor-cancel]")
      if (find('[data-model-rm="m-x"]')) {
        await click('[data-model-rm="m-x"]')
        await click("[data-confirm]")
      }
    }

    fixture.probeProvider = async () => ({ ok: false, reason: "http", status: 404 })
    await click("[data-provider-probe]")
    await click("[data-model-add]")
    await input(combo, "catalog only")
    check("a missing models endpoint falls back to catalog candidates", Boolean(find('[data-model-combo-option="catalog-only"]')))
    await click("[data-model-editor-cancel]")

    fixture.probeProvider = async () => ({ ok: true, modelIds: Array.from({ length: 250 }, (_, i) => `bulk-${i}`) })
    await click("[data-provider-probe]")
    await click("[data-model-add]")
    await input(combo, "")
    check("empty search renders at most 200 candidates", document.querySelectorAll("[data-model-combo-option]").length <= 200)
    await event(combo, "keydown", { key: "ArrowDown" })
    const active = find(combo)?.getAttribute("aria-activedescendant")
    check("empty search exposes a rendered active option to keyboard users", Boolean(active && document.getElementById(active)?.getAttribute("role") === "option"))
    for (let i = 1; i <= 200; i++) await event(combo, "keydown", { key: "ArrowDown" })
    const nextActive = find(combo)?.getAttribute("aria-activedescendant")
    check("arrow keys reach candidates past the first 200", Boolean(nextActive &&
      document.getElementById(nextActive)?.getAttribute("data-model-combo-option") === "bulk-200") &&
      document.querySelectorAll("[data-model-combo-option]").length <= 200)
    await input(combo, "not-a-model")
    await input(combo, "")
    find(comboMenu)!.scrollTop = 30 * 240
    await event(comboMenu, "scroll")
    check("scrolling the empty search can show the last candidate", Boolean(find('[data-model-combo-option="bulk-249"]')) &&
      document.querySelectorAll("[data-model-combo-option]").length <= 200)
    await input(combo, "bulk-249")
    check("search can reach a candidate beyond the initial window", Boolean(find('[data-model-combo-option="bulk-249"]')))
    await click("[data-model-editor-cancel]")
  } finally {
    app.unmount()
  }

  const editing = {
    ...fixture.saved[0],
    models: [
      { ...fixture.saved[0].models[0], id: "alpha", name: "Existing display name",
        thinking: { efforts: ["medium", "high"], default: "high" } },
      { id: "delete-me", name: "Delete me" },
    ],
  } satisfies CustomProvider
  const editApp = createApp(Form, { editing })
  editApp.directive("modal", {})
  const editForm = editApp.mount(host) as unknown as typeof form
  try {
    await click('[data-model-edit="alpha"]')
    check("editing hydrates the saved name and limits", find(name)?.value === "Existing display name" &&
      find(context)?.value === "256000" && find(output)?.value === "32000")
    check("a stored custom default is not the catalog recommendation", find("[data-model-reasoning-state]")?.textContent === "已自定义")
    const canOff = '[data-model-thinking="canOff"]'
    const preferred = "[data-model-effort-default]"
    const high = '[data-model-reasoning-level="high"]'
    const low = '[data-model-reasoning-level="low"]'
    if (find(canOff)) {
      find(canOff)!.checked = true
      await event(canOff, "change")
    }
    const defaultSelect = () => document.querySelector<HTMLSelectElement>(preferred)
    const selectedDefault = () => {
      const select = defaultSelect()
      return select?.options[select.selectedIndex]?.value
    }
    const chooseDefault = async (value: string) => {
      const select = defaultSelect()
      if (!select) return
      for (const option of Array.from(select.options)) option.selected = option.value === value
      await event(preferred, "change")
    }
    check("editing hydrates the stored default", selectedDefault() === "high")
    await chooseDefault("auto")
    await click(save)
    await click('[data-model-edit="alpha"]')
    check("default can be explicitly cleared", selectedDefault() === "auto")
    await chooseDefault("high")
    await click(high)
    check("default options contain only enabled levels", !defaultSelect()?.querySelector('option[value="high"]') && selectedDefault() === "auto")
    await click(high)
    check("removing and readding the default level restores it", selectedDefault() === "high")
    await click(low)
    await click(save)
    await click('[data-model-rm="delete-me"]')
    await click("[data-confirm]")
    await nextTick()
    check("confirmed immediate deletion calls the store and removes the row",
      fixture.removed.at(-1)?.join("/") === `${editing.id}/delete-me` && !find('[data-model-card="delete-me"]'), fixture.removed)
    for (const id of ["new-one", "new-two"]) {
      await click("[data-model-add]")
      await input(combo, id)
      if (id === "new-one") {
        await event(combo, "keydown", { key: "Escape" })
        check("first Escape keeps the add dialog open while closing its options",
          !find(comboMenu) && Boolean(find("[data-model-editor-dialog]")))
        if (!find(combo)) return
      }
      await click(save)
    }
    check("two consecutive successful adds append distinct rows", Boolean(find('[data-model-card="new-one"]') && find('[data-model-card="new-two"]')))
    const updated = await editForm.submit()
    const saved = fixture.updated[0]
    check("editing saves through update and excludes the deleted model", updated && saved?.models.map(({ id }) => id).join() === "alpha,new-one,new-two" && fixture.saved.length === 1)
    const thinking = saved?.models[0]?.thinking
    check("manual level click persists the exact effort set and default", thinking?.efforts.join() === "low,medium,high" && thinking.default === "high", thinking)
    check("the canOff switch persists in the update", thinking?.canOff === true, thinking)
  } finally {
    editApp.unmount()
  }
}
