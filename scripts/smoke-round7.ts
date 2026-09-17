/**
 * Round 7: the failures audited as F14-F42 that this pass closed.
 *
 * Kept apart from smoke.ts the way rounds five and six are, and called with its
 * check and section. Nothing here calls a model or reaches the network: the
 * only git driven is the one already on the machine, in a folder of its own,
 * and the one push attempted is refused before it can reach a remote.
 *
 * Round 7: what the model actually receives, measured against MiMo's engine.
 *
 * Kept apart from smoke.ts the way rounds 5 and 6 are; smoke.ts calls
 * `roundSevenChecks` with its own check and section. The pure rules are checked
 * directly, and the ones that only matter on the wire are read back out of the
 * fake provider's own request bodies - a trimmed result is only trimmed if the
 * provider saw it trimmed.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import { Storage, tempNameFor, writeAtomic } from "../src/server/storage"
import { CodedError, codeOf, diskErrorCode } from "../src/shared/errors"
import { Config, CONFIG_SCHEMA_VERSION } from "../src/server/config"
import { SessionStore } from "../src/server/session/store"
import { IndexDatabase } from "../src/server/history/database"
import { OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES, PRESSURE_MAX_BYTES, PRESSURE_MAX_LINES, ToolOutputs } from "../src/server/tool/truncate"
import { OUTPUT_PRESSURE_RATIO, underPressure } from "../src/server/session/overflow"
import { statFailure } from "../src/server/tool/read"
import { BashTool, INTERACTIVE_REFUSAL } from "../src/server/tool/bash"
import type { ToolContext } from "../src/server/tool/types"
import { push } from "../src/server/git"
import { isHtmlBody } from "../src/server/provider/types"
import { describeHttp } from "../src/server/provider/openai"
import { MEDIA_LIMIT, rankFileHit, readPreview, searchFolder } from "../src/server/handlers"
import { SKILL_BODY_MAX, discoverSkills } from "../src/server/skill"
import { MAX_BYTES, THUMBNAIL_MAX } from "../src/renderer/src/lib/attach"
import { RETRY_BUDGETS, withRequestRetry } from "../src/server/session/retry"
import { failureCode } from "../src/server/session/error-map"
import { ANTHROPIC_IMAGE_PIXELS, imageFit } from "../src/server/provider/attachment-parts"

/** A PNG's first bytes, with the width and height it declares - enough for `imageSize` to read. */
function pngHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(33)
  bytes[0] = 0x89
  bytes.write("PNG\r\n\n", 1, "latin1")
  bytes.write("IHDR", 12, "latin1")
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString("base64")
}

/** Names of the files left in a folder, so a stray temp file can be seen. */
async function namesIn(directory: string): Promise<string[]> {
  return fs.readdir(directory).catch(() => [] as string[])
}

