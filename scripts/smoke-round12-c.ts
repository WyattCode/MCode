/**
 * Round 12, lane C: what the user sees when something fails or there is
 * nothing to show (C12-1 - C12-10), measured against MiMo 26.914. Kept apart
 * from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundTwelveFailureChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import { createServer, type AddressInfo } from "node:net"
import path from "node:path"
import { WebSocketServer } from "ws"
import type { Check } from "./smoke-round5"
import { Client } from "../src/renderer/src/lib/client"
import { LANGUAGES, language, t } from "../src/renderer/src/lib/i18n"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundTwelveFailureChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 12 (C): failure and empty-state UX")

  // ---------------------------------------------------------------- C12-1
  {
    const before = language.value
    const rendered = LANGUAGES.map(({ id }) => {
      language.value = id
      return [id, t("harnessRow.retryIn", { time: "5s" })] as const
    })
    language.value = before
    const braced = rendered.filter(([, text]) => /[{}]/.test(text) || !text.includes("5s"))
    check("C12-1: the retry countdown renders its time without braces in all 18 languages", braced.length === 0, braced)
  }

  // ---------------------------------------------------------------- C12-2
  await queuedRequestChecks(check)

  const store = await read("src/renderer/src/stores/app.ts")
  const shell = await read("src/renderer/src/App.vue")
  const i18n = await read("src/renderer/src/lib/i18n.ts")
  const inTables = (key: string) => i18n.split(`"${key}":`).length - 1 === 18

  // ---------------------------------------------------------------- C12-3
  {
    const overlay = /<div v-if="([^"]*)" class="boot">/.exec(shell)?.[1] ?? ""
    check("C12-3: the full-screen overlay is shown for boot failures only, not for a drop after boot", /app\.offline && !app\.ready/.test(overlay) && !/\|\| app\.offline\)/.test(overlay), overlay)
    const timer = store.slice(store.indexOf("offlineTimer = setTimeout("), store.indexOf("}, 2500)"))
    check(
      "C12-3: after boot the reconnect notice escalates in place instead",
      /if \(booted\)/.test(timer) && /notice\.danger\(t\("error\.connectionRecovering"\), \{ id: RECONNECT_TOAST, body: t\("error\.connectionStillDown"\)/.test(timer) && inTables("error.connectionStillDown"),
    )
  }

  // ---------------------------------------------------------------- C12-4
  {
    const stream = await read("src/renderer/src/components/MessageStream.vue")
    const bodyOf = (name: string) => store.slice(store.indexOf(`async function ${name}(`), store.indexOf("\n  }\n", store.indexOf(`async function ${name}(`)))
    const send = bodyOf("send")
    const subtask = bodyOf("subtask")
    check("C12-4: nothing in the store but boot writes the boot-error slot", !/(^|[^\w.])error\.value =/m.test(store) && /app\.error = failure/.test(shell))
    check(
      "C12-4: a refused send or subtask is a failure notice (the side chat's under its transcript)",
      /if \(onSide\) setSideError\(target, reason\)\s+else notifyFailure\(t\("common\.requestFailed"\), reason\)/.test(send) && /notifyFailure\(t\("common\.requestFailed"\)/.test(subtask) && /return false/.test(send),
    )
    check("C12-4: the home hero and its dock no longer hide on a failure", !/!app\.error/.test(shell) && /<SessionHero v-if="empty" \/>/.test(shell))
    check("C12-4: a failed turn still shows under the open transcript", /app\.turnError/.test(stream) && /turnError\.value = said/.test(store))
  }

  // ---------------------------------------------------------------- C12-5
  {
    const overlay = await read("src/renderer/src/components/SearchOverlay.vue")
    const messages = overlay.slice(overlay.indexOf('type: "search.messages"'), overlay.indexOf('type: "artifact.list"'))
    check("C12-5: a failed message search is remembered as failed, not as no hits", /catch \{[^}]*messageFailed\.value = true/.test(messages), messages.slice(0, 400))
    check(
      "C12-5: it shows the error row with Retry, and not 'No matching results'",
      /<div v-if="messageFailed" class="sr-artifact-error"[^>]*>\s*<span>\{\{ t\("searchOverlay\.messageError"\) \}\}<\/span>\s*<button type="button" @click="search">/.test(overlay) &&
        /v-else-if="[^"]*!messageFailed[^"]*" class="sr-empty">\{\{ t\("searchOverlay\.empty"\)/.test(overlay) &&
        inTables("searchOverlay.messageError"),
    )
  }

  // ---------------------------------------------------------------- C12-6
  {
    const page = await read("src/renderer/src/components/PluginsView.vue")
    const loadSkills = page.slice(page.indexOf("async function loadSkills("), page.indexOf("\n}\n", page.indexOf("async function loadSkills(")))
    const refresh = page.slice(page.indexOf("async function refresh("), page.indexOf("\n}\n", page.indexOf("async function refresh(")))
    check("C12-6: a skill list that cannot be read rejects instead of emptying the list", !/\.catch\(/.test(loadSkills) && !/\?\? \[\]/.test(loadSkills) && /skills\.value = listed\.skills/.test(loadSkills), loadSkills)
    check("C12-6: both halves are read side by side, and a failed half is noted", /Promise\.allSettled\(\[app\.client\?\.request\(\{ type: "mcp\.list" \}\), loadSkills\(\)\]\)/.test(page) && /listFailed\.value = failure !== undefined/.test(page))
    check(
      "C12-6: a failed list shows its failure line with Retry, not 'Nothing installed yet'",
      /<p v-if="loaded && listFailed"[^>]*>\s*<span>\{\{ t\("plugins\.listUnavailable"\) \}\}<\/span>\s*<button class="retry" @click="retryLists">/.test(page) &&
        /<p v-else-if="loaded && !shown\.length" class="empty">/.test(page) &&
        inTables("plugins.listUnavailable"),
    )
    check("C12-6: Refresh says it failed when either half failed", /if \(failure === undefined\) notify\(t\("plugins\.refreshed"\)\)\s+else notifyFailure\(t\("plugins\.refreshFailed", \{ error: failure \}\)\)/.test(refresh), refresh)
  }

  // ---------------------------------------------------------------- C12-7
  {
    const sheet = await read("src/renderer/src/components/right/XlsxView.vue")
    const start = sheet.indexOf("    flush: () => {")
    const flush = sheet.slice(start, sheet.indexOf("\n    },\n", start))
    const skipped = flush.slice(flush.indexOf("if (!check.ok || !check.unchanged)"), flush.indexOf("await saveEdits("))
    check(
      "C12-7: spreadsheet edits pending on leave that are skipped, kept or thrown say office.saveFailed with the file's name",
      /const unsaved = \(\) => notifyFailure\(t\("office\.saveFailed"\), base\)/.test(flush) &&
        /unsaved\(\)\s+return/.test(skipped) &&
        /await saveEdits\(\(\) => true\)[\s\S]*if \(edits\.size\) unsaved\(\)/.test(flush) &&
        /\.catch\(\(err\) => \{[\s\S]*unsaved\(\)/.test(flush),
      flush,
    )
  }

  // ---------------------------------------------------------------- C12-8
  {
    const chat = await read("src/renderer/src/components/right/RpChat.vue")
    const loadSide = store.slice(store.indexOf("async function loadSide("), store.indexOf("\n  }\n", store.indexOf("async function loadSide(")))
    check("C12-8: reading a side conversation reports whether it could", /Promise<boolean>/.test(loadSide) && /if \(!result\) return false/.test(loadSide) && /return true\s*$/.test(loadSide), loadSide)
    check(
      "C12-8: the side chat shows loading, then the failure, and tries again every 2 s",
      /const ok = await app\.loadSide\(id\)/.test(chat) &&
        /if \(!ok\) retry = setTimeout\(\(\) => void load\(\), 2000\)/.test(chat) &&
        /loadState\.value === "loading" \? t\("stream\.loadingConvo"\) : loadState\.value === "error" \? t\("subagentDetail\.error"\) : t\("rp\.chat\.empty"\)/.test(chat) &&
        /onBeforeUnmount\(\(\) => clearTimeout\(retry\)\)/.test(chat),
    )
  }
}

/** A port nothing listens on yet. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * C12-2, against a real socket: a request made while the backend is away waits
 * for it rather than failing on the next refused reconnect, is sent exactly
 * once when it returns, and - once its bound runs out - fails and is never
 * sent afterwards. A request the socket did carry fails when the socket drops.
 */
