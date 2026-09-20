/**
 * Round 17, lane W: version control, the review tab, worktrees, subagents and
 * scheduled tasks (R17-W1 onwards).
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundSeventeenWorkflowChecks` with its own check and section.
 *
 * The subagent checks run whole turns through the real runner over a fake
 * provider that answers by what it is asked, so a gate that stops holding
 * fails here rather than in the window. Everything runs in temporary folders
 * of its own: nothing reads the user's profile, calls a real model or reaches
 * the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import type { Check } from "./smoke-round5"
import type { AssistantPart, AutomationTask, Message, ToolPart } from "../src/shared/protocol"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { SUBAGENT_LIMIT } from "../src/server/session/semaphore"
import { bindHistory, bindMemoryWrites, type HistoryService } from "../src/server/history/service"
import { turnFilePaths } from "../src/server/session/turn-revert"
import { editedFiles } from "../src/renderer/src/lib/edited-files"
import { createdFile, parseUnifiedDiff, sectionCreates } from "../src/shared/unified-diff"
import { actorAction } from "../src/shared/subagent"
import { worktreeNotice } from "../src/server/session/worktree"
import { MAX_PROGRESS_REACT, PROGRESS_SECTIONS, missingProgressSections, progressPath, progressReminder, progressTemplate } from "../src/server/session/task-progress"
import { AutomationService, scheduleKey, type AutomationDeps } from "../src/server/automation/service"
import { LEASE_MS } from "../src/server/automation/run-queue"
import { automationLines } from "../src/renderer/src/lib/convo-card"
import { checkout } from "../src/server/git"

type Section = (name: string) => void

export async function roundSeventeenWorkflowChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r17w-"))
  const titles = process.env.MCODE_GENERATE_TITLES
  process.env.MCODE_GENERATE_TITLES = "0"
  try {
    diffChecks(check, section)
    noticeChecks(check, section)
    await sourceChecks(check, section)
    await gitChecks(check, section, root)
    await automationChecks(check, section, root)
    await subagentChecks(check, section, root)
  } finally {
    if (titles === undefined) delete process.env.MCODE_GENERATE_TITLES
    else process.env.MCODE_GENERATE_TITLES = titles
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/* ---------------------------------------------------------------- the diffs a turn leaves */

const NOTEBOOK_DIFF = ["--- a/notes.ipynb", "+++ b/notes.ipynb", "@@ -3,2 +3,2 @@", "-  one", "+  two", "   three"].join("\n")
const NEW_FILE_DIFF = ["--- a/fresh.ts", "+++ b/fresh.ts", "@@ -1,0 +1,2 @@", "+export const a = 1", "+export const b = 2"].join("\n")
const GIT_NEW_FILE_DIFF = ["--- /dev/null", "+++ b/fresh.ts", "@@ -0,0 +1,1 @@", "+export const a = 1"].join("\n")

function toolPart(name: string, diff: string, extra: Record<string, unknown> = {}, status: ToolPart["status"] = "completed"): ToolPart {
  return { type: "tool", id: `prt_${name}`, callID: `call_${name}`, name, status, input: {}, metadata: { diff, filediff: { file: "x", patch: diff }, ...extra } } as ToolPart
}

function turnOf(parts: AssistantPart[]): Message[] {
  return [{ id: "msg_1", sessionID: "s", role: "assistant", model: { provider: "p", model: "m" }, agent: "build", parts, time: { created: 1 } } as Message]
}

