import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { LAB_TASK_SET, type LabCard, type LabRun, type LabState } from "@shared/lab"
import { nulFields, runGit } from "./git-process"
import { pushRef } from "./git"
import { githubRepository, remotesOf } from "./pull-request"
import { labTasks, type LabTask } from "./lab-catalog"
import { runSandboxed, type SandboxResult } from "./lab-sandbox"
import { addWorktree, removeWorktree, worktreeTop } from "./session/worktree"
import { FANOUT_MAX_CONCURRENCY, type SessionRunner } from "./session/runner"
import type { Storage } from "./storage"

const HISTORY_KEY = "lab/runs.json"
/*
 * Both contracts are answered by weaker models as an essay: the round before these words
 * existed, two candidates independently explained the bug — correctly, naming the function —
 * and returned neither a diff nor a file, because nothing said the answer may not contain
 * prose. The shape comes first, and the answer has to begin with it.
 */
const DIFF_SYSTEM = "Begin your reply with the line `diff --git` and write nothing before it. No prose, no explanation, no analysis: only a git unified diff that fixes the bug, touching only the listed implementation files, with --- and +++ headers and accurate hunk line numbers."
const FILES_SYSTEM = "Begin your reply with the line `=== FILE <path> ===` and write nothing before it. No prose, no explanation, no analysis: for each file you change, that marker line followed by the file's complete new content, unchanged parts included. Never output a diff, never leave part of a file out, and change nothing outside the listed files."
const JOB_GATES = ["mdcheck", "providercheck", "themecheck"]
const ARENA_GATES = [...JOB_GATES, "i18ncheck", "androidtheme", "gencheck"]
const BRANCH = /^lab\/evolve-\d{4}-\d{2}-\d{2}(?:-\d+)?$/
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
// A shell that launched MCode may itself be holding an alternate Git index.
const LAB_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined, GIT_NAMESPACE: undefined, GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_CONFIG: undefined,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_PARAMETERS: undefined,
}

function labGit(directory: string, args: string[]): Promise<string> {
  return runGit(directory, args, { env: LAB_GIT_ENV })
}


export function passingRate(exits: readonly (number | null)[]): number {
  return exits.length ? exits.filter((code) => code === 0).length / exits.length : 0
}

export async function replayVerified<T>(patches: readonly T[], apply: (patch: T) => Promise<void>, gates: () => Promise<void>): Promise<void> {
  for (const patch of patches) await apply(patch)
  await gates()
}

export async function publishLabBranch(git: (args: string[]) => Promise<string>, branch: string, head: string): Promise<void> {
  if (!BRANCH.test(branch) || !OBJECT_ID.test(head)) throw Error("Invalid Lab branch or commit")
  await git(["update-ref", `refs/heads/${branch}`, head, "0".repeat(head.length)])
}

interface Candidate {
  card: LabCard
  directory: string
}
interface Repair {
  task: LabTask
  patch: string
  card: LabCard
}

function problem(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000)
}

/**
 * The whole-file contract: `=== FILE <path> ===`, then that file's new content, repeated.
 * Git makes the patch from what the model wrote, so a wrong hunk count cannot sink a round
 * the way a hand-written diff did. Scope is checked here because the reply is model text and
 * a file the task does not own must never reach the checkout.
 */
/*
 * The candidate's checkout has to carry the bug in its index as well as in its files, because
 * the patch handed to the arena is whatever `git diff` says there, and the arena is a checkout
 * with the bug applied to its index. When only the files were changed, the candidate's diff was
 * measured against clean code: it replayed onto a bugged tree and `git apply` refused it at the
 * hunk the regression itself had moved — a run whose candidate had passed every acceptance test
 * died there, reporting only `patch does not apply` far from the cause.
 */
export async function enterBugState(directory: string, scratch: string, task: LabTask): Promise<void> {
  await applyPatch(directory, scratch, task.regression, task, true)
}

