/**
 * Round 10: memory, history search, skills, instructions and the slash
 * commands, item by item against MiMo 26.914 (R10-1 … R10-14). Kept apart from
 * smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundTenMemoryChecks` with its own check and section. Every folder here is
 * a throwaway one: nothing reads the user's own memory, history or skills.
 */
import fs from "node:fs/promises"
import { existsSync, readFileSync as readFileNow } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Check } from "./smoke-round5"
import { calls, engine, say } from "./smoke-round5"
import type { Message, SessionInfo, ToolPart } from "../src/shared/protocol"
import { MESSAGE_SEARCH_CHARS, scoreMatch, snippetOf } from "../src/shared/search-score"
import { findInMessages, messageText, searchMessages } from "../src/server/search"
import { GLOBAL_PROJECT_ID, PROJECT_ID_FILE, forgetProjectIDs, mainGitDir, projectMemoryID } from "../src/server/memory/project-id"
import { folderMemoryID, memoryFiles } from "../src/server/memory/paths"
import { migrateMemoryLayout } from "../src/server/memory/migrate"
import { memoryWriteRefusal, sandboxRefusal } from "../src/server/memory/guard"
import { bindHistory, bindMemoryWrites, type HistoryService } from "../src/server/history/service"
import { rowsOf, summaryPart, summaryRow } from "../src/server/history/extract"
import { IndexDatabase } from "../src/server/history/database"
import { HistoryIndex } from "../src/server/history/index"
import { memorySection, systemPrompt } from "../src/server/session/prompt"
import { agentPrompt } from "../src/server/session/prompts"
import { withoutSkillPrefix, fallbackTitle } from "../src/server/session/title"
import { discoverSkills, enabledSkills, readSkillFile, removableSkill, uninstallSkill, watchSkillProblems, type SkillProblem } from "../src/server/skill"
import { expandCommand, listCommands } from "../src/server/command"
import { toolsFor } from "../src/server/tool/registry"
import { resolvePath } from "../src/server/tool/fs-util"
import { sanitizeConfig } from "../src/server/config-sanitize"
import { wordMatch } from "../src/renderer/src/lib/word-match"
import { skillBrief, skillDescription, skillTitle } from "../src/renderer/src/lib/skill-display"
import { toolContext } from "./smoke-round10-files"

/** A file's text, or nothing when it is not there: a broken build must fail a check, not stop the run. */
function readFileSync(file: string, _encoding: "utf8"): string {
  try {
    return readFileNow(file, "utf8")
  } catch {
    return ""
  }
}