function diffChecks(check: Check, section: Section): void {
  section("Round 17 (R17-W1): a notebook edit draws its card and can be taken back")
  {
    const parts = [toolPart("notebook_edit", NOTEBOOK_DIFF)]
    check("the card counts the notebook's lines", editedFiles(parts).files[0]?.path === "notes.ipynb" && editedFiles(parts).add === 1 && editedFiles(parts).del === 1, editedFiles(parts))
    const paths = turnFilePaths(path.resolve("/project"), turnOf(parts))
    check("and the undo has a file to put back", paths.length === 1 && paths[0]?.endsWith("notes.ipynb") === true, paths)
  }

  section("Round 17 (R17-W6): a new file is recognised from the patch when the flag is gone")
  {
    const [fresh] = parseUnifiedDiff(NEW_FILE_DIFF)
    const [git] = parseUnifiedDiff(GIT_NEW_FILE_DIFF)
    const [edited] = parseUnifiedDiff(NOTEBOOK_DIFF)
    check("git's own header is read", git !== undefined && git.oldFile === "/dev/null" && sectionCreates(git))
    check("and this app's equivalent - one hunk from the top that removes nothing", fresh !== undefined && sectionCreates(fresh))
    check("a patch that changes an existing file is not one", edited !== undefined && !sectionCreates(edited))
    check("what the call recorded still wins", createdFile(false, fresh!) === false && createdFile(true, edited!) === true)
    check("and the patch answers only where it recorded nothing", createdFile(undefined, fresh!) === true && createdFile(undefined, edited!) === false)
    check("a write with no flag is taken back as a new file", editedFiles([toolPart("write", NEW_FILE_DIFF)]).files[0]?.created === true)
  }

  section("Round 17 (R17-W7): the card and the undo agree on what a turn changed")
  {
    const rejected = [toolPart("write", NEW_FILE_DIFF, {}, "rejected" as ToolPart["status"])]
    check("a call that ended rejected is on the card", editedFiles(rejected).files.length === 1)
    check("and the undo sees the same file", turnFilePaths(path.resolve("/project"), turnOf(rejected)).length === 1)
    const failed = [toolPart("write", NEW_FILE_DIFF, {}, "error")]
    check("a call that ended in an error is on neither", editedFiles(failed).files.length === 0 && turnFilePaths(path.resolve("/project"), turnOf(failed)).length === 0)
    const outside = [toolPart("edit", ["--- a/x", "+++ b/" + path.resolve("/elsewhere/away.ts").split(path.sep).join("/"), "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n"))]
    const project = path.resolve("/project")
    check("a file outside the project is kept for the card, which the undo reports on", editedFiles(outside, project, { outside: true }).files.length === 1)
    check("and left out of the composer's count", editedFiles(outside, project).files.length === 0)
  }
}

/* ---------------------------------------------------------------- what the model is told */

function noticeChecks(check: Check, section: Section): void {
  section("Round 17 (R17-W10): the worktree notice says what to do, not only what happened")
  {
    const linked = worktreeNotice("/repo", true)
    const alone = worktreeNotice("/repo", false)
    for (const [name, text] of [["in a repository that keeps worktrees", linked], ["in one that does not", alone]] as const) {
      check(`${name}: the reason concurrent writes matter is given`, /other agents/i.test(text) && /committed/i.test(text), text)
      check(`${name}: the rule is about repositories, not this one path`, /another repository/i.test(text), text)
    }
    check("with worktrees: it is told not to ask, and to move before writing", /do not need to ask/i.test(linked) && /before your next write/i.test(linked), linked)
    check("without: it is told to ask, and what each answer leads to", /ask the user/i.test(alone) && /say yes/i.test(alone) && /say no/i.test(alone), alone)
    check("and still not to make one on its own", /do not make a worktree on your own/i.test(alone), alone)
  }

  section("Round 17 (R17-W12): the record a subagent working on a task leaves")
  {
    check("MiMo's bound on how often it is sent back is three", MAX_PROGRESS_REACT === 3, MAX_PROGRESS_REACT)
    check("there are five sections", PROGRESS_SECTIONS.length === 5, PROGRESS_SECTIONS)
    const filled = progressTemplate("T1.2")
    check("the template carries all five and the task's own id", missingProgressSections(filled).length === 0 && filled.includes("T1.2"), filled)
    check("a file missing one is named exactly", missingProgressSections(filled.replace(PROGRESS_SECTIONS[3], "## Other")).join() === PROGRESS_SECTIONS[3])
    const missing = progressReminder("T1", "/m/progress.md", [...PROGRESS_SECTIONS])
    const partial = progressReminder("T1", "/m/progress.md", [PROGRESS_SECTIONS[4]])
    check("a missing file is asked for by path, inside one system-reminder", missing.startsWith("<system-reminder>") && missing.endsWith("</system-reminder>") && missing.includes("/m/progress.md"), missing)
    check("an incomplete one names what is not in it", partial.includes(PROGRESS_SECTIONS[4]) && /not in it/i.test(partial), partial)
    check("both hand back the whole template", missing.includes(PROGRESS_SECTIONS[0]) && partial.includes(PROGRESS_SECTIONS[0]))
    check("the path is the folder the memory guard already carved out", progressPath("/m", "ses_1", "T1") === path.join("/m", "sessions", "ses_1", "tasks", "T1", "progress.md"))
  }

  section("Round 17 (R17-W14): a flat background call spawns instead of blocking")
  {
    check("background: true is a spawn", actorAction({ description: "d", prompt: "p", subagent_type: "general", background: true }) === "spawn")
    check("async: true is too", actorAction({ async: true }) === "spawn")
    check("a call that names its action is unaffected", actorAction({ action: "run", background: true }) === "run")
    check("and one that names neither is still a run", actorAction({ description: "d" }) === "run")
    check("wrapped in MiMo's operation object it reads the same", actorAction({ operation: { background: true } }) === "spawn")
  }

  section("Round 17 (R17-W26): a conversation's tooltip says which scheduled task it belongs to")
  {
    const tasks: AutomationTask[] = [
      { id: "auto-1", title: "Daily digest", targetThreadId: "ses_target", nextAt: new Date(2026, 0, 3, 9, 0).getTime(), runs: [{ sessionID: "ses_run", at: new Date(2026, 0, 2, 9, 0).getTime() }] },
    ]
    const ofRun = automationLines("ses_run", tasks)
    const ofTarget = automationLines("ses_target", tasks)
    check("a conversation a run opened names the task and when it ran", ofRun.length === 2 && ofRun[0]!.includes("Daily digest") && /02|Jan/.test(ofRun[1]!), ofRun)
    check("the conversation the task runs in is told when it next runs", ofTarget.length === 2 && ofTarget[0]!.includes("Daily digest") && /03|Jan/.test(ofTarget[1]!), ofTarget)
    check("a conversation with nothing to do with a task gets no block", automationLines("ses_other", tasks).length === 0)
    check("a paused task says only its name", automationLines("ses_target", [{ ...tasks[0]!, nextAt: undefined }]).length === 1)
  }
}