/*
 * Only one candidate per task is replayed into the arena, so this order decides which patch the
 * project gets. Sorting by length alone — which is what it was — lets a one-line guess outrank
 * the candidate that passed every acceptance test, and the round then dies in the arena over the
 * weaker choice. Correctness first, then the smaller diff, then the worker slot for determinism.
 */
export function rankRepairs<T extends { patch: string; card: { score?: number; worker: number } }>(repairs: T[]): T[] {
  return [...repairs].sort((a, b) => (b.card.score ?? 0) - (a.card.score ?? 0) || a.patch.length - b.patch.length || a.card.worker - b.card.worker)
}

/*
 * A task is a patch taken from real history, and history moves. LAB-05's file took 185 commits
 * since the task was written, so its regression no longer lands — and because that patch is
 * applied while preparing the candidates, outside a candidate's error handling, one rotten task
 * failed the whole run and swept seven healthy ones into `discarded` with no reason. Checking
 * the patch against the arena, which is still pristine at this point, costs one Git call and
 * lets a stale task cost only its own round.
 */
export async function staleTask(arena: string, scratch: string, task: LabTask): Promise<string> {
  const file = path.join(scratch, `${randomUUID()}.check.diff`)
  await fs.writeFile(file, task.regression, { mode: 0o600 })
  try {
    await labGit(arena, ["apply", "--check", "--whitespace=nowarn", file])
    return ""
  } catch (error) {
    const text = problem(error)
    const first = text.split("\n").find((line) => line.includes("error:")) ?? text.split("\n")[0]
    return `The task's regression no longer applies to this checkout — ${task.id}: ${first}`
  } finally {
    await fs.rm(file, { force: true })
  }
}

/** What the candidate claims to have fixed, relative to the bug it was shown. */
export async function candidateDiff(directory: string, task: LabTask): Promise<string> {
  return labGit(directory, ["diff", "--no-color", "--", ...task.files])
}

export function labFiles(text: string, task: LabTask): { file: string; content: string }[] | null {
  const marks = [...text.matchAll(/^=== FILE (.+?) ===$/gm)]
  if (!marks.length) return null
  const out: { file: string; content: string }[] = []
  for (const [at, mark] of marks.entries()) {
    const file = (mark[1] ?? "").trim().replace(/^\.?\//, "")
    if (!task.files.includes(file)) throw Error(`Reply covers a file outside the task scope: ${file}`)
    const from = (mark.index ?? 0) + mark[0].length + 1
    const to = at + 1 < marks.length ? (marks[at + 1].index ?? text.length) : text.length
    let content = text.slice(from, to)
    // A model that closes its own block leaves its marker and a sign-off inside the range.
    const end = content.search(/^=== END ===\s*$/m)
    if (end >= 0) content = content.slice(0, end)
    content = content.replace(/^\s*\n/, "").replace(/[ \t]+$/gm, "").replace(/\n+$/, "")
    if (!content.trim()) throw Error(`The reply has no file content for ${file}`)
    out.push({ file, content: `${content}\n` })
  }
  return out
}

/**
 * Control characters cannot survive a trip through a model: they are invisible in the prompt
 * and they vanish from the reply, and a file that keeps its stashed HTML behind ` … `
 * sentinels then comes back with its protections removed. They travel as visible tokens and
 * are restored when the file is written. A file that already spells the tokens is left alone,
 * because inventing them there would corrupt a file that was fine.
 */
export function controlTokens(text: string): { text: string; escaped: boolean } {
  if (/[⟦⟧]/.test(text)) return { text, escaped: false }
  let escaped = false
  const mapped = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (character) => {
    escaped = true
    return `⟦${character.charCodeAt(0).toString(16).padStart(4, "0")}⟧`
  })
  return { text: mapped, escaped }
}

