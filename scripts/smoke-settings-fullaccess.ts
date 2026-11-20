import fs from "node:fs"
import { createRequire } from "node:module"
import { isDeepStrictEqual } from "node:util"
import { compileScript, parse } from "@vue/compiler-sfc"
import { build } from "esbuild"
import { DEFAULT_PERMISSIONS } from "../src/shared/protocol"
import type { AccessPatch } from "../src/renderer/src/lib/confirm-queue"
import type { Check } from "./smoke-round5"

export async function settingsFullAccess(check: Check, section: (name: string) => void): Promise<void> {
  section("Settings full access")
  const settings = fs.readFileSync("src/renderer/src/components/SettingsDialog.vue", "utf8")
  const i18n = fs.readFileSync("src/renderer/src/lib/i18n.ts", "utf8")
  const toggle = settings.match(/async function toggleFullAccess\(\) \{([\s\S]*?)^\}/m)?.[1] ?? ""
  const enable = settings.match(/async function enableFullAccess\(\) \{([\s\S]*?)^\}/m)?.[1] ?? ""
  const modal = settings.match(/<Teleport to="body">\s*<div v-if="confirmingFullAccess"([\s\S]*?)<\/Teleport>/)?.[1] ?? ""

  check("turning on full access only opens confirmation", /if \(!config\.allowFullAccess\) \{\s*confirmingFullAccess\.value = true\s*return\s*\}/.test(toggle))
  check("confirmation enables full access in one patch and announces it", /await app\.patchConfig\(\{\s*allowFullAccess: true,\s*\.\.\.accessPatch\([^,]+, "full"\),?\s*\}\)\s*app\.announceAccess\("full"\)/.test(enable))
  check("turning off uses the restoration patch and announces a drop", /const \{ patch, dropped \} = fullAccessOff\(config\)[\s\S]*?await app\.patchConfig\(patch\)\s*if \(dropped\) app\.announceAccess\("ask"\)/.test(toggle))
  check("confirmation uses the existing copy and dismiss actions", [
    'class="vs-scrim"',
    '@mousedown.self="confirmingFullAccess = false"',
    't("composer.access.confirmTitle")',
    't("composer.access.confirmBody")',
    't("composer.access.confirmOk")',
    't("common.cancel")',
    '@click="confirmingFullAccess = false"',
    '@click="enableFullAccess"',
  ].every((snippet) => modal.includes(snippet)))

  await clickFullAccess(check, settings)

  const languageCount = 18
  const tables = [...i18n.matchAll(/^const \w+: Table = \{\n([\s\S]*?)^\}/gm)]
  check("every language table has one full-access description", tables.length === languageCount &&
    tables.every(([, table]) => [...table.matchAll(/^  "set\.allowFullAccessSub":/gm)].length === 1))
  check("the old Chinese unlock-only wording is gone", [...i18n.matchAll(/才能在对话框中选择/g)].length === 0)
  check("the full-access description key appears 18 times", [...i18n.matchAll(/"set\.allowFullAccessSub":/g)].length === languageCount)
  check("the full-access title key appears 18 times", [...i18n.matchAll(/"set\.allowFullAccess":/g)].length === languageCount)
}

/** Mount the production row, Teleport, and handlers with a minimal app store. */
async function clickFullAccess(check: Check, settings: string): Promise<void> {
  const label = settings.indexOf('t("set.allowFullAccess")')
  const row = settings.lastIndexOf('<div class="line">', label)
  const teleport = settings.indexOf('<Teleport to="body">', label)
  const end = settings.indexOf("</Teleport>", teleport)
  const setup = settings.match(/const confirmingFullAccess = ref\(false\)[\s\S]*?async function enableFullAccess\(\) \{[\s\S]*?^\}/m)?.[0]
  if (row < 0 || teleport < 0 || end < 0 || !setup) {
    check("the full-access row, confirmation and handlers can be mounted", false)
    return
  }

  const source = `
    <script setup lang="ts">
    import { reactive, ref } from "vue"
    import { accessPatch, fullAccessOff } from "./src/renderer/src/lib/confirm-queue"
    import { t } from "./src/renderer/src/lib/i18n"
    import { DEFAULT_PERMISSIONS } from "./src/shared/protocol"
    const app = reactive({
      config: { permissions: { ...DEFAULT_PERMISSIONS, edit: "allow" }, allowFullAccess: false },
      patches: [],
      announcements: [],
      async patchConfig(patch) {
        app.patches.push(patch)
        Object.assign(app.config, patch)
      },
      announceAccess(level) { app.announcements.push(level) },
    })
    ${setup}
    defineExpose({ app })
    </script>
    <template>${settings.slice(row, end + "</Teleport>".length)}</template>
  `
  const compiled = compileScript(parse(source).descriptor, { id: "settings-fullaccess", inlineTemplate: true })
  const { outputFiles } = await build({
    stdin: {
      contents: compiled.content + '\nexport { createApp, nextTick } from "vue"',
      loader: "ts",
      resolveDir: process.cwd(),
    },
    alias: { "@shared": "./src/shared" },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  })

  const require = createRequire(import.meta.url)
  const window = require("@mixmark-io/domino").createWindow()
  window.Node.prototype.getRootNode ??= function (this: Node) { return this.ownerDocument }
  const module = { exports: {} }
  new Function("module", "exports", "require", "document", "window", "SVGElement", "Element", "Document", outputFiles[0].text)(
    module, module.exports, require, window.document, window, window.SVGElement ?? class {}, window.Element, window.Document,
  )
  const { default: FullAccessRow, createApp, nextTick } = module.exports as {
    default: import("vue").Component
    createApp: typeof import("vue").createApp
    nextTick: typeof import("vue").nextTick
  }
  const document = window.document as Document
  const host = document.createElement("div")
  document.body.appendChild(host)
  const view = createApp(FullAccessRow)
  view.directive("modal", {})
  const { app } = view.mount(host) as unknown as {
    app: {
      patches: (Partial<AccessPatch> & { allowFullAccess: boolean })[]
      announcements: string[]
    }
  }
  try {
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')
    toggle?.click()
    await nextTick()
    const dialog = document.querySelector('[role="alertdialog"]')
    check("clicking the switch opens confirmation before patching config",
      Boolean(dialog) && app.patches.length === 0)

    dialog?.querySelector<HTMLButtonElement>(".vs-ok")?.click()
    await nextTick()
    await nextTick()
    const enabled = app.patches[0]
    check("clicking confirm sends one patch with the switch, level and original answers",
      app.patches.length === 1 && enabled?.allowFullAccess === true && enabled.accessLevel === "full" &&
      isDeepStrictEqual(enabled.accessBefore, { ...DEFAULT_PERMISSIONS, edit: "allow" }), enabled)
    check("confirm closes the dialog and announces full access",
      !document.querySelector('[role="alertdialog"]') && app.announcements.join(",") === "full")

    toggle?.click()
    await nextTick()
    await nextTick()
    const disabled = app.patches[1]
    check("clicking the enabled switch restores the answers and clears the backup in one patch",
      app.patches.length === 2 && disabled?.allowFullAccess === false && disabled.accessLevel === "ask" &&
      isDeepStrictEqual(disabled.accessBefore, {}) &&
      isDeepStrictEqual(disabled.permissions, { ...DEFAULT_PERMISSIONS, edit: "allow" }), disabled)
    check("switching off announces the default level", app.announcements.join(",") === "full,ask")
  } finally {
    view.unmount()
    host.remove()
  }
}