/* ---------------------------------------------------------------- the window's side, read from the source */

/**
 * Several of this lane's fixes are one line inside a component, which a probe
 * measures and this cannot. What is checked here is that the line is still
 * there and still says what it was put there to say - the same way round 11
 * checks the shapes it left in the runner and the main process.
 */
async function sourceChecks(check: Check, section: Section): Promise<void> {
  const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8")

  section("Round 17 (R17-W2/W4/W5): the review tab and the branch menu")
  {
    const review = await read("src/renderer/src/components/right/RpReview.vue")
    check(
      "a file the reader chose clears the diff first, and a background re-read keeps it",
      /loadPatch\(file: string \| undefined, keepStale = false\)/.test(review) && /if \(!keepStale\) patch\.value = undefined/.test(review) && /loadPatch\(selected\.value, true\)/.test(review),
    )
    const picker = await read("src/renderer/src/components/BranchPicker.vue")
    const created = picker.slice(picker.indexOf("if (result.ok) {"), picker.indexOf("if (result.ok) {") + 300)
    check("making a branch leaves the field, not the menu", created.includes("creating.value = false") && !created.includes("open.value = false"), created.slice(0, 200))
    const switching = await read("src/renderer/src/lib/branch-switch.ts")
    check("a branch list that came back without a repository says so", /if \(!state\?\.repo \|\| !Array\.isArray\(state\.branches\)\) error\.value = t\("info\.branchListUnavailable"\)/.test(switching))
    const card = await read("src/renderer/src/components/InfoCommitCard.vue")
    check("the commit card falls back to the known branch, then to unknownBranch", /props\.knownBranch \?\? t\(stateLoading\.value && !state\.value \? "info\.loadingBranch" : "info\.unknownBranch"\)/.test(card))
    const environment = await read("src/renderer/src/components/InfoEnvironment.vue")
    check("and the environment row hands it the branch it has already read", /:known-branch="summary\.branch"/.test(environment))
  }

  section("Round 17 (R17-W9/W13/W21): the worktree pick, the subagent panel and the run's notice")
  {
    const home = await read("src/renderer/src/components/HomeHero.vue")
    const used = home.slice(home.indexOf("async function useWorktree"), home.indexOf("async function useWorktree") + 300)
    check("a worktree switched to is added to the project list before it is picked", used.includes("app.addProject(directory, { used: true })") && used.indexOf("addProject") < used.indexOf("choose(directory)"), used)
    const editedCard = await read("src/renderer/src/components/EditedFilesCard.vue")
    check("the card lists the files a run reached outside the project, which its undo reports on", /editedFiles\(props\.parts, props\.directory, \{ outside: true \}\)/.test(editedCard))
    const panel = await read("src/renderer/src/components/right/RpSubagents.vue")
    const box = panel.slice(panel.indexOf(".rp-subagent-transcript {"), panel.indexOf(".rp-subagent-transcript {") + 400)
    check("a subagent's transcript is a boxed panel of its own, scrolling inside 320", /max-height: 320px/.test(box) && /border: 1px solid/.test(box) && /overflow: auto/.test(box), box)
    const app = await read("src/renderer/src/App.vue")
    check(
      "a scheduled run's notice is silent when the chime already played for it",
      /automationChimed\.set\(turn\.sessionID, chiming\)/.test(app) && /silent: chimed/.test(app) && !/taskNotice\(\{ kind: notice\.failed \? "failed" : "done", \.\.\.noticeAbout\(notice\.sessionID\), silent: false \}\)/.test(app),
    )
  }

  section("Round 17 (R17-W11/W16/W24): the transcript read back, and two tool descriptions")
  {
    const runner = await read("src/server/session/runner.ts")
    const hit = runner.slice(runner.indexOf("private async worktreeHit("), runner.indexOf("private async worktreeHit(") + 900)
    check(
      "a pending worktree hit is read back out of the stored messages once",
      /if \(this\.worktreeScanned\.has\(sessionID\)\) return undefined/.test(hit) && /this\.worktreeScanned\.add\(sessionID\)/.test(hit) && hit.includes("await this.store.messages(sessionID)") && hit.includes("changedMainWorktree"),
      hit.slice(0, 200),
    )
    const actorTool = await read("src/server/tool/subagent.ts")
    check("send takes MiMo's to_session_id and type rather than refusing them", /to_session_id: \{ type: "string"/.test(actorTool) && /type: \{ type: "string"/.test(actorTool))
    check("and status names MiMo's pending", /pending \(started, still queued behind others\)/.test(actorTool))
    const automationTool = await read("src/server/tool/automation.ts")
    check("the automation tool says what deduplicated means, and to read the task back", /deduplicated: true/.test(automationTool) && /view the task again/.test(automationTool))
  }
}

/* ---------------------------------------------------------------- git */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
}

async function gitChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 17 (R17-W8): a checkout that failed says all of what git said")
  {
    const repo = path.join(root, "repo")
    await fs.mkdir(repo, { recursive: true })
    git(repo, ["init", "-q", "-b", "main"])
    git(repo, ["config", "user.email", "a@b.c"])
    git(repo, ["config", "user.name", "A"])
    await fs.writeFile(path.join(repo, "a.txt"), "one\n", "utf8")
    git(repo, ["add", "-A"])
    git(repo, ["commit", "-qm", "first"])
    git(repo, ["branch", "other"])
    /*
     * An index lock is git's one reliably multi-line failure: the first line
     * names the file, and the sentences that say what to do about it come
     * after. Keeping only the first line dropped exactly those.
     */
    await fs.writeFile(path.join(repo, ".git", "index.lock"), "", "utf8")
    const refused = await checkout(repo, "other")
    await fs.rm(path.join(repo, ".git", "index.lock"), { force: true })
    const said = refused.error ?? ""
    check("the checkout was refused", refused.ok === false, refused)
    check("and every line git wrote is kept, up to 300 characters", said.includes("\n") && said.length <= 300, said)
  }
}

