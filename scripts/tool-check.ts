/**
 * The tools, driven the way a turn drives them.
 *
 * These are the parts of the app that touch the machine, and the failures worth
 * guarding against are the quiet ones: a command that appears to stop while what
 * it started keeps running, and an edit that silently changes the wrong line.
 * Neither is visible from the interface and neither is a type error.
 */
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execSync } from "node:child_process"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { findTool, TOOLS, toolsFor } from "../src/server/tool/registry"
import { Questions } from "../src/server/tool/question"
import type { ServerEvent } from "../src/shared/protocol"
import { applyChunks } from "../src/server/tool/patch"
import { Shells } from "../src/server/shell"

const problems: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "BAD "} ${name}${detail ? " - " + detail : ""}`)
  if (!ok) problems.push(name)
}

/** Whether a process exists, asked without touching it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function reap(pid: number): void {
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" })
    else process.kill(pid, "SIGKILL")
  } catch {
    /* already gone */
  }
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-tool-check-"))
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })

  const storage = new Storage(path.join(root, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "credentials.json"))
  await config.load()
  await config.set({ autoApprove: ["bash", "edit", "write", "outside"], directory: project })
  const permissions = new Permissions(bus, config)
  const questions = new Questions(bus)

  /** Everything published while a call ran, so the events can be asserted on. */
  const events: ServerEvent[] = []
  bus.subscribe((event) => events.push(event))

  /** Paths recorded before a tool wrote them - what undo would put back. */
  const recorded: string[] = []

  const context = (signal: AbortSignal, callID = "c1") =>
    ({
      sessionID: "s1",
      messageID: "m1",
      callID,
      directory: project,
      shell: "",
      permissions,
      questions,
      signal,
      progress: () => undefined,
      snapshot: async (target: string) => {
        recorded.push(target)
      },
    }) as never

  const bash = findTool("bash")
  const edit = findTool("edit")
  if (!bash || !edit) throw new Error("the registry is missing a tool this checks")

  /**
   * Runs a command that starts a second process, and hands back that process's
   * pid once it has announced itself.
   */
  const startTree = async (signal: AbortSignal, timeout: number) => {
    const marker = path.join(project, `child-${Math.floor(Date.now() % 100000)}.pid`)
    const script = path.join(project, "long.js")
    await fs.writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid))\n` +
        "setInterval(() => {}, 1000)\n",
      "utf8",
    )
    const running = bash.execute({ command: `node "${script}"`, timeout }, context(signal)).catch(() => undefined)
    let pid = 0
    for (let i = 0; i < 60; i += 1) {
      const raw = await fs.readFile(marker, "utf8").catch(() => "")
      if (raw.trim()) {
        pid = Number(raw.trim())
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return { pid, running }
  }

  console.log("stopping a command")
  {
    const controller = new AbortController()
    const { pid, running } = await startTree(controller.signal, 60000)
    check("a command can start another process", pid > 0 && alive(pid))
    controller.abort()
    await running
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const survived = pid > 0 && alive(pid)
    check("stopping it takes that process with it", !survived)
    if (survived) reap(pid)
  }

  console.log("a command that runs out of time")
  {
    const controller = new AbortController()
    // Long enough to start, short enough to be killed by the timeout.
    const { pid, running } = await startTree(controller.signal, 3000)
    await running
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const survived = pid > 0 && alive(pid)
    check("timing out takes that process with it", !survived)
    if (survived) reap(pid)
  }

  console.log("editing")
  {
    const target = path.join(project, "twice.txt")
    await fs.writeFile(target, "alpha\nbeta\nalpha\n", "utf8")
    const controller = new AbortController()

    let refused = false
    await edit
      .execute({ path: target, oldString: "alpha", newString: "gamma" }, context(controller.signal))
      .catch(() => (refused = true))
    check("an edit matching twice is refused rather than guessed at", refused)
    check("and the file is untouched", (await fs.readFile(target, "utf8")) === "alpha\nbeta\nalpha\n")

    await edit
      .execute({ path: target, oldString: "beta", newString: "delta" }, context(controller.signal))
      .catch(() => undefined)
    check("an edit matching once lands", (await fs.readFile(target, "utf8")).includes("delta"))
  }

  /*
   * The question tool, driven the way a turn drives it.
   *
   * Everything here is invisible from a type: the tool parks on a promise
   * nothing else resolves, the event that tells the window about it is fired
   * once, and the sentence the model reads back is copied from the reference
   * word for word. A missing `case` in handlers.ts, an event that stops being
   * published, or a reworded output would all compile and all break the
   * feature silently.
   */
  console.log("asking the reader a question")
  {
    const question = findTool("question")
    if (!question) throw new Error("the registry is missing the question tool")

    check(
      "the question tool is offered to the model",
      TOOLS.some((tool) => tool.name === "question"),
    )

    const controller = new AbortController()
    events.length = 0
    const running = question.execute(
      {
        questions: [
          {
            question: "Which way?",
            header: "Direction",
            options: [
              { label: "Left", description: "towards the river" },
              { label: "Right", description: "towards the hill" },
            ],
          },
          {
            question: "How fast?",
            header: "Speed",
            options: [{ label: "Slow", description: "carefully" }],
          },
        ],
      },
      context(controller.signal, "call-q1"),
    )

    // Published synchronously by `ask`, so it is already there.
    const asked = events.find((event) => event.type === "question.asked")
    check("asking publishes question.asked", asked !== undefined)
    check(
      "and names the call it came from, so the form can find its card",
      asked?.type === "question.asked" && asked.request.tool?.callID === "call-q1",
    )

    const parked = questions.outstanding()
    check("a reloaded window can list what is parked", parked.length === 1, String(parked.length))

    const id = parked[0]?.id ?? ""
    check("replying to an unknown request is refused, not silently accepted", !questions.reply("nope", []))

    check("replying to a parked question is accepted", questions.reply(id, [["Left"], []]))
    const result = await running

    check(
      "the model is told the answers in the reference's own words",
      result.output ===
        'User has answered your questions: "Which way?"="Left", "How fast?"="Unanswered". ' +
          "You can now continue with the user's answers in mind.",
      result.output,
    )
    check("a skipped question reads as Unanswered", result.output.includes('"How fast?"="Unanswered"'))
    check(
      "the answers are stored on the part so the card can redraw",
      JSON.stringify(result.metadata?.answers) === '[["Left"],[]]',
      JSON.stringify(result.metadata?.answers),
    )
    check("and nothing stays parked", questions.outstanding().length === 0)
    check(
      "the reply is announced, so a second window closes its copy",
      events.some((event) => event.type === "question.replied"),
    )
  }

  console.log("a question the reader dismisses")
  {
    const question = findTool("question")!
    const controller = new AbortController()
    const running = question
      .execute(
        { questions: [{ question: "Go on?", header: "Go on", options: [{ label: "Yes", description: "" }] }] },
        context(controller.signal, "call-q2"),
      )
      .then(
        () => "resolved",
        (err: Error) => err.message,
      )

    const id = questions.outstanding()[0]?.id ?? ""
    check("dismissing a parked question is accepted", questions.reject(id))
    check(
      "and the model is told in the reference's own words",
      (await running) === "The user dismissed this question",
      await running,
    )
    check("nothing stays parked after a dismissal", questions.outstanding().length === 0)
  }

  console.log("a question left standing when the turn is stopped")
  {
    const question = findTool("question")!
    const controller = new AbortController()
    const running = question
      .execute(
        { questions: [{ question: "Wait?", header: "Wait", options: [{ label: "Yes", description: "" }] }] },
        context(controller.signal, "call-q3"),
      )
      .then(
        () => "resolved",
        (err: Error) => err.message,
      )
    check("it is parked", questions.outstanding().length === 1)
    /*
     * Stop is the one path that can leave a question with nobody to answer it.
     * Without this the promise never settles, the turn never ends and the
     * session reports itself busy for the life of the process.
     */
    controller.abort()
    check("stopping the turn settles it", (await running) === "The user dismissed this question", await running)
    check("and it is no longer listed", questions.outstanding().length === 0)
  }

  /*
   * Which tools a model is given.
   *
   * The reference does not offer `apply_patch` alongside `edit` and `write` -
   * it swaps them, for GPT-5 ids only. Getting the swap backwards would leave a
   * model with no way to change a file at all, which no type and no other check
   * would notice.
   */
  console.log("the patch-language swap")
  {
    const names = (agent: string, model: string) => toolsFor(agent, model).map((tool) => tool.name)

    const gpt5 = names("build", "gpt-5.5")
    check("a gpt-5 id is given apply_patch", gpt5.includes("apply_patch"), gpt5.join(","))
    check("and loses edit and write", !gpt5.includes("edit") && !gpt5.includes("write"))

    const codex = names("build", "gpt-5.3-codex-spark")
    check("so is a codex id", codex.includes("apply_patch") && !codex.includes("edit"))

    const claude = names("build", "claude-opus-5")
    check("an anthropic id keeps edit and write", claude.includes("edit") && claude.includes("write"))
    check("and is never shown apply_patch", !claude.includes("apply_patch"))

    const gpt4 = names("build", "gpt-4.1")
    check("gpt-4 is carved back out", !gpt4.includes("apply_patch") && gpt4.includes("edit"))
    const oss = names("build", "gpt-oss-120b")
    check("so is gpt-oss", !oss.includes("apply_patch") && oss.includes("edit"))

    const plan = names("plan", "gpt-5.5")
    check("plan gets no way to write at all", !plan.includes("apply_patch") && !plan.includes("edit"))
    check("but keeps the question tool", plan.includes("question"))

    check("the model is never offered the invalid tool", !gpt5.includes("invalid") && !claude.includes("invalid"))
    check("though a call can still be routed to it", findTool("invalid") !== undefined)
  }

  console.log("applying a patch")
  {
    const patch = findTool("apply_patch")
    if (!patch) throw new Error("the registry is missing the apply_patch tool")
    const controller = new AbortController()
    const run = (patchText: string) =>
      patch.execute({ patchText }, context(controller.signal, "call-p1")).then(
        (result) => result.output,
        (err: Error) => "ERROR " + err.message,
      )

    await fs.writeFile(path.join(project, "keep.txt"), "one\ntwo\nthree\n", "utf8")
    await fs.writeFile(path.join(project, "gone.txt"), "bye\n", "utf8")

    recorded.length = 0
    const output = await run(
      [
        "*** Begin Patch",
        "*** Add File: made.txt",
        "+fresh",
        "*** Update File: keep.txt",
        "@@",
        "-two",
        "+TWO",
        "*** Delete File: gone.txt",
        "*** End Patch",
      ].join("\n"),
    )
    check("one patch can add, update and delete at once", output.startsWith("Success. Updated the following files:"), output)
    check("the new file is there", (await fs.readFile(path.join(project, "made.txt"), "utf8")) === "fresh\n")
    check("the updated file changed", (await fs.readFile(path.join(project, "keep.txt"), "utf8")) === "one\nTWO\nthree\n")
    check(
      "the deleted file is gone",
      !(await fs.stat(path.join(project, "gone.txt")).catch(() => undefined)),
    )
    check("and every file it touched was recorded first, so undo can reach them", recorded.length === 3, String(recorded.length))

    const moved = await run(
      ["*** Begin Patch", "*** Update File: made.txt", "*** Move to: moved.txt", "@@", "-fresh", "+moved", "*** End Patch"].join("\n"),
    )
    check("a rename writes the destination", (await fs.readFile(path.join(project, "moved.txt"), "utf8")) === "moved\n", moved)
    check("and removes the source", !(await fs.stat(path.join(project, "made.txt")).catch(() => undefined)))

    /*
     * The property that matters most: a patch is computed against every file
     * before any of them is written, so one bad chunk leaves the project
     * exactly as it was rather than half-applied.
     */
    const before = await fs.readFile(path.join(project, "keep.txt"), "utf8")
    const refused = await run(
      [
        "*** Begin Patch",
        "*** Update File: keep.txt",
        "@@",
        "-one",
        "+ONE",
        "*** Update File: moved.txt",
        "@@",
        "-not in the file",
        "+nope",
        "*** End Patch",
      ].join("\n"),
    )
    check("a chunk that does not match is refused", refused.startsWith("ERROR apply_patch verification failed"), refused)
    check("and the file that would have applied is untouched", (await fs.readFile(path.join(project, "keep.txt"), "utf8")) === before)

    const empty = await run("*** Begin Patch\n*** End Patch")
    check("an empty patch is rejected in the reference's words", empty === "ERROR patch rejected: empty patch", empty)
    const nonsense = await run("just some text")
    check(
      "so is text that is not a patch",
      nonsense === "ERROR apply_patch verification failed: Invalid patch format: missing Begin/End markers",
      nonsense,
    )

    /*
     * A move whose destination is the project itself.
     *
     * The reference fixed exactly this in 1.18.26 - "apply_patch no longer
     * produces empty move paths in permission metadata". `relative()` returns
     * an empty string when the two paths are equal, and `moveDisplay ?? display`
     * does not fall back for one, because `??` only catches null. So the
     * approval names a file with no name, and the call goes on to treat the
     * directory as the destination.
     */
    await fs.writeFile(path.join(project, "movable.txt"), "here\n", "utf8")
    events.length = 0
    const ontoDirectory = await run(
      [
        "*** Begin Patch",
        "*** Update File: movable.txt",
        "*** Move to: .",
        "@@",
        "-here",
        "+there",
        "*** End Patch",
      ].join("\n"),
    )
    /*
     * Driven through the output rather than through the permission event: this
     * harness approves edits automatically, so no request is ever published and
     * an assertion on that list can only ever pass.
     */
    check(
      "a move onto the directory is refused in the tool's own words",
      ontoDirectory.startsWith("ERROR patch rejected:"),
      ontoDirectory,
    )
    check(
      "and the file it would have moved is still there",
      await fs
        .readFile(path.join(project, "movable.txt"), "utf8")
        .then(() => true)
        .catch(() => false),
      ontoDirectory,
    )
  }

  console.log("a call that could not be dispatched")
  {
    const invalid = findTool("invalid")!
    const controller = new AbortController()
    const result = await invalid.execute(
      { tool: "Reed", error: "Model tried to call unavailable tool 'Reed'." },
      context(controller.signal, "call-i1"),
    )
    check(
      "invalid explains itself in the reference's words",
      result.output === "The arguments provided to the tool are invalid: Model tried to call unavailable tool 'Reed'.",
      result.output,
    )
    check("and titles the card the way the reference does", result.title === "Invalid Tool", result.title)
  }

  console.log("\nthe three defects a second read found")
  {
    /*
     * 1. A question asked on a turn that has ALREADY been stopped.
     *
     * An AbortSignal that has fired does not fire again for a listener attached
     * afterwards, so the guard inside `ask` has to be an up-front test rather
     * than only a listener. Without it the promise never settles: the turn sits
     * parked forever with a form on screen asking the reader to answer
     * something they had just stopped. The window is real - runTool awaits a
     * permission check before it calls execute, and Stop can land inside it.
     */
    const questions = new Questions(new Bus())
    const stopped = new AbortController()
    stopped.abort()
    let settled = "never"
    await Promise.race([
      questions
        .ask({
          sessionID: "ses_review",
          questions: [{ question: "q", header: "h", options: [{ label: "a", description: "b" }] }],
          signal: stopped.signal,
        })
        .then(
          () => (settled = "resolved"),
          () => (settled = "rejected"),
        ),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ])
    check("a question asked after Stop settles rather than parking", settled === "rejected", settled)
    check("and nothing is left outstanding for it", questions.outstanding().length === 0, String(questions.outstanding().length))
  }

  {
    /*
     * 2. Where a pure insertion lands.
     *
     * opencode's applier pops one trailing blank and then inserts at
     * `lines.length` (`replacements.push([lines2.length, 0, chunk.newLines])`).
     * This app stepped back one line further whenever the file ended in a
     * blank, which put the new text ABOVE the final line instead of after it -
     * measuring the same trailing newline twice.
     */
    const before = "alpha\nbeta\n"
    const after = applyChunks("f.ts", [{ oldLines: [], newLines: ["gamma"] }], before)
    check("an insertion goes after the last line", after === "alpha\nbeta\ngamma\n", JSON.stringify(after))

    // The case that used to differ: a file whose text ends in a blank line.
    const padded = "alpha\nbeta\n\n"
    const paddedAfter = applyChunks("f.ts", [{ oldLines: [], newLines: ["gamma"] }], padded)
    check(
      "and still after it when the file ends in a blank line",
      paddedAfter === "alpha\nbeta\n\ngamma\n",
      JSON.stringify(paddedAfter),
    )
  }

  {
    /*
     * 3. A shell that cannot start must still be able to say so.
     *
     * The bus reaches the socket the moment it is published, and `open` is
     * called from inside the request that is about to answer with the id. So a
     * failure published synchronously arrives BEFORE the response, at a window
     * that does not yet know the id and drops it - leaving the pane in front of
     * a blank rectangle with no explanation, which is the very failure the pty
     * work was done to remove. The events have to come after the frame.
     */
    const bus = new Bus()
    const seen: string[] = []
    bus.subscribe((event) => {
      if (event.type === "shell.data" || event.type === "shell.exit") seen.push(event.type)
    })
    const shells = new Shells(bus)
    /*
     * A shell that genuinely cannot start, so the catch above is the path
     * taken. The name has to be one shellCommand RECOGNISES - an unknown one
     * falls back to the platform default and starts fine - so this is a bash
     * at a path that is not there. A first attempt at this assertion opened the
     * default shell instead, which succeeds, and so proved nothing at all.
     */
    const missing = process.platform === "win32" ? "C:/nowhere/at/all/bash.exe" : "/nowhere/at/all/bash"
    const id = shells.open("ses_review", os.tmpdir(), missing, { cols: 80, rows: 24 })
    check("a shell that cannot start still answers with an id", typeof id === "string" && id.length > 0)
    // Whether it started or not, nothing may have been said before this line.
    check("and says nothing before the caller has that id", seen.length === 0, seen.join(","))
    shells.close(id)
  }

  console.log("")
  if (problems.length) {
    console.error(`FAILED with ${problems.length} problem(s):`)
    for (const problem of problems) console.error("  " + problem)
    process.exit(1)
  }
  console.log(
    "A stopped command takes its children with it, an ambiguous edit is refused, " +
      "a question survives a reload and a half-matching patch changes nothing.",
  )
  process.exit(0)
}

void main()