export function tokensToControl(text: string): string {
  return text.replace(/⟦([0-9a-f]{4})⟧/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * The model is asked for a bare diff and hands back a sentence, a fence, or both. Taking
 * the diff out of that reply is not a loosening: every rule below still runs on what is
 * left, so an unscoped, renamed or binary patch is refused exactly as before.
 */
function extractDiff(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const start = lines.findIndex((line) => line.startsWith("diff --git "))
  if (start < 0) return ""
  const body = lines.slice(start)
  /*
   * A reply wrapped in a fence closes at its last fence line: a hunk that adds a fenced
   * block to a document carries ``` lines of its own, and cutting at the first one would
   * hand a half patch to `git apply`.
   */
  if (/^```(?:diff|patch)?$/.test((lines[start - 1] ?? "").trim())) {
    for (let line = body.length - 1; line > 0; line--) {
      if (body[line].trim() === "```") return body.slice(0, line).join("\n")
    }
  }
  while (body.length && !body[body.length - 1].trim()) body.pop()
  return body.join("\n")
}

export function labPatch(text: string, task: LabTask): string {
  const extracted = extractDiff(text)
  if (!extracted.startsWith("diff --git ")) {
    throw Error(`The reply has no git diff (head: ${text.replace(/\s+/g, " ").trim().slice(0, 200)})`)
  }
  const patch = `${extracted}\n`
  // Only text changes to the scoped implementation files may enter the worktree.
  const headers = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
  const changed = (prefix: string) => [...patch.matchAll(new RegExp(`^${prefix} (.*)$`, "gm"))].map((match) => match[1])
  if (!headers.length) throw Error("The git diff has no `diff --git` header")
  const outside = [...new Set(headers.flatMap(([, left, right]) => (left === right ? [left] : [left, right]))
    .filter((file) => !task.files.includes(file)))]
  if (outside.length) throw Error(`Patch touches files outside the task scope: ${outside.join(", ")}`)
  if (patch.length > 96_000) throw Error("Patch is larger than 96KB")
  if (changed("---").join("\n") !== headers.map((entry) => `a/${entry[1]}`).join("\n") ||
      changed("\\+\\+\\+").join("\n") !== headers.map((entry) => `b/${entry[2]}`).join("\n")) {
    throw Error("Patch headers disagree (diff --git, --- and +++ must name the same files in order)")
  }
  if (/^(?:old mode|new mode|new file mode|deleted file mode|rename |copy |GIT binary patch|Binary files)/m.test(patch) ||
      /^index [^\n]+ (?!100(?:644|755)$)\d+$/m.test(patch)) {
    throw Error("Patch contains a binary, rename or file mode change")
  }
  return patch
}

export async function applyPatch(directory: string, scratch: string, patch: string, task: LabTask, index = false): Promise<string> {
  const file = path.join(scratch, `${randomUUID()}.diff`)
  await fs.writeFile(file, patch, { mode: 0o600 })
  try {
    const entries = nulFields(await labGit(directory, ["apply", "--numstat", "-z", file]))
    const stats = entries.map((entry) => {
      const fields = /^(\d+)\t(\d+)\t(.+)$/.exec(entry)
      if (!fields || !task.files.includes(fields[3])) throw Error("Patch touches files outside the task scope")
      return { path: fields[3], added: fields[1], removed: fields[2] }
    })
    if (!stats.length) throw Error("Patch is empty")
    for (const entry of stats) {
      if (!(await fs.lstat(path.join(directory, entry.path))).isFile()) throw Error("Patch target is not a regular file")
    }
    await labGit(directory, ["apply", "--whitespace=nowarn", ...(index ? ["--index"] : []), file])
    return stats.map(({ path, added, removed }) => `${path}  +${added} / −${removed}`).join("\n")
  } finally {
    await fs.unlink(file)
  }
}

async function verify(directory: string, deps: string, command: string[], signal: AbortSignal): Promise<SandboxResult> {
  const [program, ...args] = command
  return runSandboxed(directory, deps, program, args, signal)
}

async function gates(directory: string, deps: string, names: string[], signal: AbortSignal): Promise<void> {
  for (const name of names) {
    const result = await runSandboxed(directory, deps, "npm", ["run", "-s", name], signal)
    if (result.code !== 0) throw Error(`Gate ${name} exited ${result.code ?? "by signal"}\n${result.output}`)
  }
}

async function githubFor(directory: string) {
  const remotes = remotesOf(await runGit(directory, ["remote", "-v"]))
  const origin = githubRepository(remotes.get("origin") ?? "")
  if (!origin) return undefined
  const urls = (await runGit(directory, ["remote", "get-url", "--push", "--all", "origin"])).trim().split("\n")
  if (urls.length !== 1) return undefined
  const destination = githubRepository(urls[0])
  if (destination?.owner.toLowerCase() !== origin.owner.toLowerCase() ||
      destination.repo.toLowerCase() !== origin.repo.toLowerCase()) return undefined
  return origin
}

export class Lab {
  private current?: LabRun
  private active?: { controller: AbortController; done: Promise<void> }
  private closed = false
  private completed: LabRun[] = []
  private readonly ready: Promise<void>

  constructor(private readonly storage: Storage, private readonly runner: Pick<SessionRunner, "fanoutControl">) {
    this.ready = storage.read<LabRun[]>(HISTORY_KEY).then((history) => { this.completed = history ?? [] })
    void this.ready.catch(() => {})
  }

  async state(id?: string): Promise<LabState> {
    await this.ready
    const history = this.completed.map(({ id, started, cards, branch }) => ({
      id, started, branch,
      taskCount: new Set(cards.map((card) => card.task)).size,
      passed: cards.filter((card) => card.stage === "accepted").length,
    }))
    return {
      current: this.current ?? this.completed[0],
      selected: id && id !== this.current?.id ? this.completed.find((run) => run.id === id) : undefined,
      history, taskCount: labTasks.length, maxConcurrency: FANOUT_MAX_CONCURRENCY,
    }
  }

  async start(sessionID: string, directory: string, options: { set: string; rounds: number; concurrency: number }): Promise<void> {
    await this.ready
    if (process.platform !== "linux") throw Error("Lab sandbox requires Linux with bubblewrap and user namespaces")
    if (this.closed || this.active) throw Error("A Lab run is already active or the server is closing")
    if (options.set !== LAB_TASK_SET || !Number.isInteger(options.rounds) || options.rounds < 1 || options.rounds > labTasks.length ||
        !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > FANOUT_MAX_CONCURRENCY) {
      throw Error("Invalid Lab task set, rounds, or concurrency")
    }
    const run: LabRun = { id: randomUUID(), started: Date.now(), directory, status: "running", cards: [] }
    this.current = run
    const controller = new AbortController()
    const done = this.execute(run, sessionID, options, controller.signal).catch((error) => {
      run.status = controller.signal.aborted ? "aborted" : "failed"
      if (!controller.signal.aborted || (error instanceof Error && error.name !== "AbortError")) run.error = problem(error)
    }).finally(async () => {
      for (const card of run.cards) if (card.stage !== "accepted" && card.stage !== "discarded") card.stage = "discarded"
      const history = [run, ...this.completed].slice(0, 30)
      try {
        await this.storage.write(HISTORY_KEY, history)
      } catch (error) {
        run.error = [run.error, problem(error)].filter(Boolean).join("\n")
      } finally {
        this.completed = history
        this.active = undefined
      }
    })
    this.active = { controller, done }
  }

  stop(): void {
    if (this.current?.status !== "running") return
    this.current.status = "stopping"
    this.active?.controller.abort()
  }

  async close(): Promise<void> {
    this.closed = true
    this.stop()
    await this.active?.done
  }

  async createPR(id: string): Promise<{ branch: string; url?: string }> {
    await this.ready
    if (this.current?.id === id && this.current.status === "finished") await this.active?.done
    const run = this.completed.find((entry) => entry.id === id)
    if (run?.status !== "finished" || !run.branch || !BRANCH.test(run.branch) || !run.head || !OBJECT_ID.test(run.head)) {
      throw Error("No completed Lab branch")
    }
    const origin = await githubFor(run.directory)
    if (!origin || !run.changed) return { branch: run.branch }
    const result = await pushRef(run.directory, run.branch, run.head)
    if (!result.ok) throw Error(`Push failed: ${result.code}`)
    const url = `https://github.com/${origin.owner}/${origin.repo}/compare/${encodeURIComponent(run.branch)}?expand=1`
    return { branch: run.branch, url }
  }

  private async execute(run: LabRun, sessionID: string, options: { rounds: number; concurrency: number }, signal: AbortSignal): Promise<void> {
    const top = await worktreeTop(run.directory)
    if (!top) throw Error("Open a session in the MCode repository")
    run.directory = await fs.realpath(top.root)
    const root = run.directory
    const base = (await labGit(root, ["rev-parse", "HEAD"])).trim()
    const manifest = JSON.parse(await labGit(root, ["show", `${base}:package.json`]))
    if (manifest.name !== "mcode") throw Error("Open a session in the MCode repository")
    const deps = await fs.realpath(path.join(root, "node_modules"))
    if (path.basename(deps) !== "node_modules") throw Error("Lab requires the project's existing node_modules")
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-lab-"))
    const mounted = new Set<string>()
    const checkout = async (name: string) => {
      signal.throwIfAborted()
      const directory = path.join(scratch, name)
      // Register before the operation so even partial checkouts are cleaned.
      mounted.add(directory)
      // Wait for checkout to exit before removing its Git registration on abort.
      await addWorktree(root, ["--detach", directory, base], { env: LAB_GIT_ENV, timeout: 120_000 })
      signal.throwIfAborted()
      /*
       * The mount point has to exist before bwrap runs: /work is mounted read-only, so the
       * bind of the dependencies at /work/node_modules cannot create its own target there.
       * A symlink would work as a mount target too, but it is the indirection that broke the
       * sibling lookup in the first place.
       */
      await fs.mkdir(path.join(directory, "node_modules"), { recursive: true })
      return directory
    }
    const clean = async (directory: string) => {
      try {
        await removeWorktree(root, directory, true, { env: LAB_GIT_ENV, timeout: 120_000 })
      } catch (error) {
        const exists = await fs.lstat(directory).then(() => true, (failure) => {
          if (failure.code !== "ENOENT") throw failure
          return false
        })
        if (exists) throw error
        const registered = nulFields(await labGit(root, ["worktree", "list", "--porcelain", "-z"]))
        if (registered.includes(`worktree ${directory}`)) throw error
      }
      mounted.delete(directory)
    }
    try {
      const arena = await checkout("arena")
      const probe = await runSandboxed(arena, deps, "node", ["--version"], signal)
      if (probe.code !== 0) throw Error(`Lab sandbox unavailable: ${probe.output}`)
      const fanout = this.runner.fanoutControl({ sessionID, signal })
      const repairs: Repair[] = []
      for (const [index, task] of labTasks.slice(0, options.rounds).entries()) {
        const stale = await staleTask(arena, scratch, task)
        if (stale) {
          for (let slot = 1; slot <= options.concurrency; slot++) {
            run.cards.push({ round: index + 1, worker: slot, task: task.id, title: task.title, stage: "discarded", error: stale })
          }
          continue
        }
        const candidates: Candidate[] = []
        for (let slot = 1; slot <= options.concurrency; slot++) {
          const card: LabCard = { round: index + 1, worker: slot, task: task.id, title: task.title, stage: "selecting" }
          run.cards.push(card)
          const directory = await checkout(`round-${index + 1}-${slot}`)
          await enterBugState(directory, scratch, task)
          candidates.push({ card, directory })
        }
        // The tool-free model sees only the scoped source paths from its bug-state checkout.
        const sources = await Promise.all(task.files.map(async (file) => {
          const source = await fs.readFile(path.join(candidates[0].directory, file), "utf8")
          if (source.length <= 64_000) return `File ${file}:\n${source}`
          // Use the actual bug-state line numbers, since HEAD can be newer than the seed commit.
          // The index carries the bug too, so the bug's own lines are only visible against `base`.
          const diff = await labGit(candidates[0].directory, ["diff", "--no-ext-diff", "--no-textconv", base, "--", file])
          const lines = source.split("\n")
          const excerpts = [...diff.matchAll(/^@@ .*? \+(\d+)(?:,\d+)? @@/gm)].map((match) => {
            const first = Math.max(0, Number(match[1]) - 18)
            return lines.slice(first, first + 42).map((line, offset) => `${first + offset + 1} ${line}`).join("\n")
          })
          if (!excerpts.length) throw Error(`Could not locate the regression in ${file}`)
          return `File ${file} (excerpts):\n` + excerpts.join("\n\n")
        }))
        // A model that was given whole files may hand whole files back; one that saw excerpts may only send a diff.
        const whole = sources.every((text) => !text.includes(" (excerpts):"))
        const given = sources.map((text) => controlTokens(text))
        const escaping = given.some((entry) => entry.escaped)
        for (const candidate of candidates) candidate.card.stage = "patching"
        const outcomes = await fanout.generate(candidates.map(({ card }) => ({
          name: `${task.id}-${card.worker}`,
          prompt: `Fix this regression: ${task.title}\n\n${given.map((entry) => entry.text).join("\n\n")}\n\n${whole ? "Write the complete fixed file(s). Begin your reply with the `=== FILE <path> ===` line; put nothing before it." : "Return the git unified diff. Begin your reply with the `diff --git` line; put nothing before it."}`,
        })), {
          concurrency: options.concurrency,
          /*
           * A thinking model handed this budget spends nearly all of it planning and
           * returns no diff at all, which is what the Lab measured on its own model
           * server: both candidates came back with an empty reply. The gates and the
           * task's acceptance tests decide whether a patch is worth keeping, so an
           * off-thinking candidate is worth more than no candidate, and this follows the
           * same rule the runner applies to a step that was cut inside the call.
           */
          effort: "off",
          system: whole ? FILES_SYSTEM : DIFF_SYSTEM,
        })
        signal.throwIfAborted()
        const verified = await Promise.allSettled(candidates.map(async ({ card, directory }, at): Promise<Repair | undefined> => {
          try {
            const outcome = outcomes[at]
            if (!outcome?.ok) throw Error(outcome?.error ?? "Patch generation failed")
            /*
             * An empty reply used to look like a formatting refusal, which sent the search for
             * the cause in the wrong direction. How the request stopped and what it spent says
             * whether the model ran out of budget or simply ignored the contract.
             */
            if (!outcome.text.trim()) {
              throw Error(`The model returned no text (stop=${outcome.stop ?? "unknown"}, output=${outcome.usage?.output ?? "?"}, reasoning=${outcome.usage?.reasoning ?? "?"})${outcome.note ? ` — ${outcome.note}` : ""}`)
            }
            /*
             * A reply cut off at the output limit looks like a broken file or a corrupt patch
             * further down, so it says what it is here: the answer is a larger budget, not a
             * different parser.
             */
            if (outcome.stop === "max_tokens") {
              throw Error(`The reply was cut off at the model's output limit after ${outcome.usage?.output ?? "?"} tokens; the file or diff is incomplete`)
            }
            /*
             * Whole files, because a hand-written diff is where rounds were lost: `git apply`
             * called one corrupt at line 4 over a hunk count off by one. Git makes the patch
             * here, and the task's own acceptance tests and the gates still decide its fate.
             */
            let patch = ""
            const files = whole ? labFiles(outcome.text, task) : null
            if (files) {
              for (const entry of files) {
                await fs.writeFile(path.join(directory, entry.file), escaping ? tokensToControl(entry.content) : entry.content)
              }
              card.diff = await candidateDiff(directory, task)
              if (!card.diff.trim()) throw Error("The reply rewrote the files without changing them")
              // Both sides start from the bug, so this patch and the arena's replay cannot disagree.
              patch = card.diff
            } else {
              try {
                patch = labPatch(escaping ? tokensToControl(outcome.text) : outcome.text, task)
              } catch (error) {
                throw Error(`${problem(error)}${outcome.note ? ` — ${outcome.note}` : ""}`)
              }
              await applyPatch(directory, scratch, patch, task)
              /*
               * `applyPatch` answers with a one-line-per-file summary, and storing that as the card's
               * diff cost two things: the UI shows prose where the other contract shows a patch, and an
               * accepted candidate could not be replayed afterwards — a re-audit of a LAB-08 adoption
               * had a `+0 / −5` summary where the patch should have been. Git's own diff is what the
               * arena replays, so it is what the record has to hold.
               */
              card.diff = await candidateDiff(directory, task)
              if (!card.diff.trim()) throw Error("The patch changed nothing in the task's files")
            }
            card.stage = "testing"
            const tests: SandboxResult[] = []
            for (const command of task.tests) tests.push(await verify(directory, deps, command, signal))
            card.score = passingRate(tests.map(({ code }) => code))
            const failure = tests.find(({ code }) => code !== 0)
            if (failure) throw Error(`Acceptance exited ${failure.code ?? "by signal"}\n${failure.output}`)
            card.stage = "gates"
            await gates(directory, deps, JOB_GATES, signal)
            card.stage = "arena"
            return { task, patch, card }
          } catch (error) {
            card.stage = "discarded"
            if (!signal.aborted) card.error = problem(error)
          } finally {
            await clean(directory)
          }
        }))
        for (const result of verified) if (result.status === "rejected") throw result.reason
        signal.throwIfAborted()
        const ranked = rankRepairs(verified.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []))
        if (ranked[0]) repairs.push(ranked[0])
        for (const repair of ranked.slice(1)) repair.card.stage = "discarded"
      }
      if (repairs.length) {
        let head = base
        await replayVerified(repairs, async ({ task, patch }) => {
          signal.throwIfAborted()
          await applyPatch(arena, scratch, task.regression, task, true)
          await applyPatch(arena, scratch, patch, task, true)
        }, async () => {
          // Freeze exactly what gates will see; never read worker-controlled output back into Git.
          const tree = (await labGit(arena, ["write-tree"])).trim()
          const baseTree = (await labGit(arena, ["rev-parse", `${base}^{tree}`])).trim()
          if (tree !== baseTree) {
            head = (await labGit(arena, ["-c", "user.name=MCode Lab", "-c", "user.email=lab@localhost", "-c", "commit.gpgSign=false",
              "commit-tree", tree, "-p", base, "-m", `Lab: verify ${repairs.map(({ task }) => task.id).join(", ")}`])).trim()
          }
          for (const { task } of repairs) for (const command of task.tests) {
            const result = await verify(arena, deps, command, signal)
            if (result.code !== 0) throw Error(`Combined acceptance failed: ${task.id}\n${result.output}`)
          }
          await gates(arena, deps, ARENA_GATES, signal)
        })
        const date = new Date(run.started).toISOString().slice(0, 10)
        const stem = `lab/evolve-${date}`
        const branches = new Set((await labGit(root, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${stem}*`])).trim().split("\n"))
        let branch = stem
        for (let suffix = 2; branches.has(branch); suffix++) branch = `${stem}-${suffix}`
        const canCreatePR = head !== base && Boolean(await githubFor(root))
        await clean(arena)
        signal.throwIfAborted()
        const refGit = (args: string[]) => labGit(root, args)
        await publishLabBranch(refGit, branch, head)
        if (signal.aborted) {
          await refGit(["update-ref", "-d", `refs/heads/${branch}`, head])
          signal.throwIfAborted()
        }
        Object.assign(run, { branch, head, changed: head !== base, canCreatePR, status: "finished" })
        for (const { card } of repairs) card.stage = "accepted"
      } else {
        await clean(arena)
        signal.throwIfAborted()
        run.status = "finished"
      }
    } finally {
      const results = await Promise.allSettled([...mounted].map(clean))
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }
}
