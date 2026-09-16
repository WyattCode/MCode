/**
 * Round 7: the failures audited as F14-F42 that this pass closed.
 *
 * Kept apart from smoke.ts the way rounds five and six are, and called with its
 * check and section. Nothing here calls a model or reaches the network: the
 * only git driven is the one already on the machine, in a folder of its own,
 * and the one push attempted is refused before it can reach a remote.
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
import { MEDIA_LIMIT, readPreview, searchFolder } from "../src/server/handlers"
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
}
