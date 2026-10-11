/** Second review: app operation state survives queued calls and window reloads. */
import { AppDriver } from "../src/server/appdrive/driver"
import { AppTool, closeAppOf, closeAllApps } from "../src/server/tool/app"
import type { ToolContext } from "../src/server/tool/types"
import type { ToolPart } from "../src/shared/protocol"
import { operationKind } from "../src/shared/operation-kind"
import { calls, engine, type Check } from "./smoke-round5"

export async function roundFortyNineChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 49: queued app state and reload recovery")
  const originalOpen = AppDriver.open
  const originalAttach = AppDriver.attach
  const id = "round49-operation-review"
  let release: (() => void) | undefined
  let entered = false
  let failAttach = false
  let closes = 0
  let adapterCalls = 0
  let gate = Promise.resolve()
  const driver = () => ({
    alive: true, label: "Review fixture", snapshot: async () => "Review fixture",
    run: async () => { entered = true; await gate; return { output: "done", done: 1 } },
    close: async () => { closes++ },
  }) as unknown as AppDriver
  AppDriver.open = async () => { adapterCalls++; return driver() }
  AppDriver.attach = async () => { adapterCalls++; if (failAttach) throw new Error("Replacement refused"); return driver() }
  const reports: (string | undefined)[] = []
  const context = {
    sessionID: id, messageID: "review", callID: "review", directory: process.cwd(),
    permissions: { ask: async () => undefined }, questions: {}, signal: new AbortController().signal,
    progress: () => {}, snapshot: async () => {}, reportOperation: (kind) => { reports.push(kind) },
  } as ToolContext
  try {
    await AppTool.execute({ action: "open", url: "http://127.0.0.1" }, context)
    reports.length = 0
    gate = new Promise<void>(resolve => { release = resolve })
    const running = AppTool.execute({ action: "do", steps: [{ action: "click", ref: 1 }] }, context)
    const deadline = Date.now() + 2000
    while (!entered && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    check("R49: an ongoing do reports its browser before the driver returns", entered && reports.join() === "browser", reports)
    const queued = AppTool.execute({ action: "attach", port: 9222 }, context)
    await new Promise(resolve => setTimeout(resolve, 25))
    check("R49: a queued replacement does not announce before its predecessor finishes", reports.length === 1, reports)
    release!()
    await running
    await queued
    check("R49: queued replacement announces the computer when it actually starts", reports.join() === "browser,computer", reports)
    reports.length = 0
    const snapshot = await AppTool.execute({ action: "snapshot" }, context)
    check("R49: a generic snapshot keeps the attached computer surface", reports[0] === "computer" && snapshot.metadata?.operationKind === "computer")
    failAttach = true
    reports.length = 0
    const beforeClose = closes
    await AppTool.execute({ action: "attach", port: 9222 }, context).catch(() => undefined)
    check("R49: failed replacement closes the predecessor and clears its operation", closes === beforeClose + 1 && reports.length === 2 && reports[0] === "computer" && reports[1] === undefined, reports)
    reports.length = 0
    await AppTool.execute({ action: "snapshot" }, context).catch(() => undefined)
    check("R49: no subsequent call inherits a failed replacement's surface", reports.length > 0 && reports.every(kind => kind === undefined), reports)
    failAttach = false
    await AppTool.execute({ action: "open", url: "http://127.0.0.1" }, context)
    await closeAllApps()
    reports.length = 0
    await AppTool.execute({ action: "snapshot" }, context).catch(() => undefined)
    check("R49: shutdown removes the cached surface along with its driver", reports.length > 0 && reports.every(kind => kind === undefined), reports)
    const absent = { name: "app", input: { action: "attach" }, metadata: { operationKind: "none" } } as ToolPart
    check("R49: explicit absent surface overrides action and cached browser hints", operationKind(absent, "browser") === undefined)

    await AppTool.execute({ action: "open", url: "http://127.0.0.1" }, context)
    entered = false
    gate = new Promise<void>(resolve => { release = resolve })
    const predecessor = AppTool.execute({ action: "do", steps: [{ action: "click", ref: 1 }] }, context)
    const queuedBy = Date.now() + 2000
    while (!entered && Date.now() < queuedBy) await new Promise(resolve => setTimeout(resolve, 5))
    const queuedController = new AbortController()
    const cancelledReports: (string | undefined)[] = []
    const callsBeforeCancel = adapterCalls
    const cancelled = AppTool.execute({ action: "attach", port: 9222 }, {
      ...context, signal: queuedController.signal, reportOperation: kind => { cancelledReports.push(kind) },
    }).then(() => false, () => true)
    queuedController.abort()
    release!()
    await predecessor
    check("R49: cancelled queued operation never announces or opens its target", await cancelled && adapterCalls === callsBeforeCancel && !cancelledReports.length)
    const preparingController = new AbortController()
    const callsBeforePreparation = adapterCalls
    const refused = await AppTool.execute({ action: "open", url: "http://127.0.0.1" }, {
      ...context, signal: preparingController.signal, reportOperation: async () => { preparingController.abort(); await Promise.resolve() },
    }).then(() => false, () => true)
    check("R49: cancellation during operation-state persistence stops before the driver starts", refused && adapterCalls === callsBeforePreparation)

    const e = await engine()
    let pending: Promise<unknown> | undefined
    try {
      await e.config.set({ permissions: { ...e.config.get().permissions, bash: "allow" } })
      const session = await e.store.create({ directory: e.project, model: e.model })
      await AppTool.execute({ action: "attach", port: 9222 }, { ...context, sessionID: session.id })
      entered = false
      gate = new Promise<void>(resolve => { release = resolve })
      e.replies.push(calls([{ name: "app", input: { action: "do", steps: [{ action: "click", ref: 1 }] } }]))
      pending = e.runner.prompt({ sessionID: session.id, text: "Operate the review fixture" })
      const started = await e.until(() => entered)
      const runningEvents = e.events.filter(event => event.type === "message.part.updated" && event.part.type === "tool" && event.part.status === "running" && event.part.metadata?.operationKind === "computer")
      check("R49: real runner broadcasts actual type while the app call is still running", started && runningEvents.length > 0)
      const parts = (await e.assistants(session.id)).flatMap(message => message.parts)
      check("R49: reload reads the ongoing operation type from the saved transcript", parts.some(part => part.type === "tool" && part.status === "running" && part.metadata?.operationKind === "computer"))
      release!()
      await pending
      await e.idle(session.id)
      const finished = (await e.assistants(session.id)).flatMap(message => message.parts)
      check("R49: the operation finishes with its actual surface intact", finished.some(part => part.type === "tool" && part.status === "completed" && part.metadata?.operationKind === "computer"))
      await closeAppOf(session.id)
    } finally {
      release?.()
      await pending
      await e.close()
    }
  } finally {
    release?.()
    await closeAppOf(id)
    AppDriver.open = originalOpen
    AppDriver.attach = originalAttach
  }
}