export async function roundSevenChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-round7-"))

  // ------------------------------------------------------------------ F14
  section("Round 7 (F14): an oversized picture is measured before it is sent")
  {
    /*
     * Round six added the fitting itself (`image-shrink.ts` behind the
     * `ImageShrinker` hook). What is checked here is the half that decides
     * whether it runs at all, since that is what the audit found missing: a
     * picture past the cap has to be recognised as past it.
     */
    const huge = imageFit("image/png", pngHeader(20_000, 20_000))
    check("a 20000px picture is measured as needing to be made smaller", huge?.maxPixels === ANTHROPIC_IMAGE_PIXELS, huge)
    const strip = imageFit("image/png", pngHeader(1, 30_000))
    check("so is a long thin one, which is the shape that used to slip through", strip !== undefined, strip)
    check("an ordinary picture is left exactly as it was", imageFit("image/png", pngHeader(800, 600)) === undefined)
    check("and something that is not a picture is never fitted", imageFit("text/plain", pngHeader(20_000, 20_000)) === undefined)
  }

  // ------------------------------------------------------------------ F15
  section("Round 7 (F15): tool output is capped tighter when the context is tight")
  {
    const outputs = new ToolOutputs(path.join(root, "outputs"))
    const long = Array.from({ length: 1500 }, (_, index) => `line ${index}`).join("\n")

    const easy = await outputs.cap(long, {})
    check("1,500 lines pass whole when there is room", !easy.truncated, easy.text.length)
    const tight = await outputs.cap(long, { pressure: true })
    check("...and are cut once the conversation is near its line", tight.truncated)
    check("the pressed caps are half of the ordinary ones", PRESSURE_MAX_LINES === OUTPUT_MAX_LINES / 2 && PRESSURE_MAX_BYTES === OUTPUT_MAX_BYTES / 2)

    const enormous = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n")
    const said = await outputs.cap(enormous, { outcome: "success" })
    check("a cut output says the call succeeded", said.text.includes("The tool call succeeded"), said.text.slice(-260))
    const failed = await outputs.cap(enormous, { outcome: "failure" })
    check("...and says so when it did not", failed.text.includes("The tool call failed"), failed.text.slice(-260))
    const quiet = await outputs.cap(enormous, {})
    check("with neither claimed when the caller did not say", !quiet.text.includes("The tool call"), quiet.text.slice(-260))
    check("a bare true still means delegate, as every old call site meant", (await outputs.cap(enormous, true)).text.includes("explore subagent"))

    const window = { contextWindow: 100_000 }
    const spent = (total: number) => ({ input: total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    // usable is 90% of the window, and pressure is 70% of that: 63,000 tokens.
    check("a conversation barely started is not under pressure", !underPressure(spent(10_000), window))
    check("one at seven tenths of its usable room is", underPressure(spent(64_000), window), OUTPUT_PRESSURE_RATIO)
    check("a model whose window is unknown never counts as pressed", !underPressure(spent(999_999), undefined))
  }

  // ------------------------------------------------------------------ F22
  section("Round 7 (F22): a file that may not be read is not called missing")
  {
    check("a refused read is told apart", statFailure("EACCES") === "denied")
    check("...on Windows too", statFailure("EPERM") === "denied")
    check("a file that is genuinely absent still reads as absent", statFailure("ENOENT") === "missing")
    check("and anything unrecognised is treated as absent, as before", statFailure(undefined) === "missing")
  }

  // ------------------------------------------------------------------ F24
  section("Round 7 (F24): a proxy's web page is never poured into the card")
  {
    const page = '<!DOCTYPE html><html><head><title>407 Proxy Authentication Required</title></head><body>go away</body></html>'
    check("an HTML body is recognised", isHtmlBody(page))
    check("...however it is capitalised, and with leading space", isHtmlBody("\n  <HTML><body>x</body></HTML>"))
    check("a JSON body is not", !isHtmlBody('{"error":{"message":"nope"}}'))
    const said = describeHttp(407, page)
    check("a 407 page becomes a sentence, not tag soup", !said.includes("<") && said.includes("gateway or proxy"), said)
    check("a 401 page is blamed on the gateway, not on the key", describeHttp(401, page).includes("gateway or proxy"), describeHttp(401, page))
    check("a real 401 from the provider still blames the key", describeHttp(401, '{"error":"bad key"}').includes("API key"))
    check("a JSON body is still passed through", describeHttp(400, '{"error":"bad model"}').includes("bad model"))
    check("the gateway sentence is coded for the window to phrase", failureCode(new Error(said))?.code === "error.gatewayBlocked")
  }

  // ------------------------------------------------------------------ F20
  section("Round 7 (F20): failures MiMo names, named here too")
  {
    check("a stall becomes a timeout rather than raw English", failureCode(new Error("The provider sent no response for 300s: stream timeout"))?.code === "error.modelTimeout")
    check("...for a stream that went quiet mid-answer", failureCode(new Error("The provider stopped sending for 480s: stream timeout"))?.code === "error.modelTimeout")
    check("a full disk is named", diskErrorCode({ code: "ENOSPC" }) === "error.diskFull")
    check("a quota is the same failure", diskErrorCode({ code: "EDQUOT" }) === "error.diskFull")
    check("a data folder that may not be written is named", diskErrorCode({ code: "EROFS" }) === "error.databaseReadonly")
    check("...and so is one this process is refused", diskErrorCode({ code: "EACCES" }) === "error.databaseReadonly")
    check("an ordinary failure is left unnamed", diskErrorCode({ code: "ENOENT" }) === undefined)
    check("a coded failure carries its code out to the socket", codeOf(new CodedError("x", "error.sessionBusy")) === "error.sessionBusy")
    check("...and a plain error carries none", codeOf(new Error("x")) === undefined)
  }

  // ------------------------------------------------------------------ F26
  section("Round 7 (F26): an interactive command is answered, not waited on")
  {
    const context = {
      sessionID: "ses_i",
      messageID: "msg_1",
      callID: "call_1",
      directory: root,
      permissions: { ask: async () => undefined },
      questions: { ask: async () => undefined },
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => undefined,
    } as unknown as ToolContext

    const at = Date.now()
    const answer = await BashTool.execute({ command: "sudo apt install something", interactive: true }, context)
    const took = Date.now() - at
    check("it comes back at once rather than after two minutes", took < 2000, took)
    check("the model is told there is no terminal to hand over", answer.output === INTERACTIVE_REFUSAL, answer.output)
    check("and told what to do instead", INTERACTIVE_REFUSAL.includes("--yes") && INTERACTIVE_REFUSAL.includes("pipe"))
    check("it is recorded as a command that failed", answer.metadata?.exit === 1, answer.metadata)
    check("and nothing was run", answer.metadata?.interactive === true)
  }

  // ------------------------------------------------------------------ F27
  section("Round 7 (F27): a detached HEAD answers with a code, not English")
  {
    const repo = path.join(root, "detached")
    await fs.mkdir(repo, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: repo })
    execFileSync("git", ["config", "user.email", "probe@example.invalid"], { cwd: repo })
    execFileSync("git", ["config", "user.name", "Probe"], { cwd: repo })
    await fs.writeFile(path.join(repo, "a.txt"), "a\n")
    execFileSync("git", ["add", "-A"], { cwd: repo })
    execFileSync("git", ["commit", "-qm", "first"], { cwd: repo })
    execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: repo })

    const result = await push(repo)
    check("pushing off a branch is refused", !result.ok)
    check("...with a code the window can phrase", result.code === "detached", result)
    check("and no English sentence smuggled out in its place", result.error === undefined, result)
  }

  // ------------------------------------------------------------------ F29
  section("Round 7 (F29): a config from a newer build is read but never written over")
  {
    const newer = path.join(root, "newer", "storage")
    await fs.mkdir(newer, { recursive: true })
    await fs.writeFile(
      path.join(newer, "config.json"),
      JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION + 5, theme: "dark", somethingFromTheFuture: true }),
    )
    const config = new Config(new Storage(newer), new Bus(), path.join(root, "newer", "credentials.json"))
    await config.load()
    check("the newer document is noticed", config.fromNewerVersion)
    check("...and still read, so the app is usable", config.get().theme === "dark")
    const refused = await config.set({ theme: "light" }).then(
      () => undefined,
      (err: unknown) => err,
    )
    check("saving over it is refused", refused !== undefined)
    check("...saying why, in a word the window can phrase", codeOf(refused) === "error.configNewer", String(refused))
    const onDisk = JSON.parse(await fs.readFile(path.join(newer, "config.json"), "utf8"))
    check("and the newer build's own fields are still there", onDisk.somethingFromTheFuture === true, onDisk)
    /*
     * The version on disk is what actually proves nothing was written: the
     * spread would have carried the unknown field through a write too, so that
     * check alone passed even with the guard removed.
     */
    check("...with the document still stamped by the build that wrote it", onDisk.schemaVersion === CONFIG_SCHEMA_VERSION + 5, onDisk.schemaVersion)

    const mine = path.join(root, "mine", "storage")
    await fs.mkdir(mine, { recursive: true })
    const ordinary = new Config(new Storage(mine), new Bus(), path.join(root, "mine", "credentials.json"))
    await ordinary.load()
    check("an ordinary profile is not mistaken for a newer one", !ordinary.fromNewerVersion)
    await ordinary.set({ theme: "dark" })
    const stamped = JSON.parse(await fs.readFile(path.join(mine, "config.json"), "utf8"))
    check("and what this build writes says which build wrote it", stamped.schemaVersion === CONFIG_SCHEMA_VERSION, stamped.schemaVersion)
  }

  // ------------------------------------------------------------------ F30
  section("Round 7 (F30): only a damaged index is thrown away, and it is kept")
  {
    const folder = path.join(root, "index")
    await fs.mkdir(folder, { recursive: true })
    const file = path.join(folder, "history.db")
    await fs.writeFile(file, "this is emphatically not a database")

    const database = IndexDatabase.open(file)
    check("a file that is not a database is started over", database.openedAs === "recreated", database.openedAs)
    database.close()
    const kept = (await namesIn(folder)).filter((name) => name.includes(".corrupt-"))
    check("...and the unreadable one is kept rather than deleted", kept.length === 1, await namesIn(folder))

    const again = IndexDatabase.open(file)
    check("the index that replaced it works", again.openedAs === "existing" || again.openedAs === "recreated")
    again.close()
  }

  // ------------------------------------------------------- F31, F32, F34
  section("Round 7 (F31, F32, F34): writing a document near MAX_PATH, and failing to")
  {
    /*
     * A target long enough that the old temp name - the whole path plus
     * ".<pid>.<n>.tmp" - would have run past what Windows accepts, while the
     * document itself fits perfectly well.
     */
    const deep = path.join(root, "deep")
    await fs.mkdir(deep, { recursive: true })
    const room = Math.max(8, 250 - deep.length - 1)
    const target = path.join(deep, `${"n".repeat(room)}.json`)
    /*
     * Checked as a property of the name rather than by writing one and seeing
     * whether Windows objects: this machine's Node accepts paths past 260, so
     * a write-and-see check here passed whatever the name looked like - it
     * could not have failed, which is worse than not having it.
     */
    const temp = tempNameFor(target)
    check("the temp file is never longer than the document it stands in for", temp.length <= target.length, { temp: temp.length, target: target.length })
    check("...while still being a different file", temp !== target && temp.endsWith(".tmp"), temp.slice(-40))
    const short = path.join(root, "s.json")
    check("a path with room to spare keeps the readable appended form", tempNameFor(short).startsWith(`${short}.`), tempNameFor(short))

    const written = await writeAtomic(target, JSON.stringify({ ok: true })).then(
      () => undefined,
      (err: unknown) => err,
    )
    check("a document whose own path is near the limit is saved", written === undefined, String(written))
    check("...and reads back as what was written", JSON.parse(await fs.readFile(target, "utf8")).ok === true)
    check("with no temp file left beside it", (await namesIn(deep)).every((name) => !name.endsWith(".tmp")), await namesIn(deep))

    /* A write that cannot finish: the target is a folder, so the rename fails. */
    const blocked = path.join(root, "blocked")
    await fs.mkdir(path.join(blocked, "taken.json"), { recursive: true })
    const failure = await writeAtomic(path.join(blocked, "taken.json"), "{}").then(
      () => undefined,
      (err: unknown) => err,
    )
    check("a write that cannot finish fails rather than half-writing", failure !== undefined)
    check("...and clears up after itself", (await namesIn(blocked)).every((name) => !name.endsWith(".tmp")), await namesIn(blocked))
  }

  // ------------------------------------------------------------------ F33
  section("Round 7 (F33): a damaged history costs the undo, not the conversation")
  {
    const storageRoot = path.join(root, "history-store")
    const storage = new Storage(storageRoot)
    const store = new SessionStore(storage, new Bus())
    const session = await store.create({ directory: root, model: { provider: "probe", model: "stub" } })
    await fs.writeFile(storage.fileOf(`session/${session.id}/history`), "{ not json at all")

    const depth = await store.historyDepth(session.id).then(
      (value) => value,
      () => undefined,
    )
    check("asking how deep the stacks are answers instead of throwing", depth !== undefined, depth)
    check("...with nothing to take back", depth?.undo === 0 && depth?.redo === 0, depth)
    const folder = path.join(storageRoot, "session", session.id)
    check("and the damaged file is kept rather than written over", (await namesIn(folder)).some((name) => name.includes(".corrupt-")), await namesIn(folder))
  }

  // ------------------------------------------------------------------ F37
  section("Round 7 (F37): two writers of one record do not eat each other's fields")
  {
    const storage = new Storage(path.join(root, "race-store"))
    const store = new SessionStore(storage, new Bus())
    const session = await store.create({ directory: root, model: { provider: "probe", model: "stub" } })

    /*
     * Exactly the pair that raced on a conversation's first turn: the title
     * written in the background, and the first step's usage. Each read the
     * record before the other wrote, so whichever landed second carried a copy
     * without the other's field.
     */
    await Promise.all([
      store.update(session.id, { title: "Named in the background" }),
      store.addUsage(session.id, { input: 11, output: 22, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 }),
    ])

    const after = await store.get(session.id)
    check("the title survives", after?.title === "Named in the background", after?.title)
    check("and so does the usage written at the same moment", after?.usage.input === 11 && after?.usage.output === 22, after?.usage)
    check("with the cost counted once, not twice or never", after?.usage.cost === 0.5, after?.usage.cost)
  }

  // ------------------------------------------------------------------ F25
  section("Round 7 (F25): a file too large to preview says so")
  {
    const folder = path.join(root, "media")
    await fs.mkdir(folder, { recursive: true })
    const big = path.join(folder, "huge.pdf")
    const handle = await fs.open(big, "w")
    // Made by length rather than by writing the bytes: the size is all that is read.
    await handle.truncate(MEDIA_LIMIT + 1_000)
    await handle.close()
    const refused = await readPreview(big)
    check("an oversized PDF is answered as too large", refused.tooBig === true, refused)
    check("...and keeps its own kind rather than being called binary", refused.kind === "pdf", refused.kind)

    const small = path.join(folder, "small.png")
    await fs.writeFile(small, Buffer.from(pngHeader(4, 4), "base64"))
    const fine = await readPreview(small)
    check("an ordinary picture is not refused", fine.tooBig === undefined, fine)
    check("one figure covers every kind, as MiMo has one", MEDIA_LIMIT === 25_000_000, MEDIA_LIMIT)
  }

  // ------------------------------------------------------------------ F38
  section("Round 7 (F38): the @ picker stops at the same depth as the files tab")
  {
    const project = path.join(root, "deep-project")
    let here = project
    for (let level = 0; level < 20; level++) {
      here = path.join(here, `level${level}`)
      await fs.mkdir(here, { recursive: true })
      await fs.writeFile(path.join(here, `needle${level}.txt`), "x")
    }

    const found = await searchFolder(project, "needle")
    const depths = found.entries.map((entry) => entry.rel.split("/").length - 1)
    check("files within the depth are found", found.entries.length > 0, found.entries.length)
    check("...and nothing deeper than sixteen folders is walked into", Math.max(...depths) <= 16, depths)
    check("a shallow file is still found first", found.entries[0]?.rel.includes("level0"), found.entries[0])
  }

  // ----------------------------------------------------------------- C11-38
  section("Round 11 (C11-38): the @ picker searches the whole project, ranked as MiMo ranks it")
  {
    const rank = (rel: string, query: string) => rankFileHit(rel, query)
    check("a name typed whole beats one that starts with it, which beats one that merely holds it", (rank("a/x.ts", "x.ts") ?? 0) > (rank("a/x.tsx", "x.ts") ?? 0) && (rank("a/x.tsx", "x.ts") ?? 0) > (rank("a/ax.tsx", "x.ts") ?? 0))
    check("a longer path is docked a little", (rank("x.ts", "x.ts") ?? 0) > (rank("a/b/c/d/e/x.ts", "x.ts") ?? 0))
    check("a name that does not hold the query is no match", rank("a/y.ts", "x.ts") === undefined)
    check("a query with a slash is matched along the folders", (rank("src/components/Composer.vue", "comp/composer") ?? 0) > 500)
    check("...in order, so a folder named after the file does not count backwards", rank("components/src/Composer.vue", "src/composer") !== undefined && rank("src/components/Composer.vue", "components/src") === undefined)
    check("...and every piece has to be somewhere", rank("src/components/Composer.vue", "lib/composer") === undefined)

    const project = path.join(root, "at-search")
    await fs.mkdir(path.join(project, "src", "renderer", "components"), { recursive: true })
    await fs.mkdir(path.join(project, "node_modules", "pkg"), { recursive: true })
    await fs.writeFile(path.join(project, "src", "renderer", "components", "Composer.vue"), "x")
    await fs.writeFile(path.join(project, "src", "composer-text.ts"), "x")
    await fs.writeFile(path.join(project, "node_modules", "pkg", "Composer.vue"), "x")
    await fs.writeFile(path.join(project, ".gitignore"), "x")
    await fs.writeFile(path.join(project, "a-compo.ts"), "x")
    const hits = await searchFolder(project, "Compo")
    check("a name that starts with the query outranks one that merely holds it, however the two sort", hits.entries.at(-1)?.rel === "a-compo.ts" && hits.entries.length === 3, hits.entries.map((entry) => entry.rel))
    const slashed = await searchFolder(project, "src/composer")
    check("a query with a slash is matched along the folders, not as a substring of the path", slashed.entries.some((entry) => entry.rel === "src/renderer/components/Composer.vue"), slashed.entries)
    check("a file folders deep is found from the project root", hits.entries.some((entry) => entry.rel === "src/renderer/components/Composer.vue"), hits.entries)
    check("each row carries the folder it sits in", hits.entries.find((entry) => entry.name === "Composer.vue")?.dir === "src/renderer/components")
    check("node_modules is left out", !hits.entries.some((entry) => entry.rel.startsWith("node_modules/")), hits.entries)
    check("nothing but files comes back", hits.entries.every((entry) => !entry.rel.endsWith("/")))
    // MiMo leaves hidden entries in: a project is made of .gitignore and .github as much as of src.
    check("a hidden file is findable", (await searchFolder(project, "gitignore")).entries.some((entry) => entry.name === ".gitignore"))
    const inSub = await searchFolder(project, "Compo", "src")
    check("searching inside a folder still names each file from the project root", inSub.entries.every((entry) => entry.rel.startsWith("src/")) && inSub.entries.length > 0, inSub.entries)
  }

  // ------------------------------------------------------------------ F39
  section("Round 7 (F39): a large paste is taken, as MiMo takes one")
  {
    check("what travels as data may weigh what MiMo's engine allows", MAX_BYTES === 50 * 1024 * 1024, MAX_BYTES)
    check("a 12 MB paste is no longer refused", 12 * 1024 * 1024 < MAX_BYTES)
    check("and a picture still carries its bytes only when small enough to draw", THUMBNAIL_MAX === 8 * 1024 * 1024, THUMBNAIL_MAX)
  }

  // ------------------------------------------------------------------ F40
  section("Round 7 (F40): a SKILL.md cannot spend the whole context")
  {
    const skills = path.join(root, "skill-project", ".mcode", "skills", "enormous")
    await fs.mkdir(skills, { recursive: true })
    /*
     * Written to a fixed length, and compared against a fixed one.
     *
     * Sizing the body as `SKILL_BODY_MAX + 5_000` made the fixture move with
     * the constant under test: raising the cap raised the body with it and the
     * check stayed green, so it could not have caught a cap set wrongly.
     */
    const body = "x".repeat(205_000)
    await fs.writeFile(path.join(skills, "SKILL.md"), `---\nname: enormous\ndescription: A skill with far too much in it\n---\n${body}`)

    const scan = await discoverSkills({ directory: path.join(root, "skill-project"), builtinRoot: null })
    const found = scan.skills.find((skill) => skill.name === "enormous")
    check("the skill still loads", found !== undefined, scan.skills.map((skill) => skill.name))
    check("the cap is MiMo's two hundred thousand characters", SKILL_BODY_MAX === 200_000, SKILL_BODY_MAX)
    check("...and a 205,000-character body is cut to it", found?.content.length === 200_000, found?.content.length)
    check("and marked as cut rather than passing for whole", found?.truncated === true)

    const ordinary = path.join(root, "skill-project", ".mcode", "skills", "ordinary")
    await fs.mkdir(ordinary, { recursive: true })
    await fs.writeFile(path.join(ordinary, "SKILL.md"), "---\nname: ordinary\ndescription: A normal skill\n---\nDo the thing.\n")
    const second = await discoverSkills({ directory: path.join(root, "skill-project"), builtinRoot: null })
    const normal = second.skills.find((skill) => skill.name === "ordinary")
    check("an ordinary skill is untouched", normal?.content.includes("Do the thing.") && normal?.truncated === undefined, normal?.truncated)
  }

  // ------------------------------------------------------------------ F42
  section("Round 7 (F42): a call that is not a turn has a budget of its own")
  {
    const budget = RETRY_BUDGETS.request
    check("MiMo's figures: four tries inside half a minute, starting at 200ms", budget.retries === 4 && budget.deadline === 30_000 && budget.initial === 200, budget)

    let tries = 0
    const gaveUp = await withRequestRetry(() => {
      tries++
      return Promise.reject(new Error("fetch failed"))
    }).then(
      () => undefined,
      (err: unknown) => err,
    )
    // Counted against a fixed five, not against the constant under test, which would move with it.
    check("a dropped connection is tried four more times", tries === 5, tries)
    check("...and then given up on rather than retried for ever", gaveUp !== undefined)

    let terminal = 0
    await withRequestRetry(() => {
      terminal++
      return Promise.reject(new Error("the model refused for a reason nobody retries"))
    }).catch(() => undefined)
    check("a failure nothing would fix is not repeated", terminal === 1, terminal)

    let once = 0
    const answered = await withRequestRetry(() => {
      once++
      return Promise.resolve("done")
    })
    check("and a call that works is made exactly once", once === 1 && answered === "done")
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)

  await roundSevenModelChecks(check, section)
}

