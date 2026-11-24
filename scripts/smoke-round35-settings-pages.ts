/**
 * The three settings pages a person reaches as a section body, not a dialog.
 *
 * `SettingsDialog.vue` styles its page title with a `scoped` rule, and a scoped rule
 * cannot cross into a child component's template: every page that lives in its own
 * `.vue` file has to carry the page title's type itself. Two of the three do, in two
 * different spellings of the same token pair; the hooks page carries only a colour, so
 * its title fell back to the browser default (21px bold pure white next to everyone
 * else's 24px regular soft white). Nothing but these lines keeps the third page honest
 * when the fourth arrives.
 *
 * The same sweep found a list page that says nothing when it is empty (every sibling
 * says so), and one zh-CN button that calls the thing "Server" while the page above it
 * calls it 服务器.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import { compileScript, parse } from "@vue/compiler-sfc"
import { build } from "esbuild"
import type { Check } from "./smoke-round5"

const COMPONENTS = "src/renderer/src/components"

function read(file: string): string {
  return fs.readFileSync(file, "utf8")
}

/** A page title is one thing across the dialog; this is what every one of them says. */
const TITLE_TYPE = [
  /font-size:\s*calc\(24px \* var\(--ui-font-scale, 1\)\)/,
  /font-weight:\s*400/,
  /line-height:\s*calc\(38\.4px \* var\(--ui-font-scale, 1\)\)/,
]

/** The soft ink MiMo draws a page title in, hard in light and soft in dark. */
const TITLE_INK = /--set-title:\s*#f4f4f5|:root\[data-theme="dark"\][^{]*h2[^{]*\{[^}]*color:\s*#f4f4f5/

/** Components the dialog pulls in and renders as one section's whole body. */
function sectionPages(dialog: string): string[] {
  const files = new Map<string, string>()
  for (const [, tag, file] of dialog.matchAll(/import (\w+) from "\.\/([A-Z]\w*\.vue)"/g)) files.set(tag, file)
  const pages: string[] = []
  for (const [tag, file] of files) {
    const used = new RegExp(`<${tag}\\b((?:[^<>"']|"[^"]*"|'[^']*')*)>`, "g")
    const asSectionBody = [...dialog.matchAll(used)].some(([, attrs]) => /section === ['"]/.test(attrs) || /\bv-else(\s|$)/.test(attrs))
    if (!asSectionBody) continue
    const source = read(`${COMPONENTS}/${file}`)
    const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? ""
    if (/<h2[\s>]/.test(template)) pages.push(file)
  }
  return pages.sort()
}

/** The rule that sets the page title's type, wherever the page scoped it. */
function titleRule(source: string): string {
  const style = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(([, css]) => css).join("\n")
  const rules = [...style.matchAll(/(?:^|\})\s*([^{}@]*\bh2\b[^{}]*)\{([^}]*)\}/g)]
  const typed = rules.filter(([, , body]) => /font-size:/.test(body))
  return typed.map(([, selector, body]) => `${selector.trim()} { ${body.trim()} }`).join("\n")
}

/** Everything from the page's own title to whatever speaks for an empty list. */
function pluginsPageBody(dialog: string): string {
  const start = dialog.indexOf('<template v-else-if="section === \'cliPlugins\'">')
  assert.ok(start >= 0, "the custom-plugins section is no longer a section of its own")
  const open = dialog.indexOf('<div v-if="cliRows.length"', start)
  const cardEnd = '</div>\n          <ContextMenu v-if="cliMenu"'
  const end = dialog.indexOf(cardEnd, open)
  assert.ok(open > start && end > open, "the plugins list card and its menu are no longer neighbours")
  const body = dialog.slice(dialog.indexOf("<h2>", start), end + "</div>".length)
  const opened = [...body.matchAll(/<div\b/g)].length
  const closed = [...body.matchAll(/<\/div>/g)].length
  assert.equal(closed, opened, "the plugins page no longer ends on a balanced list block")
  assert.ok(!body.includes("<dialog"), "the plugins page carries its install dialog inside the block under test")
  return body
}

