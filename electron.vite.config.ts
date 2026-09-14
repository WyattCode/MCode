import { cpSync, createReadStream, existsSync, statSync } from "node:fs"
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
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [vue(), pdfjsAssets()],
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
