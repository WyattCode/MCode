import path from "node:path"
import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import type { Config } from "../src/server/config"
import { PermissionDenied, Permissions } from "../src/server/permission"
import type { Access } from "../src/shared/access"
import type { PermissionRecord, PermissionRequest } from "../src/shared/protocol"

export async function denyWins(check: Check): Promise<void> {
  const directory = path.resolve("tmp-local", "project")
  const scope = path.resolve("tmp-local", "outside")
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

  function fixture() {
    const settings: ReturnType<Config["get"]> = {
      allowFullAccess: true,
      permissions: { outside: "ask", webfetch: "ask" },
      permissionRules: [],
    } as ReturnType<Config["get"]>
    const bus = new Bus()
    const gate = new Permissions(bus, { get: () => settings } as Config)
    const levels = new Map<string, Access>()
    gate.useSessions(async (sessionID) => levels.get(sessionID) ?? "ask")
    const requests: PermissionRequest[] = []
    bus.subscribe((event) => {
      if (event.type === "permission.requested") requests.push(event.request)
    })
    let sequence = 0
    function start(input: Partial<Parameters<Permissions["ask"]>[0]> = {}) {
      const callID = `call-${++sequence}`
      const records: PermissionRecord[] = []
      gate.onDecided(callID, (record) => records.push(record))
      const running = gate.ask({
        sessionID: "session", messageID: "message", callID, directory,
        kind: "webfetch", title: "访问网页", subject: "https://example.com",
        ...input,
      }).then(() => undefined, (error: unknown) => error)
      return { running, records }
    }
    function answer(response: "once" | "always" | "reject") {
      const request = gate.outstanding()[0]
      if (request) gate.respond(request.id, response)
    }
    return { settings, gate, levels, requests, start, answer }
  }

  {
    const { settings, gate, levels, requests, start, answer } = fixture()
    const outside = { kind: "outside", scope, subject: scope } as const
    const saved = start(outside)
    await tick()
    answer("always")
    check("历史始终允许仍然有效", await saved.running === undefined &&
      gate.allowsOutside({ directory, sessionID: "session" }, scope))

    settings.permissions.outside = "deny"
    check("历史始终允许不能绕过 outside 桶拒绝", !gate.allowsOutside({ directory, sessionID: "session" }, scope))
    levels.set("session", "full")
    const denied = start(outside)
    await tick()
    answer("once")
    check("完全访问仍拒绝被禁止的桶且不发卡", await denied.running instanceof PermissionDenied && requests.length === 1)

    settings.permissions.outside = "ask"
    settings.permissionRules = [{ action: "outside", resource: `${scope}/*`, effect: "deny" }]
    check("历史始终允许不能绕过 outside 资源拒绝", !gate.allowsOutside({ directory, sessionID: "session" }, scope))
  }

  for (const change of ["full", "stop"] as const) {
    const { gate, levels, requests, start, answer } = fixture()
    levels.set("session", "auto")
    let finishReview!: (approved: boolean) => void
    let reviewStarted = false
    gate.useReviewer(() => {
      reviewStarted = true
      return new Promise<boolean>((resolve) => { finishReview = resolve })
    })
    const attempt = start()
    await tick()
    check("模型审批确实已开始", reviewStarted && requests.length === 0)
    if (change === "full") levels.set("session", "full")
    else gate.rejectAll("session")
    finishReview?.(false)
    await tick()
    const published = requests.length
    answer("once")
    const result = await attempt.running
    if (change === "full") {
      check("审批在途切到完全访问，策略放行且不发卡",
        published === 0 && result === undefined && attempt.records[0]?.decided === "policy", { published, records: attempt.records })
    } else {
      check("审批在途停止，拒绝且不发卡", published === 0 && result instanceof PermissionDenied, { published })
    }
  }

  for (const response of ["once", "always"] as const) {
    const { settings, start, answer } = fixture()
    const attempt = start()
    await tick()
    answer(response)
    settings.permissions.webfetch = "deny"
    const result = await attempt.running
    /*
     * 记录分成两笔：`response` 是人选的（审计要留），`decided` 是策略复查后的最终结论。
     * 这条断言同时钉住两笔——把用户选择写回 decided、或把最终结论写成放行，都会红。
     */
    check(`人工批准 ${response} 后桶拒绝续跑并保留人工审计`,
      result instanceof PermissionDenied &&
        (attempt.records[0] as { response?: string } | undefined)?.response === response &&
        attempt.records[0]?.decided === "policy", { records: attempt.records })
  }

  {
    const { settings, levels, start, answer } = fixture()
    const first = start({ subject: "https://example.com/approved" })
    const other = start({ sessionID: "other" })
    await tick()
    answer("always")
    levels.set("other", "full")
    settings.permissionRules = [{ action: "webfetch", resource: "*", effect: "deny" }]
    // Resource-specific rules still let the original approval through for its own subject.
    settings.permissionRules.push({ action: "webfetch", resource: "https://example.com/approved", effect: "allow" })
    // Release both attempts even when propagation fails to settle the second card.
    await tick()
    answer("reject")
    await first.running
    const result = await other.running
    check("始终允许传播前按目标会话策略拒绝", result instanceof PermissionDenied && other.records[0]?.decided === "policy")
  }
}
