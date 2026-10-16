import { offlineByEnv, markOffline, isOffline, resetOffline, probeOnline } from "../src/server/tool/offline"
import { toolsForTurn } from "../src/server/tool/registry"
import { WebFetchTool } from "../src/server/tool/webfetch"
import { ToolError } from "../src/server/tool/types"

let passed = 0
let failed = 0

function check(name: string, ok: boolean): void {
  if (ok) {
    passed += 1
  } else {
    failed += 1
    console.error(`failed ${name}`)
  }
}

async function main(): Promise<void> {
  delete process.env.MCODE_OFFLINE
  resetOffline()

  const onlineNames = toolsForTurn("build", { voiceFeedback: false }).map((tool) => tool.name)
  check("online turn offers websearch", onlineNames.includes("websearch"))
  check("online turn offers webfetch", onlineNames.includes("webfetch"))

  process.env.MCODE_OFFLINE = "1"
  check("offlineByEnv sees MCODE_OFFLINE", offlineByEnv())
  const offlineNames = toolsForTurn("build", { voiceFeedback: false }).map((tool) => tool.name)
  check("env offline withholds websearch", !offlineNames.includes("websearch"))
  check("env offline withholds webfetch", !offlineNames.includes("webfetch"))
  delete process.env.MCODE_OFFLINE

  resetOffline()
  markOffline("session-a", "could not resolve a.invalid")
  check("marked session is offline", isOffline("session-a"))
  check("other session is online", !isOffline("session-b"))

  resetOffline()
  for (let i = 0; i <= 500; i++) {
    markOffline(`session-${i}`, "bound")
  }
  check("map bound drops oldest", !isOffline("session-0"))
  check("map bound keeps newest", isOffline("session-500"))
  check("map bound keeps next oldest", isOffline("session-1"))

  const rejectingResolver = async (): Promise<unknown> => {
    throw new Error("resolver failed")
  }
  const resolvingResolver = async (): Promise<unknown> => ({ address: "198.18.0.1" })
  const neverSettlingResolver = (): Promise<unknown> => new Promise<unknown>(() => undefined)

  check("probeOnline false when resolver rejects", (await probeOnline(["a.example"], 1500, rejectingResolver)) === false)
  check("probeOnline true when resolver resolves", (await probeOnline(["a.example"], 1500, resolvingResolver)) === true)
  check("probeOnline false when resolver never settles", (await probeOnline(["a.example"], 50, neverSettlingResolver)) === false)

  resetOffline()
  markOffline("webfetch-session", "could not resolve example.invalid")
  const context = {
    sessionID: "webfetch-session",
    messageID: "message",
    callID: "call",
    directory: process.cwd(),
    permissions: { ask: async () => undefined },
    questions: { ask: async () => [] },
    signal: AbortSignal.timeout(1000),
    progress: () => undefined,
    snapshot: async () => undefined,
  }
  let threw = false
  let message = ""
  try {
    await WebFetchTool.execute({ url: "https://example.invalid" }, context as any)
  } catch (error) {
    threw = error instanceof ToolError
    message = error instanceof Error ? error.message : String(error)
  }
  check("webfetch throws ToolError when offline", threw)
  check("webfetch offline message", message.includes("network is unavailable"))
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .then(() => {
    console.log(`${passed} passed / ${failed} failed`)
    process.exitCode = failed ? 1 : 0
  })
