import "./fenced-home"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Storage } from "../src/server/storage"
import { Permissions } from "../src/server/permission"
import { SessionRunner } from "../src/server/session/runner"
import { SessionStore } from "../src/server/session/store"
import { installPlugin, listPlugins, parseInstallCommand, pluginPrompt, setPlugin } from "../src/server/cli-plugins"

test("only an exact allowlisted first token can launch an installer", () => {
  for (const command of ["rm -rf example", "curl example", "npm-other install example", "npm install x && rm x"]) {
    assert.throws(() => parseInstallCommand(command))
  }
  assert.deepEqual(parseInstallCommand('npm i -g "example"'), ["npm", "i", "-g", "example"])
})

test("settings persist installs, enable and disable prompt injection, and remove deleted records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-plugin-"))
  const open = async () => {
    const config = new Config(new Storage(root), new Bus(), path.join(root, "credentials.json"))
    await config.load()
    return config
  }
  try {
    const config = await open()
    const outputs: string[] = []
    await assert.rejects(installPlugin(config, { name: " ", command: "npm --version" }, () => {}), /请填写名称/)
    await assert.rejects(installPlugin(config, { name: "node", command: " " }, () => {}), /请填写安装命令/)
    const plugin = await installPlugin(config, { name: "node", command: "npm --version" }, output => outputs.push(output))
    assert.ok(outputs.join("").trim())
    const missing = await installPlugin(config, { name: "missing", binary: "mcode-nonexistent-plugin-test", command: "npm --version" }, () => {})
    assert.equal(listPlugins(config.get()).find(row => row.id === missing.id)?.available, false)
    await setPlugin(config, missing.id, true)
    assert.equal(pluginPrompt(config.get()), "")
    await setPlugin(config, missing.id, "delete")
    const reopened = await open()
    assert.deepEqual(reopened.get().cliPlugins, { version: 1, entries: [plugin] })
    assert.equal(pluginPrompt(reopened.get()), "")
    await setPlugin(reopened, plugin.id, true)
    assert.match(pluginPrompt(reopened.get()), /可用命令行工具[\s\S]*node/)
    await setPlugin(reopened, plugin.id, false)
    assert.equal(pluginPrompt(reopened.get()), "")
    await setPlugin(reopened, plugin.id, true)
    await setPlugin(reopened, plugin.id, "delete")
    assert.equal(pluginPrompt(reopened.get()), "")
    assert.deepEqual((await open()).get().cliPlugins, { version: 1, entries: [] })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the runner adds and removes CLI tools while reusing an existing conversation's prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-plugin-runner-"))
  try {
    const storage = new Storage(root)
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(root, "credentials.json"))
    await config.load()
    const store = new SessionStore(storage, bus)
    const runner = new SessionRunner(store, bus, config, new Permissions(bus, config), {} as never, storage)
    const session = await store.create({ directory: root, model: { provider: "fake", model: "m" }, agent: "build" })
    const plugin = await installPlugin(config, { name: "node", command: "npm --version" }, () => {})
    const prompt = async () => (await runner["systemFor"]({ ...session, agent: "build" })).system

    const original = await prompt()
    assert.doesNotMatch(original, /可用命令行工具/)
    await setPlugin(config, plugin.id, true)
    assert.match(await prompt(), /可用命令行工具[\s\S]*通过 bash 工具调用/)
    await setPlugin(config, plugin.id, false)
    assert.equal(await prompt(), original)
    await setPlugin(config, plugin.id, true)
    await setPlugin(config, plugin.id, "delete")
    assert.equal(await prompt(), original)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a failing installer streams output and persists no plugin", { skip: process.platform === "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-plugin-failure-"))
  const originalPath = process.env.PATH
  try {
    await fs.writeFile(path.join(root, "npm"), "#!/bin/sh\nprintf 'progress\\nfailure details\\n' >&2\nexit 1\n", { mode: 0o700 })
    process.env.PATH = root + path.delimiter + (originalPath ?? "")
    const config = new Config(new Storage(root), new Bus(), path.join(root, "credentials.json"))
    await config.load()
    const logs: string[] = []
    const installing = installPlugin(config, { name: "example", command: "npm --version" }, chunk => logs.push(chunk))
    await assert.rejects(installing, { message: "failure details" })
    assert.match(logs.join(""), /progress/)
    assert.match(logs.join(""), /failure details/)
    assert.equal(config.get().cliPlugins, undefined)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await fs.rm(root, { recursive: true, force: true })
  }
})
