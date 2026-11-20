import type { Check } from "./smoke-round5"
import { PermissionDenied } from "../src/server/permission"
import type { Access } from "../src/shared/access"
import { fixture, runSmoke, tick } from "./smoke-permflow-review"

export async function permflowCancel(check: Check): Promise<void> {
  for (const mode of ["signal", "stop"] as const) {
    const { gate, requests, start, answer } = fixture()
    const controller = new AbortController()
    let finishLevel: ((level: Access) => void) | undefined
    gate.useSessions(() => new Promise<Access>((resolve) => { finishLevel = resolve }))
    let result: unknown
    const running = start({ signal: controller.signal }).then((value) => { result = value })
    if (mode === "signal") controller.abort()
    else gate.rejectAll("session")
    await tick()
    const settledWhileReading = result instanceof PermissionDenied
    finishLevel?.("ask")
    await tick()
    answer("reject")
    await running
    check(`读档位在途取消立即结算且不发卡 ${mode}`,
      Boolean(finishLevel) && settledWhileReading && requests.length === 0, { settledWhileReading, asked: requests.length })
  }

  {
    const { gate, requests, resolutions, start, answer } = fixture()
    const controller = new AbortController()
    const running = start({ signal: controller.signal })
    controller.abort()
    await tick()
    const cancelled = resolutions.join() === "cancelled" && gate.outstanding().length === 0
    answer("reject")
    check("AbortSignal 结算已经显示的审批卡",
      requests.length === 1 && cancelled && (await running) instanceof PermissionDenied, { resolutions })
  }

  {
    const { gate, requests, start, answer } = fixture()
    const stopped = start()
    gate.rejectAll("session")
    const other = start({ sessionID: "other" })
    answer("once")
    const later = start()
    answer("once")
    check("Stop 不影响其他会话或同会话下一轮的同名调用",
      (await stopped) instanceof PermissionDenied && (await other) === undefined && (await later) === undefined &&
      requests.length === 3, { sessions: requests.map((request) => request.sessionID) })
  }
}

if (process.argv.includes("--permflow-cancel")) await runSmoke(permflowCancel)