/** Mount that body over a row list and read back what the page says. */
async function renderPlugins(rows: { id: string; name: string; available: boolean; enabled: boolean }[], loaded = true): Promise<{ text: string; empty: string | null; loading: string | null }> {
  const source = `
    <script setup lang="ts">
    import { ref } from "vue"
    import { t } from "./src/renderer/src/lib/i18n"
    const cliRows = ref(${JSON.stringify(rows)})
    const cliListError = ref(false)
    const cliListLoaded = ref(${loaded})
    const cliBusy = ref(new Set<string>())
    const cliMenu = ref<null | { x: number; y: number; end: boolean; row: { id: string } }>(null)
    function openCliDialog() {}
    function refreshCliPlugins() {}
    function changeCliPlugin() {}
    function openCliMenu() {}
    </script>
    <template>${pluginsPageBody(read(`${COMPONENTS}/SettingsDialog.vue`))}</template>
  `
  const compiled = compileScript(parse(source).descriptor, { id: "plugins-page", inlineTemplate: true })
  const { outputFiles } = await build({
    stdin: {
      contents: compiled.content + '\nexport { createApp } from "vue"',
      loader: "ts",
      resolveDir: process.cwd(),
    },
    alias: { "@shared": "./src/shared" },
    bundle: true, platform: "node", format: "cjs", write: false,
  })
  const require = createRequire(`${process.cwd()}/scripts/`)
  const window = require("@mixmark-io/domino").createWindow()
  window.Node.prototype.getRootNode ??= function (this: Node) { return this.ownerDocument }
  const module = { exports: {} }
  new Function("module", "exports", "require", "document", "window", "SVGElement", "Element", "Document", outputFiles[0].text)(
    module, module.exports, require, window.document, window, window.SVGElement ?? class {}, window.Element, window.Document,
  )
  const { default: View, createApp } = module.exports as { default: import("vue").Component; createApp: typeof import("vue").createApp }
  const host = window.document.createElement("div")
  window.document.body.appendChild(host)
  const app = createApp(View)
  app.mount(host)
  const empty = host.querySelector("[data-cli-empty]")
  const notice = host.querySelector("p.line-sub")
  const result = {
    text: host.textContent ?? "",
    empty: empty ? (empty.textContent ?? "").trim() : null,
    loading: notice ? (notice.textContent ?? "").trim() : null,
  }
  app.unmount()
  return result
}

export async function settingsPageChecks(check: Check, section: (name: string) => void): Promise<void> {
  const dialog = read(`${COMPONENTS}/SettingsDialog.vue`)
  const i18n = read("src/renderer/src/lib/i18n.ts")

  section("Settings page titles share one type")
  const pages = sectionPages(dialog)
  check("the pages that bring their own title are known", pages.length >= 3, pages)
  for (const file of pages) {
    const source = read(`${COMPONENTS}/${file}`)
    const rule = titleRule(source)
    check(`${file} carries the page title's type`,
      TITLE_TYPE.every((want) => want.test(rule)), rule)
    check(`${file} draws the page title in the shared ink`, TITLE_INK.test(source), file)
  }

  section("The custom-plugins page speaks when it is empty")
  const empty = await renderPlugins([])
  check("an empty plugins page says so in a card of its own",
    empty.empty !== null && empty.empty.trim().length > 3, empty.text.slice(0, 160))
  const filled = await renderPlugins([{ id: "p1", name: "mcode-plugin-demo", available: true, enabled: true }])
  check("a filled plugins page shows the row and no empty card",
    filled.text.includes("mcode-plugin-demo") && filled.empty === null, filled.text.slice(0, 160))
  const loading = await renderPlugins([], false)
  check("a plugins page the list has not answered for offers no empty-list claim",
    loading.empty === null, loading.text.slice(0, 160))
  check("while it waits, that page says it is loading",
    loading.loading !== null && loading.loading.length > 0, loading.text.slice(0, 160))
  check("an answered empty page shows the card and no loading line",
    empty.empty !== null && empty.loading === null, empty.text.slice(0, 160))

  section("One language, one name for an MCP server")
  const zh = /^const zhCN: Table = \{\n([\s\S]*?)^\}/m.exec(i18n)?.[1] ?? ""
  const values = [...zh.matchAll(/^  "set\.mcp\.[^"]+": "((?:[^"\\]|\\.)*)"/gm)].map(([, value]) => value)
  check("the zh-CN page names itself with 服务器", /"set\.nav\.mcp": "MCP 服务器"/.test(zh))
  check("no zh-CN copy calls it a Server in Latin letters",
    values.length >= 40 && !values.some((value) => /(^|[^A-Za-z])Server([^A-Za-z]|$)/.test(value)),
    values.filter((value) => /(^|[^A-Za-z])Server([^A-Za-z]|$)/.test(value)))
}