/* ---------------------------------------------------------------- scheduled tasks */

async function automationChecks(check: Check, section: Section, root: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(root, "auto-"))
  const project = path.join(dir, "project")
  await fs.mkdir(project, { recursive: true })
  let clock = new Date(2026, 0, 2, 10, 0).getTime()
  const busy = new Set<string>()
  const prompts: { sessionID: string }[] = []
  const sessions = new Map<string, { id: string; directory: string }>()
  const messages = new Map<string, Message[]>()
  let made = 0
  let promptThrows: string | undefined
  /** Held open so the check that started the run never reports on its queue entry. */
  let promptHangs: Promise<void> | undefined
  const deps: AutomationDeps = {
    file: path.join(dir, "automations.json"),
    now: () => clock,
    sessions: {
      get: async (id) => (sessions.has(id) ? ({ id, directory: project, model: { provider: "fake", model: "m" } } as never) : undefined),
      create: async () => {
        const id = `ses_auto_${++made}`
        sessions.set(id, { id, directory: project })
        messages.set(id, [])
        return { id, directory: project, model: { provider: "fake", model: "m" } } as never
      },
      messages: async (id) => messages.get(id) ?? [],
      delete: async (id) => void sessions.delete(id),
    },
    prompt: async (input) => {
      if (promptThrows) throw new Error(promptThrows)
      prompts.push({ sessionID: input.sessionID })
      busy.add(input.sessionID)
      if (promptHangs) {
        const held = promptHangs
        promptHangs = undefined
        await held
      }
    },
    busy: (id) => busy.has(id),
    models: () => [{ provider: "fake", id: "m", name: "M" }],
    agent: () => "build",
    effort: () => undefined,
    scratch: async () => project,
    publish: () => {},
  }
  const home = "ses_home"
  sessions.set(home, { id: home, directory: project })
  messages.set(home, [])
  const service = new AutomationService(deps)
  await service.start({ interval: false })
  const call = async (input: Record<string, unknown>) => JSON.parse(await service.handle(input, { sessionID: home })) as { automation?: { id: string } }
  const daily = "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0"

  section("Round 17 (R17-W17): resuming a paused task does not fire a run that is already past")
  {
    await call({ mode: "create", title: "Digest", prompt: "Summarise", rrule: daily, runMode: "new-task" })
    await call({ mode: "pause", id: "auto-1" })
    check("a paused task has no next run", service.dueAt("auto-1") === undefined)
    // Past this morning's nine o'clock: counted from the old anchor it would be due at once.
    clock = new Date(2026, 0, 3, 14, 0).getTime()
    await call({ mode: "resume", id: "auto-1" })
    check("resuming counts from now, so the next run is tomorrow", service.dueAt("auto-1") === new Date(2026, 0, 4, 9, 0).getTime(), service.dueAt("auto-1"))
    const before = prompts.length
    await service.tick()
    check("and nothing fires in the same second", prompts.length === before, prompts)
  }

  section("Round 17 (R17-W20/W23): a busy conversation, and what a run's record keeps")
  {
    await call({ mode: "update", id: "auto-1", runMode: "existing-task", targetThreadId: home, notification: "failed-runs" })
    busy.add(home)
    clock = new Date(2026, 0, 6, 9, 0, 1).getTime()
    await service.tick()
    const record = service.list()[0]?.runHistory?.at(-1)
    check("a busy conversation is a run that did not happen", record?.status === "skipped" && record?.errorCode === "target-busy", record)
    check("it is not held in the queue", service.queued === 0, service.queued)
    check("the schedule moved on by itself", service.dueAt("auto-1") === new Date(2026, 0, 7, 9, 0).getTime())
    check("the record says where the run came from", record?.source === "schedule", record?.source)
    check("and what the task was asked to do at the time", record?.contextSnapshot?.prompt === "Summarise" && record?.contextSnapshot?.runMode === "existing-task" && record?.contextSnapshot?.model === "fake/m", record?.contextSnapshot)
    busy.delete(home)
  }

  section("Round 17 (R17-W19): two runs of one task do not overlap")
  {
    /*
     * The first run's turn is still going - nothing has told the service it
     * ended - so the next occurrence finds the task still answering. The
     * conversation itself is left idle, so the overlap is what stops it and
     * not the busy check above.
     */
    clock = new Date(2026, 0, 7, 9, 0, 1).getTime()
    await service.tick()
    check("the first run started", prompts.at(-1)?.sessionID === home, prompts.at(-1))
    busy.delete(home)
    const opened = service.list()[0]?.runHistory?.length ?? 0
    clock = new Date(2026, 0, 8, 9, 0, 1).getTime()
    const before = prompts.length
    await service.tick()
    const overlapped = service.list()[0]?.runHistory?.at(-1)
    check("the next one does not start on top of it", prompts.length === before, prompts.length - before)
    check("and is recorded as an overlap", (service.list()[0]?.runHistory?.length ?? 0) > opened && overlapped?.errorCode === "overlap", overlapped)
    await service.turnEnded(home)
    busy.delete(home)
  }

  section("Round 17 (R17-W19): a lease that runs out under a working turn does not start it again")
  {
    /*
     * The one way the same run could be handed out twice, which is what MiMo's
     * ring of settled ids guards against: the prompt is held open, so the check
     * that took the entry never reports, and thirty seconds later the entry is
     * deliverable again. Here the run ids are `<task>-<due moment>`, so the
     * overlap check is what settles it - and it settles it before anything can
     * start.
     */
    clock = new Date(2026, 0, 9, 9, 0, 1).getTime()
    let releasePrompt: () => void = () => {}
    promptHangs = new Promise<void>((resolve) => (releasePrompt = resolve))
    const started = service.tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const ran = prompts.length
    check("the run started and the check that took it has not reported", ran > 0 && service.queued === 1, { ran, queued: service.queued })
    // Past the lease, with the next occurrence still a day off.
    clock = new Date(2026, 0, 9, 9, 0, 41).getTime()
    await service.tick()
    check("the run is not started a second time", prompts.length === ran, prompts.length - ran)
    const twice = service.list()[0]?.runHistory?.at(-1)
    check("the entry is given up on as an overlap instead", twice?.status === "skipped" && twice?.errorCode === "overlap", twice)
    check("and nothing is left in the queue", service.queued === 0, service.queued)
    releasePrompt()
    await started
    await service.turnEnded(home)
    busy.delete(home)
  }

  section("Round 17 (R17-W22): a new-task run that cannot start leaves no empty conversation")
  {
    await call({ mode: "update", id: "auto-1", runMode: "new-task", project: "none", notification: "failed-runs" })
    promptThrows = "ENOSPC: no space left on device"
    const before = sessions.size
    clock = (service.dueAt("auto-1") ?? clock) + 1000
    await service.tick()
    promptThrows = undefined
    check("the run is recorded as failed", service.list()[0]?.runHistory?.at(-1)?.status === "failed", service.list()[0]?.runHistory?.at(-1))
    check("and the conversation it made is taken away again", sessions.size === before, sessions.size)
  }

  section("Round 17 (R17-W25/W26): the lease, and the tasks the side column reads")
  {
    check("MiMo's lease is thirty seconds", LEASE_MS === 30_000, LEASE_MS)
    const listed = service.sidebar()
    check("each task is named, with where it runs and when it next does", listed.length === 1 && listed[0]?.title === "Digest" && typeof listed[0]?.nextAt === "number", listed)
    check("and the conversations its runs went to", (listed[0]?.runs.length ?? 0) > 0, listed[0]?.runs)
  }
  await service.stop()

  section("Round 17 (R17-W19): a run queued before a pause does not run after it")
  {
    /*
     * The queue is on disk and comes back with the app, so this is the real
     * shape of the fault: a run queued a second before the user paused the
     * task - or before the app was closed - used to run at the next check.
     */
    const saved = JSON.parse(await fs.readFile(deps.file, "utf8")) as { automations: { id: string; enabled: boolean; rrule: string; label?: string }[]; runQueue?: unknown }
    const task = saved.automations[0]!
    task.enabled = false
    const scheduledFor = new Date(2026, 0, 8, 9, 0).getTime()
    saved.runQueue = {
      entries: [
        {
          run: { runId: `run-${task.id}-${scheduledFor.toString(36)}`, automationID: task.id, scheduledFor, scheduleFingerprint: scheduleKey(task.rrule, task.label), source: "restored", deliveryGeneration: 0 },
          attempts: 0,
        },
      ],
    }
    await fs.writeFile(deps.file, JSON.stringify(saved), "utf8")
    clock = new Date(2026, 0, 8, 9, 0, 30).getTime()
    const reopened = new AutomationService(deps)
    await reopened.start({ interval: false })
    check("the queued run came back with the app", reopened.queued === 1, reopened.queued)
    const before = prompts.length
    await reopened.tick()
    const record = reopened.list()[0]?.runHistory?.at(-1)
    check("it does not run", prompts.length === before, prompts.length - before)
    check("and is recorded under MiMo's reason", record?.status === "skipped" && record?.errorCode === "paused", record)
    check("the queue is empty again", reopened.queued === 0, reopened.queued)
    await reopened.stop()
  }

  section("Round 17 (R17-W18): a clock that jumped replans instead of firing everything at once")
  {
    /*
     * Driven by the service's own checks rather than by hand, because that is
     * what the guard is about: two checks that should have been a moment apart,
     * with hours of wall clock between them. The check itself is a hundredth of
     * a second here; the guard's own figures are untouched.
     */
    const own = { ...deps, file: path.join(dir, "clock.json"), tickMs: 10 }
    const jumper = new AutomationService(own)
    clock = new Date(2026, 1, 1, 8, 0).getTime()
    await jumper.start()
    await jumper.handle({ mode: "create", title: "Nightly", prompt: "Summarise", rrule: daily, runMode: "new-task", project: "none" }, { sessionID: home })
    check("its first run is this morning's nine o'clock", jumper.dueAt("auto-1") === new Date(2026, 1, 1, 9, 0).getTime(), jumper.dueAt("auto-1"))
    const before = prompts.length
    // Three days asleep: every occurrence between is in the past when the machine wakes.
    clock = new Date(2026, 1, 4, 12, 0).getTime()
    await new Promise((resolve) => setTimeout(resolve, 200))
    check("the missed occurrences do not all fire", prompts.length === before, prompts.length - before)
    check("and the next run is worked out again from now", jumper.dueAt("auto-1") === new Date(2026, 1, 5, 9, 0).getTime(), jumper.dueAt("auto-1"))
    check("nothing is left in the queue for them", jumper.queued === 0, jumper.queued)
    await jumper.stop()
  }
}

