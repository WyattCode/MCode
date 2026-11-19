import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { compileScript, parse } from "@vue/compiler-sfc"
import type { Check } from "./smoke-round5"

export async function modelParityChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Model editor dialog")
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
                  { id: "catalog-only", name: "Catalog only" }
                ] }],
                probeProvider: async () => ({ ok: true, modelIds: [
                  { id: "alpha", name: "Catalog name", contextWindow: 512000, maxOutput: 64000, inputs: { image: true } },
                  "beta"
                ] }),
                addCustomProvider: async (entry) => fixture.saved.push(entry) }
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
    fixture: { saved: import("../src/shared/protocol").CustomProvider[] }
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
  } finally {
    app.unmount()
  }
}
