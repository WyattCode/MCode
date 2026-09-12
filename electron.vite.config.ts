import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import vue from "@vitejs/plugin-vue"

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
    plugins: [vue()],
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
