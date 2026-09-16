/**
 * Round 6: the failures and edge cases audited on 2026-09-16 (F1 onwards).
 *
 * Kept apart from smoke.ts the way rounds five and six are, and called with its
 * check and section. Nothing here calls a model or reaches the network; the git
 * these checks drive is the one already on the machine, in a folder of its own.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { Snapshots } from "../src/server/session/snapshot"
import type { Check } from "./smoke-round5"

/** A project git will record, with the files a turn is about to change. */
async function project(root: string, name: string, files: Record<string, string>): Promise<string> {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(directory, file), content, "utf8")
  execFileSync("git", ["init", "-q"], { cwd: directory })
  return directory
}

const names = (files: { path: string }[]) => files.map((file) => path.basename(file.path)).sort()

export async function failureChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r6-failures-"))

  // ------------------------------------------------------------------- F1
  section("Round 6 (F1): a turn's undo holds only what that turn changed")
  {
    const directory = await project(root, "shared", { "a.txt": "a0", "b.txt": "b0", "c.txt": "c0" })
    const snapshots = new Snapshots(path.join(root, "store"))
    const at = (file: string) => path.join(directory, file)

    /*
     * Two conversations mid-turn in one project. Before this the recorder
     * photographed the whole project at the start and the end of each turn, so
     * either turn's undo would have written back the other's file as well - and
     * reported a file count that looked like a clean rollback.
     */
    const first = snapshots.begin(directory)
    await first.ready()
    const second = snapshots.begin(directory)
    await second.ready()
    await fs.writeFile(at("a.txt"), "a1", "utf8")
    first.claim(at("a.txt"))
    await fs.writeFile(at("b.txt"), "b1", "utf8")
    second.claim(at("b.txt"))
    const one = await first.finish()
    const two = await second.finish()
    check("a turn records the file its own tool wrote", names(one.files).join(",") === "a.txt", one)
    check("and not the file the other conversation wrote at the same time", one.files.length === 1, names(one.files))
    check("the other conversation's turn records its own file too", names(two.files).join(",") === "b.txt", two)
    check("what each turn recorded is the state it opened on", one.files[0]?.content === "a0" && two.files[0]?.content === "b0", [one.files[0], two.files[0]])

    /* A change while both were watching that neither tool named: refused, not guessed at. */
    const third = snapshots.begin(directory)
    await third.ready()
    const fourth = snapshots.begin(directory)
    await fourth.ready()
    third.opaque()
    fourth.opaque()
    await fs.writeFile(at("c.txt"), "c1", "utf8")
    const contested = await third.finish()
    await fourth.finish()
    check("a change neither conversation can account for is refused rather than claimed", Boolean(contested.refused) && contested.files.length === 0, contested)
    check("the refusal says another conversation was writing", (contested.refused ?? "").includes("Another conversation"), contested.refused)

    /* One turn alone in the project still records everything, shell commands included. */
    const alone = snapshots.begin(directory)
    await alone.ready()
    alone.opaque()
    await fs.writeFile(at("a.txt"), "a2", "utf8")
    const solo = await alone.finish()
    check("a turn with the project to itself still records what nothing reported", names(solo.files).join(",") === "a.txt" && !solo.refused, solo)
  }

  // ------------------------------------------------------------------- F1
  section("Round 6 (F1): undo refuses once another conversation has written the same file")
  {
    const store = path.join(root, "ledger")
    const snapshots = new Snapshots(store)
    const directory = path.join(root, "ledger-project")
    const file = path.join(directory, "shared.txt")

    await snapshots.wrote(directory, "ses_a", 1000, [file])
    check("a conversation's own write is never in its own way", (await snapshots.writtenSince(directory, "ses_a", 900, [file])).length === 0)
    await snapshots.wrote(directory, "ses_b", 2000, [file])
    check("another conversation writing since the turn is named", (await snapshots.writtenSince(directory, "ses_a", 1000, [file]))[0] === file)
    check("a write that came before the turn does not stand in its way", (await snapshots.writtenSince(directory, "ses_a", 3000, [file])).length === 0)
    check("a file nobody else touched is still restorable", (await snapshots.writtenSince(directory, "ses_a", 1000, [path.join(directory, "other.txt")])).length === 0)
    /* Written where the shadow repositories live, so the refusal survives a restart. */
    check("the ledger is read back after a restart", (await new Snapshots(store).writtenSince(directory, "ses_a", 1000, [file]))[0] === file)
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
