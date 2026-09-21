/**
 * The entry chunk (round 7's open item): 5.60MB, later 5.90MB, against MiMo
 * 26.920's 2.27MB. What was in it and not needed for the first paint - sixteen
 * language tables (1.9MB), KaTeX (600KB), the settings dialog, the artifacts
 * and plugins pages, the previews, the connect and import dialogs, and the
 * Office / PDF / HTML / browser tabs - is now fetched when first used. These
 * guard the boundaries and the size: the source says lazy, the build agrees,
 * and the entry stays inside its budget.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
// Namespace imports, so this still bundles against a tree without the split and fails its checks there instead.
import * as viteConfig from "../electron.vite.config"
import * as i18n from "../src/renderer/src/lib/i18n"

const { LANGUAGES, language, t } = i18n
const split = viteConfig as { EAGER_LANGUAGES?: string[]; splitLanguageTables?: (code: string) => { code: string; tables: Map<string, string> } }
const lazyI18n = i18n as { languageReady?: (id: string) => boolean; loadLanguage?: (id: string) => Promise<void> }

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** The entry chunk may not grow past this again without someone deciding it should (MiMo's is 2 271 966 B). */
export const ENTRY_BUDGET = 2_400_000

/** Components each fetched on first use, and the file that must say so. */
const LAZY: [file: string, component: string, path: string][] = [
  ["src/renderer/src/App.vue", "SettingsDialog", "./components/SettingsDialog.vue"],
  ["src/renderer/src/App.vue", "ArtifactsView", "./components/ArtifactsView.vue"],
  ["src/renderer/src/App.vue", "PluginsView", "./components/PluginsView.vue"],
  ["src/renderer/src/App.vue", "ImagePreview", "./components/ImagePreview.vue"],
  ["src/renderer/src/App.vue", "VideoPreview", "./components/VideoPreview.vue"],
  ["src/renderer/src/App.vue", "ConnectDialog", "./components/ConnectDialog.vue"],
  ["src/renderer/src/App.vue", "ImportDialog", "./components/ImportDialog.vue"],
  ["src/renderer/src/components/RightPanel.vue", "OfficeTab", "./right/OfficeTab.vue"],
  ["src/renderer/src/components/RightPanel.vue", "HtmlTab", "./right/HtmlTab.vue"],
  ["src/renderer/src/components/RightPanel.vue", "RpBrowser", "./right/RpBrowser.vue"],
  ["src/renderer/src/components/right/RpFiles.vue", "PdfView", "./PdfView.vue"],
]

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export async function perfEntryChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Entry chunk: what the first paint does not need is fetched on first use")

  // ------------------------------------------------------------ source side
  const unlazy: string[] = []
  for (const [file, component, target] of LAZY) {
    const source = await read(file)
    const lazy = new RegExp(`const ${component} = defineAsyncComponent\\(\\(\\) => import\\("${escapeRe(target)}"\\)\\)`).test(source)
    const eager = new RegExp(`^import ${component} from "${escapeRe(target)}"`, "m").test(source)
    if (!lazy || eager) unlazy.push(`${file}: ${component}`)
  }
  check("E1: the settings, the pages, the previews, the dialogs and the heavy tabs are async components", unlazy.length === 0, unlazy)

  const markdown = await read("src/renderer/src/lib/markdown.ts")
  check(
    "E2: KaTeX is imported for its type only and fetched with import() the first time a formula is drawn",
    /^import type Katex from "katex"$/m.test(markdown) && !/^import katex\b/m.test(markdown) && /import\("katex"\)/.test(markdown),
  )
  const body = await read("src/renderer/src/components/parts/MarkdownBody.vue")
  check("E3: and a reply drawn before it arrived is drawn again when it has", /void mathReady\.value/.test(body.slice(body.indexOf("const rendered = computed"))))

  // The language tables: the split, run on the real file.
  const source = await read("src/renderer/src/lib/i18n.ts")
  let parts: { code: string; tables: Map<string, string> } | undefined
  try {
    if (!split.splitLanguageTables) throw new Error("electron.vite.config.ts has no language split")
    parts = split.splitLanguageTables(source)
  } catch (error) {
    check("E4: the build's language split still recognises lib/i18n.ts", false, String(error))
  }
  if (parts) {
    const eager = split.EAGER_LANGUAGES ?? []
    const lazyIds = LANGUAGES.map((entry) => entry.id as string).filter((id) => !eager.includes(id))
    check(
      "E4: the build takes every table but zh-CN and English out of the entry, one loader each",
      [...parts.tables.keys()].sort().join() === [...lazyIds].sort().join() &&
        lazyIds.every((id) => parts.code.includes(`${JSON.stringify(id)}: () => import(`)) &&
        !/\nconst (fr|ja|de|zhTW|ptBR): Table = \{/.test(parts.code) &&
        /\nconst zhCN: Table = \{/.test(parts.code) &&
        /\nconst en: Table = \{/.test(parts.code),
      [...parts.tables.keys()],
    )
    const frTable = parts.tables.get("fr") ?? ""
    check("E5: and each table it takes out is a plain object of strings", (() => {
      try {
        const table = new Function(`return ${frTable}`)() as Record<string, unknown>
        return Object.keys(table).length > 1000 && Object.values(table).every((value) => typeof value === "string")
      } catch {
        return false
      }
    })())
  }
  const config = await read("electron.vite.config.ts")
  check("E6: the split runs on the renderer, before the Vue and TypeScript transforms", /plugins: \[languageChunks\(\), vue\(\)/.test(config) && /enforce: "pre"/.test(config))

  // Unbuilt (the checks) every table is present at once, and loading one is a no-op.
  const was = language.value
  await lazyI18n.loadLanguage?.("fr")
  language.value = "fr"
  const french = t("common.cancel")
  language.value = was
  check("E7: unbuilt, every table is in hand from the start", Boolean(lazyI18n.languageReady) && LANGUAGES.every((entry) => lazyI18n.languageReady?.(entry.id)) && french === "Annuler", french)

  // The window keeps the last language it drew in and fetches it, and the machine's, before mounting.
  const [main, app] = await Promise.all([read("src/renderer/src/main.ts"), read("src/renderer/src/App.vue")])
  check(
    "E8: the likely tables are asked for at start, the window remembers its language, and the switch waits for its table",
    /new Set\(\[rememberedLanguage\(\), detectLanguage\(\)\]\)\) if \(id\) void loadLanguage\(id\)/.test(main) &&
      /if \(app\.config\) rememberLanguage\(chosen\)/.test(app) &&
      /if \(!languageReady\(chosen\)\) await loadLanguage\(chosen\)/.test(app) &&
      /if \(asked !== languageAsked\) return/.test(app),
  )

  // --------------------------------------------------------------- the build
  const assetDir = path.join(process.cwd(), "out/renderer/assets")
  const built = await fs.readdir(assetDir).catch(() => undefined)
  if (!built) {
    console.log("  --   out/renderer holds no build, so the entry chunk itself is untested here (npm run build first)")
    return
  }
  const page = await read("out/renderer/index.html")
  const entryName = /<script[^>]*src="[./]*assets\/(index-[^"]+\.js)"/.exec(page)?.[1] ?? ""
  const entry = entryName ? await read(`out/renderer/assets/${entryName}`) : ""
  const entryBytes = Buffer.byteLength(entry)
  check(`E9: the entry chunk is within its budget (${ENTRY_BUDGET} B)`, entryName !== "" && entryBytes <= ENTRY_BUDGET, { entryName, entryBytes })
  check("E10: the entry chunk statically imports nothing, so nothing else loads with it", !/^import\s*["{*\w]/m.test(entry.slice(0, 4000)) && !/<link rel="modulepreload"/.test(page))

  const chunk = (prefix: string) => built.find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"))
  const missing = [...LAZY.map(([, component]) => component), "katex"].filter((name) => !chunk(name))
  check("E11: each of them is a chunk of its own in the build", missing.length === 0, missing)

  // A French string that is only in the French table: in its chunk, not in the entry.
  const others = await Promise.all(built.filter((name) => name.endsWith(".js") && name !== entryName).map((name) => read(`out/renderer/assets/${name}`)))
  check(
    "E12: KaTeX's code is not in the entry, and is in a chunk",
    !entry.includes("KaTeX can only parse string typed") && others.some((text) => text.includes("KaTeX can only parse string typed")),
  )
  const languageChunks = built.filter((name) => /^_mcode-language_/.test(name) && name.endsWith(".js"))
  check("E13: sixteen language chunks, none of them zh-CN or English", languageChunks.length === 16 && !languageChunks.some((name) => /_(zh-CN|en)-/.test(name)), languageChunks)
  check(
    "E14: a French-only string is in a language chunk and not in the entry; a Chinese and an English one are in the entry",
    !entry.includes("Aucune tâche pour l") && others.some((text) => text.includes("Aucune tâche pour l")) && entry.includes("暂无任务") && entry.includes("No tasks yet"),
  )
}
