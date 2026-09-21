import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import vue from "@vitejs/plugin-vue"
import type { Plugin } from "vite"

/*
 * pdf.js reads its character maps, standard fonts, colour profiles and image
 * decoders at run time, by URL. They are served from the package while
 * developing and copied beside the page in a build, both under `pdfjs/`.
 */
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"]
/*
 * The annotation layer's note icons (annotation-note.svg and its ten
 * siblings), served as `pdfjs/images/`: only these, not the viewer's toolbar
 * and editor images beside them.
 */
const PDFJS_ICON = /^annotation-[a-z]+\.svg$/

function pdfjsAssets(): Plugin {
  const source = resolve("node_modules/pdfjs-dist")
  const icons = resolve(source, "web/images")
  let outDir = ""
  return {
    name: "mcode-pdfjs-assets",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "")
        const [dir, ...rest] = rel.split("/")
        const icon = dir === "images" && rest.length === 1 && PDFJS_ICON.test(rest[0])
        const file = icon ? resolve(icons, rest[0]) : resolve(source, rel)
        const allowed = (icon || PDFJS_DIRS.includes(dir)) && file.startsWith(source + sep)
        if (!allowed || !existsSync(file) || !statSync(file).isFile()) return next()
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm")
        if (file.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml")
        createReadStream(file).pipe(res)
      })
    },
    writeBundle() {
      for (const dir of PDFJS_DIRS) cpSync(resolve(source, dir), resolve(outDir, "pdfjs", dir), { recursive: true })
      mkdirSync(resolve(outDir, "pdfjs", "images"), { recursive: true })
      for (const name of readdirSync(icons)) if (PDFJS_ICON.test(name)) copyFileSync(resolve(icons, name), resolve(outDir, "pdfjs", "images", name))
    },
  }
}

/*
 * FluidSynth's WebAssembly build (LGPL-2.1), which plays a reply's ABC score.
 * It must stay a separate, replaceable file, so it is never imported: it is
 * served from js-synthesizer's package while developing and copied, unmodified
 * and with its licence, to `vendor/` beside the page in a build, where
 * electron-builder keeps it outside the asar. lib/abc-fluidsynth.ts loads it
 * with a script tag.
 */
const FLUIDSYNTH_SOURCE = resolve("node_modules/js-synthesizer/externals")
const FLUIDSYNTH_FILES = ["libfluidsynth-2.4.6-with-libsndfile.js", "LICENSE.fluidsynth.txt"]

function fluidsynthVendor(): Plugin {
  let outDir = ""
  return {
    name: "mcode-fluidsynth-vendor",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use("/vendor", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "")
        if (!FLUIDSYNTH_FILES.includes(name)) return next()
        res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "text/plain; charset=utf-8")
        createReadStream(resolve(FLUIDSYNTH_SOURCE, name)).pipe(res)
      })
    },
    writeBundle() {
      mkdirSync(resolve(outDir, "vendor"), { recursive: true })
      for (const name of FLUIDSYNTH_FILES) copyFileSync(resolve(FLUIDSYNTH_SOURCE, name), resolve(outDir, "vendor", name))
    },
  }
}

/*
 * The language tables, one chunk per language. lib/i18n.ts keeps all eighteen
 * in one file - the checks read and import it whole - and this takes every one
 * but the default (zh-CN) and the fallback (en) out of the entry chunk as the
 * file is compiled, leaving a loader for each in its LOADERS. Anything it does
 * not find exactly as expected stops the build rather than shipping the tables
 * in the entry again without a word.
 */
const I18N_FILE = resolve("src/renderer/src/lib/i18n.ts")
const LANGUAGE_PREFIX = "\0mcode-language:"
export const EAGER_LANGUAGES = ["zh-CN", "en"]

export function splitLanguageTables(code: string): { code: string; tables: Map<string, string> } {
  const tables = new Map<string, string>()
  const block = /\nconst TABLES: Partial<Record<Language, Table>> = \{\n([\s\S]*?)\n\}\n/.exec(code)
  const loaders = "\nconst LOADERS: Partial<Record<Language, () => Promise<Table>>> = {}\n"
  if (!block || !code.includes(loaders)) throw new Error("languageChunks: TABLES or LOADERS is not where it was")
  const kept: string[] = []
  const load: string[] = []
  let out = code
  for (const line of block[1].split("\n")) {
    const entry = /^ {2}(?:"([^"]+)": ([A-Za-z]+)|([A-Za-z]+)),$/.exec(line)
    if (!entry) throw new Error(`languageChunks: unexpected TABLES line ${JSON.stringify(line)}`)
    const id = entry[1] ?? entry[3]
    const name = entry[2] ?? entry[3]
    if (EAGER_LANGUAGES.includes(id)) {
      kept.push(line)
      continue
    }
    const start = out.indexOf(`\nconst ${name}: Table = {\n`)
    const end = start === -1 ? -1 : out.indexOf("\n}\n", start)
    if (end === -1) throw new Error(`languageChunks: no table ${name}`)
    tables.set(id, out.slice(out.indexOf("{", start), end + 2))
    out = out.slice(0, start) + out.slice(end + 2)
    load.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(LANGUAGE_PREFIX + id)}).then((table) => table.default),`)
  }
  out = out.replace(block[0], `\nconst TABLES: Partial<Record<Language, Table>> = {\n${kept.join("\n")}\n}\n`)
  out = out.replace(loaders, `\nconst LOADERS: Partial<Record<Language, () => Promise<Table>>> = {\n${load.join("\n")}\n}\n`)
  return { code: out, tables }
}

function languageChunks(): Plugin {
  let tables = new Map<string, string>()
  return {
    name: "mcode-language-chunks",
    enforce: "pre",
    transform(code, id) {
      if (resolve(id.split("?")[0]) !== I18N_FILE) return null
      const split = splitLanguageTables(code)
      tables = split.tables
      return { code: split.code, map: null }
    },
    resolveId(id) {
      return id.startsWith(LANGUAGE_PREFIX) ? id : null
    },
    load(id) {
      if (!id.startsWith(LANGUAGE_PREFIX)) return null
      const table = tables.get(id.slice(LANGUAGE_PREFIX.length))
      if (!table) throw new Error(`languageChunks: ${id} asked for before lib/i18n.ts was compiled`)
      return `export default ${table}`
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve("src/main/index.ts") },
      },
    },
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        /*
         * CommonJS, because the main window is sandboxed (round 8, X15) and a
         * sandboxed page runs no ES-module preload. The preload uses nothing
         * but the parts of electron a sandboxed preload is given.
         */
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [languageChunks(), vue(), pdfjsAssets(), fluidsynthVendor()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
        /*
         * The app's own artwork, which both halves need: the settings gallery
         * draws the original mark from the same file the main process hands
         * the window, rather than keeping a second copy that could drift.
         */
        "@resources": resolve("resources"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") },
      },
    },
  },
})