async function put(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

const skillFile = (name: string, description: string, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`

export async function roundTenMemoryChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10m-"))
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true })

  // ------------------------------------------------------------------ R10-6
  section("Round 10 (R10-6): memory belongs to a repository, and every folder outside one shares it")
  {
    forgetProjectIDs()
    const plainA = path.join(root, "plain-a")
    const plainB = path.join(root, "plain-b", "deeper")
    await fs.mkdir(plainA, { recursive: true })
    await fs.mkdir(plainB, { recursive: true })
    check("a folder outside any repository is the shared global project", projectMemoryID(plainA, { home }) === GLOBAL_PROJECT_ID)
    check("and so is every other one", projectMemoryID(plainB, { home }) === GLOBAL_PROJECT_ID)

    const repo = path.join(root, "repo")
    await fs.mkdir(path.join(repo, ".git", "worktrees", "feature"), { recursive: true })
    await fs.mkdir(path.join(repo, "packages", "web"), { recursive: true })
    const id = projectMemoryID(repo, { home })
    const stored = readFileSync(path.join(repo, ".git", PROJECT_ID_FILE), "utf8")
    check("a repository gets a random id, written into its main .git", /^[0-9a-f-]{36}$/.test(id) && stored === id, { id, stored })
    check("a subfolder of it shares that id", projectMemoryID(path.join(repo, "packages", "web"), { home }) === id)
    const linked = path.join(root, "linked-tree")
    await put(path.join(linked, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "feature")}\n`)
    check("a linked worktree finds the main .git", mainGitDir(linked, home) === path.join(repo, ".git"))
    check("and shares the repository's id", projectMemoryID(linked, { home }) === id)
    const relative = path.join(root, "relative-tree")
    await put(path.join(relative, ".git"), `gitdir: ../repo/.git/worktrees/feature\n`)
    check("a worktree whose pointer is relative is read from its own folder", projectMemoryID(relative, { home }) === id)
    const clone = path.join(root, "clone")
    await fs.mkdir(path.join(clone, ".git"), { recursive: true })
    check("another clone of it is another project", projectMemoryID(clone, { home }) !== id && projectMemoryID(clone, { home }) !== GLOBAL_PROJECT_ID)
    forgetProjectIDs()
    check("the id is read back after a restart, not made again", projectMemoryID(repo, { home }) === id)
    await put(path.join(repo, ".git", PROJECT_ID_FILE), "../escape")
    forgetProjectIDs()
    const replaced = projectMemoryID(repo, { home })
    check("an id file holding a path is not used as a folder name", replaced !== "../escape" && /^[0-9a-f-]{36}$/.test(replaced), replaced)
    const homeRepo = path.join(root, "home-with-git")
    await fs.mkdir(path.join(homeRepo, ".git"), { recursive: true })
    await fs.mkdir(path.join(homeRepo, "notes"), { recursive: true })
    check("a .git at the home folder does not make a project", projectMemoryID(path.join(homeRepo, "notes"), { home: homeRepo }) === GLOBAL_PROJECT_ID)
    const memoryRoot = path.join(root, "data", "memory")
    check("the project memory file is named by that id", memoryFiles(memoryRoot, path.join(repo, "packages", "web"), "ses_x").project === path.join(memoryRoot, "projects", replaced, "MEMORY.md"))

    // Moving the per-folder layout.
    forgetProjectIDs()
    const data = path.join(root, "migrate-data")
    const projects = path.join(data, "memory", "projects")
    const sub = path.join(repo, "packages", "web")
    const repoID = projectMemoryID(repo, { home })
    await put(path.join(projects, folderMemoryID(repo), "MEMORY.md"), "# Project memory\n- root rule\n")
    await put(path.join(projects, folderMemoryID(sub), "MEMORY.md"), "# Project memory\n- web rule\n")
    await put(path.join(projects, folderMemoryID(sub), "MEMORY-api.md"), "api notes\n")
    await put(path.join(projects, folderMemoryID(linked), "MEMORY.md"), "# Project memory\n- root rule\n")
    await put(path.join(projects, folderMemoryID(plainA), "MEMORY.md"), "plain a\n")
    await put(path.join(projects, folderMemoryID(plainB), "MEMORY.md"), "plain b\n")
    await put(path.join(projects, "0123456789abcdef", "MEMORY.md"), "nobody knows this folder\n")
    const moved = await migrateMemoryLayout({ dataDirectory: data, directories: [repo, sub, linked, plainA, plainB, plainA], home, now: new Date(Date.UTC(2026, 8, 17)) })
    const merged = readFileSync(path.join(projects, repoID, "MEMORY.md"), "utf8")
    check("a repository's folders are merged into its one memory", merged.includes("- root rule") && merged.includes("- web rule") && [sub, repo, linked].some((folder) => merged.includes(`## Merged from ${folder} (2026-09-17)`)), merged)
    check("the same text met twice is kept once", merged.split("- root rule").length === 2, merged)
    check("a file only one folder had is moved over as it is", readFileSync(path.join(projects, repoID, "MEMORY-api.md"), "utf8") === "api notes\n")
    const shared = readFileSync(path.join(projects, GLOBAL_PROJECT_ID, "MEMORY.md"), "utf8")
    check("folders outside a repository are merged into the shared one", shared.includes("plain a") && shared.includes("plain b"), shared)
    check("the emptied old folders are gone", [repo, sub, linked, plainA, plainB].every((folder) => !existsSync(path.join(projects, folderMemoryID(folder)))))
    check("an old folder nothing points at is left alone", existsSync(path.join(projects, "0123456789abcdef", "MEMORY.md")))
    check(
      "the old layout is backed up first, untouched",
      Boolean(moved.backup) && readFileSync(path.join(moved.backup!, folderMemoryID(sub), "MEMORY.md"), "utf8").includes("web rule") && existsSync(path.join(moved.backup!, "0123456789abcdef", "MEMORY.md")),
      moved,
    )
    check("it says how much it moved and merged", moved.moved === 5 && moved.merged === 2, moved)
    const again = await migrateMemoryLayout({ dataDirectory: data, directories: [repo, sub], home })
    check("running it again finds nothing to do", again.moved === 0 && !again.backup, again)
    const empty = await migrateMemoryLayout({ dataDirectory: path.join(root, "no-memory"), directories: [repo], home })
    check("a profile with no memory is left as it is", empty.moved === 0 && !existsSync(path.join(root, "no-memory")))
  }

  // ------------------------------------------------------------------ R10-5, R10-13
  section("Round 10 (R10-5, R10-13): what may be written under memory")
  {
    forgetProjectIDs()
    const memoryRoot = path.join(root, "guard", "memory")
    const directory = path.join(root, "plain-a")
    const base = { memoryRoot, directory, sessionID: "ses_main", writeEnabled: true }
    const refused = (target: string, extra: Record<string, unknown> = {}) => memoryWriteRefusal({ ...base, ...extra, target: path.join(memoryRoot, target) })
    check("project memory may be written", refused(path.join("projects", GLOBAL_PROJECT_ID, "MEMORY.md")) === undefined)
    check("so may the global memory and the conversation's notes", refused(path.join("global", "MEMORY.md")) === undefined && refused(path.join("sessions", "ses_main", "notes.md")) === undefined)
    check("another conversation's notes are not refused, as MiMo does not refuse them", refused(path.join("sessions", "ses_other", "notes.md")) === undefined)
    const loose = refused("foo.md")
    check("a file outside the three scopes is refused, naming the right paths", Boolean(loose?.includes(path.join(memoryRoot, "projects", GLOBAL_PROJECT_ID, "MEMORY.md")) && loose.includes(path.join(memoryRoot, "sessions", "ses_main", "notes.md"))), loose)
    check("so is a file straight under projects, which the search could never find", Boolean(refused(path.join("projects", "x.md"))))
    check("and a file that is not markdown", Boolean(refused(path.join("projects", GLOBAL_PROJECT_ID, "data.json"))))
    check("the task folders are refused to the conversation itself", Boolean(refused(path.join("sessions", "ses_main", "tasks", "T1", "progress.md"))))
    check(
      "but a subagent started for that task writes its own folder",
      refused(path.join("sessions", "ses_main", "tasks", "T1", "progress.md"), { sessionID: "ses_child", taskID: "T1", parentID: "ses_main" }) === undefined,
    )
    check("and not another task's", Boolean(refused(path.join("sessions", "ses_main", "tasks", "T2", "progress.md"), { sessionID: "ses_child", taskID: "T1", parentID: "ses_main" })))
    const off = refused(path.join("projects", GLOBAL_PROJECT_ID, "MEMORY.md"), { writeEnabled: false })
    check("with memory.disableWrite every write is refused, and reading is said to still work", Boolean(off?.includes("memory.disableWrite") && off.includes("memory tool")), off)
    check("a path outside memory is not this rule's business", memoryWriteRefusal({ ...base, target: path.join(root, "elsewhere.md") }) === undefined)

    const project = path.join(root, "sandbox-project")
    const outside = sandboxRefusal({ agent: "dream", target: path.join(project, "src", "a.ts"), memoryRoot, projectRoot: project })
    check("/dream may not write the project's files", Boolean(outside?.includes(".mcode")), outside)
    check("but may write memory and the project's .mcode folder", !sandboxRefusal({ agent: "distill", target: path.join(project, ".mcode", "skills", "x", "SKILL.md"), memoryRoot, projectRoot: project }) && !sandboxRefusal({ agent: "dream", target: path.join(memoryRoot, "projects", "p", "MEMORY.md"), memoryRoot, projectRoot: project }))
    check("an ordinary turn is not held to it", !sandboxRefusal({ agent: "build", target: path.join(project, "src", "a.ts"), memoryRoot, projectRoot: project }))

    const doc = { memory: { disableWrite: "yes" }, disabledSkills: ["a", 3] } as never
    const fallback = { memory: undefined } as never
    sanitizeConfig(doc, fallback)
    check("a disableWrite that is not a boolean is dropped, and the skill list keeps its names", JSON.stringify((doc as { memory: unknown }).memory) === "{}" && JSON.stringify((doc as { disabledSkills: unknown }).disabledSkills) === '["a"]', doc)

    const files = { project: "/m/projects/p/MEMORY.md", global: "/m/global/MEMORY.md", notes: "/m/sessions/s/notes.md" }
    check("switched off, the prompt says memory is read-only", memorySection({ ...files, readOnly: true }).includes("do not write or edit any memory file") && !memorySection(files).includes("do not write or edit"))

    // The guard in the write tools, bound as the backend binds it.
    const store = { get: async (id: string) => (id === "ses_child" ? ({ id, parentID: "ses_main", subagent: { type: "general", id: "general-1", taskID: "T1" } } as unknown as SessionInfo) : undefined) }
    bindHistory({ memoryRoot, store } as unknown as HistoryService)
    try {
      const write = (target: string, sessionID = "ses_main", agent?: string) =>
        resolvePath(toolContext(directory, { sessionID, ...(agent ? { plan: { agent } as never } : {}) }), target, "write").then(
          () => "",
          (failure: Error) => failure.message,
        )
      check("the write tools refuse a loose memory file", (await write(path.join(memoryRoot, "loose.md"))).includes("<memory>/<scope>"))
      check("and take a proper one without asking", (await write(path.join(memoryRoot, "sessions", "ses_main", "notes.md"))) === "")
      check("a task's subagent reaches its own folder through them", (await write(path.join(memoryRoot, "sessions", "ses_main", "tasks", "T1", "log.md"), "ses_child")) === "")
      check("/dream is held to memory by them", (await write(path.join(directory, "x.txt"), "ses_main", "dream")).includes("/dream"))
      bindMemoryWrites(() => false)
      check("and memory.disableWrite reaches them", (await write(path.join(memoryRoot, "sessions", "ses_main", "notes.md"))).includes("switched off"))
    } finally {
      bindMemoryWrites(() => true)
      bindHistory(undefined)
    }
  }

  // R10-7: the recall note itself is the agent-tools lane's (reminders recallHint, checked in smoke-round10-agents); a real /dream turn below checks it reaches a request.

  // ------------------------------------------------------------------ R10-8
  section("Round 10 (R10-8): compaction summaries, tool attachments and failed replies are searchable")
  {
    const reply = {
      id: "msg_r10a",
      sessionID: "ses_r10a",
      role: "assistant",
      model: { provider: "p", model: "m" },
      agent: "build",
      parts: [{ type: "tool", id: "prt_r10", callID: "c", name: "read", status: "completed", input: { file_path: "shot.png" }, output: "an image", attachments: [{ path: "/p/diagram-kestrel.png", mime: "image/png", data: "" }], time: { created: 5 } }],
      error: "upstream said capybara-overloaded",
      time: { created: 5 },
    } as unknown as Message
    const rows = rowsOf(reply)
    check("a tool's attachment is indexed with its call", rows.some((row) => row.kind === "tool" && row.body.includes("diagram-kestrel.png") && row.body.includes("image/png")), rows)
    check("a failed reply's error is indexed", rows.some((row) => row.kind === "error" && row.body.includes("capybara-overloaded") && row.part_id === "ses_r10a/msg_r10a/error"), rows)
    const session = { id: "ses_r10a", compacted: { messageID: "msg_r10a", summary: "## Task\n- the axolotl migration", at: 9, files: ["src/axolotl.ts"] } } as SessionInfo
    const row = summaryRow(session)
    check("a compaction summary is a row of its own, filed under the message it ends at", row?.part_id === "ses_r10a/msg_r10a/summary" && row.kind === "summary" && row.body.includes("axolotl migration") && row.body.includes("src/axolotl.ts"), row)
    check("and get reads it back only for that message", summaryPart(session, "msg_r10a")?.text.includes("axolotl") === true && summaryPart(session, "msg_other") === undefined)

    // Through the real index and store.
    const e = await engine()
    try {
      const database = await IndexDatabase.open(path.join(e.dir, "data", "index", "search.db"))
      const index = new HistoryIndex(database, e.store, e.storage, e.bus)
      await index.start()
      const convo = await e.store.create({ directory: e.project, model: e.model, title: "R10-8" })
      await e.store.saveMessage({ id: "msg_r10b", sessionID: convo.id, role: "user", text: "start the pangolin work", attachments: [], time: { created: 10 } }, true)
      await e.store.update(convo.id, { compacted: { messageID: "msg_r10b", summary: "The pangolin work reached the okapi stage", at: 11 } })
      check("a summary written to a conversation is found by search", (await index.search({ query: "okapi" })).some((hit) => hit.part_id.endsWith("/summary")), await index.search({ query: "okapi" }))
      await e.store.saveMessage({ id: "msg_r10b", sessionID: convo.id, role: "user", text: "start the pangolin work again", attachments: [], time: { created: 10 } }, true)
      await index.flush()
      check("writing that message again keeps the summary", (await index.search({ query: "okapi" })).length === 1)
      await e.store.update(convo.id, { compacted: { messageID: "msg_r10b", summary: "Now the tapir stage", at: 12 } })
      check("a newer summary replaces the older one", (await index.search({ query: "okapi" })).length === 0 && (await index.search({ query: "tapir" })).length === 1)
      await index.close()
      await database.close()
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ R10-9
  section("Round 10 (R10-9): the search overlay's ranking")
  {
    check("a match at the start as a whole word scores 1000 + 200 + 80", scoreMatch("zebra crossing", "zebra")?.score === 1280)
    check("inside a word it gets no boundary bonus", scoreMatch("the zebras", "zebra")?.score === 1000 + 196 + 30)
    check("far in, the nearness bonus runs out and never goes below nothing", scoreMatch(`${"x".repeat(300)} zebra`, "zebra")?.score === 1080)
    const scattered = scoreMatch("zoo of brave animals", "zba")
    check("letters in order score 500 less the pieces, the spread and the start", scattered?.score === 500 - 2 * 40 - Math.min(200, 10 - 3) - 0, scattered)
    check("a spread too thin scores nothing and is dropped", scoreMatch(`${"-".repeat(100)}${[..."abcdefg"].join("-".repeat(40))}`, "abcdefg") === undefined && Boolean(scoreMatch(`${[..."abcdefg"].join("-")}`, "abcdefg")))
    check("spaces in the query are matched too", scoreMatch("ab", "a b") === undefined)
    const snip = snippetOf(`${"y".repeat(100)}needle${"z".repeat(100)}`, [{ start: 100, end: 106 }])
    check("a snippet keeps 40 either side and moves the ranges", snip.text.startsWith("…") && snip.text.endsWith("…") && snip.text.slice(snip.ranges[0]!.start, snip.ranges[0]!.end) === "needle", snip)
    const tool = { type: "tool", id: "t", callID: "c", name: "bash", status: "completed", input: {}, output: "build log: wombat-error at line 3", time: { created: 1 } } as ToolPart
    const messages = [
      { id: "m1", sessionID: "s", role: "user", text: "look at the wombatish thing", attachments: [], time: { created: 1 } },
      { id: "m2", sessionID: "s", role: "assistant", model: { provider: "p", model: "m" }, agent: "build", parts: [{ type: "reasoning", id: "r", text: "wombat", time: { created: 1 } }, tool], time: { created: 2 } },
    ] as unknown as Message[]
    check("a message is read with its steps' output", messageText(messages[1]!).includes("wombat-error") && !messageText(messages[1]!).includes("reasoning"))
    const best = findInMessages(messages, "wombat")
    check("the best-scoring message is chosen, not the first", best?.messageID === "m2" && best.score === scoreMatch(messageText(messages[1]!), "wombat")!.score, best)
    check("what is read of a message stops at 20,000 characters", messageText({ ...(messages[0] as object), text: "a".repeat(30_000) } as Message).length === MESSAGE_SEARCH_CHARS)
    const sessions = [
      { id: "old", updated: 1 },
      { id: "new", updated: 2 },
    ] as unknown as SessionInfo[]
    const found = await searchMessages(sessions, async (id) => (id === "old" ? messages.slice(1) : [{ ...(messages[0] as object), text: "zzzwombatzzz" } as Message]), "wombat")
    check("conversations come back best match first, whatever their age", found.map((hit) => hit.sessionID).join() === "old,new" && found[0]!.score > found[1]!.score, found)
  }

  // ------------------------------------------------------------------ R10-10
  section("Round 10 (R10-10): the first global instruction file that exists is the one read")
  {
    const project = path.join(root, "instructions", "project")
    await put(path.join(project, "AGENTS.md"), "PROJECT-RULES")
    const globalAgents = path.join(root, "instructions", "data", "AGENTS.md")
    await put(path.join(home, ".claude", "CLAUDE.md"), "CLAUDE-HOME-RULES")
    await put(globalAgents, "GLOBAL-AGENTS-RULES")
    const both = await systemPrompt({ directory: project, agent: "build", globalAgentsFile: globalAgents, home })
    check("with a global AGENTS.md, ~/.claude/CLAUDE.md is not read", both.includes("GLOBAL-AGENTS-RULES") && !both.includes("CLAUDE-HOME-RULES"))
    check("the global file comes after the project's own, labelled with its path", both.indexOf("PROJECT-RULES") < both.indexOf("GLOBAL-AGENTS-RULES") && both.includes(`<instructions source="${globalAgents}">`))
    check("and appears once", both.split("GLOBAL-AGENTS-RULES").length === 2)
    await fs.rename(globalAgents, `${globalAgents}.disabled`)
    const off = await systemPrompt({ directory: project, agent: "build", globalAgentsFile: globalAgents, home })
    check("switched off, CLAUDE.md is read in its place", off.includes("CLAUDE-HOME-RULES") && !off.includes("GLOBAL-AGENTS-RULES"))
    await put(globalAgents, "")
    const blank = await systemPrompt({ directory: project, agent: "build", globalAgentsFile: globalAgents, home })
    check("an empty global AGENTS.md still ends the search, as MiMo's does", !blank.includes("CLAUDE-HOME-RULES"))
  }

  // ------------------------------------------------------------------ R10-11
  section("Round 10 (R10-11): the first title leaves the skill chips out")
  {
    const names = new Set(["docx", "pdf"])
    check("leading chips go", withoutSkillPrefix("/docx /pdf 帮我整理报告", names) === "帮我整理报告")
    check("an unknown command stays", withoutSkillPrefix("/deploy now", names) === "/deploy now")
    check("a chip in the middle stays", withoutSkillPrefix("use /docx here", names) === "use /docx here")
    check("chips alone leave the attachments to name it", fallbackTitle(withoutSkillPrefix("/docx", names), [{ path: "C:/a/report.docx" }]) === "report.docx")
    check("a chip on its own line goes with the line break", withoutSkillPrefix("/pdf\nsummarise this", names) === "summarise this")
  }

  // ------------------------------------------------------------------ R10-12
  section("Round 10 (R10-12): the memory-search skill")
  {
    const scan = await discoverSkills({ directory: root, builtinRoot: undefined, storageDirectory: path.join(root, "no-storage") })
    const skill = scan.skills.find((entry) => entry.name === "memory-search")
    check("it ships with the app", Boolean(skill?.builtin), scan.skills.map((entry) => entry.name))
    const body = skill?.content ?? ""
    check("it names the index, its tables and read-only access", ["index/search.db", "history_part", "memory_doc", "mode=ro"].every((word) => body.includes(word)))
    const e = await engine()
    try {
      const file = path.join(e.dir, "data", "index", "search.db")
      const database = await IndexDatabase.open(file)
      const index = new HistoryIndex(database, e.store, e.storage, e.bus)
      await index.start()
      const convo = await e.store.create({ directory: e.project, model: e.model, title: "R10-12" })
      await e.store.saveMessage({ id: "msg_r10c", sessionID: convo.id, role: "user", text: "always deploy to staging first", attachments: [], time: { created: Date.now() } }, true)
      await index.flush()
      await index.close()
      await database.close()
      const reader = new DatabaseSync(file, { readOnly: true })
      const project = (reader.prepare("SELECT project FROM history_session WHERE session_id = ?").get(convo.id) as { project: string }).project
      const queries = [...body.matchAll(/```sql\n([\s\S]*?)```/g), ...agentPrompt("dream").matchAll(/```sql\n([\s\S]*?)```/g), ...agentPrompt("distill").matchAll(/```sql\n([\s\S]*?)```/g)].map((match) =>
        match[1]!.replace(/<session id>|<conversation id>/g, convo.id).replace(/<project id>/g, project).replace(/<cutoff ms>/g, "0"),
      )
      const ran = queries.map((query) => {
        try {
          return { ok: true, rows: reader.prepare(query).all().length }
        } catch (failure) {
          return { ok: false, error: String(failure), query }
        }
      })
      reader.close()
      check("every query the skill and the two passes give runs on a real index", queries.length >= 6 && ran.every((entry) => entry.ok), ran)
      check("the phrase query finds what the user said", ran.some((entry) => "rows" in entry && entry.rows === 1))
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ R10-14
  section("Round 10 (R10-14): a broken SKILL.md is reported once")
  {
    const storage = path.join(root, "skills-storage")
    await put(path.join(storage, "skills", "broken", "SKILL.md"), "---\nname: broken\nthis is not yaml\n---\nbody\n")
    await put(path.join(storage, "skills", "nameless", "SKILL.md"), "---\ndescription: no name here\n---\nbody\n")
    const heard: SkillProblem[] = []
    watchSkillProblems((problem) => heard.push(problem))
    try {
      const first = await discoverSkills({ directory: root, storageDirectory: storage, builtinRoot: null })
      await discoverSkills({ directory: root, storageDirectory: storage, builtinRoot: null })
      check("a frontmatter that will not parse is reported", heard.length === 1 && heard[0]!.path.endsWith(path.join("broken", "SKILL.md")) && heard[0]!.kind === "syntax", { heard, problems: first.problems })
      check("a missing name is skipped without a word to the user", first.problems.some((problem) => problem.kind === "invalid") && !heard.some((problem) => problem.path.includes("nameless")))
      await put(path.join(storage, "skills", "broken", "SKILL.md"), skillFile("broken", "fixed now"))
      await discoverSkills({ directory: root, storageDirectory: storage, builtinRoot: null })
      await put(path.join(storage, "skills", "broken", "SKILL.md"), "---\nname: broken\nthis is not yaml\n---\nbody\n")
      await discoverSkills({ directory: root, storageDirectory: storage, builtinRoot: null })
      check("fixed and then broken again, it is reported again", heard.length === 2, heard)
    } finally {
      watchSkillProblems(undefined)
      await fs.rm(path.join(storage, "skills"), { recursive: true, force: true })
    }
  }

  // ------------------------------------------------------------------ R10-1, R10-2
  section("Round 10 (R10-1, R10-2): switching skills off, the skill card and uninstalling")
  {
    const storage = path.join(root, "skill-data")
    const project = path.join(root, "skill-project")
    await fs.mkdir(path.join(project, ".git"), { recursive: true })
    await put(path.join(storage, "skills", "mine", "SKILL.md"), skillFile("mine", "My own global skill", "icon: 🦊\n"))
    await put(path.join(storage, "skills", "mine", "locales", "zh-CN.json"), JSON.stringify({ displayName: "我的技能", brief: "一句话简介" }))
    await put(path.join(storage, "skills", "mine", "locales", "bad.json"), "{")
    await put(path.join(project, ".mcode", "skills", "theirs", "SKILL.md"), skillFile("theirs", "The project's skill"))
    await put(path.join(storage, "skills", "big", "SKILL.md"), `---\nname: big\ndescription: large\n---\n${"x".repeat(200_100)}`)
    const scan = await discoverSkills({ directory: project, storageDirectory: storage })
    const byName = (name: string) => scan.skills.find((entry) => entry.name === name)!
    check("off means gone from the list every consumer reads", enabledSkills(scan.skills, ["mine"]).every((entry) => entry.name !== "mine") && enabledSkills(scan.skills, undefined).length === scan.skills.length)
    const deps = (disabledSkills?: string[]) => ({
      config: { get: () => ({ disabledSkills }) },
      mcp: { prompts: async () => ({}), getPrompt: async () => "" },
      storage: { directory: storage },
      home,
    })
    const listed = await listCommands(deps(["mine", "docx"]) as never, project)
    check("a switched-off skill leaves the slash menu, a shipped one too", !listed.some((entry) => entry.name === "mine" || entry.name === "docx") && listed.some((entry) => entry.name === "theirs"), listed.map((entry) => entry.name))
    check("the icon and translated names are read", byName("mine").icon === "🦊" && byName("mine").localizations?.["zh-CN"]?.displayName === "我的技能" && !("bad" in (byName("mine").localizations ?? {})))
    const summary = { name: "mine", description: "My own global skill", builtin: false, enabled: true, removable: true, location: "", localizations: byName("mine").localizations }
    check("the card shows the translated name and summary in that language", skillTitle(summary, "zh-CN") === "我的技能" && skillBrief(summary, "zh-CN") === "一句话简介" && skillTitle(summary, "en") === "mine")
    check("an English-only description is not shown under Chinese, as MiMo hides it", skillDescription(summary, "zh-CN") === "" && skillDescription(summary, "en") === "My own global skill")
    check("a Chinese description is not shown under English", skillDescription({ ...summary, description: "中文说明" }, "en") === "" && skillDescription({ ...summary, description: "中文说明" }, "ja") === "中文说明")
    const read = await readSkillFile(byName("mine").location)
    check("the card reads the whole SKILL.md, frontmatter too", Boolean(read?.content.startsWith("---\nname: mine")) && read?.truncated === false)
    const long = await readSkillFile(byName("big").location)
    check("and stops a long one at 200,000 characters, saying so", long?.content.length === 200_000 && long.truncated === true)
    check("only the user's own global skills can be uninstalled", removableSkill(byName("mine"), storage) && !removableSkill(byName("theirs"), storage) && !removableSkill(byName("docx"), storage))
    const trash = await uninstallSkill(byName("mine"), storage, 1_700_000_000_000)
    check("uninstalling moves the folder to the skill trash, nothing is deleted", !existsSync(path.join(storage, "skills", "mine")) && trash === path.join(storage, "skill-trash", "1700000000000-mine") && existsSync(path.join(trash, "SKILL.md")))
    check("a project's skill is refused", await uninstallSkill(byName("theirs"), storage).then(() => false, () => true))

    // Through a real turn: a switched-off skill is not in the prompt and is not loaded by /name.
    const e = await engine()
    try {
      await e.config.set({ disabledSkills: ["docx"] })
      const convo = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: convo.id, text: "/docx /pdf make a report" })
      await e.idle(convo.id)
      const sent = JSON.stringify(e.bodies.at(-1)?.messages ?? [])
      check("the prompt lists the skills that are on and not the one that is off", sent.includes("<name>pdf</name>") && !sent.includes("<name>docx</name>"))
      check("/name loads a skill that is on and not one that is off", sent.includes('loaded_skill name=\\"pdf\\"') && !sent.includes('loaded_skill name=\\"docx\\"'))
      const chipped = await e.store.create({ directory: e.project, model: e.model })
      await e.runner.prompt({ sessionID: chipped.id, text: "/pdf make a report" })
      await e.idle(chipped.id)
      const fallbackTitles = e.events.flatMap((event) => (event.type === "session.updated" && event.session.id === chipped.id && event.session.titleSource === "fallback" ? [event.session.title] : []))
      check("the first title leaves the chips out (R10-11)", fallbackTitles[0] === "make a report", fallbackTitles)
      check("and so does what the title model is asked", e.titleBodies.some((body) => JSON.stringify(body).includes("make a report") && !JSON.stringify(body).includes("/pdf make")))
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ R10-3, R10-4
  section("Round 10 (R10-3, R10-4): MiMo's own slash commands, and the filter by name")
  {
    const project = path.join(root, "cmd-project")
    await fs.mkdir(path.join(project, ".git"), { recursive: true })
    await fs.mkdir(path.join(project, "src"), { recursive: true })
    const deps = (commands?: Record<string, unknown>) => ({
      config: { get: () => ({ commands }) },
      mcp: { prompts: async () => ({}), getPrompt: async () => "" },
      storage: { directory: path.join(root, "cmd-storage") },
      home,
    })
    const listed = await listCommands(deps() as never, path.join(project, "src"))
    check("the list opens with /init /review /dream /distill /rebuild, in that order", listed.slice(0, 5).map((entry) => entry.name).join() === "init,review,dream,distill,rebuild", listed.slice(0, 6).map((entry) => entry.name))
    const named = (name: string) => listed.find((entry) => entry.name === name) ?? { name, source: "command" as const, template: "", hints: [] }
    check("they are commands of the app's own, with a description each", listed.slice(0, 5).every((entry) => entry.source === "command" && entry.own === true && Boolean(entry.description)))
    check("/review runs as a subagent", named("review").subtask === true && named("review").hints.join() === "$ARGUMENTS")
    check("/dream and /distill run as their own agent, in this conversation", named("dream").agent === "dream" && named("dream").subtask === false && named("distill").agent === "distill")
    check("/init names the repository's top for AGENTS.md", named("init").template.includes(`\`${project}\``) && !named("init").template.includes("${path}"))
    check("no other product is named in them", listed.slice(0, 5).every((entry) => !/opencode|mimo/i.test(entry.template)))
    const replaced = await listCommands(deps({ init: { template: "my own init", description: "mine" } }) as never, project)
    check("a user's command of the same name replaces one in its place", replaced[0]?.name === "init" && replaced[0].template === "my own init" && !replaced[0].own)
    const expanded = await expandCommand(deps() as never, { directory: project, name: "dream", arguments: "focus on the build" }).catch(() => ({ prompt: "", files: [] }))
    check("sending one fills in what was typed after it", expanded.prompt.includes("focus on the build") && !expanded.prompt.includes("$ARGUMENTS"))
    check("the consolidation agents get only their own tools", toolsFor("dream").map((tool) => tool.name).sort().join() === "bash,edit,glob,grep,memory,read,write" && toolsFor("distill").length === 7)
    check("and their own prompt", agentPrompt("dream").startsWith("# Dream") && agentPrompt("distill").startsWith("# Distill") && !agentPrompt("dream").includes("You are MCode"))

    // A /dream turn through the real runner.
    const e = await engine()
    const memoryRoot = path.join(e.dir, "data", "memory")
    bindHistory({ memoryRoot, store: e.store } as unknown as HistoryService)
    try {
      const convo = await e.store.create({ directory: e.project, model: e.model })
      const memoryFile = memoryFiles(memoryRoot, e.project, convo.id).project
      e.replies.push(
        calls([
          { name: "write", input: { file_path: path.join(e.project, "stray.txt"), content: "no" } },
          { name: "write", input: { file_path: memoryFile, content: "# Project memory\n- kept\n" } },
        ]),
        say("tidied"),
      )
      const prompt = expanded.prompt || "Tidy this project's memory once, now."
      await e.runner.prompt({ sessionID: convo.id, text: prompt, agent: "dream" })
      await e.idle(convo.id)
      const first = e.bodies.at(-2)
      const tools = ((first?.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name).sort()
      check("the turn is offered only the dream agent's tools", tools.join() === "bash,edit,glob,grep,memory,read,write", tools)
      check("and reads the dream prompt", JSON.stringify(first?.messages?.[0] ?? "").includes("# Dream: tidying project memory"))
      const parts = (await e.assistants(convo.id)).flatMap((message) => message.parts).filter((part): part is ToolPart => part.type === "tool")
      check("a write outside memory is refused", parts.some((part) => part.status === "error" && (part.error ?? "").includes("/dream")) && !existsSync(path.join(e.project, "stray.txt")), parts.map((part) => part.error))
      check("a write to project memory goes through without a question", readFileSync(memoryFile, "utf8").includes("- kept") && !e.events.some((event) => event.type === "permission.requested"))
      const after = await e.store.get(convo.id)
      check("the conversation keeps its own agent afterwards", after?.agent === "build")
      // R10-7 through the runner: this conversation now has memory of its own? Its notes folder is empty, so no note.
      check("no recall note while the conversation has kept nothing", !JSON.stringify(e.bodies.at(-1)?.messages ?? "").includes("keeps memory in"))
      await put(memoryFiles(memoryRoot, e.project, convo.id).notes, "## [turn 1]\nsomething")
      await e.runner.prompt({ sessionID: convo.id, text: "carry on" })
      await e.idle(convo.id)
      const last = e.bodies.at(-1)?.messages as { role: string; content: unknown }[]
      const lastUser = [...last].reverse().find((message) => message.role === "user")
      check("once it has, the request carries the recall note after the last user message", JSON.stringify(lastUser?.content ?? "").includes("keeps memory in"), lastUser)
      check("the transcript does not", !(await e.store.messages(convo.id)).some((message) => message.role === "user" && message.text.includes("keeps memory in")))
    } finally {
      bindHistory(undefined)
      await e.close()
    }

    // R10-4: the slash menu's filter reads names, word by word.
    check("a query must begin a word of the name", wordMatch("review", "rev") && !wordMatch("docx", "cx"))
    check("camelCase and hyphenated names count their parts", wordMatch("frontend-design", "des") && wordMatch("skillCreator", "crea"))
    check("a Chinese query matches anywhere in the name", wordMatch("中文技能", "技能"))
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
