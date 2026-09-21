/**
 * Round 19, lane A: settings and shell items found by comparing against MiMo
 * 26.920 again.
 *
 * Most of these live in markup and in the i18n tables, so they are read from
 * the source; what can run in plain node runs against the real code. The
 * drawn result of each visible change was looked at in the lane's Electron
 * probe.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

const exists = (relative: string) =>
  fs.access(path.join(process.cwd(), relative)).then(
    () => true,
    () => false,
  )

export async function roundNineteenLaneAChecks(check: Check, section: (name: string) => void): Promise<void> {
  const i18n = await read("src/renderer/src/lib/i18n.ts")

  // ------------------------------------------------------------------ R19-F1
  section("Round 19 (F1): no first-run import dialog - MiMo 26.920 never renders its own")
  {
    const app = await read("src/renderer/src/App.vue")
    const protocol = await read("src/shared/protocol.ts")
    const handlers = await read("src/server/handlers.ts")
    check("the dialog component is gone", !(await exists("src/renderer/src/components/ImportDialog.vue")))
    check("and so is the server's scan of other AI apps", !(await exists("src/server/import.ts")))
    check("the window no longer asks on startup", !/ImportDialog|askAboutImport|import\.scan/.test(app))
    check("the requests are gone from the protocol and the handlers", !/"import\.(scan|run)"/.test(protocol) && !/"import\.(scan|run)"/.test(handlers))
    check("the first-run marker is gone from the config", !/importOnboarded/.test(protocol))
    check("no table keeps the dialog's strings", !/^ {2}"import\./m.test(i18n))
  }

  // ------------------------------------------------------------------ R19-F2
  section("Round 19 (F2): removing a custom model asks first, and takes effect at once")
  {
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    const handlers = await read("src/server/handlers.ts")
    const store = await read("src/renderer/src/stores/app.ts")
    const button = form.slice(form.indexOf('class="cp-model-remove"'), form.indexOf("</button>", form.indexOf('class="cp-model-remove"')))
    check("the trash button opens a confirmation instead of dropping the card", /@click="removingModel = row"/.test(button) && !/removeModel\(row\)/.test(button))
    check(
      "the confirmation is MiMo's: 删除自定义模型 over the model's name",
      /<ConfirmDialog\s+v-if="removingModel"\s+:title="t\('set\.models\.deleteModelTitle'\)"\s+:body="t\('set\.models\.deleteBody', \{ name: removingModel\.name\.trim\(\) \|\| removingModel\.id \}\)"/.test(form),
    )
    check("on yes the saved provider loses the model before the card goes", /if \(editing\) await app\.removeCustomModel\(editing\.id, row\.id\)/.test(form) && /type: "provider\.removeCustomModel", provider, model/.test(store))
    const handler = handlers.slice(handlers.indexOf('case "provider.removeCustomModel"'), handlers.indexOf('case "auth.begin"'))
    check("the backend drops it from the stored provider, keeping the last one", /models\.length > 1/.test(handler) && /models\.filter\(\(model\) => model\.id !== request\.model\)/.test(handler))
    check("the title is in all 18 tables", (i18n.match(/^ {2}"set\.models\.deleteModelTitle": /gm) ?? []).length === 18)
  }
}
