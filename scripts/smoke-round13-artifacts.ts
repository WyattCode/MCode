/**
 * Round 13 (lane A): artifacts and conversation search at scale (S13-3,
 * S13-5). Kept apart from smoke.ts the way the earlier rounds are; smoke.ts
 * calls `roundThirteenArtifactChecks` with its own check and section.
 *
 * Everything here runs in temporary folders of its own. Nothing reads the
 * user's profile, calls a model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import type { Message } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { SessionStore } from "../src/server/session/store"
import { ARTIFACT_LIST_LIMIT, ArtifactStore, INLINE_RECONCILE } from "../src/server/artifact/store"

const MODEL = { provider: "anthropic", model: "claude-opus-5" } as const

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** Waits for a condition a background pass will make true, or gives up. */
async function until(condition: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

export async function roundThirteenArtifactChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r13-artifacts-"))

  // ------------------------------------------------------------------ S13-3
  section("Round 13 (S13-3): artifact listings are paged and read only what changed")
  {
    const storage = new Storage(path.join(root, "art", "storage"))
    const store = new SessionStore(storage, new Bus())
    const directory = path.join(root, "art-project")
    await fs.mkdir(directory, { recursive: true })

    /** An assistant turn that created one file, as the artifact rules read it. */
    const wrote = async (sessionID: string, id: string, file: string, at: number) => {
      await store.saveMessage(
        {
          id,
          sessionID,
          role: "assistant",
          model: MODEL,
          agent: "build",
          parts: [
            {
              type: "tool",
              id: `prt_${id}`,
              callID: `call_${id}`,
              name: "write",
              status: "completed",
              input: { file_path: file },
              output: "",
              title: file,
              metadata: { created: true },
              time: { created: at, completed: at },
            },
          ],
          finish: "end_turn",
          time: { created: at, completed: at },
        } as never,
        true,
      )
    }

    // 40 conversations, three files each: a document, a page and something else; 120 files, newest last.
    const KINDS = ["md", "html", "ts"] as const
    const ids: string[] = []
    let at = 1_000
    for (let n = 0; n < 40; n++) {
      const session = await store.create({ directory, model: MODEL, title: `Conversation ${n}` })
      ids.push(session.id)
      for (const [k, extension] of KINDS.entries()) {
        const file = `f${String(n).padStart(2, "0")}-${k}.${extension}`
        await fs.writeFile(path.join(directory, file), "x", "utf8")
        at += 1
        await wrote(session.id, `msg_${String(at).padStart(8, "0")}`, file, at)
      }
    }

    const artifacts = (await ArtifactStore.open(path.join(root, "art", "storage", "artifacts.db")))!
    const unwatch = store.watch((change) => {
      if (change.type === "message") artifacts.touched(change.message.sessionID)
      else if (change.type === "message.removed") artifacts.touched(change.sessionID)
    })
    let reads = 0
    const messagesOf = (id: string): Promise<Message[]> => {
      reads += 1
      return store.messages(id)
    }

    // A store with nothing in it yet: more conversations than a listing waits for, so it answers at once.
    const first = await artifacts.answer(await store.list(), messagesOf)
    check(
      "S13-3: the first listing on a profile with no store does not wait for the build, and says it is building",
      first.building === true && reads < 40,
      { building: first.building, reads, files: first.artifacts.flatMap((group) => group.files).length },
    )
    check("S13-3: the build goes on in the background and finishes", await until(() => !artifacts.building), artifacts.building)
    check("S13-3: and when it is done every file is stored", (await artifacts.count()) === 120, await artifacts.count())

    // Paging: fifty at a time, newest first, each page starting where the last ended.
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    let sizes: number[] = []
    do {
      const page = await artifacts.answer(await store.list(), messagesOf, { cursor })
      const files = page.artifacts.flatMap((group) => group.files.map((file) => ({ path: file.path, at: file.at })))
      sizes.push(files.length)
      seen.push(...files.sort((a, b) => b.at - a.at).map((file) => file.path))
      cursor = page.nextCursor
      pages += 1
    } while (cursor && pages < 10)
    check("S13-3: a page holds MiMo's fifty, and the last page says there is no more", sizes.join() === `${ARTIFACT_LIST_LIMIT},${ARTIFACT_LIST_LIMIT},20`, sizes)
    check(
      "S13-3: the pages together are every file once, newest first",
      seen.length === 120 && new Set(seen).size === 120 && seen[0] === "f39-2.ts" && seen[119] === "f00-0.md",
      [seen.length, seen[0], seen[119]],
    )
    const clamped = await artifacts.list({ limit: 500 })
    check("S13-3: a page never holds more than fifty, whatever is asked for", clamped.artifacts.flatMap((group) => group.files).length === ARTIFACT_LIST_LIMIT)
    let refused = false
    await artifacts.list({ cursor: "not a cursor" }).catch(() => (refused = true))
    check("S13-3: a cursor it did not make is refused", refused)

    // The tabs and their counts come from the store, across every page.
    const docs = await artifacts.list({ category: "doc" })
    const other = await artifacts.list({ category: "other" })
    check(
      "S13-3: the counts cover every file, per tab, not just the page",
      JSON.stringify(docs.facets) === JSON.stringify({ total: 120, doc: 40, app: 40, other: 40 }),
      docs.facets,
    )
    check(
      "S13-3: a tab's page holds only that tab's files",
      docs.artifacts.every((group) => group.files.every((file) => file.path.endsWith(".md"))) &&
        other.artifacts.every((group) => group.files.every((file) => file.path.endsWith(".ts"))) &&
        docs.artifacts.flatMap((group) => group.files).length === 40,
    )
    const searched = await artifacts.list({ query: "f1", category: "app" })
    check(
      "S13-3: a search's counts are of what it matches",
      JSON.stringify(searched.facets) === JSON.stringify({ total: 30, doc: 10, app: 10, other: 10 }) && searched.artifacts.flatMap((group) => group.files).length === 10,
      searched.facets,
    )

    // A listing with nothing changed reads no conversation at all.
    reads = 0
    const quiet = [await artifacts.answer(await store.list(), messagesOf), await artifacts.answer(await store.list(), messagesOf, { query: "f2" })]
    check(
      "S13-3: a listing with nothing changed reads no transcript and starts no pass",
      reads === 0 && quiet.every((answer) => !answer.building) && !artifacts.building,
      { reads, building: quiet.map((answer) => answer.building) },
    )

    // One conversation written to: that one is read before the answer, and the new file is in it.
    await fs.writeFile(path.join(directory, "late.md"), "x", "utf8")
    await wrote(ids[3]!, "msg_90000000", "late.md", 90_000)
    reads = 0
    const withLate = await artifacts.answer(await store.list(), messagesOf)
    check(
      "S13-3: a conversation written since is read again, only it, and its new file is there at once",
      reads === 1 && withLate.building === false && withLate.artifacts[0]?.files.some((file) => file.path === "late.md") === true,
      { reads, first: withLate.artifacts[0]?.files.map((file) => file.path) },
    )
    // A renamed conversation changes its checkpoint too.
    await store.update(ids[5]!, { title: "Renamed conversation" })
    reads = 0
    await artifacts.answer(await store.list(), messagesOf)
    check("S13-3: a renamed conversation is read again, and only it", reads === 1, reads)

    // Only the page's files are asked about: one gone from a later page is not noticed until the full check.
    const deep = seen[110]!
    await fs.rm(path.join(directory, deep), { force: true })
    const before = (await artifacts.list()).facets.total
    check("S13-3: a listing does not ask the disk about files off its page", before === 121, before)
    await artifacts.recheck()
    check("S13-3: the full check at launch does", (await artifacts.list()).facets.total === 120, (await artifacts.list()).facets.total)
    // One gone from the first page is passed over, and the page is filled from the next.
    const top = (await artifacts.list()).artifacts.flatMap((group) => group.files).sort((a, b) => b.at - a.at)[0]!.path
    await fs.rm(path.join(directory, top), { force: true })
    const refilled = (await artifacts.list()).artifacts.flatMap((group) => group.files)
    check(
      "S13-3: a file found gone on the page is left out and the page is still fifty",
      refilled.length === ARTIFACT_LIST_LIMIT && !refilled.some((file) => file.path === top) && refilled.every((file) => file.exists),
      [refilled.length, top],
    )

    // A handful of changed conversations is read before the answer; more than that is left to the background.
    for (const id of ids.slice(0, INLINE_RECONCILE)) artifacts.touched(id)
    reads = 0
    const few = await artifacts.answer(await store.list(), messagesOf)
    check(`S13-3: up to ${INLINE_RECONCILE} changed conversations are read before the answer`, reads === INLINE_RECONCILE && few.building === false, { reads, building: few.building })
    for (const id of ids.slice(0, INLINE_RECONCILE + 1)) artifacts.touched(id)
    reads = 0
    const many = await artifacts.answer(await store.list(), messagesOf)
    check("S13-3: more are read in the background, and the answer says so", many.building === true && reads < INLINE_RECONCILE + 1, { reads, building: many.building })
    await until(() => !artifacts.building)
    unwatch()
    await artifacts.close()

    // The window's side of it.
    const handlers = await read("src/server/handlers.ts")
    const listCase = handlers.slice(handlers.indexOf('case "artifact.list"'), handlers.indexOf('case "session.create"'))
    check(
      "S13-3: artifact.list answers through the store's paged answer, not a pass over everything",
      /runtime\.artifacts\.answer\(/.test(listCase) && !/runtime\.artifacts\.reconcile\(/.test(listCase) && /cursor:/.test(listCase) && /nextCursor/.test(listCase),
      listCase.slice(0, 600),
    )
    const server = await read("src/server/index.ts")
    check(
      "S13-3: a conversation's files are read again once its writes pause, and the launch pass alone re-checks every file",
      /setTimeout\(\(\) => \{[\s\S]{0,200}artifacts\.reconcile\(listed/.test(server) && /ARTIFACT_SETTLE_MS/.test(server) && /reconcile\([^\n]*\{ recheck: true \}\)/.test(server),
    )
    const page = await read("src/renderer/src/components/ArtifactsView.vue")
    check(
      "S13-3: the page asks for fifty at a time and the next page where the last ended, on scroll or the button",
      /limit: ARTIFACT_PAGE/.test(page) && /\{ \.\.\.asking\(\), cursor \}/.test(page) && /@scroll\.passive="onScroll"/.test(page) && /v-if="!failed && nextCursor"/.test(page),
    )
    check("S13-3: the page's counts are the server's, and the tab is asked of the server", /facets\.value\.total/.test(page) && /category: kind\.value/.test(page) && /watch\(\[needle, kind\]/.test(page))
    check("S13-3: while the store is still being filled, the page shows what is ready and asks again", /watch\(building/.test(page) && /BUILDING_REFRESH_MS/.test(page))
    const overlay = await read("src/renderer/src/components/SearchOverlay.vue")
    check(
      "S13-3: the search overlay asks for fifty files and more as its results are scrolled",
      /type: "artifact\.list", query: needle, limit: RECENT \}/.test(overlay) && /limit: RECENT, cursor \}/.test(overlay) && /@scroll\.passive="onResultsScroll"/.test(overlay),
    )
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
