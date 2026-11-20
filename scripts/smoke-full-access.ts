import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { PermissionDenied, Permissions } from "../src/server/permission"
import { Storage } from "../src/server/storage"
import type { Access } from "../src/shared/access"

export async function fullAccessNeverAsks(check: Check, section: (name: string) => void): Promise<void> {
  await fs.mkdir("tmp-local", { recursive: true })
  const root = await fs.mkdtemp(path.resolve("tmp-local", "smoke-full-access-"))
  try {
    const storage = new Storage(path.join(root, "storage"))
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(root, "credentials.json"))
    await storage.write("config", {})
    await config.load()
    await config.set({
      allowFullAccess: true,
      permissionRules: [],
      permissions: {
        read: "allow", glob: "allow", grep: "allow", list: "allow",
        edit: "ask", bash: "ask", outside: "ask", webfetch: "ask", mcp: "ask",
      },
    })
    const gate = new Permissions(bus, config)
    let level: Access = "full"
    gate.useSessions(async (sessionID) => sessionID === "ses_isolated_ask" ? "ask" : level)
    let call = 0
    const requests: string[] = []
    bus.subscribe((event) => {
      if (event.type === "permission.requested") requests.push(event.request.sessionID)
    })
    type Input = Parameters<Permissions["ask"]>[0]
    type Attempt = Pick<Input, "kind" | "subject" | "forced" | "humanOnly" | "patternAsks" | "patterns" | "scope">
    const start = async (input: Attempt, sessionID = "ses_full_access") => {
      const previousRequests = requests.length
      const running = gate.ask({
        sessionID,
        messageID: "m",
        callID: `c${++call}`,
        directory: root,
        title: "Approve tool call",
        ...input,
      }).then(() => "allowed", (error: unknown) => {
        if (error instanceof PermissionDenied) return "denied"
        return String(error)
      })
      // Let the asynchronous session lookup and permission request complete.
      await new Promise<void>((resolve) => setImmediate(resolve))
      return { running, parked: gate.outstanding().find((request) => request.sessionID === sessionID), asked: requests.length > previousRequests }
    }
    const expect = async (label: string, input: Attempt, asked = false, outcome = "allowed") => {
      const attempt = await start(input)
      if (attempt.parked) gate.respond(attempt.parked.id, "once")
      const actual = await attempt.running
      check(label, attempt.asked === asked && Boolean(attempt.parked) === asked && actual === outcome, {
        asked: attempt.asked, parked: Boolean(attempt.parked), outcome: actual,
      })
    }

    const bash = { kind: "bash", subject: "node build.js" } as const
    const remove = { kind: "bash", subject: "rm -rf build" } as const
    const edit = { kind: "edit", subject: path.join(root, "source.ts") } as const
    const desktop = {
      kind: "bash", subject: "Run macOS controls in TextEdit",
      patterns: ["app: macos TextEdit", "app: macos TextEdit type text"], humanOnly: true,
    } as const
    const push = { kind: "bash", subject: "git push origin main" } as const

    section("Full access never asks")
    await expect("full allows ordinary bash", bash)
    await expect("full allows a forced delete", { ...remove, forced: true })
    await expect("full allows an edit", edit)
    await expect("full allows access outside the project", { kind: "outside", subject: "../notes.txt", scope: ".." })
    await expect("full allows webfetch", { kind: "webfetch", subject: "https://example.com" })
    await expect("full allows a humanOnly desktop request", { ...desktop, patterns: [...desktop.patterns] })
    await expect("full allows a patternAsks read", { kind: "read", subject: ".env", patternAsks: true })
    await config.set({ permissionRules: [{ action: "bash", resource: "git push *", effect: "ask" }] })
    await expect("full allows an explicit ask rule", push)
    await config.set({ permissions: { bash: "deny" } })
    await expect("full refuses a bucket deny without asking", bash, false, "denied")
    await expect("full refuses a bucket deny with a matching ask rule", push, false, "denied")
    await config.set({
      permissions: { bash: "ask" },
      permissionRules: [{ action: "bash", resource: "git push *", effect: "deny" }],
    })
    await expect("full refuses a rule deny without asking", push, false, "denied")

    section("Switching to full releases parked requests")
    await config.set({ permissionRules: [{ action: "bash", resource: "git push *", effect: "ask" }] })
    const releases: [string, Attempt][] = [
      ["ordinary edit", edit],
      ["forced delete", { ...remove, forced: true }],
      ["humanOnly desktop request", { ...desktop, patterns: [...desktop.patterns] }],
      ["explicit ask rule", push],
    ]
    for (const [label, input] of releases) {
      level = "ask"
      const previousRequests = requests.length
      const attempt = await start(input)
      level = "full"
      await gate.drainDecided()
      const remaining = gate.outstanding()[0]
      if (remaining) gate.respond(remaining.id, "once")
      const outcome = await attempt.running
      const published = requests.length - previousRequests
      check(`切到完全访问后释放挂起卡片且仅发布一次（${label}）`,
        Boolean(attempt.parked) && !remaining && outcome === "allowed" && published === 1, {
          parkedBefore: Boolean(attempt.parked), parkedAfter: Boolean(remaining), outcome, published,
      })
    }

    section("同一项目的会话分别使用各自的档位")
    const previousRequests = requests.length
    const ask = await start(edit, "ses_isolated_ask")
    const full = await start(edit)
    for (const request of gate.outstanding()) gate.respond(request.id, "once")
    const published = requests.slice(previousRequests)
    check("同一项目内只有询问档会话发卡",
      Boolean(ask.parked) && !full.parked && published.length === 1 && published[0] === "ses_isolated_ask" &&
      await ask.running === "allowed" && await full.running === "allowed", { published })

    section("Auto and ask keep their approval behavior")
    level = "auto"
    await expect("auto allows an edit", edit)
    await expect("auto asks about a delete", remove, true)
    level = "ask"
    await expect("ask prompts for an edit", edit, true)
    await expect("ask prompts for ordinary bash", bash, true)
  } finally {
    await fs.rm(root, { force: true, recursive: true })
  }
}