/* ---------------------------------------------------------------- subagents, through the real runner */

type Call = { name: string; input: Record<string, unknown> }
type Reply = { text: string } | { calls: Call[] }
type Seen = { system: string; messages: { role: string; content?: unknown }[] }

/** An app over a fake provider: the conversation is scripted, and the subagents answer from a function. */
async function harness(root: string, child: (seen: Seen) => Promise<Reply>) {
  const parentSteps: Reply[] = []
  let calls = 0
  const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", async () => {
      const asked = JSON.parse(body || "{}") as { messages?: Seen["messages"] }
      const seen: Seen = { system: JSON.stringify(asked.messages?.find((message) => message.role === "system")?.content ?? ""), messages: asked.messages ?? [] }
      const subagent = seen.system.includes("Working as a subagent")
      const reply: Reply = subagent ? await child(seen) : (parentSteps.shift() ?? { text: "parent done" })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if ("text" in reply) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      } else {
        reply.calls.forEach((entry, index) => {
          const frame = { choices: [{ delta: { tool_calls: [{ index, id: `call_r17_${++calls}`, type: "function", function: { name: entry.name, arguments: JSON.stringify(entry.input) } }] } }] }
          response.write(`data: ${JSON.stringify(frame)}\n\n`)
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      }
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  const data = path.join(root, "data")
  const storage = new Storage(path.join(data, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(data, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const model = { provider: "fake", model: "m" }

  const busyAnywhere = async (sessionID: string) =>
    runner.busySessions().includes(sessionID) || (await store.list()).some((session) => session.parentID === sessionID && runner.busySessions().includes(session.id))
  const settled = async (sessionID: string) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && (await busyAnywhere(sessionID))) await new Promise((resolve) => setTimeout(resolve, 25))
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return {
    store,
    runner,
    project,
    model,
    memoryRoot: path.join(data, "memory"),
    script: (steps: Reply[]) => void parentSteps.splice(0, parentSteps.length, ...steps),
    settled,
    close: () => new Promise<void>((resolve) => provider.close(() => resolve())),
  }
}

const actor = (input: Record<string, unknown>): Call => ({ name: "actor", input: { operation: input } })
const task = (summary: string): Call => ({ name: "task", input: { operation: { action: "create", summary } } })

async function subagentChecks(check: Check, section: Section, root: string): Promise<void> {
  const memoryRoot = path.join(root, "sub", "data", "memory")
  bindHistory({ memoryRoot } as unknown as HistoryService)
  bindMemoryWrites(() => true)
  let writeProgress: string | undefined
  let childTurns = 0
  const app = await harness(path.join(root, "sub"), async () => {
    childTurns++
    if (writeProgress) {
      const file = writeProgress
      writeProgress = undefined
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, progressTemplate("T1"), "utf8")
    }
    return { text: "**Status**: success\n**Summary**: done\nAll finished." }
  })
  try {
    section("Round 17 (R17-W12): a subagent carrying a task id is sent back for its record")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ calls: [task("Write the thing")] }, { calls: [actor({ action: "run", description: "Do it", prompt: "Do the thing", subagent_type: "general", task_id: "T1" })] }, { text: "reported" }])
      childTurns = 0
      await app.runner.prompt({ sessionID: session.id, text: "go" })
      await app.settled(session.id)
      const child = (await app.store.list()).find((entry) => entry.parentID === session.id)
      const notes = child ? await app.store.messages(child.id) : []
      const reminders = notes.filter((message) => message.role === "user" && message.text.includes(PROGRESS_SECTIONS[0]))
      check("it is asked for the record rather than allowed to finish", reminders.length > 0, notes.map((message) => message.role))
      /* One turn, the task gate's two re-entries, then this gate's three: the two gates are in that order and each keeps its own count. */
      check("and only as often as MiMo allows", reminders.length === MAX_PROGRESS_REACT && childTurns === 1 + 2 + MAX_PROGRESS_REACT, { reminders: reminders.length, childTurns })
      check("the reminder names the file under the task's own folder", reminders[0]?.text.includes(path.join("tasks", "T1", "progress.md")) === true, reminders[0]?.text.slice(0, 200))
    }

    section("Round 17 (R17-W12): a subagent that writes the record is let go at once")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      writeProgress = progressPath(app.memoryRoot, session.id, "T1")
      app.script([{ calls: [task("Write the thing")] }, { calls: [actor({ action: "run", description: "Do it", prompt: "Do the thing", subagent_type: "general", task_id: "T1" })] }, { text: "reported" }])
      childTurns = 0
      await app.runner.prompt({ sessionID: session.id, text: "go" })
      await app.settled(session.id)
      const child = (await app.store.list()).find((entry) => entry.parentID === session.id)
      const notes = child ? await app.store.messages(child.id) : []
      check("it is never asked for the record", notes.every((message) => !(message.role === "user" && message.text.includes(PROGRESS_SECTIONS[0]))), notes.map((message) => message.role))
      check("and stops as soon as the task gate lets it", childTurns === 1 + 2, childTurns)
    }

    section("Round 17 (R17-W12): a subagent with no task id is not asked for one")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ calls: [actor({ action: "run", description: "Look", prompt: "Look at it", subagent_type: "general" })] }, { text: "reported" }])
      childTurns = 0
      await app.runner.prompt({ sessionID: session.id, text: "go" })
      await app.settled(session.id)
      check("it finishes in one turn", childTurns === 1, childTurns)
    }
  } finally {
    await app.close()
    bindHistory(undefined)
  }

  await pendingCheck(check, section, path.join(root, "pending"))
  await stopCheck(check, section, path.join(root, "stop"))
}