import { Identifier } from "../src/shared/id"
// M2: the environment block, and what it now names.
import { systemPrompt } from "../src/server/session/prompt"
// M9: standing down the largest tool results before the summary request replays them.
import { COMPACTION_TOOL_RESULT_LIMIT, shrinkLargeToolResults } from "../src/server/session/summary"
// M3: the tool descriptions as the registry hands them to a provider.
import { findTool } from "../src/server/tool/registry"
import type { AssistantMessage, Message, ToolPart, UserMessage } from "../src/shared/protocol"
import type { Check } from "./smoke-round5"
import { calls, engine, say, wireText } from "./smoke-round5"
// M5: the local token estimate everything else sizes itself with.
import { CHARS_PER_TOKEN, estimateTokens, formatQuantity, parseQuantity } from "../src/server/session/estimate"
// M4: trimming what a turn re-sends.
import {
  DEFAULT_CACHE_TTL_MS,
  PRUNE_MINIMUM,
  PRUNE_PROTECT,
  SOFT_TRIM_KEEP_HEAD,
  SOFT_TRIM_KEEP_TAIL,
  SOFT_TRIM_THRESHOLD,
  isCacheCold,
  pressureLevel,
  pruneCandidates,
  pruneLevelFor,
  prunedHistory,
  softTrim,
} from "../src/server/session/prune"
import { contextCount } from "../src/server/session/overflow"
// M10: the per-provider body fields, and the wire they are written onto.
import { providerExtras, smallRequest } from "../src/server/provider/sampling"
import { OpenAICompatible } from "../src/server/provider/openai"

