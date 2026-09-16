import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, statSync } from "node:fs"
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

function pdfjsAssets(): Plugin {
  const source = resolve("node_modules/pdfjs-dist")
  let outDir = ""
  return {
    name: "mcode-pdfjs-assets",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "")
        const file = resolve(source, rel)
        const allowed = PDFJS_DIRS.includes(rel.split("/")[0]) && file.startsWith(source + sep)
        if (!allowed || !existsSync(file) || !statSync(file).isFile()) return next()
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm")
        createReadStream(file).pipe(res)
      })
    },
    writeBundle() {
      for (const dir of PDFJS_DIRS) cpSync(resolve(source, dir), resolve(outDir, "pdfjs", dir), { recursive: true })
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
    plugins: [vue(), pdfjsAssets(), fluidsynthVendor()],
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
