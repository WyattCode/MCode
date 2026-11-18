import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { test } from "node:test"
import { Bus } from "../src/server/bus"
import type { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { AppTool, closeAppOf, macOSActions } from "../src/server/tool/app"
import type { ToolContext } from "../src/server/tool/types"
import { installMacOSHost, MacOSDriver } from "../src/server/appdrive/macos"
import { classifyMacOSAction } from "../src/server/appdrive/macos-risk"

test("registers the native desktop action on macOS only", () => {
  assert.deepEqual(macOSActions("darwin"), ["macos"])
  assert.deepEqual(macOSActions("win32"), [])
  assert.deepEqual(macOSActions("linux"), [])
  const actions = (AppTool.parameters.properties as { action: { enum: string[] } }).action.enum
  assert.equal(actions.includes("macos"), process.platform === "darwin")
})

test("classifies Telegram and destructive input together", () => {
  assert.deepEqual(classifyMacOSAction("Telegram", [{ action: "type", text: "sudo rm -rf cache" }]), ["sensitive-app", "destructive-text"])
  assert.deepEqual(classifyMacOSAction("TextEdit", [{ action: "type", text: "hello" }]), [])
  assert.deepEqual(classifyMacOSAction("Notes", [{ action: "type", text: "请删除文件" }]), ["destructive-text"])
})

test("an inaccessible control tree keeps the PNG and coordinate grid", async () => {
  const png = Buffer.from("fixture PNG bytes")
  installMacOSHost({
    enabled: () => true,
    launch: async () => {},
    activate: async () => {},
    inspect: async () => { throw new Error("Accessibility denied") },
    capture: async () => ({ png, width: 1440, height: 900 }),
    input: async () => {},
  })
  try {
    const driver = await MacOSDriver.open("TextEdit")
    try {
      const snapshot = await driver.snapshot(true)
      assert.match(snapshot, /No accessible front-window controls/)
      assert.match(snapshot, /x=0…1439, y=0…899/)
      const file = /^Desktop screenshot: (.+)$/m.exec(snapshot)?.[1]
      assert.ok(file)
      assert.deepEqual(await fs.readFile(file), png)
    } finally {
      await driver.close()
    }
  } finally {
    installMacOSHost(undefined)
  }
})

test("permission denial degrades the snapshot and approval gates every native action", { skip: process.platform !== "darwin" }, async () => {
  const bus = new Bus()
  let reviewerCalls = 0
  let accessLevel = "full"
  let rule = "allow"
  const permissions = new Permissions(bus, { get: () => ({
    accessLevel,
    permissionRules: [{ action: "bash", resource: "*", effect: rule }],
  }) } as Config)
  permissions.useReviewer(async () => { reviewerCalls++; return true })
  const requests: { id: string; subject: string; titleCode?: string }[] = []
  bus.subscribe((event) => {
    if (event.type === "permission.requested") {
      assert.equal(event.request.forced, true)
      requests.push(event.request)
    }
  })
  const context = { sessionID: "macctl-test", permissions, signal: new AbortController().signal } as ToolContext
  const effects: string[] = []
  installMacOSHost({
    enabled: () => true,
    launch: async () => { effects.push("open") },
    activate: async () => { effects.push("activate") },
    inspect: async () => { throw new Error("AX denied") },
    capture: async () => { throw new Error("Screen Recording denied") },
    input: async (_app, input) => {
      if (input.action === "click") effects.push(`click ${input.point.x},${input.point.y}`)
      else effects.push("input")
    },
  })
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
  try {
    const launch = AppTool.execute({ action: "macos", app: "Telegram" }, context)
    await tick()
    assert.equal(requests.length, 1)
    assert.deepEqual(effects, [])
    await permissions.drainDecided()
    assert.deepEqual(effects, [])
    permissions.respond(requests[0]!.id, "always")
    assert.match((await launch).output, /Privacy & Security/)
    const action = { action: "do", steps: [{ action: "type", text: "rm file" }] }
    const rejected = AppTool.execute(action, context)
    const refusal = assert.rejects(rejected)
    await tick()
    assert.equal(requests.length, 2)
    assert.equal(requests[1]!.titleCode, "perm.app.macosDestructive")
    assert.match(requests[1]!.subject, /Telegram[\s\S]*rm file/)
    permissions.respond(requests[1]!.id, "reject")
    await refusal
    assert.deepEqual(effects, ["open"])
    const accepted = AppTool.execute(action, context)
    await tick()
    assert.equal(requests.length, 3)
    await permissions.drainDecided()
    assert.deepEqual(effects, ["open"])
    permissions.respond(requests[2]!.id, "once")
    assert.equal((await accepted).metadata?.done, 1)
    assert.deepEqual(effects, ["open", "activate", "input"])
    accessLevel = "auto"
    const unreviewed = AppTool.execute(action, context)
    const switched = assert.rejects(unreviewed)
    await tick()
    assert.equal(requests.length, 4)
    accessLevel = "full"
    await permissions.drainDecided()
    assert.deepEqual(effects, ["open", "activate", "input"])
    rule = "deny"
    await permissions.drainDecided()
    await switched
    assert.deepEqual(effects, ["open", "activate", "input"])
    assert.equal(reviewerCalls, 0)
    rule = "allow"
    const click = AppTool.execute({ action: "do", steps: [{ action: "click", x: 12, y: 34 }] }, context)
    await tick()
    assert.equal(requests.length, 5)
    assert.deepEqual(effects, ["open", "activate", "input"])
    permissions.respond(requests[4]!.id, "once")
    assert.equal((await click).metadata?.done, 1)
    assert.deepEqual(effects, ["open", "activate", "input", "activate", "click 12,34"])
  } finally {
    permissions.rejectAll(context.sessionID)
    await closeAppOf(context.sessionID)
    installMacOSHost(undefined)
  }
})