/** R17-W15: a subagent held behind the process-wide gate reports itself pending. */
async function pendingCheck(check: Check, section: Section, root: string): Promise<void> {
  const app = await harness(root, async () => ({ text: "**Status**: success\n**Summary**: done\nFinished." }))
  const permits: (() => void)[] = []
  try {
    section("Round 17 (R17-W15): status says pending for a subagent still in the queue")
    for (let taken = 0; taken < SUBAGENT_LIMIT; taken++) permits.push(await app.runner.subagentGate.acquire())
    const session = await app.store.create({ directory: app.project, model: app.model })
    app.script([
      { calls: [actor({ action: "spawn", description: "Queued", prompt: "Wait your turn", subagent_type: "general" })] },
      { calls: [actor({ action: "status", actor_id: "general-1" })] },
      { text: "reported" },
    ])
    await app.runner.prompt({ sessionID: session.id, text: "go" })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const parts = (await app.store.messages(session.id)).flatMap((message) => (message.role === "assistant" ? message.parts.filter((part): part is ToolPart => part.type === "tool" && part.name === "actor") : []))
    const status = parts.find((part) => String(part.output ?? "").includes("actor_id"))
    const reported = parts.map((part) => (part.output ? String(part.output) : "")).find((output) => output.includes('"status"'))
    check("the subagent it has not started yet is pending, not running", reported?.includes('"status":"pending"') === true, reported ?? status?.output)
  } finally {
    for (const release of permits) release()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await app.close()
  }
}

