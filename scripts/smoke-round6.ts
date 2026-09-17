/**
 * Round 6: the eight differences the user decided on 2026-09-16 to close.
 *
 * Kept apart from smoke.ts the way round 5 is, and called with its check and
 * section. Nothing here calls a model or reaches the network: the one web
 * address fetched is served by a loopback server this file starts.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import type { SessionInfo } from "../src/shared/protocol"
import type { Check } from "./smoke-round5"
// L13: the speak tool, and the setting that decides whether a turn is offered it.
import { SPEAK_LIMIT, SpeakTool } from "../src/server/tool/speak"
import { reachOf, toolsForTurn } from "../src/server/tool/registry"
// L15: the agent a subagent runs as, and the rule the write tools apply.
import { guardPlanWrite, subagentAgent } from "../src/server/session/plan"
import { ToolError, type ToolContext } from "../src/server/tool/types"
// L16: a template's shell placeholders, run whatever source the template came from.
import { runShellPlaceholders } from "../src/server/command"
// L18: which local media a reply may preview.
import { mediaPath } from "../src/renderer/src/lib/delivered"
// L19: scheduling that belongs to the project rather than to one conversation.
import { ADOPTED_TITLE, CronScheduler, reaches } from "../src/server/cron/scheduler"
import { readCronTasks, writeCronTasks, type CronTask } from "../src/server/cron/tasks"
// L21: where a conversation's instructions come from, web addresses included.
import { fetchInstruction, systemPrompt } from "../src/server/session/prompt"
// L23: the skills this app ships.
import { discoverSkills } from "../src/server/skill"
// J2: taking conversations in from other AI apps on this machine.
import { DatabaseSync } from "node:sqlite"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { SessionStore } from "../src/server/session/store"
import { runImport, scanImports, worthAsking } from "../src/server/import"
// J5: which model writes a conversation's title. J14: what a drop turns into an @mention.
import { titleModelRef } from "../src/server/session/title"
import { MENTION_MAX, mentionable } from "../src/renderer/src/lib/attach"
// J15, J16: where a pasted picture and a large paste are written.
import { savePastedImage, savePastedText } from "../src/main/paste-files"

/**
 * A conversation as the scheduler needs to see one.
 *
 * The scheduler reads only an id and a folder off it, so the rest is not built;
 * the cast is what lets a check drive it without a store behind it.
 */
const fakeSession = (id: string, directory: string) =>
  ({ id, title: id, directory, agent: "build", created: 0, updated: 0 }) as unknown as SessionInfo

