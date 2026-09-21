/**
 * A deleted conversation's artifacts leave the list, as MiMo's delete takes
 * them (the user's 2026-09-22 call): version 2 kept them unlinked, and 进入对话
 * on one answered that the conversation could not be found.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { ArtifactStore, identityKey } from "../src/server/artifact/store"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function artifactForgetChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Artifacts: a deleted conversation's files leave the list (MiMo's delete)")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-artifact-forget-"))
  try {
    const file = path.join(root, "artifacts.db")
    const seed = await ArtifactStore.open(file)
    await seed?.close()
    // A version-2 store as a delete left it: one file only a gone conversation wrote, one a live one wrote too.
    const { DatabaseSync } = await import("node:sqlite")
    const raw = new DatabaseSync(file)
    const now = Date.now()
    const row = raw.prepare(
      "INSERT INTO artifact (identity_key, session_id, session_title, path, absolute, produced_at, updated_at, title, title_search) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    const source = raw.prepare("INSERT INTO artifact_source (source_key, artifact_id, session_id, session_title, path, produced_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    const orphan = Number(row.run(identityKey(path.join(root, "orphan.ts")), "", "Gone", "orphan.ts", path.join(root, "orphan.ts"), now, now, "orphan.ts", "orphan.ts").lastInsertRowid)
    source.run("s-orphan", orphan, "", "Gone", "orphan.ts", now, now)
    const shared = Number(row.run(identityKey(path.join(root, "shared.ts")), "ses_live", "Live", "shared.ts", path.join(root, "shared.ts"), now, now, "shared.ts", "shared.ts").lastInsertRowid)
    source.run("s-shared-live", shared, "ses_live", "Live", "shared.ts", now, now)
    source.run("s-shared-gone", shared, "", "Gone", "shared.ts", now - 1, now)
    const vanished = Number(row.run(identityKey(path.join(root, "vanished.ts")), "ses_vanished", "Vanished", "vanished.ts", path.join(root, "vanished.ts"), now, now, "vanished.ts", "vanished.ts").lastInsertRowid)
    source.run("s-vanished", vanished, "ses_vanished", "Vanished", "vanished.ts", now, now)
    const broken = Number(row.run(identityKey(path.join(root, "broken.ts")), "ses_broken", "Broken", "broken.ts", path.join(root, "broken.ts"), now, now, "broken.ts", "broken.ts").lastInsertRowid)
    source.run("s-broken", broken, "ses_broken", "Broken", "broken.ts", now, now)
    raw.prepare("DELETE FROM schema_migrations WHERE version > 2").run()
    raw.close()

    const store = (await ArtifactStore.open(file))!
    const left = async () => (await store.sourcesOf(path.join(root, "shared.ts"))).map((entry) => entry.sessionID)
    check("opening a version-2 store drops the sources a delete left unlinked, and the file only they held", (await store.count()) === 3 && (await store.sourcesOf(path.join(root, "orphan.ts"))).length === 0, await store.count())
    check("a file a live conversation also wrote stays, under that one only", JSON.stringify(await left()) === '["ses_live"]', await left())

    const forgotten = await store.forgetMissing(new Set(["ses_live", "ses_broken"]))
    check("forgetMissing drops a conversation that is gone without a word", forgotten === 1 && (await store.sourcesOf(path.join(root, "vanished.ts"))).length === 0, forgotten)
    check("and keeps one that is still there but would not read (L12-11)", (await store.sourcesOf(path.join(root, "broken.ts"))).length === 1 && (await store.count()) === 2)

    await store.detach("ses_live")
    check("detach deletes the conversation's sources rather than unlinking them", (await store.count()) === 1 && (await left()).length === 0)
    await store.close()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }

  const backend = await read("src/server/index.ts")
  check("the start-up housekeeping forgets vanished conversations, counting the unreadable as present", /artifacts\?\.forgetMissing\(new Set\(\[\.\.\.\(await sessions\.list\(\)\)\.map\(\(session\) => session\.id\), \.\.\.\(await sessions\.unreadable\(\)\)\]\)\)/.test(backend))
}
