import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import { compileScript, parse } from "@vue/compiler-sfc"
import { build } from "esbuild"
import { Bus } from "../src/server/bus"
import type { Config } from "../src/server/config"
import { HookEngine } from "../src/server/hooks"
import { Permissions } from "../src/server/permission"
import { SessionRunner } from "../src/server/session/runner"

type Check = (name: string, ok: boolean, detail?: string) => void
const cases: [string, () => Promise<void>][] = [
  ["settings mounts live rows, diagnostics, and reloads through the engine RPC", async () => {
    const settings = await fs.readFile("src/renderer/src/components/SettingsDialog.vue", "utf8")
    assert.match(settings, /<HooksSettings\b[\s\S]*?:request="requestHooks"/)
    assert.match(settings, /navShows\('hooks'\)/)
    const source = await fs.readFile("src/renderer/src/components/HooksSettings.vue", "utf8")
    const compiled = compileScript(parse(source).descriptor, { id: "hooks-settings", inlineTemplate: true })
    const { outputFiles } = await build({
      stdin: {
        contents: compiled.content + '\nexport { createApp, nextTick } from "vue"',
        loader: "ts",
        resolveDir: "src/renderer/src/components",
      },
      alias: { "@shared": "./src/shared" },
      bundle: true, platform: "node", format: "cjs", write: false,
    })
    const require = createRequire(import.meta.url)
    const window = require("@mixmark-io/domino").createWindow()
    window.Node.prototype.getRootNode ??= function (this: Node) { return this.ownerDocument }
    const module = { exports: {} }
    new Function("module", "exports", "require", "document", "window", "SVGElement", "Element", "Document", outputFiles[0].text)(
      module, module.exports, require, window.document, window, window.SVGElement ?? class {}, window.Element, window.Document,
    )
    const { default: View, createApp, nextTick } = module.exports as {
      default: import("vue").Component
      createApp: typeof import("vue").createApp
      nextTick: typeof import("vue").nextTick
    }
    const document = window.document as Document
    const host = document.createElement("div")
    document.body.appendChild(host)
    const requests: string[] = []
    const settingsConfig = { hooks: { PreToolUse: [{ matcher: "Bash", command: "list-command", timeoutMs: 0 }] } }
    const config = {
      get: () => settingsConfig,
      async reloadFromDisk() { settingsConfig.hooks.PreToolUse[0].command = "reload-command" },
    }
    const engine = new HookEngine(new Permissions(new Bus(), config as unknown as Config))
    const runner = Object.assign(Object.create(SessionRunner.prototype) as SessionRunner, { hooks: engine, config })
    const directory = process.platform === "win32" ? "Z:\\worktree" : "/worktree"
    let reloaded = 0
    const app = createApp(View, {
      directory,
      onReloaded: () => { reloaded++ },
      request: async (type: string, directory: string) => {
        requests.push(type + " " + directory)
        return runner.listHooks(directory, type === "hooks.reload")
      },
    })
    const settle = async () => {
      await nextTick()
      for (let attempt = 0; attempt < 200 && host.querySelector("button")?.disabled; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        await nextTick()
      }
    }
    try {
      app.mount(host)
      await settle()
      assert.deepEqual(requests, [`hooks.list ${directory}`])
      for (const value of ["PreToolUse", "Bash", "list-command", "config.json", "timeoutMs", "worktree"]) {
        assert.ok(host.textContent?.includes(value), value)
      }
      const button = host.querySelector<HTMLButtonElement>("button")
      assert.match(button?.textContent ?? "", /Reload hooks|重新加载钩子/i)
      button?.click()
      await settle()
      assert.deepEqual(requests, [`hooks.list ${directory}`, `hooks.reload ${directory}`])
      assert.match(host.textContent ?? "", /reload-command/)
      assert.equal(reloaded, 1)
      assert.doesNotMatch(host.textContent ?? "", /list-command/)
    } finally {
      app.unmount()
      host.remove()
    }
  }],
]

export async function hooksSettingsChecks(check: Check) {
  for (const [name, run] of cases) {
    try {
      await run()
      check(name, true)
    } catch (e) {
      check(name, false, (e as Error).message)
    }
  }
}

if (process.argv[1]?.split("/").pop() === "smoke-hooks-settings.ts") {
  await hooksSettingsChecks((name, ok, detail) => {
    console.log(ok ? "PASS" : "FAIL", name, detail ?? "")
    if (!ok) process.exitCode = 1
  })
}
