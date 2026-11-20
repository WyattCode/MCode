import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import type { Config } from "../src/server/config"
import { PermissionDenied, Permissions } from "../src/server/permission"
import type { Access } from "../src/shared/access"
import type { PermissionDecision, PermissionRecord, PermissionRequest, PermissionResponse } from "../src/shared/protocol"

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

export function fixture() {
  const settings = {
    allowFullAccess: true,
    permissions: { webfetch: "ask" },
    permissionRules: [],
  } as ReturnType<Config["get"]>
  const bus = new Bus()
  const gate = new Permissions(bus, { get: () => settings } as Config)
  const requests: PermissionRequest[] = []
  const resolutions: PermissionDecision[] = []
  bus.subscribe((event) => {
    if (event.type === "permission.requested") requests.push(event.request)
    if (event.type === "permission.resolved") resolutions.push(event.decided)
  })
  function start(input: Partial<Parameters<Permissions["ask"]>[0]> & { signal?: AbortSignal } = {}) {
    return gate.ask({
      sessionID: "session", messageID: "message", callID: "call",
      kind: "webfetch", title: "访问网页", subject: "https://example.com",
      ...input,
    }).then(() => undefined, (error: unknown) => error)
  }
  function answer(response: PermissionResponse) {
    const request = gate.outstanding()[0]
    if (request) gate.respond(request.id, response)
  }
  return { settings, gate, requests, resolutions, start, answer }
}

export async function permflowReview(check: Check): Promise<void> {
  for (const change of ["manual", "ask-rule", "allow-rule", "unchanged", "full"] as const) {
    const { gate, settings, requests, start, answer } = fixture()
    let level: Access = "auto"
    gate.useSessions(async () => level)
    let finishReview: ((approved: boolean) => void) | undefined
    gate.useReviewer(() => new Promise<boolean>((resolve) => { finishReview = resolve }))
    const running = start()
    await tick()
    if (change === "manual") level = "ask"
    if (change === "full") level = "full"
    if (change === "ask-rule" || change === "allow-rule") {
      settings.permissionRules = [{ action: "webfetch", resource: "*", effect: change === "ask-rule" ? "ask" : "allow" }]
    }
    finishReview?.(change !== "allow-rule" && change !== "full")
    await tick()
    const asked = requests.length
    answer("once")
    check(`模型审批返回后重新判定 ${change}`,
      Boolean(finishReview) && (await running) === undefined && asked === (change === "manual" || change === "ask-rule" ? 1 : 0),
      { asked })
  }

  for (const response of ["once", "always"] as const) {
    const { gate, settings, resolutions, start, answer } = fixture()
    const records: (PermissionRecord & { response?: PermissionResponse })[] = []
    gate.onDecided("call", (record) => records.push(record))
    const running = start()
    answer(response)
    const publishedBeforeRecheck = resolutions.length
    settings.permissions.webfetch = "deny"
    const result = await running
    check(`人工选择 ${response} 后策略拒绝只发布最终结论`,
      result instanceof PermissionDenied && publishedBeforeRecheck === 0 &&
      resolutions.join() === "policy" && records.length === 1 &&
      records[0].decided === "policy" && records[0].response === response,
      { publishedBeforeRecheck, resolutions, records: records.map(({ decided, response }) => ({ decided, response })) })
  }
}

export async function runSmoke(run: (check: Check) => Promise<void>): Promise<void> {
  let checks = 0
  let failures = 0
  await run((name, passed, detail) => {
    checks++
    if (!passed) failures++
    console.log(`  ${passed ? "ok  " : "FAIL"} ${name}${passed || detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`)
  })
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures) {
    console.log(`FAILED with ${failures} problem(s)`)
    process.exitCode = 1
  }
}

if (process.argv.includes("--permflow-review")) await runSmoke(permflowReview)