/** A finished tool call carrying `output`, as a completed step leaves one. */
function toolPart(name: string, output: string): ToolPart {
  return {
    type: "tool",
    id: Identifier.part(),
    callID: `call_${Identifier.part()}`,
    name,
    status: "completed",
    input: {},
    output,
    time: { created: 1, completed: 2 },
  }
}

function user(sessionID: string, text: string, at: number): UserMessage {
  return { id: Identifier.message(), sessionID, role: "user", text, attachments: [], time: { created: at } }
}

function assistant(sessionID: string, parts: AssistantMessage["parts"], at: number, input = 0): AssistantMessage {
  return {
    id: Identifier.message(),
    sessionID,
    role: "assistant",
    model: { provider: "fake", model: "m" },
    agent: "build",
    parts,
    finish: "end_turn",
    ...(input ? { usage: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } : {}),
    time: { created: at, completed: at },
  }
}

export async function roundSevenModelChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ------------------------------------------------------------------ M5
  section("Round 7 (M5): the local token estimate")
  {
    check("four characters to a token, as MiMo counts", CHARS_PER_TOKEN === 4)
    check("nothing is nothing", estimateTokens("") === 0 && estimateTokens(undefined) === 0)
    check("and it rounds rather than truncating", estimateTokens("abcdef") === 2, estimateTokens("abcdef"))
    check("a long string is its length over four", estimateTokens("x".repeat(4_000)) === 1_000)

    check("a plain number is taken as a count", parseQuantity(1234) === 1234)
    check("a negative or broken number is not a quantity", parseQuantity(-5) === undefined && parseQuantity(Number.NaN) === undefined)
    check("K is a thousand and M a million, as MiMo reads them", parseQuantity("40K") === 40_000 && parseQuantity("1.5M") === 1_500_000)
    check("a percentage needs something to be a percentage of", parseQuantity("20%") === undefined && parseQuantity("20%", 1_000) === 200)
    check("and an impossible percentage is refused", parseQuantity("0%", 100) === undefined && parseQuantity("120%", 100) === undefined)
    check("anything else is not a quantity", parseQuantity("soon") === undefined && parseQuantity("40KB") === undefined)
    check("a count reads back the way MiMo writes it", formatQuantity(40_000) === "40K" && formatQuantity(1_500_000) === "1.5M" && formatQuantity(12) === "12")
  }

  // ------------------------------------------------------------------ M4
  section("Round 7 (M4): pruning only runs on a cold cache, and only under pressure")
  {
    const now = 1_000_000_000
    check("a conversation with no reply yet counts as cold", isCacheCold(undefined, undefined, now))
    check("a reply a moment ago leaves the cache warm", !isCacheCold(now - 1_000, undefined, now))
    check(
      "past MiMo's five-minute default it is cold",
      isCacheCold(now - (DEFAULT_CACHE_TTL_MS + 1), undefined, now) && DEFAULT_CACHE_TTL_MS === 300_000,
    )
    check("a model asking for the hour-long cache stays warm far longer", !isCacheCold(now - 600_000, "1h", now))

    // usable = floor(10000 * 0.9) = 9000, so the bands fall at 4500 / 6300 / 7650.
    const entry = { contextWindow: 10_000 }
    const at = (input: number) => pressureLevel({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, entry)
    check("under half the usable window there is no pressure", at(4_000) === 0)
    check("past half, level 1", at(5_000) === 1)
    check("past 0.7, level 2", at(6_500) === 2)
    check("past 0.85, level 3", at(8_000) === 3)
    check(
      "a model whose window is unknown never reports pressure",
      pressureLevel({ input: 8_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, { contextWindow: 0 }) === 0,
    )
    check(
      "the count is the same five figures the overflow trigger adds up",
      contextCount({ input: 1, output: 2, reasoning: 4, cacheRead: 8, cacheWrite: 16 }) === 31,
    )

    const tokens = { input: 8_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    check(
      "a warm cache prunes nothing however full the window is",
      pruneLevelFor({ tokens, entry, lastAssistantAt: now - 1_000, now }) === 0,
    )
    check(
      "cold and half full soft-trims (level 1)",
      pruneLevelFor({ tokens: { ...tokens, input: 5_000 }, entry, lastAssistantAt: now - 600_000, now }) === 1,
    )
    check("cold and nearly full clears (level 2)", pruneLevelFor({ tokens, entry, lastAssistantAt: now - 600_000, now }) === 2)
  }

  section("Round 7 (M4): the soft trim keeps the head and the tail")
  {
    check("a short result is left exactly as it was", softTrim("hello") === "hello")
    const short = "y".repeat(SOFT_TRIM_THRESHOLD)
    check("and so is one right on the threshold", softTrim(short) === short)

    const long = "A".repeat(3_000) + "MIDDLE" + "B".repeat(3_000)
    const trimmed = softTrim(long)
    /*
     * Both halves assert the exact boundary, not merely "starts with 1,536 A's":
     * an untrimmed 3,000-A string satisfies that too, so the loose form passed
     * even with trimming switched off entirely.
     */
    check(
      "a long one keeps MiMo's first 1,536 characters and no more",
      trimmed.startsWith("A".repeat(SOFT_TRIM_KEEP_HEAD)) && !trimmed.startsWith("A".repeat(SOFT_TRIM_KEEP_HEAD + 1)),
    )
    check(
      "and its last 1,536, exactly",
      trimmed.endsWith("B".repeat(SOFT_TRIM_KEEP_TAIL)) && !trimmed.endsWith("B".repeat(SOFT_TRIM_KEEP_TAIL + 1)),
    )
    check("the middle is gone", !trimmed.includes("MIDDLE"))
    check("the note says how long the whole thing was", trimmed.includes(String(long.length)))
    check("and the result is shorter than what it replaced", trimmed.length < long.length)
  }

  section("Round 7 (M4): what may be pruned, and what is protected")
  {
    const s = "s1"
    const big = "x".repeat(PRUNE_PROTECT * CHARS_PER_TOKEN + 40_000)
    const history: Message[] = [
      user(s, "one", 1),
      assistant(s, [toolPart("bash", big)], 2),
      user(s, "two", 3),
      assistant(s, [toolPart("bash", "recent output")], 4),
      user(s, "three", 5),
    ]
    const found = pruneCandidates(history)
    check("the old result past the protected tail is a candidate", found.parts.length === 1 && found.parts[0]?.output === big, found.parts.length)
    check("and clearing it would reclaim its whole estimate", found.reclaimable === estimateTokens(big))

    const newest = pruneCandidates([user(s, "one", 1), assistant(s, [toolPart("bash", big)], 2), user(s, "two", 3)])
    check("the newest turn is never a candidate, however large", newest.parts.length === 0, newest.parts.length)

    const skill = pruneCandidates([
      user(s, "one", 1),
      assistant(s, [toolPart("skill", big)], 2),
      user(s, "two", 3),
      assistant(s, [toolPart("bash", "x")], 4),
      user(s, "three", 5),
    ])
    check("a loaded skill is never pruned, being instructions rather than output", skill.parts.length === 0, skill.parts.length)

    // Everything here fits inside the protected tail, so nothing is a candidate.
    const small = pruneCandidates([
      user(s, "one", 1),
      assistant(s, [toolPart("bash", "a".repeat(400))], 2),
      user(s, "two", 3),
      assistant(s, [toolPart("bash", "b")], 4),
      user(s, "three", 5),
    ])
    check("output inside the protected tail is left alone", small.parts.length === 0, small.parts.length)
  }

  section("Round 7 (M4): the two levels, and the floor under clearing")
  {
    const s = "s2"
    const big = "x".repeat(PRUNE_PROTECT * CHARS_PER_TOKEN + 200_000)
    /*
     * Five turns, because MiMo's strip keeps the newest three: the reasoning in
     * the first reply is only old enough to be stripped once four user messages
     * stand after it.
     */
    const build = (): Message[] => [
      user(s, "one", 1),
      assistant(s, [{ type: "reasoning", id: "r1", text: "old thinking", time: { created: 1 } }, toolPart("bash", big)], 2),
      user(s, "two", 3),
      assistant(s, [toolPart("bash", "second")], 4),
      user(s, "three", 5),
      assistant(s, [toolPart("bash", "third")], 6),
      user(s, "four", 7),
      assistant(s, [toolPart("bash", "recent")], 8),
      user(s, "five", 9),
    ]
    const newest = 7

    const original = build()
    const before = JSON.stringify(original)
    check("level 0 changes nothing at all", JSON.stringify(prunedHistory(original, 0)) === before)

    const one = prunedHistory(build(), 1)
    const oneOut = (one[1] as AssistantMessage).parts.find((p): p is ToolPart => p.type === "tool")?.output ?? ""
    check("level 1 soft-trims the old result", oneOut.length < big.length && oneOut.includes("left out the middle"), oneOut.length)
    check("level 1 leaves the newest turn whole", (one[newest] as AssistantMessage).parts.some((p) => p.type === "tool" && p.output === "recent"))
    check("level 1 keeps old reasoning, which only level 2 strips", (one[1] as AssistantMessage).parts.some((p) => p.type === "reasoning" && p.text === "old thinking"))

    const two = prunedHistory(build(), 2)
    const twoOut = (two[1] as AssistantMessage).parts.find((p): p is ToolPart => p.type === "tool")?.output ?? ""
    check("level 2 clears the old result outright", twoOut.includes("cleared this older bash result") && twoOut.length < 200, twoOut.slice(0, 80))
    check("level 2 strips the reasoning of the turns before the last three", (two[1] as AssistantMessage).parts.some((p) => p.type === "reasoning" && p.text === ""))
    check("level 2 still leaves the newest turn whole", (two[newest] as AssistantMessage).parts.some((p) => p.type === "tool" && p.output === "recent"))

    /*
     * MiMo's floor: past the protected tail but with less than PRUNE_MINIMUM to
     * reclaim, clearing rewrites the prefix for too little, so it does not.
     *
     * The filler is exactly the protected tail, so only the small result behind
     * it tips over the line - and it alone is not worth clearing.
     */
    const filler = "z".repeat(PRUNE_PROTECT * CHARS_PER_TOKEN)
    const barely: Message[] = [
      user("s3", "one", 1),
      assistant("s3", [toolPart("bash", "y".repeat(4_000))], 2),
      user("s3", "two", 3),
      assistant("s3", [toolPart("bash", filler)], 4),
      user("s3", "three", 5),
      assistant("s3", [toolPart("bash", "recent")], 6),
      user("s3", "four", 7),
    ]
    const reclaim = pruneCandidates(barely).reclaimable
    const kept = prunedHistory(barely, 2)
    const keptOut = (kept[1] as AssistantMessage).parts.find((p): p is ToolPart => p.type === "tool")?.output ?? ""
    check("only what is past the protected tail counts as reclaimable", reclaim === 1_000, reclaim)
    check("too little to reclaim, so level 2 clears nothing", reclaim < PRUNE_MINIMUM && !keptOut.includes("cleared"), reclaim)
  }

  // -------------------------------------------------- M4 on the wire
  section("Round 7 (M4): a trimmed result as the provider receives it")
  {
    // The window has to be stated as MiMo's `limit.context`: `customModelOf` keeps that and drops anything else.
    const e = await engine({ custom: { models: [{ id: "m", name: "M", limit: { context: 10_000 } }] } })
    try {
      const stale = Date.now() - 10 * 60 * 1000
      const big = "x".repeat(PRUNE_PROTECT * CHARS_PER_TOKEN + 200_000)

      /**
       * A conversation whose older turn read something large, with its last
       * reply far enough back that the prompt cache has expired.
       *
       * `input` decides the pressure: the usable window is 9,000, so 5,000 is
       * level 1 and 8,000 is level 2.
       */
      const seed = async (input: number, when: number) => {
        const session = await e.store.create({ directory: e.project, model: e.model })
        for (const message of [
          user(session.id, "read the big file", when),
          assistant(session.id, [toolPart("bash", big)], when),
          user(session.id, "thanks", when),
          assistant(session.id, [toolPart("bash", "the newest result")], when, input),
        ]) {
          await e.store.saveMessage(message)
        }
        return session.id
      }

      const cold = await seed(5_000, stale)
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: cold, text: "carry on" })
      await e.idle(cold)
      const sent = JSON.stringify(e.bodies.at(-1) ?? {})
      check("the provider is not sent the whole old result", !sent.includes("x".repeat(5_000)), sent.length)
      check("it is sent the trimmed form instead", sent.includes("left out the middle"))
      check("and the newest turn's result still arrives whole", sent.includes("the newest result"))

      const hot = await seed(5_000, Date.now())
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: hot, text: "carry on" })
      await e.idle(hot)
      const warm = JSON.stringify(e.bodies.at(-1) ?? {})
      check("a warm cache is still sent everything, since trimming it would cost more than it saves", warm.includes("x".repeat(5_000)))

      const full = await seed(8_000, stale)
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: full, text: "carry on" })
      await e.idle(full)
      const cleared = JSON.stringify(e.bodies.at(-1) ?? {})
      check("under real pressure the old result is cleared, not merely trimmed", cleared.includes("cleared this older bash result"), cleared.length)
      check("the newest turn survives that too", cleared.includes("the newest result"))
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M10
  section("Round 7 (M10): the per-provider body fields MCode never sent")
  {
    check(
      "Zhipu's thinking switch and DashScope's are untouched",
      JSON.stringify(providerExtras("zhipu", false)) === JSON.stringify({ thinking: { type: "enabled", clear_thinking: false } }) &&
        providerExtras("dashscope", true).enable_thinking === true &&
        Object.keys(providerExtras("dashscope", false)).length === 0,
    )

    const router = providerExtras("openrouter", false, "ses_1")
    check("OpenRouter is asked for the usage MCode already reads back", JSON.stringify(router.usage) === JSON.stringify({ include: true }), router.usage)
    check("and carries the conversation as its prompt cache key", router.prompt_cache_key === "ses_1", router.prompt_cache_key)
    check("llmgateway asks for the same usage", JSON.stringify(providerExtras("llmgateway", false).usage) === JSON.stringify({ include: true }))
    check("xAI is told not to retain the request, as MiMo defaults it", providerExtras("xai", false, "s").store === false)
    check("OpenAI gets the cache key without the retention switch", providerExtras("openai", false, "s").prompt_cache_key === "s" && providerExtras("openai", false, "s").store === undefined)
    check("a request belonging to no conversation carries no cache key", providerExtras("openrouter", false).prompt_cache_key === undefined)
    check("a provider MiMo names none of is sent nothing extra", Object.keys(providerExtras("deepseek", true)).length === 0)

    /*
     * On the wire, because the point of this item is a field the provider
     * receives: reading it back off the adapter's own request body is the only
     * way to know `extra` was actually written into it.
     */
    const p = await engine()
    try {
      p.replies.push(say("ok"))
      const controller = new AbortController()
      await OpenAICompatible.stream(
        {
          apiKey: "k",
          model: { provider: "openrouter", model: "m" },
          system: "s",
          history: [],
          tools: [],
          effort: "",
          showReasoning: false,
          signal: controller.signal,
          baseURL: `http://127.0.0.1:${p.port}/v1`,
          extra: providerExtras("openrouter", false, "ses_wire"),
        },
        () => {},
      )
      const body = p.bodies.at(-1) ?? {}
      check("the provider really receives the usage request", JSON.stringify(body.usage) === JSON.stringify({ include: true }), body.usage)
      check("and the prompt cache key travels with it", body.prompt_cache_key === "ses_wire", body.prompt_cache_key)
    } finally {
      await p.close()
    }
  }

  // ------------------------------------------------------------------ M2
  section("Round 7 (M2): the environment block names the model and the repository")
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r7-env-"))
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r7-plain-"))
    try {
      const as = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
      as(["init", "-q"])
      as(["config", "user.email", "r7@example.com"])
      as(["config", "user.name", "Round Seven"])
      await fs.writeFile(path.join(root, "a.txt"), "one\n")
      as(["add", "-A"])
      as(["commit", "-q", "-m", "first"])

      const model = { name: "M Two", provider: "fake", id: "m-2" }
      const built = await systemPrompt({ directory: root, agent: "build", model })
      check("it names the model and its exact id, which MCode never told the model before", built.includes("Model: M Two, fake/m-2"), built.slice(-500))
      check("it says whether the folder is a repository", built.includes("Is a git repository: true"))
      check("it names the branch a pull request should target", /Default branch: (main|master)\./.test(built), built.slice(-500))
      check("and who a commit would be credited to", built.includes("Git user: Round Seven"))
      /*
       * The volatile half deliberately stays out, as round 5 (E10) decided: it
       * rides on each prompt instead, so the cached prefix is stable while the
       * model still reads a current working tree.
       */
      check("the volatile repository state stays out of the cached block", !built.includes("## Repository") && !built.includes("Today:"))

      /*
       * MiMo memoises this per directory, day, provider and model id. Changing
       * the git user and asking again must return the cached block; asking for
       * a different model must not.
       */
      execFileSync("git", ["config", "user.name", "Someone Else"], { cwd: root, stdio: "ignore" })
      const again = await systemPrompt({ directory: root, agent: "build", model })
      check("the block is cached for the day rather than rebuilt per turn", again === built)
      const other = await systemPrompt({ directory: root, agent: "build", model: { name: "M Three", provider: "fake", id: "m-3" } })
      check("but a different model gets its own block", other.includes("Model: M Three, fake/m-3"), other.slice(-400))
      check("which is built fresh, so it reads the new git user", other.includes("Git user: Someone Else"), other.slice(-400))

      const bare = await systemPrompt({ directory: plain, agent: "build" })
      check("a plain folder says so and names no branch or user", bare.includes("Is a git repository: false") && !bare.includes("Default branch:") && !bare.includes("Git user:"), bare.slice(-400))
      check("and with no model chosen it names none", !bare.includes("Model: "), bare.slice(-300))
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      await fs.rm(plain, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ------------------------------------------------------------------ M9
  section("Round 7 (M9): compaction stands down the largest tool results")
  {
    const s = "s9"
    const huge = "q".repeat(COMPACTION_TOOL_RESULT_LIMIT * CHARS_PER_TOKEN + 40_000)
    const small = "still small"
    const history: Message[] = [
      user(s, "look at it", 1),
      assistant(s, [toolPart("bash", huge), toolPart("read", small)], 2),
    ]
    const shrunk = shrinkLargeToolResults(history)
    const parts = (shrunk[1] as AssistantMessage).parts.filter((p): p is ToolPart => p.type === "tool")
    check("a result over the limit is stood down", parts[0]?.output !== huge && (parts[0]?.output ?? "").includes("left this bash result out"), parts[0]?.output?.slice(0, 90))
    check("the line says roughly what it cost", (parts[0]?.output ?? "").includes(String(estimateTokens(huge))))
    check("one under the limit is replayed as it was", parts[1]?.output === small)
    check("the user's own words are never touched", (shrunk[0] as Message).role === "user" && JSON.stringify(shrunk[0]) === JSON.stringify(history[0]))

    /* Only completed results: a failure's message is short, and is usually the thing worth summarising. */
    const failed: Message[] = [user(s, "x", 1), assistant(s, [{ ...toolPart("bash", huge), status: "error" as const }], 2)]
    check("a failed call is left alone however long it is", JSON.stringify(shrinkLargeToolResults(failed)) === JSON.stringify(failed))

    // On the wire: the summary request is what this item exists to shrink.
    const e = await engine({ custom: { models: [{ id: "m", name: "M", limit: { context: 200_000 } }] } })
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      const now = Date.now()
      await e.store.saveMessage(user(session.id, "read the big one", now))
      await e.store.saveMessage(assistant(session.id, [toolPart("bash", huge)], now, 10))
      await e.runner.compact(session.id)
      const asked = JSON.stringify(e.summaryBodies.at(-1) ?? {})
      check("the summary request no longer replays the whole result", !asked.includes("q".repeat(5_000)), asked.length)
      check("it carries the shrink note instead", asked.includes("left this bash result out of the compaction"))
      check("and still asks for the summary", asked.includes("about to be compacted"))
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M3
  section("Round 7 (M3): the tool descriptions carry MiMo's coverage, in MCode's words")
  {
    const describe = (name: string) => findTool(name)?.description ?? ""

    const question = describe("question")
    check("question is no longer the inherited upstream wording", !question.includes("Use this tool when you need to ask the user questions during execution"), question.slice(0, 80))
    check("it is in MiMo's length class rather than a sentence", question.length > 800, question.length)
    check("it says the flag, not the wording, is what allows several answers", question.includes("multiple flag"))
    check('it tells the model not to write its own "Other" row', /Other/.test(question) && question.includes("type your own answer"))
    check("and how to mark the option it would pick", question.includes("(Recommended)"))

    const read = describe("read")
    check("read explains the numbered-line form the edit tool matches on", read.includes("N: text") && read.includes("edit expects you to quote back"))
    check("it explains reading a long file in parts", read.includes("offset") && read.includes("limit") && read.includes("2,000 lines or 50 KB"))
    check("it discourages a series of tiny slices, as MiMo's does", read.includes("30-line slices"))
    check("and it is no longer a single sentence", read.length > 800, read.length)

    const bash = describe("bash")
    check("bash carries the git discipline MiMo spends its length on", bash.includes("Version control") && bash.includes("Commit only when the user asks"))
    check("including not skipping hooks and not pushing unasked", bash.includes("skip hooks") && bash.includes("Never push unless the user asks"))
    check("and how to open a pull request", bash.includes("Pull requests") && bash.includes("default branch"))
    check("it still says to prefer the dedicated tools", bash.includes("read, edit, write, glob and grep"))
    check("and it is in MiMo's length class", bash.length > 1_500, bash.length)

    const actor = describe("actor")
    check("actor now lists the agent types, which it never did", actor.includes("Available agent types and what each one may do:"))
    check("explore is named read-only", /explore: reads only/.test(actor))
    check("and general is named as the one that may change files", /general:/.test(actor) && actor.includes("change files"))

    /* The description is only worth anything if the provider is the one reading it. */
    const e = await engine()
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: session.id, text: "hello" })
      await e.idle(session.id)
      const tools = (e.bodies.at(-1)?.tools ?? []) as { function?: { name?: string; description?: string } }[]
      const sent = tools.find((tool) => tool.function?.name === "bash")?.function?.description ?? ""
      check("the provider receives the long bash description, not a summary of it", sent.includes("Version control") && sent.length > 1_500, sent.length)
      const askedFor = tools.find((tool) => tool.function?.name === "question")?.function?.description ?? ""
      check("and the rewritten question description", askedFor.includes("multiple flag"), askedFor.length)
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M12
  section("Round 7 (M12): an out-of-band request runs on the cheap profile")
  {
    check("a Google model over a gateway is switched off rather than levelled", JSON.stringify(smallRequest("openrouter", "google/gemini-3-pro")) === JSON.stringify({ effort: "minimal", extra: { reasoning: { enabled: false } } }))
    check("another model over the same gateway asks for the lowest level", JSON.stringify(smallRequest("openrouter", "anthropic/claude-sonnet")) === JSON.stringify({ effort: "minimal", extra: {} }))
    check("GPT-5 is asked for its lowest level and left unstored", JSON.stringify(smallRequest("openai", "gpt-5")) === JSON.stringify({ effort: "minimal", extra: { store: false } }))
    check("its 5.x and mini variants take low instead of minimal", smallRequest("openai", "gpt-5.1").effort === "low" && smallRequest("openai", "gpt-5-mini").effort === "low")
    check("anything else simply runs low", JSON.stringify(smallRequest("fake", "m")) === JSON.stringify({ effort: "low", extra: {} }))

    /*
     * On the wire, read off a field no gating can hide.
     *
     * reasoning_effort is withheld whenever the model's variants list does not
     * carry the level, so asserting on it proves nothing here: the fake model
     * advertises no levels and the field is absent from every request, which
     * means such a check passes whether or not the cheap profile is applied.
     * `store` comes from the profile's own body fields and is sent as-is, so
     * the ordinary turn carrying none and the out-of-band request carrying
     * `false` is a difference only this item can produce.
     */
    const e = await engine({ custom: { models: [{ id: "gpt-5", name: "GPT5" }] } })
    try {
      const model = { provider: "fake", model: "gpt-5" }
      const session = await e.store.create({ directory: e.project, model })
      e.replies.push(say("one"))
      await e.runner.prompt({ sessionID: session.id, text: "FIRST" })
      await e.idle(session.id)
      const turn = e.bodies.at(-1)
      await e.runner.compact(session.id)
      const summary = e.summaryBodies.at(-1)
      check("the conversation's own turn is left stored, as an ordinary turn is", turn?.store === undefined, turn?.store)
      check("but the out-of-band summary request runs on the cheap profile", summary?.store === false, summary?.store)
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M17
  section("Round 7 (M17): a nested AGENTS.md reaches the model when a file under it is read")
  {
    const e = await engine()
    try {
      await fs.mkdir(path.join(e.project, "pkg"), { recursive: true })
      await fs.writeFile(path.join(e.project, "pkg", "AGENTS.md"), "Package rule: this package indents with tabs.\n")
      await fs.writeFile(path.join(e.project, "pkg", "x.ts"), "export const x = 1\n")
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "read", input: { file_path: "pkg/x.ts" } }]))
      e.replies.push(say("read it"))
      await e.runner.prompt({ sessionID: session.id, text: "read pkg/x.ts" })
      await e.idle(session.id)
      const sent = wireText(e.bodies.at(-1))
      check("the package's own instructions travel with the read", sent.includes("Instructions from") && sent.includes("indents with tabs"), sent.slice(-400))

      /* Once per conversation: reading a second file under the same folder does not send them again. */
      await fs.writeFile(path.join(e.project, "pkg", "y.ts"), "export const y = 2\n")
      e.replies.push(calls([{ name: "read", input: { file_path: "pkg/y.ts" } }]))
      e.replies.push(say("read that too"))
      await e.runner.prompt({ sessionID: session.id, text: "now pkg/y.ts" })
      await e.idle(session.id)
      const second = JSON.stringify(e.bodies.at(-1)?.messages?.at(-1) ?? {})
      check("and are not repeated for the next file beside them", !second.includes("indents with tabs"), second.slice(0, 300))
    } finally {
      await e.close()
    }
  }
}