export async function roundSixChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-round6-"))

  // ------------------------------------------------------------------ L15
  section("Round 6 (L15): a subagent started while planning is not held to plan mode")
  {
    check("a general subagent builds, even started from a planning turn", subagentAgent("general") === "build")
    check("an explore subagent still only reads", subagentAgent("explore") === "plan")

    /* The rule the write tools apply, read through the control the runner hands them. */
    const control = (agent: string) => ({
      agent,
      switched: false,
      file: path.join(root, "plan.md"),
      writable: (target: string) => target === path.join(root, "plan.md"),
      approve: async () => undefined,
    })
    const context = (agent: string) => ({ directory: root, plan: control(agent) }) as unknown as ToolContext
    let refused = false
    try {
      guardPlanWrite(context("plan"), path.join(root, "src.ts"), "src.ts")
    } catch (err) {
      refused = err instanceof ToolError
    }
    check("a planning turn is still refused a write outside its plan file", refused)
    let allowed = true
    try {
      guardPlanWrite(context("build"), path.join(root, "src.ts"), "src.ts")
    } catch {
      allowed = false
    }
    check("and a subagent's own build turn is not", allowed)
  }

  // ------------------------------------------------------------------ L16
  section("Round 6 (L16): a filled-in template runs its commands, whatever its source")
  {
    const deps = { config: { get: () => ({ shell: "" }) } }
    /*
     * Each of these asserts the placeholder is gone as well as the output being
     * there: the unrun text says "echo one" and "echo two" itself, so looking
     * only for the words would pass whether or not anything ever ran.
     */
    const ran = await runShellPlaceholders(deps, { directory: root, text: "before !`echo hi` after" })
    check(
      "an MCP prompt's backtick command runs and its output lands in the text",
      !ran.includes("!`") && !ran.includes("echo hi") && /before\s+hi\s+after/.test(ran.replace(/\r?\n/g, " ")),
      ran,
    )
    const skillLine = await runShellPlaceholders(deps, { directory: root, text: "/review !`echo one` and !`echo two`" })
    check(
      "a skill's arguments run theirs too, in order",
      !skillLine.includes("!`") && !skillLine.includes("echo one") && /one[\s\S]*and[\s\S]*two/.test(skillLine),
      skillLine,
    )
    const plain = "nothing to run here"
    check("text with no placeholder comes back exactly as it was", (await runShellPlaceholders(deps, { directory: root, text: plain })) === plain)
    const failed = await runShellPlaceholders(deps, { directory: root, text: "[!`definitely-not-a-command-xyz`]" })
    check("a command that cannot run leaves the empty string, as MiMo does", failed.startsWith("[") && failed.endsWith("]") && !failed.includes("definitely-not-a-command"), failed)
  }

  // ------------------------------------------------------------------ L18
  section("Round 6 (L18): a reply's local media is previewed wherever it lives")
  {
    const project = process.platform === "win32" ? "C:/proj" : "/proj"
    const outside = process.platform === "win32" ? "C:/elsewhere/shot.png" : "/elsewhere/shot.png"
    check("a picture outside the project is previewed rather than left a chip", mediaPath(outside, project) === outside)
    check("a relative path is still taken from the conversation's folder", mediaPath("sub/shot.png", project) === `${project}/sub/shot.png`)
    check("a file inside the project still resolves", mediaPath(`${project}/a/b.png`, project) === `${project}/a/b.png`)
    check("a web address is not a file to read", mediaPath("https://example.com/a.png", project) === undefined)
    check("nor is another scheme", mediaPath("data:image/png;base64,AAAA", project) === undefined)
    check("a home-relative path is left alone, since the window cannot expand it", mediaPath("~/shot.png", project) === undefined)
    check("a relative path with no project has nowhere to start from", mediaPath("sub/shot.png", undefined) === undefined)
  }

  // ------------------------------------------------------------------ L13
  section("Round 6 (L13): the speak tool, and the setting that offers it")
  {
    const on = toolsForTurn("build", { voiceFeedback: true }).map((tool) => tool.name)
    const off = toolsForTurn("build", { voiceFeedback: false }).map((tool) => tool.name)
    check("speak is offered while voice feedback is on", on.includes("speak"))
    check("and is not there at all when it is off", !off.includes("speak"))
    check("nothing else changes with the setting", on.filter((name) => name !== "speak").join() === off.join())
    check("an explore subagent is never offered it", !toolsForTurn("explore", { voiceFeedback: true }).some((tool) => tool.name === "speak"))
    check("saying something changes no file", reachOf("speak") === "reads")

    const said = await SpeakTool.execute({ text: "  Finished the migration.  " }, {} as unknown as ToolContext)
    check("the line is what the window is given to say", said.metadata?.text === "Finished the migration.", said.metadata)
    const long = await SpeakTool.execute({ text: "x".repeat(SPEAK_LIMIT + 50) }, {} as unknown as ToolContext)
    check("a line too long to speak is cut rather than said half way", String(long.metadata?.text).length === SPEAK_LIMIT)
    let emptyRefused = false
    try {
      await SpeakTool.execute({ text: "   " }, {} as unknown as ToolContext)
    } catch (err) {
      emptyRefused = err instanceof ToolError
    }
    check("a call with nothing to say is refused", emptyRefused)
  }

  // ------------------------------------------------------------------ L19
  section("Round 6 (L19): a schedule belongs to its project, not to one conversation")
  {
    const project = path.join(root, "scheduled")
    await fs.mkdir(project, { recursive: true })
    let clock = Date.UTC(2026, 0, 1, 0, 0, 0)
    const fired: { sessionID: string; text: string }[] = []
    const sessions = new Map<string, SessionInfo>()
    const maker = fakeSession("ses_maker", project)
    sessions.set(maker.id, maker)
    let opened = 0
    const host = {
      now: () => clock,
      fire: async (sessionID: string, text: string) => {
        fired.push({ sessionID, text })
      },
      busy: () => false,
      session: async (id: string) => sessions.get(id),
      create: async (directory: string) => {
        opened += 1
        const made = fakeSession(`ses_opened_${opened}`, directory)
        sessions.set(made.id, made)
        return made
      },
      directories: async () => [project],
    }

    /* Written the way a file from before this change reads: a task owned by a conversation. */
    const stored: CronTask = { id: "keepgoing", cron: "*/10 * * * *", prompt: "keep going", createdAt: clock, recurring: true, createdBySessionId: maker.id }
    await writeCronTasks(project, [stored])
    check("a task file written the old way still reads", (await readCronTasks(project)).some((task) => task.id === "keepgoing" && task.createdBySessionId === maker.id))

    const scheduler = new CronScheduler(host)
    await scheduler.start({ interval: false })
    // The conversation that made it is gone, as if the user had deleted it.
    sessions.delete(maker.id)
    clock += 20 * 60 * 1000
    await scheduler.tick()
    check("a durable task whose conversation was deleted still fires", fired.length === 1 && fired[0]?.text.includes("keep going"), fired)
    check("and it fires in a new conversation opened in its own project", Boolean(fired[0] && fired[0].sessionID !== maker.id && sessions.get(fired[0].sessionID)?.directory === project))
    check("the task is still scheduled rather than dropped", (await readCronTasks(project)).some((task) => task.id === "keepgoing"))
    const rewritten = (await readCronTasks(project)).find((task) => task.id === "keepgoing")
    check("and the file now names the conversation that took it over, so later runs keep to it", rewritten?.createdBySessionId === fired[0]?.sessionID, rewritten)

    clock += 20 * 60 * 1000
    await scheduler.tick()
    check("the next run goes to that same conversation rather than opening another", fired.length === 2 && fired[1]?.sessionID === fired[0]?.sessionID && opened === 1, { fired: fired.length, opened })

    /* Who may see a task: the project's, whichever conversation made it. */
    const durable: CronTask = { ...stored, durable: true }
    const sessionOnly: CronTask = { ...stored, id: "sessiononly", durable: false }
    check("anyone working in the project reaches its durable task", reaches({ ownerID: "ses_someone_else", directory: project }, durable, project))
    check("a conversation elsewhere does not", !reaches({ ownerID: "ses_x", directory: path.join(root, "other") }, durable, project))
    check("a session-only task is still its own conversation's", reaches({ ownerID: maker.id }, sessionOnly, project) && !reaches({ ownerID: "ses_x" }, sessionOnly, project))
    check("and an unscoped look sees everything", reaches(undefined, durable, project) && reaches({}, sessionOnly, project))
    await scheduler.stop()
  }

  // ------------------------------------------------------------------ L21
  section("Round 6 (L21): instruction files, by glob and by web address")
  {
    const project = path.join(root, "instructed")
    const home = path.join(root, "home")
    await fs.mkdir(path.join(project, "docs"), { recursive: true })
    await fs.mkdir(path.join(home, ".claude"), { recursive: true })
    await fs.writeFile(path.join(project, "docs", "house-style.md"), "House style: short sentences.", "utf8")
    await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), "Global claude rules: be brief.", "utf8")

    const asked: string[] = []
    const stub = async (url: string) => {
      asked.push(url)
      return url.endsWith("remote.md") ? "Remote rule: never force-push." : ""
    }
    const prompt = await systemPrompt({
      directory: project,
      agent: "build",
      instructionFiles: ["docs/*.md", "https://example.invalid/remote.md"],
      home,
      fetchInstruction: stub,
    })
    check("a glob in the instructions setting is read", prompt.includes("House style: short sentences."))
    check("the global ~/.claude/CLAUDE.md is read, in MiMo's order", prompt.includes("Global claude rules: be brief."))
    check("a web address is fetched and labelled with where it came from", prompt.includes("Remote rule: never force-push.") && prompt.includes('source="https://example.invalid/remote.md"'))
    check("only the web address was fetched - a glob never reaches the network", asked.length === 1 && asked[0] === "https://example.invalid/remote.md", asked)

    const quiet = await systemPrompt({
      directory: project,
      agent: "build",
      instructionFiles: ["https://example.invalid/gone.md"],
      home,
      fetchInstruction: async () => "",
    })
    check("a web address that answers with nothing is left out, and the rest of the prompt stands", !quiet.includes("gone.md") && quiet.includes("Global claude rules: be brief."))

    const angry = await systemPrompt({
      directory: project,
      agent: "build",
      instructionFiles: ["https://example.invalid/boom.md"],
      home,
      fetchInstruction: async () => {
        throw new Error("network is down")
      },
    })
    check("a fetch that throws does not take the conversation down with it", !angry.includes("boom.md") && angry.includes("House style") === false && angry.length > 0)

    /* The real fetch, against a loopback server rather than the internet. */
    const server = createServer((request, response) => {
      if (request.url === "/rules.md") {
        response.writeHead(200, { "content-type": "text/markdown" })
        response.end("Served rule: run the checks.")
        return
      }
      response.writeHead(404)
      response.end("no")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    check("the real fetch reads a file that is served", (await fetchInstruction(`http://127.0.0.1:${port}/rules.md`)) === "Served rule: run the checks.")
    check("a status that is not ok is nothing rather than an error page", (await fetchInstruction(`http://127.0.0.1:${port}/missing.md`)) === "")
    check("a scheme that is not http is never fetched", (await fetchInstruction("file:///etc/passwd")) === "")
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // ------------------------------------------------------------------ L23
  section("Round 6 (L23): the skills this app ships")
  {
    const { skills, problems } = await discoverSkills({ directory: root })
    check("every shipped skill reads, frontmatter and all", problems.length === 0, problems)
    const shipped = skills.filter((skill) => skill.builtin)
    check("each shipped skill says what it is for", shipped.every((skill) => skill.name && skill.description))
    const chat = shipped.find((skill) => skill.name === "session-chat")
    check("the session-chat skill is shipped", Boolean(chat))
    const body = chat?.content ?? ""
    check("it teaches MCode's own session tools", ["contacts", "talk_to_session", "create_session", "update_session"].every((tool) => body.includes(tool)))
    /* A skill must never instruct a tool this app does not ship - the reader would follow it and the call would not exist. */
    const absent = ["tts_speech", "asr_transcribe", "image_gen", "image_edit", "use_figma", "create_new_file", "generate_diagram"]
    const offenders = shipped.filter((skill) => absent.some((tool) => skill.content.includes(tool))).map((skill) => skill.name)
    check("no shipped skill instructs a tool MCode does not have", offenders.length === 0, offenders)
  }

  // ------------------------------------------------------------------- J2
  section("Round 6 (J2): conversations taken in from other AI apps")
  {
    /*
     * Fixtures, never the reader's own files: MCODE_IMPORT_HOME points the
     * scan at a folder made here, holding one transcript per source.
     */
    const home = path.join(root, "import-home")
    const ccFile = path.join(home, ".claude", "projects", "d--work-alpha", "conversation.jsonl")
    await fs.mkdir(path.dirname(ccFile), { recursive: true })
    const project = path.join(root, "alpha")
    await fs.writeFile(
      ccFile,
      [
        JSON.stringify({ type: "user", cwd: project, timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "Rename the widget\nand run the checks" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-09-01T10:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "Renamed it." }, { type: "tool_use", name: "edit", input: { secretpath: "never-shown" } }] } }),
      ].join("\n"),
    )
    const codexFile = path.join(home, ".codex", "sessions", "2026", "09", "02", "rollout.jsonl")
    await fs.mkdir(path.dirname(codexFile), { recursive: true })
    await fs.writeFile(
      codexFile,
      [
        JSON.stringify({ timestamp: "2026-09-02T09:00:00.000Z", type: "session_meta", payload: { id: "abc", cwd: project } }),
        JSON.stringify({ timestamp: "2026-09-02T09:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Explain the build" }] } }),
        JSON.stringify({ timestamp: "2026-09-02T09:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "It runs vite." }] } }),
      ].join("\n"),
    )
    /* A file that is not a transcript at all, to prove what an error may say. */
    const broken = path.join(path.dirname(ccFile), "broken.jsonl")
    await fs.writeFile(broken, "this is not json and mentions hunter2\n")

    const dbFile = path.join(home, ".local", "share", "opencode", "opencode.db")
    await fs.mkdir(path.dirname(dbFile), { recursive: true })
    {
      const db = new DatabaseSync(dbFile)
      db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)")
      db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, time_created INTEGER)")
      db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("ses_one", "Ship the parser", project, 1756000000000, 1756000100000)
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("m1", "ses_one", "user", "Ship the parser", 1756000000000)
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("m2", "ses_one", "assistant", JSON.stringify({ content: [{ type: "text", text: "Shipped." }] }), 1756000050000)
      db.close()
    }

    const before = process.env.MCODE_IMPORT_HOME
    process.env.MCODE_IMPORT_HOME = home
    const storage = new Storage(path.join(root, "import-store"))
    const sessions = new SessionStore(storage, new Bus())
    const model = { provider: "stub", model: "stub-1" }

    const scan = await scanImports(storage)
    check("each source says whether it is there and how much it holds", scan.cc.available && scan.cc.sessions === 2 && scan.codex.available && scan.codex.sessions === 1 && scan.opencode.available && scan.opencode.sessions === 1, scan)
    check("nothing has been taken from them yet", scan.cc.imported === 0 && scan.codex.imported === 0 && scan.opencode.imported === 0)
    check("a scan with something in it is worth asking about", worthAsking(scan))
    check("a scan with nothing in it is not", !worthAsking({ cc: { available: true, sessions: 0, imported: 3 }, codex: { available: false, sessions: 0, imported: 0 }, opencode: { available: false, sessions: 0, imported: 0 } }))

    const first = await runImport({ storage, sessions, model }, ["cc", "codex", "opencode"])
    check("every source was taken in", first.cc.imported === 1 && first.codex.imported === 1 && first.opencode.imported === 1, first)
    check("a file that is not a transcript is one error, not a failed import", first.cc.errors.length === 1, first.cc.errors)
    check("an error names the file and quotes nothing out of it", first.cc.errors.every((line) => line.startsWith("broken.jsonl:") && !line.includes("hunter2")), first.cc.errors)

    const imported = await sessions.list()
    check("three conversations arrived", imported.length === 3, imported.length)
    const claude = imported.find((session) => session.imported?.source === "cc")
    check("it is filed as imported, with the key it has over there", claude?.imported?.key === ccFile)
    check("its title is the first line the user wrote", claude?.title === "Rename the widget")
    check("it works where the other app worked", claude?.directory === project)
    check("it joins no project on its own", claude?.group === "")
    check("its clock is the source's, not the moment it was taken", claude?.updated === Date.parse("2026-09-01T10:00:20.000Z"))
    const claudeMessages = claude ? await sessions.messages(claude.id) : []
    check("both turns came across", claudeMessages.length === 2 && claudeMessages[0].role === "user" && claudeMessages[1].role === "assistant")
    const answer = claudeMessages[1]
    const answerText = answer?.role === "assistant" ? answer.parts.map((part) => (part.type === "text" ? part.text : "")).join("") : ""
    check("what was said came across and what was called did not", answerText === "Renamed it.")
    const codexSession = imported.find((session) => session.imported?.source === "codex")
    const codexMessages = codexSession ? await sessions.messages(codexSession.id) : []
    check("Codex's rollout reads the same way", codexSession?.title === "Explain the build" && codexMessages.length === 2)
    const openSession = imported.find((session) => session.imported?.source === "opencode")
    const openMessages = openSession ? await sessions.messages(openSession.id) : []
    check("OpenCode's database gives its title and its messages", openSession?.title === "Ship the parser" && openMessages.length === 2)

    const again = await runImport({ storage, sessions, model }, ["cc", "codex", "opencode"])
    check("nothing changed, so nothing is taken twice", again.cc.imported === 0 && again.codex.imported === 0 && again.opencode.imported === 0, again)
    check("what was already taken is skipped", again.cc.skipped === 1 && again.codex.skipped === 1 && again.opencode.skipped === 1, again)
    check("and no second copy of anything was made", (await sessions.list()).length === 3)

    /* Changed over there: the same conversation is written again rather than doubled. */
    await fs.appendFile(ccFile, `\n${JSON.stringify({ type: "user", timestamp: "2026-09-03T08:00:00.000Z", message: { role: "user", content: "One more thing" } })}`)
    const future = Date.now() + 5000
    await fs.utimes(ccFile, new Date(future), new Date(future))
    const third = await runImport({ storage, sessions, model }, ["cc"])
    check("a changed transcript comes back as a resync", third.cc.resynced === 1 && third.cc.imported === 0, third)
    const after = await sessions.list()
    check("it is still the one conversation", after.length === 3 && after.some((session) => session.id === claude?.id))
    const resynced = claude ? await sessions.messages(claude.id) : []
    check("and it now carries the turn that was added", resynced.length === 3)

    const counted = await scanImports(storage)
    check("the scan now says how many have been taken", counted.cc.imported === 1 && counted.codex.imported === 1 && counted.opencode.imported === 1, counted)

    const none = await runImport({ storage, sessions, model }, [])
    check("a run with nothing chosen reads nothing at all", none.cc.scanned === 0 && none.codex.scanned === 0 && none.opencode.scanned === 0)

    if (before === undefined) delete process.env.MCODE_IMPORT_HOME
    else process.env.MCODE_IMPORT_HOME = before
  }

  // ------------------------------------------------------------- J5, J14, J15, J16
  section("Round 6 (J5, J14, J15, J16): the title model, what becomes a mention, and what a paste writes")
  {
    // ---------------------------------------------------------------- J5
    const working = { provider: "anthropic", model: "claude-opus-5" }
    const cheap = { provider: "openai", model: "gpt-5-mini" }
    check("with nothing chosen, the conversation's own model writes its title", titleModelRef(undefined, working, () => true) === working)
    check("a chosen title model is the one used", titleModelRef(cheap, working, () => true) === cheap)
    check("a chosen model this install cannot reach falls back to the working one", titleModelRef(cheap, working, () => false) === working)
    let asked: { provider: string; model: string } | undefined
    titleModelRef(cheap, working, (ref) => {
      asked = ref
      return true
    })
    check("only the chosen model is asked about", asked === cheap)

    // --------------------------------------------------------------- J14
    const file = (name: string, type: string, size: number) =>
      new File([new Uint8Array(size)], name, { type })
    check("a text file inside the project is named rather than sent", mentionable(file("notes.md", "text/markdown", 20)))
    check("a source file the system has no opinion about is too", mentionable(file("main.rs", "", 20)))
    check("a PDF is attached, not mentioned", !mentionable(file("spec.pdf", "application/pdf", 20)))
    check("a spreadsheet is attached", !mentionable(file("book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 20)))
    check("a picture is attached", !mentionable(file("shot.png", "image/png", 20)))
    check("a huge log is attached rather than mentioned", !mentionable(file("run.log", "text/plain", MENTION_MAX + 1)))
    check("a folder, which arrives with no type and no bytes, is attached", !mentionable(file("src", "", 0)))

    // ------------------------------------------------------------ J15, J16
    const userData = path.join(root, "paste-userdata")
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    )
    const written = await savePastedImage(userData, `data:image/png;base64,${png.toString("base64")}`)
    check("a pasted picture lands under attachments/images", written.ok && written.path.startsWith(path.join(userData, "attachments", "images")))
    if (written.ok) {
      check("named for a paste, with the picture's own extension", /mcode-paste-\d+-[0-9a-f]+\.png$/.test(written.path))
      const stat = await fs.stat(written.path)
      check("and the bytes are there to open", stat.size === png.length)
      if (process.platform !== "win32") {
        check("the file is owner-only", (stat.mode & 0o077) === 0)
        const folder = await fs.stat(path.dirname(written.path))
        check("and so is the folder", (folder.mode & 0o077) === 0)
      }
    }
    check("a data URL that is not a picture is refused", !(await savePastedImage(userData, "data:text/plain;base64,aGk=")).ok)
    check("something that is not a data URL at all is refused", !(await savePastedImage(userData, "../../etc/passwd")).ok)

    const big = "x".repeat(300_000)
    const text = await savePastedText(big)
    check("a large paste becomes a .txt file", text.ok && text.path.endsWith(".txt"))
    if (text.ok) {
      check("holding the whole paste, with no cap applied", (await fs.readFile(text.path, "utf8")).length === big.length)
      await fs.rm(text.path, { force: true }).catch(() => undefined)
    }
    check("an empty paste writes nothing", !(await savePastedText("")).ok)
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