async function queuedRequestChecks(check: Check): Promise<void> {
  const port = await freePort()
  const received: string[] = []
  let server: WebSocketServer | undefined
  const start = async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port })
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw))
        received.push(frame.request.type)
        // "hang" is never answered, so the socket can be dropped under it.
        if (frame.request.type !== "hang") socket.send(JSON.stringify({ kind: "response", id: frame.id, ok: true, data: frame.request.type }))
      })
    })
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()))
  }
  const stop = async () => {
    for (const socket of server?.clients ?? []) socket.terminate()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }

  const client = new Client(port, "smoke")
  client.connect()
  const settled = <T,>(promise: Promise<T>) => {
    const state: { value?: T; error?: Error } = {}
    promise.then((value) => (state.value = value), (error) => (state.error = error))
    return state
  }
  try {
    // Down: queued, and survives several refused reconnect attempts.
    const queued = settled(client.request({ type: "early" } as never))
    await pause(1500)
    check("C12-2: a request queued while the service is down is not failed by refused reconnects", !queued.error && queued.value === undefined, queued.error?.message)
    await start()
    for (let i = 0; i < 40 && queued.value === undefined; i++) await pause(100)
    check("C12-2: it is delivered once the service returns, exactly once", queued.value === ("early" as never) && received.filter((type) => type === "early").length === 1, received)

    // Carried, then dropped: fails, naming the local service rather than the network.
    const carried = settled(client.request({ type: "hang" } as never))
    for (let i = 0; i < 20 && !received.includes("hang"); i++) await pause(50)
    await stop()
    for (let i = 0; i < 20 && !carried.error; i++) await pause(50)
    check("C12-2: a request the dropped socket carried fails, blaming the local service", carried.error?.message === t("error.backendLost") && t("error.backendLost") !== "error.backendLost", carried.error?.message)

    // Queued past its bound: fails, and is never sent later.
    client.queueTimeout = 600
    const late = settled(client.request({ type: "late" } as never))
    await pause(1000)
    check("C12-2: a queued request that outlives its bound fails with the same sentence", late.error?.message === t("error.backendLost"), late.error?.message)
    await start()
    for (let i = 0; i < 30 && !client.state.connected; i++) await pause(100)
    await pause(300)
    check("C12-2: and a request reported as failed is not sent when the service returns", client.state.connected && !received.includes("late"), received)
  } finally {
    client.close()
    await stop()
  }
}
