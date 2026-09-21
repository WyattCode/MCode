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

  // ------------------------------------------------------------ R19-F3 / SH1
  section("Round 19 (F3, SH1): a picker asked for while another is open warns, as MiMo's nativePick.busy")
  {
    const main = await read("src/main/index.ts")
    const paths = await read("src/main/paths.ts")
    const handler = (source: string, channel: string) => {
      const at = source.indexOf(`ipcMain.handle("${channel}"`)
      return at < 0 ? "" : source.slice(at, source.indexOf("\n  })", at))
    }
    for (const channel of ["mcode:pick-directory", "mcode:open-text", "mcode:save-text"]) {
      check(`${channel} answers busy when the one dialog slot is taken`, /if \(!claim\) return PICKER_BUSY/.test(handler(main, channel)))
    }
    const png = handler(paths, "mcode:save-png")
    check("mcode:save-png takes the same slot and answers busy too", /claimDialog\(process\.platform, owner\)/.test(png) && /if \(!claim\) return PICKER_BUSY/.test(png) && /releaseDialog\(claim\)/.test(png))

    // Every caller in the window goes through the wrappers that turn busy into the warning.
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(process.cwd(), dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(relative)
        else if (/\.(ts|vue)$/.test(entry.name) && !relative.endsWith(path.join("lib", "native-pick.ts"))) {
          if (/window\.mcode\.(pickDirectory|pickProjectFolder|saveText|openText|savePng)\(/.test(await read(relative))) offenders.push(relative)
        }
      }
    }
    await walk(path.join("src", "renderer", "src"))
    check("no window code calls a native picker around the busy warning", offenders.length === 0, offenders)
    const errorPage = await read("src/renderer/src/components/ErrorPage.vue")
    check("the error page, which draws no notices, says it in its own line", /if \(isPickerBusy\(saved\)\) note\.value = \{ text: t\("toast\.pickerBusy"\), failed: true \}/.test(errorPage))

    const { isPickerBusy, PICKER_BUSY } = await import("../src/shared/native-pick")
    check("the marker is recognised, and a cancel's answers are not", isPickerBusy(PICKER_BUSY) && ![[], undefined, "", { busy: false }, null].some(isPickerBusy))
    const { toasts } = await import("../src/renderer/src/lib/toast")
    const { language } = await import("../src/renderer/src/lib/i18n")
    const spoken = language.value
    language.value = "zh-CN"
    const picks = await import("../src/renderer/src/lib/native-pick")
    const answers: Record<string, unknown> = { pickDirectory: PICKER_BUSY, pickProjectFolder: PICKER_BUSY, saveText: PICKER_BUSY, openText: PICKER_BUSY, savePng: PICKER_BUSY }
    const stub = Object.fromEntries(Object.keys(answers).map((name) => [name, async () => answers[name]]))
    const global = globalThis as { window?: unknown }
    const before = global.window
    global.window = { mcode: stub }
    try {
      toasts.value = []
      const results = [await picks.pickDirectory("t"), await picks.pickProjectFolder("t"), await picks.saveText("a.txt", "x"), await picks.openText("t"), await picks.savePng("a.png", "")]
      check("a busy answer reads as a cancel to the caller", JSON.stringify(results) === "[[],[],null,null,null]", results)
      const warned = toasts.value.filter((entry) => entry.level === "warning" && entry.title === "已经打开了一个选择窗口，完成或取消它后再试（它可能被主窗口挡住了）")
      check("and raises MiMo's warning (one notice, the same text each time)", warned.length === 1, toasts.value)
      toasts.value = []
      answers.pickDirectory = ["C:\\work"]
      check("a real answer passes through with no notice", JSON.stringify(await picks.pickDirectory("t")) === JSON.stringify(["C:\\work"]) && toasts.value.length === 0)
      toasts.value = []
    } finally {
      global.window = before
      language.value = spoken
    }
    check("the sentence is in all 18 tables", (i18n.match(/^ {2}"toast\.pickerBusy": /gm) ?? []).length === 18)
  }

  // ------------------------------------------------------------------ R19-F4
  section("Round 19 (F4): confirmations are green success notices, refusals danger, as MiMo's")
  {
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    const models = await read("src/renderer/src/components/ModelsPage.vue")
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    const store = await read("src/renderer/src/stores/app.ts")
    const app = await read("src/renderer/src/App.vue")
    const success = (source: string, call: string) => source.includes(`${call}, { level: "success" })`)
    const sites: [string, boolean][] = [
      ["配置 path copied", success(settings, 'notify(t("set.config.pathCopied")')],
      ["MCP server saved", success(settings, 'notify(t("set.mcpForm.saved", { name })')],
      ["MCP server authorized", success(settings, 'notify(t("set.mcp.authorized")')],
      ["MCP server removed", success(settings, 'notify(t("set.mcp.removed") + name')],
      ["MCP import done", success(settings, 'notify(t("set.mcp.importDone", { n: String(result?.imported.length ?? 0) })')],
      ["one conversation restored", success(settings, 'notify(t("toast.convoRestored")')],
      ["a batch restored", success(settings, 'if (ids.length) notify(t("toast.convosRestored", { n: ids.length })')],
      ["models refreshed", success(models, 'notify(t("set.models.refreshed")') && success(models, 'notify(t("provider.refreshed", { n: found })')],
      ["provider saved", /if \(editing\) notice\.success\(t\("model\.changesSaved"\)\)/.test(form)],
      ["project added", success(store, 'else notify(t("side.projectAdded", { name })')],
      ["projects removed", success(store, 'notify(directories.length > 1 ? t("side.projectsRemoved", { count: directories.length }) : t("side.projectRemoved")')],
      ["update ready", success(app, 'notify(t("update.readyToast")')],
    ]
    for (const [name, ok] of sites) check(`success: ${name}`, ok)
    check("a batch of one is counted too, as MiMo's unarchiveMany", !/ids\.length === 1\) notify\(t\("toast\.convoRestored"\)/.test(settings))
    check("danger: the project is already there", /if \(result\.existed\) notifyFailure\(t\("side\.projectExists", \{ name \}\)\)/.test(store))
    check("danger: the project name is taken", /notifyFailure\(t\("toast\.projectNameTaken", \{ name \}\)\)/.test(app) && !/projectNameTaken", \{ name \}\), \{ level: "warning" \}/.test(app))
  }

  // ------------------------------------------------------------------ R19-F6
  section("Round 19 (F6): the new-project dialog is MiMo's - a name and a source folder, no location row")
  {
    const dialog = await read("src/renderer/src/components/NewProjectDialog.vue")
    const app = await read("src/renderer/src/App.vue")
    const protocol = await read("src/shared/protocol.ts")
    const handlers = await read("src/server/handlers.ts")
    check("no location row, nor its picker", !/data-np-location|pickLocation|defaultLocation|\.where\b/.test(dialog))
    check("the dialog answers a name and a source only", /submit: \[name: string, source\?: string\] \}/.test(dialog) && /emit\("submit", name, source\.value \|\| undefined\)/.test(dialog))
    check("its host passes no location", !/default-location/.test(app) && /request\(\{ type: "project\.createBlank", name: title \}\)/.test(app))
    check(
      "a blank project always lands under the default project location",
      /\| \{ type: "project\.createBlank"; name: string \}/.test(protocol) && /blankProjectDirectory\(request\.name, runtime\.config\.get\(\)\.projectRoot\)/.test(handlers),
    )
  }

  // ------------------------------------------------------------------ R19-F7
  section("Round 19 (F7): deleting a provider says it takes every model with it")
  {
    const models = await read("src/renderer/src/components/ModelsPage.vue")
    check("the provider's confirmation uses the provider wording, not the single model's", /removing\.custom \? 'set\.models\.removeProviderBody' : 'set\.models\.disconnectBody'/.test(models))
    check("which is in all 18 tables", (i18n.match(/^ {2}"set\.models\.removeProviderBody": /gm) ?? []).length === 18)
    const { language, t } = await import("../src/renderer/src/lib/i18n")
    const spoken = language.value
    language.value = "zh-CN"
    const body = t("set.models.removeProviderBody", { name: "gw" })
    language.value = spoken
    check("and names the provider and all of its models", body.includes("「gw」") && body.includes("所有模型"), body)
  }

  // ------------------------------------------------------------------ R19-F8
  section("Round 19 (F8): the models page says 供应商, as MiMo 26.920, with its probe and combo texts")
  {
    const { language, t } = await import("../src/renderer/src/lib/i18n")
    const spoken = language.value
    const said = (lang: typeof language.value, key: string, values?: Record<string, string | number>) => {
      language.value = lang
      return t(key, values)
    }
    const zh = {
      "set.models.addProvider": "添加供应商",
      "set.models.removeProvider": "删除供应商",
      "set.models.cloneProvider": "克隆供应商",
      "set.models.fromProvider": "来自此供应商的模型",
      "set.models.providerAdded": "已添加供应商",
      "set.models.comboPlaceholder": "选择或添加 model-id",
    }
    for (const [key, want] of Object.entries(zh)) check(`zh-CN ${key} is ${want}`, said("zh-CN", key) === want, said("zh-CN", key))
    check("zh-TW says 供應商 too", said("zh-TW", "set.models.addProvider") === "新增供應商" && said("zh-TW", "set.models.fromProvider") === "來自此供應商的模型")
    check("the probe's success is just the count, as MiMo's probeOkN", said("zh-CN", "set.models.probeOk", { n: 3 }) === "3 个模型" && said("en", "set.models.probeOk", { n: 3 }) === "3 models")
    check("the models page's own strings no longer say 提供商", !Object.keys(zh).some((key) => said("zh-CN", key).includes("提供商")) && !said("zh-CN", "set.models.removed", { name: "x" }).includes("提供商"))
    check("search still finds the page by the new word", said("zh-CN", "set.keywords.models").includes("供应商"))
    language.value = spoken
  }

  // ------------------------------------------------------------------ R19-F9
  section("Round 19 (F9): a provider id follows MiMo's rule - no slash, not taken in any case")
  {
    const { providerIdProblem } = await import("../src/shared/provider-id")
    const taken = ["openai", "gw"]
    check("uppercase, dots and spaces are accepted, as MiMo accepts them", ["OpenAI-2", "my.provider", "My Gateway"].every((id) => providerIdProblem(id, taken) === undefined))
    check("a slash is refused", providerIdProblem("a/b", taken) === "slash")
    check("empty (after trimming) is refused", providerIdProblem("   ", taken) === "empty")
    check("a taken id is refused without regard to case", providerIdProblem("OpenAI", taken) === "exists" && providerIdProblem(" GW ", taken) === "exists")
    check("an object's own names are refused as taken", ["__proto__", "constructor"].every((id) => providerIdProblem(id, []) === "exists"))
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    const clone = await read("src/renderer/src/components/ProviderCloneDialog.vue")
    const handlers = await read("src/server/handlers.ts")
    check("the form, the clone dialog and the backend all use it, and the old lowercase pattern is gone", [form, clone, handlers].every((source) => source.includes("providerIdProblem(") && !source.includes("[a-z0-9][a-z0-9-_]*")))
    const { cloneId } = await import("../src/renderer/src/lib/custom-model")
    check("a clone's suggested id is free in any case", cloneId("gw", new Set(["gw", "GW-copy"])) === "gw-copy-2")
    check("MiMo's slash message is in all 18 tables", (i18n.match(/^ {2}"set\.models\.providerIdSlash": /gm) ?? []).length === 18)
  }

  // ----------------------------------------------------------------- R19-F10
  section("Round 19 (F10): settings search finds hardware acceleration, and highlights by a row's whole text")
  {
    const general = i18n.split("\n").filter((line) => line.startsWith('  "set.keywords.general": '))
    check("every table's 常规 keywords name the GPU", general.length === 18 && general.every((line) => /gpu/i.test(line)), general.filter((line) => !/gpu/i.test(line)))
    check("zh-CN's say 硬件加速 and 图形", general[0]?.includes("硬件加速") && general[0]?.includes("图形"))
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    const flash = settings.slice(settings.indexOf("async function flashMatch("), settings.indexOf("\n}\n", settings.indexOf("async function flashMatch(")))
    check("the highlight reads a whole row (title, description, control), not the title alone", /querySelectorAll<HTMLElement>\("\.line, \.choice-btn, h3"\)/.test(flash) && !flash.includes(".line-title"))
  }

  // ----------------------------------------------------------------- R19-F11
  section("Round 19 (F11): the MCP page's config-file row has 复制路径 and 打开, as MiMo 26.920's")
  {
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    const at = settings.indexOf('t("set.mcp.configFile")')
    const row = at < 0 ? "" : settings.slice(at, settings.indexOf("</div>\n          </div>", at))
    check("the row copies the path", /data-config-copy-path[^>]*@click="copyConfigPath"/.test(row))
    check("and opens the file", /data-mcp-config-open[^>]*@click="openConfigFile"/.test(row))
  }
}