/**
 * R17-W27: what Stop on a conversation reaches.
 *
 * MiMo's `/session/{id}/abort` calls `SessionPrompt.cancel`, which calls
 * `SessionRunState.cancel` - and that cancels the runner keyed
 * `(sessionID, "main")` and nothing else. Its actors run under their own agent
 * ids in the same session, so a background one is left working; a blocking one
 * is stopped because the actor tool's own call was cancelled with the turn.
 * This proves MCode does both the same way round.
 */
async function stopCheck(check: Check, section: Section, root: string): Promise<void> {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => (release = resolve))
  const app = await harness(root, async () => {
    await held
    return { text: "**Status**: success\n**Summary**: done\nFinished." }
  })
  try {
    section("Round 17 (R17-W27): Stop reaches a blocking subagent and leaves a background one")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ calls: [actor({ action: "spawn", description: "Background", prompt: "Keep at it", subagent_type: "general" })] }, { text: "spawned" }])
      await app.runner.prompt({ sessionID: session.id, text: "go" })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const child = (await app.store.list()).find((entry) => entry.parentID === session.id)
      check("the background subagent is at work", Boolean(child) && app.runner.busySessions().includes(child!.id), app.runner.busySessions())
      app.runner.abort(session.id)
      await new Promise((resolve) => setTimeout(resolve, 500))
      check("stopping the conversation leaves it working, as MiMo's abort does", app.runner.busySessions().includes(child!.id), app.runner.busySessions())
    }

    section("Round 17 (R17-W27): and a run the turn is waiting on is stopped with it")
    {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([{ calls: [actor({ action: "run", description: "Blocking", prompt: "Answer me", subagent_type: "general" })] }, { text: "answered" }])
      await app.runner.prompt({ sessionID: session.id, text: "go" })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const child = (await app.store.list()).find((entry) => entry.parentID === session.id)
      check("the subagent the turn is waiting on is at work", Boolean(child) && app.runner.busySessions().includes(child!.id), app.runner.busySessions())
      app.runner.abort(session.id)
      await new Promise((resolve) => setTimeout(resolve, 500))
      check("stopping the conversation stops it too", !app.runner.busySessions().includes(child!.id), app.runner.busySessions())
    }
  } finally {
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await app.close()
  }
}
